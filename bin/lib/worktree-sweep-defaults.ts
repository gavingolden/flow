/**
 * Real-machine wiring for the worktree sweep: subprocess runner, pipeline
 * records, liveness, tmux windows, and the `flow-remove-worktree` removal
 * step. Unit tests inject their own deps and never call this.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { livenessOf } from "./liveness";
import { cachedConfigRead, defaultReadConfigFile } from "./models-config";
import { flowStateDir, resolveFlowSource } from "./paths";
import { listStates } from "./state";
import { windowExists } from "./tmux";
import { canonicalizeWorktree } from "./worktree-orphans-ps";
import type { RunResult, SweepRun } from "./worktree-sweep-facts";
import { cleanChildEnv, type SweepDeps } from "./worktree-sweep-state";
import { defaultListProcs, defaultReadCwds } from "./worktree-sweep-usage";

export const REMOVE_TIMEOUT_MS = 120_000;

export const realRun: SweepRun = (cmd, args, opts): RunResult => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: cleanChildEnv(),
    timeout: opts.timeoutMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut =
    (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut,
  };
};

function moduleDir(): string {
  return (
    (import.meta as { dir?: string }).dir ??
    path.dirname(fileURLToPath(import.meta.url))
  );
}

/** Absolute path to `bin/flow-remove-worktree.ts`, relative to THIS module. */
export const removeScriptPath = (): string =>
  path.join(moduleDir(), "..", "flow-remove-worktree.ts");

export function removeViaScript(
  wt: string,
  primary: string,
  deleteBranch: boolean,
) {
  const args = [
    removeScriptPath(),
    wt,
    ...(deleteBranch ? ["--delete-branch"] : []),
  ];
  const r = spawnSync(process.execPath, args, {
    cwd: primary,
    env: cleanChildEnv(),
    timeout: REMOVE_TIMEOUT_MS,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const text = `${r.stderr ?? ""}${r.stdout ?? ""}`
    .trim()
    .split("\n")
    .slice(-3)
    .join(" ");
  return r.status === 0
    ? { ok: true, message: "removed" }
    : { ok: false, message: text || `exit ${r.status ?? "signal"}` };
}

function sizeBytes(p: string): number {
  const r = realRun("du", ["-sk", p], { timeoutMs: 60_000 });
  const kb = Number(r.stdout.split(/\s+/)[0]);
  return r.status === 0 && Number.isFinite(kb) ? kb * 1024 : 0;
}

export function defaultSweepDeps(cwd: string = process.cwd()): SweepDeps {
  const flowSourcePaths = [
    resolveFlowSource(),
    path.resolve(moduleDir(), "..", ".."),
  ].map(canonicalizeWorktree);
  return {
    run: realRun,
    listStates: () => listStates(),
    liveness: (s) => livenessOf(s),
    windowOpen: (slug) => windowExists(slug),
    cwd,
    nowMs: () => Date.now(),
    flowSourcePaths,
    listProcs: defaultListProcs,
    readCwds: defaultReadCwds,
    selfPids: [process.pid],
    removeWorktree: removeViaScript,
    removeDir: (p) => fs.rmSync(p, { recursive: true, force: true }),
    sizeBytes,
    readConfig: cachedConfigRead(defaultReadConfigFile),
    stateDir: flowStateDir(),
    logPath: path.join(os.homedir(), ".flow", "logs", "worktree-sweep.jsonl"),
    pid: process.pid,
  };
}
