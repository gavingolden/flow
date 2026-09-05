#!/usr/bin/env bun
/**
 * Merge-update a pipeline state file at ~/.flow/state/<slug>.json.
 *
 * The supervisor skill (PR 2) calls this once per phase transition so
 * `flow ls` sees fresh phase / pr / worktree fields. PR 1 wrote the
 * initial state via `flow feature create` and pinned the schema; this binary is
 * the writer the supervisor uses to keep it current.
 *
 * Usage:
 *   flow-state-update [<slug>] [--phase <phase>] [--phase-outcome <text>] [--pr <number>]
 *                              [--worktree <path>] [--auto-merge | --no-auto-merge]
 *                              [--session-id <value>] [--answer <text> | --answer-stdin]
 *                              [--interview-stdin]
 *                              [--slug <slug>] [--force]
 *
 * `--phase-outcome <text>` records a short outcome string on the phaseLog
 * entry appended by the same `--phase` write (no-op without `--phase`).
 *
 * `--answer <text>` persists a short/controlled answer string through argv;
 * `--answer-stdin` reads the entire answer from stdin instead, so free-form
 * markdown (containing `$`, backticks, `$(...)`, or a leading `--`) survives
 * verbatim — immune to shell expansion and to argv parsing of a leading `--`.
 * This is the `--body` / `--body-file` split: the two answer flags are
 * mutually exclusive.
 *
 * `--interview-stdin` mirrors `--answer-stdin` byte-for-byte, persisting the
 * intent interview digest through `state.interview` instead of `state.answer`.
 *
 * - At least one update flag is required.
 * - The slug is optional when a pipeline is live: it auto-resolves from
 *   `$FLOW_SLUG`. The supervisor's per-call shell loses any `SLUG=…` it
 *   sets between Bash tool calls, so the auto-resolve path is the
 *   load-bearing one; the explicit positional stays for callers with no
 *   live pipeline.
 * - The slug must already have a state file (created by `flow feature create`).
 *   Refuses to invent state out of nowhere — that surfaces drift
 *   instead of papering over it.
 * - `updatedAt` is rewritten to the current ISO-8601 UTC timestamp on
 *   every call.
 * - `gated` has a named exit allowlist (TERMINAL_EXIT_TRANSITIONS in
 *   `lib/state.ts`); every other terminal→non-terminal write still needs
 *   --force.
 */

import * as fs from "node:fs";
import {
  PIPELINE_PHASES,
  PIPELINE_PHASE_SET,
  TERMINAL_PHASE_SET,
  TERMINAL_EXIT_TRANSITIONS,
  isAllowedTerminalExit,
  readState,
  writeState,
  nowIso,
  appendPhaseLog,
  type PipelineState,
} from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { writePhaseState } from "./lib/phase-write";
import { resolveSlugAmbient } from "./lib/session-identity";
import {
  BRANCH_MARKER_FILENAME,
  checkWorktreeBranch,
} from "./lib/worktree-marker";

type Args = {
  /** undefined when omitted — runUpdate falls back to resolveSlugAmbient(). */
  slug?: string;
  phase?: string;
  pr?: number;
  worktree?: string;
  autoMerge?: boolean;
  sessionId?: string;
  answer?: string;
  /** true when `--answer-stdin` was passed; runUpdate reads the answer from stdin. */
  answerStdin?: boolean;
  interview?: string;
  /** true when `--interview-stdin` was passed; runUpdate reads the interview digest from stdin. */
  interviewStdin?: boolean;
  phaseOutcome?: string;
  /** When true, bypass the terminal-phase regression guard. */
  force?: boolean;
};

/**
 * Back-compat re-export: `checkWorktreeBranch` lives in
 * `bin/lib/worktree-marker.ts` now, so `bin/lib/phase-advance.ts` can call
 * it too — a `bin/lib/` module cannot import from a `bin/*.ts` module.
 */
