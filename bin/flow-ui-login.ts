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
 *     Reads ONLY the committed `<worktree>/.flow/ui-validation.json`: a
 *     `--manifest` that resolves elsewhere exits 2
 *     `{ok:false,reason:"manifest-not-in-worktree"}`, and a manifest that is
 *     untracked or differs from HEAD exits 2
 *     `{ok:false,reason:"manifest-not-committed"}` — no value printed either
 *     way. Prints `{"ok":true,"user":"<v>","pass":"<v>"}` — the two seeded
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
 * command that prints credential VALUES, and it is pre-approved in flow's
 * launch settings (no classifier review). So it resolves only the two
 * manifest-named keys (never any other `.env` key) and takes those names
 * only from the committed, unmodified worktree manifest: pointing it at
 * different variables needs a visible commit, never a scratch file a steered
 * agent wrote. It also refuses any non-localhost target — the account is a
 * seeded test user for a local dev server. The values still never belong in
 * a committed or published artifact.
 */

import { resolveCredentials } from "./lib/ui-credentials";
import { readCredentialNames, resolveTestAccount } from "./lib/ui-test-account";

export type MainDeps = {
  env?: NodeJS.ProcessEnv;
  /** True when the worktree's manifest is tracked and unmodified vs HEAD. */
  isManifestCommitted?: (worktree: string) => boolean;
};

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

function refuse(reason: string): number {
  process.stdout.write(JSON.stringify({ ok: false, reason }) + "\n");
  return 2;
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
  const r = resolveTestAccount({
    manifest: flags.manifest,
    worktree: flags.worktree ?? process.cwd(),
    env: deps.env ?? process.env,
    isManifestCommitted: deps.isManifestCommitted,
  });
  if (r.ok) {
    process.stdout.write(
      JSON.stringify({ ok: true, user: r.values.user, pass: r.values.pass }) +
        "\n",
    );
    return 0;
  }
  if (r.reason === "credentials-missing" && r.presence) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        user: r.presence.user,
        pass: r.presence.pass,
      }) + "\n",
    );
    return 3;
  }
  return refuse(r.reason);
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
