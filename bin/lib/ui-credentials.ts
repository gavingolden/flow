/**
 * Resolve the manifest's credential env-var NAMES to VALUES, and build the
 * no-values fill script the browser page runs to log itself in.
 *
 * SECRET-VALUE GUARDRAIL: this is the one module in the UI-validation
 * surface allowed to hold real credential VALUES in memory. It never prints
 * them, never returns them from `buildFillScript`, and the caller
 * (`bin/flow-ui-login.ts`) never puts them on argv/env/stdout — only inside
 * a short-lived local HTTP response the browser page itself fetches.
 *
 * Precedence: `process.env` first, then `<worktree>/.env.local`, then
 * `<worktree>/.env` (both followed as symlinks — a worktree's `.env` is a
 * symlink to the canonical checkout per `bin/lib/worktree-fs.ts`). Only the
 * two requested keys are ever read out of a dotenv file.
 *
 * Internal import of `bin/flow-ui-login.ts` only, NOT PATH-registered.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DOTENV_KEY_RE } from "./ui-auth-infer";

export type CredentialSource = "process.env" | ".env.local" | ".env";

export type CredentialPresence = {
  name: string;
  present: boolean;
  source?: CredentialSource;
};

export type ResolvedCredentials = {
  user: CredentialPresence;
  pass: CredentialPresence;
  values?: { user: string; pass: string };
};

/**
 * Parse only the requested `keys` out of dotenv-format `text`. Strips a
 * matching pair of single/double quotes and a trailing ` #comment` on
 * unquoted values. Unrequested keys are never even stored.
 */
export function parseDotenvKeys(
  text: string,
  keys: string[],
): Record<string, string> {
  const wanted = new Set(keys);
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const m = line.match(DOTENV_KEY_RE);
    if (!m) continue;
    const key = m[1];
    if (!wanted.has(key)) continue;
    let value = line.slice(m[0].length).trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.endsWith(quote) &&
      value.length >= 2
    ) {
      value = value.slice(1, -1);
    } else {
      // Unquoted value: strip a trailing ` #comment`, not a `#` glued to
      // the value itself.
      const hashIdx = value.indexOf(" #");
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    out[key] = value;
  }
  return out;
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function lookupInDotenvFile(
  name: string,
  filePath: string,
  source: CredentialSource,
): { presence: CredentialPresence; value?: string } {
  const text = readFileIfExists(filePath);
  if (text === undefined) return { presence: { name, present: false } };
  const parsed = parseDotenvKeys(text, [name]);
  const v = parsed[name];
  if (v !== undefined && v.length > 0) {
    return { presence: { name, present: true, source }, value: v };
  }
  return { presence: { name, present: false } };
}

function resolveOne(
  name: string,
  worktree: string,
  env: NodeJS.ProcessEnv,
): { presence: CredentialPresence; value?: string } {
  const v = env[name];
  if (v !== undefined && v.length > 0) {
    return {
      presence: { name, present: true, source: "process.env" },
      value: v,
    };
  }

  const fromEnvLocal = lookupInDotenvFile(
    name,
    path.join(worktree, ".env.local"),
    ".env.local",
  );
  if (fromEnvLocal.presence.present) return fromEnvLocal;

  return lookupInDotenvFile(name, path.join(worktree, ".env"), ".env");
}

export function resolveCredentials(
  names: { user: string; pass: string },
  opts: { worktree: string; env?: NodeJS.ProcessEnv },
): ResolvedCredentials {
  const env = opts.env ?? process.env;
  const user = resolveOne(names.user, opts.worktree, env);
  const pass = resolveOne(names.pass, opts.worktree, env);

  const out: ResolvedCredentials = { user: user.presence, pass: pass.presence };
  if (user.presence.present && pass.presence.present) {
    out.values = { user: user.value as string, pass: pass.value as string };
  }
  return out;
}

/**
 * Build the JS source of an `async () => {...}` function for
 * `evaluate_script` that fetches `url` (a one-time local endpoint, see
 * `bin/flow-ui-login.ts`), fills the login form found on the current page,
 * and submits it. The returned SOURCE never contains a credential value —
 * the values live only inside the fetch response the page itself receives.
 */
export function buildFillScript(opts: { url: string }): string {
  const url = JSON.stringify(opts.url);
  return `async () => {
  const userField =
    document.querySelector('input[type="email"]') ||
    document.querySelector('input[autocomplete="username"]') ||
    document.querySelector('input[name*="email" i]') ||
    document.querySelector('input[name*="user" i]') ||
    document.querySelector("#email");
  const passField = document.querySelector('input[type="password"]');

  if (!userField) {
    return { fetched: false, userFilled: false, passFilled: false, submitted: false, reason: "user-field-not-found" };
  }
  if (!passField) {
    return { fetched: false, userFilled: false, passFilled: false, submitted: false, reason: "pass-field-not-found" };
  }

  let res;
  try {
    res = await fetch(${url}, { mode: "cors", credentials: "omit" });
  } catch {
    return { fetched: false, userFilled: false, passFilled: false, submitted: false, reason: "fetch-blocked" };
  }
  if (!res.ok) {
    return { fetched: false, userFilled: false, passFilled: false, submitted: false, reason: "endpoint-refused" };
  }
  const creds = await res.json();

  const setValue = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  setValue(userField, creds.user);
  setValue(passField, creds.pass);

  const form = passField.closest("form") || userField.closest("form");
  let submitted = false;
  if (form) {
    const submitControl = form.querySelector('button[type="submit"], input[type="submit"]');
    if (submitControl) {
      submitControl.click();
      submitted = true;
    } else if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      submitted = true;
    }
  }

  return { fetched: true, userFilled: true, passFilled: true, submitted: submitted, reason: null };
}`;
}
