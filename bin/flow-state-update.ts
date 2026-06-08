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
 *   flow-state-update [<slug>] [--phase <phase>] [--pr <number>] [--worktree <path>]
 *                              [--auto-merge | --no-auto-merge] [--session-id <value>]
 *
 * - At least one update flag is required.
 * - The slug is optional when invoked from inside a flow tmux pane: it
 *   auto-resolves from `$TMUX_PANE`'s `@flow-slug` window option. The
 *   supervisor's per-call shell loses any `SLUG=…` it sets between
 *   Bash tool calls, so the auto-resolve path is the load-bearing one;
 *   the explicit positional stays for back-compat and for callers
 *   outside tmux.
 * - The slug must already have a state file (created by `flow new`).
 *   Refuses to invent state out of nowhere — that surfaces drift
 *   instead of papering over it.
 * - `updatedAt` is rewritten to the current ISO-8601 UTC timestamp on
 *   every call.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  PIPELINE_PHASES,
  PIPELINE_PHASE_SET,
  readState,
  writeState,
  nowIso,
  type PipelineState,
} from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { resolveSlugFromPane } from "./lib/tmux";
import { BRANCH_MARKER_FILENAME } from "./lib/worktree-marker";

type Args = {
  /** undefined when omitted — runUpdate falls back to resolveSlugFromPane(). */
  slug?: string;
  phase?: string;
  pr?: number;
  worktree?: string;
  autoMerge?: boolean;
  sessionId?: string;
};

/**
 * Result of the worktree-branch guard:
 *   - "ok"      — guard passed (or skipped: no worktree path, dir missing, marker missing).
 *   - "mismatch" — worktree on a different branch than the marker says. State.json is
 *                  NOT updated; supervisor escalates `NEEDS HUMAN: branch-mismatch`.
 */
type GuardResult =
  | { kind: "ok" }
  | { kind: "mismatch"; expected: string; actual: string };

/**
 * Asserts that the worktree's current branch matches the marker file written by
 * `flow-new-worktree`. Best-effort: if the worktree directory is gone or the
 * marker file is missing (e.g. created by an older flow-new-worktree), logs a
 * one-line warning and returns ok. Only an *active* mismatch returns mismatch.
 */
export function checkWorktreeBranch(
  worktreePath: string | undefined,
): GuardResult {
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
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "branch", "--show-current"],
    {
      encoding: "utf8",
    },
  );
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
  // Slug is optional when present-but-leading-with-`--`: the supervisor
  // calls `flow-state-update --phase <p>` from inside its own pane and
  // expects auto-resolution. Treat a leading `--` arg as "no slug given"
  // rather than an error.
  let rest: string[];
  const out: Args = {};
  if (argv.length > 0 && !argv[0].startsWith("--")) {
    out.slug = argv[0];
    rest = argv.slice(1);
  } else {
    rest = argv;
  }
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
        if (!PIPELINE_PHASE_SET.has(value)) {
          return { error: phaseError(value) };
        }
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
      case "--session-id":
        out.sessionId = value;
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
    out.autoMerge === undefined &&
    out.sessionId === undefined
  ) {
    return {
      error:
        "at least one of --phase, --pr, --worktree, --auto-merge, --no-auto-merge, --session-id is required",
    };
  }
  return out;
}

export function applyUpdate(
  existing: PipelineState,
  args: Args,
): PipelineState {
  return {
    ...existing,
    phase: args.phase ?? existing.phase,
    pr: args.pr ?? existing.pr,
    worktree: args.worktree ?? existing.worktree,
    autoMerge: args.autoMerge ?? existing.autoMerge,
    sessionId: args.sessionId ?? existing.sessionId,
    updatedAt: nowIso(),
  };
}

export type RunUpdateDeps = {
  /**
   * Slug fallback when the positional arg is omitted. Defaults to
   * `resolveSlugFromPane()` against the real tmux. Tests inject a
   * stub.
   */
  resolveSlug?: () => string | null;
};

export function runUpdate(
  argv: string[],
  dir = FLOW_STATE_DIR,
  deps: RunUpdateDeps = {},
): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-state-update: ${parsed.error}`);
    console.error(
      "usage: flow-state-update [<slug>] [--phase <phase>] [--pr <number>] [--worktree <path>]\n" +
        "                                 [--auto-merge | --no-auto-merge] [--session-id <value>]",
    );
    return 2;
  }
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugFromPane());
  const slug = parsed.slug ?? resolveSlug();
  if (!slug) {
    console.error(
      "flow-state-update: no slug given and could not resolve from $TMUX_PANE's @flow-slug option.\n" +
        "  pass <slug> explicitly, or run inside a tmux window created by `flow new`.",
    );
    return 2;
  }
  const existing = readState(slug, dir);
  if (!existing) {
    console.error(
      `flow-state-update: no state file for slug '${slug}'.\n` +
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

/**
 * Builds an error message for an invalid `--phase` value. Suggests the
 * closest canonical phase by Levenshtein distance ≤ 2 — typos like
 * `implmenting` map back to `implementing`. Falls back to listing the
 * full canonical set when no near-match exists.
 */
export function phaseError(value: string): string {
  const suggestion = closestPhase(value);
  const head = `--phase '${value}' is not a valid pipeline phase`;
  if (suggestion) return `${head}; did you mean '${suggestion}'?`;
  return `${head}; valid phases: ${PIPELINE_PHASES.join(", ")}`;
}

export function closestPhase(value: string): string | null {
  let best: { phase: string; distance: number } | null = null;
  for (const p of PIPELINE_PHASES) {
    const d = levenshtein(value, p);
    if (d > 2) continue;
    if (!best || d < best.distance) best = { phase: p, distance: d };
  }
  return best?.phase ?? null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

if (import.meta.main) {
  process.exit(runUpdate(process.argv.slice(2)));
}
