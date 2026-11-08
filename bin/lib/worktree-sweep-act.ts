/**
 * Removal step of the worktree sweep: every removal is logged BEFORE it runs
 * (so a removed folder can be rebuilt from the log), and a log that cannot be
 * written blocks the removal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SweepDeps, SweepItem } from "./worktree-sweep-state";

function appendLog(deps: SweepDeps, record: Record<string, unknown>): boolean {
  try {
    fs.mkdirSync(path.dirname(deps.logPath), { recursive: true });
    const line = { at: new Date(deps.nowMs()).toISOString(), ...record };
    fs.appendFileSync(deps.logPath, `${JSON.stringify(line)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Removes one item under log-before-remove; a log that cannot be written blocks the removal. */
export function actOn(
  deps: SweepDeps,
  item: SweepItem,
  run: () => { ok: boolean; message: string },
): SweepItem {
  const base = {
    kind: item.kind,
    repo: item.repo,
    path: item.path,
    branch: item.branch,
    pr: item.pr,
    headOid: item.headOid,
    bytes: item.bytes,
    reason: item.reason,
  };
  if (!appendLog(deps, { event: "removing", ...base })) {
    return {
      ...item,
      outcome: "failed",
      detail: "could not write the removal log",
    };
  }
  let r: { ok: boolean; message: string };
  try {
    r = run();
  } catch (e) {
    r = { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  appendLog(deps, {
    event: r.ok ? "removed" : "failed",
    ...base,
    message: r.message,
  });
  return r.ok
    ? { ...item, outcome: "removed" }
    : { ...item, outcome: "failed", detail: r.message };
}
