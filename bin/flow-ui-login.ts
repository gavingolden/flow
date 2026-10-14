#!/usr/bin/env bun
/**
 * Login helper for the browser-driven UI-validation capability. Two
 * subcommands:
 *
 *   flow-ui-login check --manifest <path> [--worktree <dir>]
 *     Reports whether each of the manifest's `credentialEnvVars` NAMES
 *     resolves to a value, and where — never the value itself. Exit 0 when
 *     both resolve, 3 when either is missing, 2 on a manifest/args problem.
 *
 *   flow-ui-login test-account --manifest <path> [--worktree <dir>]
 *     Prints `{"ok":true,"user":"<v>","pass":"<v>"}` — the two seeded
 *     LOCAL test-account VALUES — so the browser agent can type them into
 *     the login form with chrome-devtools `fill_form`. Exit 0 on success,
 *     3 (names-only presence JSON, no value) when either credential is
 *     missing, 2 on a manifest/args problem (including a manifest that
 *     fails full schema validation — `test-account` never falls back to the
 *     lenient bootstrap-draft read `check` uses) or when `baseUrl` (or an
 *     absolute `loginUrl`) is not a localhost address
 *     (`{ok:false,reason:"non-local-base-url"}`, no value printed).
 *
 * `test-account` reuses the `user`/`pass` keys `check` uses for presence
 * objects, but here they carry the values. Threat model: this is the one
 * command that prints credential VALUES, so it resolves only the two
 * manifest-named keys (never any other `.env` key), reads only a
 * schema-valid manifest, and refuses any non-localhost target — the account
 * is a seeded test user for a local dev server. The values still never
 * belong in a committed or published artifact.
 */

import * as fs from "node:fs";

import { validateUiValidationManifest } from "./lib/ui-validation-schema";
import { resolveCredentials } from "./lib/ui-credentials";

type CredentialNames = { user: string; pass: string };

export type MainDeps = {
  env?: NodeJS.ProcessEnv;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PORT_SENTINEL_RE = /\{\{PORT(?:_[A-Z0-9_]+)?\}\}/g;

/**
 * True only when `url` parses and its hostname is a loopback name. The
 * `{{PORT}}` placeholder is replaced with a dummy port first so a
 * manifest's templated `baseUrl` still parses.
 */
export function isLocalBaseUrl(url: string): boolean {
  try {
    const u = new URL(url.replace(PORT_SENTINEL_RE, "1"));
    return LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function isCredentialNames(v: unknown): v is CredentialNames {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).user === "string" &&
    typeof (v as Record<string, unknown>).pass === "string"
  );
}

/**
 * Reads `credentialEnvVars` NAMES out of the manifest.
 *
 * `strict: false` (the `check` default) prefers the full schema validator
 * but falls back to a minimal JSON read when the manifest is off-shape for
 * unrelated reasons (a work-in-progress bootstrap draft) as long as
 * `credentialEnvVars` itself is well-formed — `check` is exactly the tool
 * the bootstrap flow runs before the manifest is complete.
 *
 * `strict: true` (`test-account`) requires full schema validation and never
 * takes the lenient fallback: an agent that hands `test-account` a
 * hand-rolled manifest naming an arbitrary env var pair (bypassing the
 * classifier that gates a legitimate `.flow/ui-validation.json`) gets
 * rejected here instead of a general secret printer.
 */
function readCredentialNames(
  manifestPath: string,
  opts: { strict: boolean } = { strict: false },
): CredentialNames | null {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const validated = validateUiValidationManifest(parsed);
  if (validated.ok && validated.value.credentialEnvVars) {
    return validated.value.credentialEnvVars;
  }
  if (opts.strict) return null;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const c = (parsed as Record<string, unknown>).credentialEnvVars;
    if (isCredentialNames(c)) return c;
  }
  return null;
}

function parseFlags(
  argv: string[],
  allowed: ReadonlySet<string>,
): { flags: Record<string, string>; error?: string } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--"))
      return { flags, error: `unexpected argument: ${flag}` };
    const name = flag.slice(2);
    if (!allowed.has(name)) return { flags, error: `unknown flag: ${flag}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { flags, error: `${flag} requires a value` };
    }
    flags[name] = value;
    i++;
  }
  return { flags };
}

async function runCheck(argv: string[], deps: MainDeps = {}): Promise<number> {
  const { flags, error } = parseFlags(argv, new Set(["manifest", "worktree"]));
  if (error || !flags.manifest) {
    process.stderr.write(
      "usage: flow-ui-login check --manifest <path> [--worktree <dir>]\n",
    );
    return 2;
  }
  const worktree = flags.worktree ?? process.cwd();
  const names = readCredentialNames(flags.manifest);
  if (!names) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: "no-credential-env-vars" }) + "\n",
    );
    return 2;
  }
  const env = deps.env ?? process.env;
  const resolved = resolveCredentials(names, { worktree, env });
  const ok = resolved.user.present && resolved.pass.present;
  process.stdout.write(
    JSON.stringify({ ok, user: resolved.user, pass: resolved.pass }) + "\n",
  );
  return ok ? 0 : 3;
}

function readLoginTargets(
  manifestPath: string,
): { baseUrl: string; loginUrl?: string } | null {
  try {
    const validated = validateUiValidationManifest(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    );
    if (!validated.ok) return null;
    return {
      baseUrl: validated.value.baseUrl,
      loginUrl: validated.value.loginUrl,
    };
  } catch {
    return null;
  }
}

function isAbsoluteUrlRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) || /^[/\\]{2}/.test(ref);
}

async function runTestAccount(
  argv: string[],
  deps: MainDeps = {},
): Promise<number> {
  const { flags, error } = parseFlags(argv, new Set(["manifest", "worktree"]));
  if (error || !flags.manifest) {
    process.stderr.write(
      "usage: flow-ui-login test-account --manifest <path> [--worktree <dir>]\n",
    );
    return 2;
  }
  const worktree = flags.worktree ?? process.cwd();
  const names = readCredentialNames(flags.manifest, { strict: true });
  const targets = names ? readLoginTargets(flags.manifest) : null;
  if (!names || !targets) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: "no-credential-env-vars" }) + "\n",
    );
    return 2;
  }
  const loginUrl = targets.loginUrl;
  if (
    !isLocalBaseUrl(targets.baseUrl) ||
    (loginUrl !== undefined &&
      isAbsoluteUrlRef(loginUrl) &&
      !isLocalBaseUrl(loginUrl))
  ) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: "non-local-base-url" }) + "\n",
    );
    return 2;
  }

  const env = deps.env ?? process.env;
  const resolved = resolveCredentials(names, { worktree, env });
  if (!resolved.values) {
    process.stdout.write(
      JSON.stringify({ ok: false, user: resolved.user, pass: resolved.pass }) +
        "\n",
    );
    return 3;
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      user: resolved.values.user,
      pass: resolved.values.pass,
    }) + "\n",
  );
  return 0;
}

export async function main(
  argv: string[],
  deps: MainDeps = {},
): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "check":
      return runCheck(rest, deps);
    case "test-account":
      return runTestAccount(rest, deps);
    default:
      process.stderr.write("usage: flow-ui-login <check|test-account> ...\n");
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
