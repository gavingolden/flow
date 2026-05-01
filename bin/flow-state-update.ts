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
 *
 * - At least one update flag is required.
 * - The slug must already have a state file (created by `flow new`).
 *   Refuses to invent state out of nowhere — that surfaces drift
 *   instead of papering over it.
 * - `updatedAt` is rewritten to the current ISO-8601 UTC timestamp on
 *   every call.
 */

import { readState, writeState, nowIso, type PipelineState } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";

type Args = {
  slug: string;
  phase?: string;
  pr?: number;
  worktree?: string;
};

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
  if (out.phase === undefined && out.pr === undefined && out.worktree === undefined) {
    return { error: "at least one of --phase, --pr, --worktree is required" };
  }
  return out;
}

export function applyUpdate(existing: PipelineState, args: Args): PipelineState {
  return {
    ...existing,
    phase: args.phase ?? existing.phase,
    pr: args.pr ?? existing.pr,
    worktree: args.worktree ?? existing.worktree,
    updatedAt: nowIso(),
  };
}

export function runUpdate(argv: string[], dir = FLOW_STATE_DIR): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-state-update: ${parsed.error}`);
    console.error(
      "usage: flow-state-update <slug> [--phase <phase>] [--pr <number>] [--worktree <path>]",
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
  const next = applyUpdate(existing, parsed);
  writeState(next, dir);
  return 0;
}

if (import.meta.main) {
  process.exit(runUpdate(process.argv.slice(2)));
}