export { checkWorktreeBranch };

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
    if (flag === "--answer-stdin") {
      out.answerStdin = true;
      continue;
    }
    if (flag === "--interview-stdin") {
      out.interviewStdin = true;
      continue;
    }
    if (flag === "--force") {
      out.force = true;
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
      case "--answer":
        out.answer = value;
        break;
      case "--phase-outcome":
        out.phaseOutcome = value;
        break;
      case "--slug":
        if (out.slug !== undefined) {
          return { error: "cannot combine positional <slug> with --slug" };
        }
        out.slug = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (out.answer !== undefined && out.answerStdin) {
    return { error: "cannot combine --answer and --answer-stdin" };
  }
  if (out.answerStdin && out.interviewStdin) {
    return { error: "cannot combine --answer-stdin and --interview-stdin" };
  }
  if (
    out.phase === undefined &&
    out.pr === undefined &&
    out.worktree === undefined &&
    out.autoMerge === undefined &&
    out.sessionId === undefined &&
    out.answer === undefined &&
    !out.answerStdin &&
    !out.interviewStdin
  ) {
    return {
      error:
        "at least one of --phase, --pr, --worktree, --auto-merge, --no-auto-merge, --session-id, --answer, --answer-stdin, --interview-stdin is required",
    };
  }
  return out;
}

export function applyUpdate(
  existing: PipelineState,
  args: Args,
): PipelineState {
  // A --phase write is a real transition event: append it to the
  // append-only phaseLog (creating the array when absent) so the snapshot
  // has an authoritative trace. A no---phase update (e.g. --pr only) leaves
  // phaseLog untouched. appendPhaseLog omits the outcome key entirely when
  // --phase-outcome is absent — never write `outcome: undefined`. Shared
  // with `bin/lib/phase-advance.ts`'s `advancePhase` so the two write paths
  // cannot drift on phaseLog[] shape.
  const phaseLog =
    args.phase !== undefined
      ? appendPhaseLog(existing, args.phase, args.phaseOutcome)
      : existing.phaseLog;
  const resolvedPhase = args.phase ?? existing.phase;
  // A stale reap record (recorded at a PRIOR terminal state) must not
  // survive a write that moves the pipeline back to a non-terminal phase
  // (e.g. a resume) — `flow-gate-summary --cleanup` would otherwise render
  // an old verdict for a run the reap never covered. A terminal phase write
  // (including a --pr-only write while already terminal) preserves it.
  const reap = TERMINAL_PHASE_SET.has(resolvedPhase)
    ? existing.reap
    : undefined;
  return {
    ...existing,
    phase: resolvedPhase,
    pr: args.pr ?? existing.pr,
    worktree: args.worktree ?? existing.worktree,
    autoMerge: args.autoMerge ?? existing.autoMerge,
    sessionId: args.sessionId ?? existing.sessionId,
    answer: args.answer ?? existing.answer,
    interview: args.interview ?? existing.interview,
    phaseLog,
    reap,
    updatedAt: nowIso(),
  };
}

