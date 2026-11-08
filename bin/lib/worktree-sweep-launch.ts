/**
 * Fire-and-forget starter for the automatic worktree sweep, called from
 * `flow feature create`. Foreground cost is one config read, one file stat
 * and one detached spawn that is never awaited; the child's stdio is ignored
 * so the launch's stdout first line (`flow:<slug>`) is untouched. Never
 * throws.
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultReadConfigFile, type ReadConfigFile } from "./models-config";
import { flowStateDir } from "./paths";
import {
  cleanChildEnv,
  isAutoSweepEnabled,
  stampAgeMs,
  WORKTREE_SWEEP_THROTTLE_MS,
} from "./worktree-sweep-state";

export type StartSweepDeps = {
  spawn?: typeof nodeSpawn;
  readConfig?: ReadConfigFile;
  stateDir?: string;
  nowMs?: () => number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** False outside Bun (vitest/Node): the starter is then a no-op. */
  isBun?: boolean;
};

function flowBinPath(): string {
  const here =
    (import.meta as { dir?: string }).dir ??
    path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "flow");
}

export function startBackgroundWorktreeSweep(
  deps: StartSweepDeps = {},
): "spawned" | "disabled" | "throttled" | "unavailable" {
  try {
    if (!(deps.isBun ?? typeof Bun !== "undefined")) return "unavailable";
    if (!isAutoSweepEnabled(deps.readConfig ?? defaultReadConfigFile)) {
      return "disabled";
    }
    const age = stampAgeMs(
      (deps.nowMs ?? Date.now)(),
      deps.stateDir ?? flowStateDir(),
    );
    if (age !== null && age < WORKTREE_SWEEP_THROTTLE_MS) return "throttled";

    const env = cleanChildEnv(deps.env ?? process.env);
    const child = (deps.spawn ?? nodeSpawn)(
      process.execPath,
      [flowBinPath(), "reap", "--worktrees", "--yes", "--auto"],
      {
        cwd: deps.cwd ?? process.cwd(),
        detached: true,
        stdio: "ignore",
        env,
      },
    );
    child.on?.("error", () => undefined);
    child.unref();
    return "spawned";
  } catch {
    return "unavailable";
  }
}
