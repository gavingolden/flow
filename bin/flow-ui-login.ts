#!/usr/bin/env bun
/**
 * Safe login helper for the browser-driven UI-validation capability. Two
 * subcommands, neither of which ever prints a credential VALUE:
 *
 *   flow-ui-login check --manifest <path> [--worktree <dir>]
 *     Reports whether each of the manifest's `credentialEnvVars` NAMES
 *     resolves to a value, and where — never the value itself. Exit 0 when
 *     both resolve, 3 when either is missing, 2 on a manifest/args problem.
 *
 *   flow-ui-login serve --manifest <path> --origin <origin> [--worktree <dir>]
 *     Spawns a detached, single-use, ~90-second local HTTP endpoint (see
 *     `bin/lib/ui-credential-server.ts`) that answers only the app's own
 *     origin, and prints a `fillScript` (see `bin/lib/ui-credentials.ts`)
 *     for the caller to run via `evaluate_script` inside the browser page.
 *     The values travel only inside that one HTTP response the page itself
 *     fetches — never through this CLI's stdout, stderr, or argv. Exit 0 on
 *     success, 3 (with a presence JSON, no child spawned) when either
 *     credential is missing, 2 on a manifest/args problem.
 *
 * `__serve-child` is a hidden third subcommand: the detached child process
 * `serve` spawns to actually bind and answer the endpoint. It re-resolves
 * the credential VALUES itself from the NAMES passed on its argv — the
 * VALUES never travel from parent to child.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { validateUiValidationManifest } from "./lib/ui-validation-schema";
import { buildFillScript, resolveCredentials } from "./lib/ui-credentials";
import {
  DEFAULT_CREDENTIAL_SERVER_TTL_MS,
  startCredentialServer,
} from "./lib/ui-credential-server";

type CredentialNames = { user: string; pass: string };

export type SpawnChildOpts = {
  scriptPath: string;
  userName: string;
  passName: string;
  token: string;
  origin: string;
  worktree: string;
  ttlMs: number;
  portFilePath: string;
};

export type SpawnChildFn = (opts: SpawnChildOpts) => void;

export type MainDeps = {
  env?: NodeJS.ProcessEnv;
  spawnChild?: SpawnChildFn;
  ttlMs?: number;
};

function isCredentialNames(v: unknown): v is CredentialNames {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).user === "string" &&
    typeof (v as Record<string, unknown>).pass === "string"
  );
}

/**
 * Reads `credentialEnvVars` NAMES out of the manifest. Prefers the full
 * schema validator; a manifest that's off-shape for unrelated reasons (a
 * work-in-progress bootstrap draft) still yields NAMES via a minimal JSON
 * read when the field itself is well-formed.
 */
function readCredentialNames(manifestPath: string): CredentialNames | null {
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

async function runCheck(argv: string[]): Promise<number> {
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
  const resolved = resolveCredentials(names, { worktree });
  const ok = resolved.user.present && resolved.pass.present;
  process.stdout.write(
    JSON.stringify({ ok, user: resolved.user, pass: resolved.pass }) + "\n",
  );
  return ok ? 0 : 3;
}

function defaultSpawnChild(opts: SpawnChildOpts): void {
  const child = spawn(
    process.execPath,
    [
      opts.scriptPath,
      "__serve-child",
      "--user-name",
      opts.userName,
      "--pass-name",
      opts.passName,
      "--token",
      opts.token,
      "--origin",
      opts.origin,
      "--worktree",
      opts.worktree,
      "--ttl-ms",
      String(opts.ttlMs),
      "--port-file",
      opts.portFilePath,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", () => {});
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPortFile(
  portFilePath: string,
  timeoutMs = 3000,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(portFilePath)) {
      const raw = fs.readFileSync(portFilePath, "utf8").trim();
      const port = Number(raw);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await sleep(20);
  }
  throw new Error(
    "timed out waiting for the credential server to report its port",
  );
}

async function runServe(argv: string[], deps: MainDeps): Promise<number> {
  const { flags, error } = parseFlags(
    argv,
    new Set(["manifest", "origin", "worktree"]),
  );
  if (error || !flags.manifest || !flags.origin) {
    process.stderr.write(
      "usage: flow-ui-login serve --manifest <path> --origin <origin> [--worktree <dir>]\n",
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
  if (!resolved.values) {
    process.stdout.write(
      JSON.stringify({ ok: false, user: resolved.user, pass: resolved.pass }) +
        "\n",
    );
    return 3;
  }

  const ttlMs = deps.ttlMs ?? DEFAULT_CREDENTIAL_SERVER_TTL_MS;
  const token = crypto.randomBytes(32).toString("hex");
  const scriptPath = fileURLToPath(import.meta.url);
  const portFilePath = path.join(
    worktree,
    ".flow-tmp",
    `ui-login-port-${token.slice(0, 16)}.txt`,
  );
  fs.mkdirSync(path.dirname(portFilePath), { recursive: true });
  try {
    fs.rmSync(portFilePath, { force: true });
  } catch {
    // best-effort stale-file cleanup only
  }

  const spawnChild = deps.spawnChild ?? defaultSpawnChild;
  spawnChild({
    scriptPath,
    userName: names.user,
    passName: names.pass,
    token,
    origin: flags.origin,
    worktree,
    ttlMs,
    portFilePath,
  });

  let port: number;
  try {
    port = await waitForPortFile(portFilePath);
  } finally {
    try {
      fs.rmSync(portFilePath, { force: true });
    } catch {
      // best-effort cleanup only
    }
  }

  const fillScript = buildFillScript({
    url: `http://127.0.0.1:${port}/${token}`,
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      port,
      expiresInSec: Math.round(ttlMs / 1000),
      fillScript,
    }) + "\n",
  );
  return 0;
}

async function runServeChild(argv: string[]): Promise<number> {
  const { flags, error } = parseFlags(
    argv,
    new Set([
      "user-name",
      "pass-name",
      "token",
      "origin",
      "worktree",
      "ttl-ms",
      "port-file",
    ]),
  );
  if (
    error ||
    !flags["user-name"] ||
    !flags["pass-name"] ||
    !flags.token ||
    !flags.origin ||
    !flags["port-file"]
  ) {
    return 2;
  }
  const worktree = flags.worktree ?? process.cwd();
  const ttlMs = flags["ttl-ms"]
    ? Number(flags["ttl-ms"])
    : DEFAULT_CREDENTIAL_SERVER_TTL_MS;

  const resolved = resolveCredentials(
    { user: flags["user-name"], pass: flags["pass-name"] },
    { worktree },
  );
  if (!resolved.values) {
    // Nothing to serve. The parent's port-file poll times out and the
    // caller sees a fetch-blocked/login-failed result — never a value.
    return 3;
  }

  const handle = await startCredentialServer({
    values: resolved.values,
    token: flags.token,
    origin: flags.origin,
    ttlMs,
  });
  fs.writeFileSync(flags["port-file"], String(handle.port));
  await handle.closed;
  return 0;
}

export async function main(
  argv: string[],
  deps: MainDeps = {},
): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "check":
      return runCheck(rest);
    case "serve":
      return runServe(rest, deps);
    case "__serve-child":
      return runServeChild(rest);
    default:
      process.stderr.write("usage: flow-ui-login <check|serve> ...\n");
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
