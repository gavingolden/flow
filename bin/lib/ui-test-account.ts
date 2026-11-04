/**
 * The test-account rules shared by `flow-ui-login test-account` and
 * `flow-ui-capture`: credential NAMES come only from the committed, unmodified
 * worktree manifest, the target must be a loopback address, and values are
 * resolved in-process. One implementation, so the committed-manifest and
 * localhost-only guards cannot drift between the two helpers.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveCredentials } from "./ui-credentials";
import { stubPortSentinels } from "./ui-launch-infer";
import { validateUiValidationManifest } from "./ui-validation-schema";

export type CredentialNames = { user: string; pass: string };

export const MANIFEST_REL = path.join(".flow", "ui-validation.json");

export function isManifestCommittedInGit(worktree: string): boolean {
  const git = (args: string[]): number | null =>
    spawnSync("git", ["-C", worktree, ...args], { stdio: "ignore" }).status;
  return (
    git(["ls-files", "--error-unmatch", "--", MANIFEST_REL]) === 0 &&
    git(["diff", "--quiet", "HEAD", "--", MANIFEST_REL]) === 0
  );
}

export function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True only when `url` parses and its hostname is a loopback name. The
 * `{{PORT}}` placeholder is replaced with a dummy port first so a
 * manifest's templated `baseUrl` still parses.
 */
export function isLocalBaseUrl(url: string): boolean {
  try {
    const u = new URL(stubPortSentinels(url));
    return LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * True when `loginUrl`, resolved against `baseUrl` the way a browser would
 * (so `//host`, `\\host` and leading whitespace all land on their real
 * host), points at a loopback name. A parse failure is a refusal.
 */
export function isLocalLoginUrl(baseUrl: string, loginUrl: string): boolean {
  try {
    const u = new URL(stubPortSentinels(loginUrl), stubPortSentinels(baseUrl));
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
 * takes the lenient fallback. That only rejects a schema-INVALID manifest —
 * a hand-rolled schema-valid one still parses, which is why `test-account`
 * additionally pins the manifest to the committed worktree copy before
 * calling this.
 */
export function readCredentialNames(
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

export function readLoginTargets(
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

export type TestAccountResult =
  | { ok: true; values: { user: string; pass: string }; baseUrl: string }
  | {
      ok: false;
      reason:
        | "manifest-not-in-worktree"
        | "manifest-not-committed"
        | "no-credential-env-vars"
        | "non-local-base-url"
        | "credentials-missing";
      presence?: ReturnType<typeof resolveCredentials>;
    };

/**
 * Applies every guard in order and only then resolves the two manifest-named
 * values. A refusal never carries a value.
 */
export function resolveTestAccount(opts: {
  manifest: string;
  worktree: string;
  env: NodeJS.ProcessEnv;
  isManifestCommitted?: (worktree: string) => boolean;
}): TestAccountResult {
  const worktree = realpathOrNull(opts.worktree);
  const manifest = realpathOrNull(opts.manifest);
  if (
    !worktree ||
    !manifest ||
    manifest !== path.join(worktree, MANIFEST_REL)
  ) {
    return { ok: false, reason: "manifest-not-in-worktree" };
  }
  const isCommitted = opts.isManifestCommitted ?? isManifestCommittedInGit;
  if (!isCommitted(worktree)) {
    return { ok: false, reason: "manifest-not-committed" };
  }

  const names = readCredentialNames(manifest, { strict: true });
  const targets = names ? readLoginTargets(manifest) : null;
  if (!names || !targets)
    return { ok: false, reason: "no-credential-env-vars" };
  const loginUrl = targets.loginUrl;
  if (
    !isLocalBaseUrl(targets.baseUrl) ||
    (loginUrl !== undefined && !isLocalLoginUrl(targets.baseUrl, loginUrl))
  ) {
    return { ok: false, reason: "non-local-base-url" };
  }

  const resolved = resolveCredentials(names, { worktree, env: opts.env });
  if (!resolved.values) {
    return { ok: false, reason: "credentials-missing", presence: resolved };
  }
  return { ok: true, values: resolved.values, baseUrl: targets.baseUrl };
}
