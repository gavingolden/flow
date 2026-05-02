#!/usr/bin/env bun
/**
 * Merge-update a pipeline state file at ~/.flow/state/<slug>.json.
 *
 * The supervisor skill (PR 2) calls this once per phase transition so
 * `flow ls` sees fresh phase / pr / worktree fields. PR 1 wrote the
 * initial state via `flow new` and pinned the schema; this binary is
 * the writer the supervisor uses to keep it current.
 *
 * Usage:
 *   flow-state-update <slug> [--phase <phase>] [--pr <number>] [--worktree <path>]
 *                            [--auto-merge | --no-auto-merge]
 *
 * - At least one update flag is required.
 * - The slug must already have a state file (created by `flow new`).
 *   Refuses to invent state out of nowhere — that surfaces drift
 *   instead of papering over it.
 * - `updatedAt` is rewritten to the current ISO-8601 UTC timestamp on
 *   every call.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { readState, writeState, nowIso, type PipelineState } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";

type Args = {
  slug: string;
  phase?: string;
  pr?: number;
  worktree?: string;
  autoMerge?: boolean;
};

/**
 * Result of the worktree-branch guard:
 *   - "ok"      — guard passed (or skipped: no worktree path, dir missing, marker missing).
 *   - "mismatch" — worktree on a different branch than the marker says. State.json is
 *                  NOT updated; supervisor escalates `NEEDS HUMAN: branch-mismatch`.
 */
type GuardResult = { kind: "ok" } | { kind: "mismatch"; expected: string; actual: string };

/** Filename of the worktree-local marker; mirrors flow-new-worktree's BRANCH_MARKER_FILENAME. */
const BRANCH_MARKER_FILENAME = ".flow-branch";

/**
 * Asserts that the worktree's current branch matches the marker file written by
 * `flow-new-worktree`. Best-effort: if the worktree directory is gone or the
 * marker file is missing (e.g. created by an older flow-new-worktree), logs a
 * one-line warning and returns ok. Only an *active* mismatch returns mismatch.
 */
export function checkWorktreeBranch(worktreePath: string | undefined): GuardResult {
  if (!worktreePath) return { kind: "ok" };
  if (!fs.existsSync(worktreePath)) {
    console.error(
      `flow-state-update: worktree path '${worktreePath}' does not exist; skipping branch guard`,
    );
    return { kind: "ok" };
  }
  const markerPath = path.join(worktreePath, BRANCH_MARKER_FILENAME);
  if (!fs.existsSync(markerPath)) {
    console.error(
      `flow-state-update: ${BRANCH_MARKER_FILENAME} missing in '${worktreePath}'; skipping branch guard ` +
        `(worktree predates the branch-marker fix or was created externally)`,
    );
    return { kind: "ok" };
  }
  const expected = fs.readFileSync(markerPath, "utf8").trim();
  const result = spawnSync("git", ["-C", worktreePath, "branch", "--show-current"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(
      `flow-state-update: 'git branch --show-current' failed in '${worktreePath}'; skipping branch guard`,
    );
    return { kind: "ok" };
  }
  const actual = result.stdout.trim();
  if (actual !== expected) return { kind: "mismatch", expected, actual };
  return { kind: "ok" };
}

export function parseArgs(argv: string[]): Args | { error: string } {
  if (argv.length === 0) {
    return { error: "slug is required" };
  }
  const [slug, ...rest] = argv;
  if (slug.startsWith("--")) {
    return { error: "slug must be the first positional argument" };
  }
  const out: Args = { slug };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--auto-merge" || flag === "--no-auto-merge") {
      out.autoMerge = flag === "--auto-merge";
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--phase":
        out.phase = value;
        break;
      case "--pr": {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
          return { error: `--pr must be a positive integer, got '${value}'` };
        }
        out.pr = n;
        break;
      }
      case "--worktree":
        out.worktree = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (
    out.phase === undefined &&
    out.pr === undefined &&
    out.worktree === undefined &&
    out.autoMerge === undefined
  ) {
    return {
      error: "at least one of --phase, --pr, --worktree, --auto-merge, --no-auto-merge is required",
    };
  }
  return out;
}

export function applyUpdate(existing: PipelineState, args: Args): PipelineState {
  return {
    ...existing,
    phase: args.phase ?? existing.phase,
    pr: args.pr ?? existing.pr,
    worktree: args.worktree ?? existing.worktree,
    autoMerge: args.autoMerge ?? existing.autoMerge,
    updatedAt: nowIso(),
  };
}

export function runUpdate(argv: string[], dir = FLOW_STATE_DIR): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-state-update: ${parsed.error}`);
    console.error(
      "usage: flow-state-update <slug> [--phase <phase>] [--pr <number>] [--worktree <path>]\n" +
        "                              [--auto-merge | --no-auto-merge]",
    );
    return 2;
  }
  const existing = readState(parsed.slug, dir);
  if (!existing) {
    console.error(
      `flow-state-update: no state file for slug '${parsed.slug}'.\n` +
        "  did you forget to run `flow new`? state files live at ~/.flow/state/<slug>.json.",
    );
    return 1;
  }

  // The branch guard is the supervisor's mechanical defense against the
  // 2026-05-01 worktree-contamination failure mode: a peer pipeline renames
  // this worktree's branch and the next phase transition lands commits on the
  // wrong ref. Refuse to write state — supervisor escalates branch-mismatch.
  const guard = checkWorktreeBranch(existing.worktree);
  if (guard.kind === "mismatch") {
    console.error(
      `flow-state-update: branch-mismatch in worktree '${existing.worktree}'\n` +
        `  expected (${BRANCH_MARKER_FILENAME}): ${guard.expected}\n` +
        `  actual (git branch --show-current): ${guard.actual}\n` +
        `  Refusing to update state. The supervisor should escalate ` +
        `'NEEDS HUMAN: branch-mismatch' rather than continue.`,
    );
    return 3;
  }

  const next = applyUpdate(existing, parsed);
  writeState(next, dir);
  return 0;
}

if (import.meta.main) {
  process.exit(runUpdate(process.argv.slice(2)));
}
