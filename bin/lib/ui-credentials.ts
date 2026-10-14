/**
 * Resolve the manifest's credential env-var NAMES to VALUES.
 *
 * SECRET-VALUE GUARDRAIL: this is the one module in the UI-validation
 * surface that holds real credential VALUES in memory. Only
 * `flow-ui-login test-account` prints them, and only for a seeded LOCAL
 * test account (that command refuses a non-localhost target). Only the two
 * manifest-named keys are ever read out of a dotenv file — never any other
 * `.env` key, and `flow-ui-login check` reports presence only.
 *
 * Precedence: `process.env` first, then `<worktree>/.env.local`, then
 * `<worktree>/.env` (both followed as symlinks — a worktree's `.env` is a
 * symlink to the canonical checkout per `bin/lib/worktree-fs.ts`).
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