export type RunUpdateDeps = {
  /**
   * Slug fallback when the positional arg is omitted. Defaults to
   * `resolveSlugAmbient()` against the ambient $FLOW_SLUG. Tests inject a
   * stub.
   */
  resolveSlug?: () => string | null;
  /**
   * Publishes the new phase onto the window's `@flow-phase` option, threaded
   * through to `writePhaseState`'s funnel. Defaults to the funnel's own
   * inline default publisher. Best-effort — the result is ignored and never
   * alters the exit code. Tests inject a stub to assert it fires on
   * `--phase` updates only.
   */
  publishPhase?: (slug: string, phase: string) => void;
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
      "usage: flow-state-update [<slug>] [--phase <phase>] [--phase-outcome <text>] [--pr <number>]\n" +
        "                                 [--worktree <path>] [--auto-merge | --no-auto-merge]\n" +
        "                                 [--session-id <value>] [--answer <text> | --answer-stdin]\n" +
        "                                 [--interview-stdin]\n" +
        "                                 [--slug <slug>] [--force]",
    );
    return 2;
  }

  // Read the free-form answer from stdin only when --answer-stdin is present, so
  // a value that would be mangled through argv (shell `$`/backtick/`$(...)`
  // expansion, a leading `--`) round-trips verbatim. Guarded so we never block
  // on stdin when the flag is absent. Strip exactly one trailing newline (a
  // quoted heredoc appends one); preserve all other whitespace.
  if (parsed.answerStdin) {
    const raw = fs.readFileSync(0, "utf8");
    parsed.answer = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  }
  // Mirrors the --answer-stdin byte-verbatim read above, persisting the
  // interview digest into state.interview instead of state.answer.
  if (parsed.interviewStdin) {
    const raw = fs.readFileSync(0, "utf8");
    parsed.interview = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  }
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugAmbient());
  const slug = parsed.slug ?? resolveSlug();
  if (!slug) {
    console.error(
      "flow-state-update: no slug given and no FLOW_SLUG in the environment.\n" +
        "  pass <slug> explicitly, or run inside a pipeline launched by `flow feature create`.",
    );
    return 2;
  }
  const existing = readState(slug, dir);
  if (!existing) {
    console.error(
      `flow-state-update: no state file for slug '${slug}'.\n` +
        "  did you forget to run `flow feature create`? state files live at ~/.flow/state/<slug>.json.",
    );
    return 1;
  }

  // Terminal-phase regression guard: refuse to move an already-terminal
  // pipeline back to a non-terminal phase unless --force is passed. A
  // terminal→non-terminal write is almost always an ambient-pane race that
  // resolved the slug to the wrong pipeline. Exit 4 (distinct from exit 3
  // used by branch-mismatch) so the supervisor can escalate differently.
  // `gated` carries a named exit allowlist (TERMINAL_EXIT_TRANSITIONS) for
  // its three legitimate exits (re-verify, re-gate, override-merge);
  // --force remains the escape hatch for every other terminal phase. Once
  // an allowlisted exit is accepted, `existing.phase` is no longer terminal,
  // so this guard no longer applies to the rest of that state file's
  // lifecycle — see the TERMINAL_EXIT_TRANSITIONS docblock in
  // bin/lib/state.ts for the race this implies.
  if (
    parsed.phase !== undefined &&
    !parsed.force &&
    TERMINAL_PHASE_SET.has(existing.phase) &&
    !TERMINAL_PHASE_SET.has(parsed.phase) &&
    !isAllowedTerminalExit(existing.phase, parsed.phase)
  ) {
    const allowedExits = TERMINAL_EXIT_TRANSITIONS[existing.phase];
    const allowedExitsText =
      allowedExits && allowedExits.length > 0
        ? allowedExits.join(", ")
        : "none";
    console.error(
      `flow-state-update: refusing to regress terminal phase '${existing.phase}' → '${parsed.phase}' for slug '${slug}'. If intentional, delete the state file first or use --force. Allowed exits from '${existing.phase}': ${allowedExitsText}`,
    );
    return 4;
  }
  if (
    parsed.phase !== undefined &&
    !parsed.force &&
    TERMINAL_PHASE_SET.has(existing.phase) &&
    !TERMINAL_PHASE_SET.has(parsed.phase)
  ) {
    console.error(
      `flow-state-update: accepting allowlisted terminal exit '${existing.phase}' → '${parsed.phase}' for slug '${slug}'; the terminal-regression guard no longer applies to this state file.`,
    );
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

  // Route through the shared writePhaseState funnel only on a --phase
  // transition (never a --pr-only update) — the funnel writes state first,
  // then best-effort mirrors the phase onto the window's @flow-phase option
  // so a user's status bar can read it. The result is ignored: state.json is
  // the source of truth and a tmux hiccup must not change the exit code.
  if (parsed.phase !== undefined) {
    writePhaseState(next, dir, deps.publishPhase);
  } else {
    writeState(next, dir);
  }
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
