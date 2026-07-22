/**
 * Install-time claude-runnable check for `flow install`. Mirrors the
 * findMissingRuntimeDeps / formatMissingDepsError split in setup-deps.ts:
 * strictly pure (no logging, no process.exit), runner injectable so specs
 * never spawn a real claude. No version-minimum enforcement — the probe only
 * answers "will `claude` run at launch time?".
 */

import { spawnSync } from "node:child_process";

export type ClaudeProbeRunner = (cmd: string[]) => {
  ok: boolean;
  stdout?: string;
  stderr?: string;
};

const PROBE_TIMEOUT_MS = 5000;

// node:child_process (not Bun.spawnSync) so the module runs identically
// under Bun and vitest's Node — same portability rule as setup-deps.ts.
function defaultRunner(cmd: string[]): ReturnType<ClaudeProbeRunner> {
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    timeout: PROBE_TIMEOUT_MS,
    encoding: "utf8",
  });
  if (proc.error) throw proc.error;
  return { ok: proc.status === 0, stdout: proc.stdout, stderr: proc.stderr };
}

/**
 * Probes `claude --version`. `reason` distinguishes `not-on-path` (spawn
 * itself failed — no binary) from `probe-failed: <detail>` (the binary ran
 * but exited non-zero / timed out).
 */
export function checkClaudeRunnable(
  runner: ClaudeProbeRunner = defaultRunner,
): {
  ok: boolean;
  reason?: string;
} {
  let result: ReturnType<ClaudeProbeRunner>;
  try {
    result = runner(["claude", "--version"]);
  } catch {
    return { ok: false, reason: "not-on-path" };
  }
  if (result.ok) return { ok: true };
  const detail = (result.stderr || result.stdout || "").trim();
  return {
    ok: false,
    reason:
      detail === "" ? "probe-failed: exit non-zero" : `probe-failed: ${detail}`,
  };
}

/** Actionable warning string; the caller decides how to surface it. */
export function formatClaudeCheckWarning(reason: string): string {
  const problem =
    reason === "not-on-path"
      ? "`claude` is not on PATH"
      : `\`claude --version\` failed (${reason})`;
  return (
    `warning: ${problem}.\n` +
    "  flow launches pipelines through Claude Code; launches will fail until it runs.\n" +
    "  Install it (https://code.claude.com/docs) or fix your PATH, then re-run `claude --version`."
  );
}
