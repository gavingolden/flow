/**
 * Argument and input parsing for `flow-ui-capture`, split out so the CLI
 * stays a short orchestration.
 */
import { isSafeRoute, MAX_REVIEW_TARGETS } from "./ui-review-scope";

export const USAGE =
  "usage: flow-ui-capture --worktree <w> --targets <p> --base-url <url> [--manifest <p>] --out <p>\n       flow-ui-capture --probe --worktree <w>";

export type Target = { route: string; state: string | null };

export function parseCaptureArgs(
  argv: string[],
): Record<string, string> | string {
  const flags: Record<string, string> = {};
  const allowed = new Set([
    "worktree",
    "targets",
    "base-url",
    "manifest",
    "out",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(.+)$/.exec(argv[i]);
    if (!m) return `unexpected argument: ${argv[i]}`;
    if (m[1] === "probe") {
      flags.probe = "1";
      continue;
    }
    if (!allowed.has(m[1])) return `unknown flag: ${argv[i]}`;
    const v = argv[++i];
    if (v === undefined || v.startsWith("--"))
      return `--${m[1]} requires a value`;
    flags[m[1]] = v;
  }
  const need = flags.probe
    ? ["worktree"]
    : ["worktree", "targets", "base-url", "out"];
  const missing = need.find((k) => flags[k] === undefined);
  return missing ? `--${missing} is required` : flags;
}

export function readTargets(raw: string | null): Target[] | null {
  try {
    const j: unknown = JSON.parse(raw ?? "");
    if (!Array.isArray(j)) return null;
    const ok = j.filter(
      (t): t is Target => typeof t?.route === "string" && isSafeRoute(t.route),
    );
    return ok.slice(0, MAX_REVIEW_TARGETS);
  } catch {
    return null;
  }
}

export function manifestLogin(raw: string | null): string | null {
  try {
    const m = JSON.parse(raw ?? "") as {
      credentialEnvVars?: unknown;
      loginUrl?: unknown;
    };
    return m.credentialEnvVars && typeof m.loginUrl === "string"
      ? m.loginUrl
      : null;
  } catch {
    return null;
  }
}
