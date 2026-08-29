#!/usr/bin/env bun
/**
 * Claude Code UserPromptSubmit hook for the /flow-pipeline (and /flow-epic-create)
 * supervisor.
 *
 * When a prompt is submitted inside a flow session — slug resolved env-first
 * from `FLOW_SLUG`, falling back to the tmux pane's `@flow-slug` user option,
 * exactly like flow-stop-guard — this
 * stamps `seedIngestedAt` onto `~/.flow/state/<slug>.json` the instant the
 * seed prompt is accepted. That marker is the launch-time confirmation the
 * launcher's `consumed()` predicate wants: success can latch the moment the
 * seed is ingested rather than waiting for the supervisor's first phase write.
 *
 * Integrity check: when `state.seed` is recorded (every tmux launch/resume
 * path records it before delivery — see `bin/lib/feature.ts` /
 * `bin/lib/epic.ts` / `bin/flow-session-start-hook.ts`), this hook compares
 * the submitted prompt against it (whitespace-squashed CONTAINMENT, never
 * equality — a supervisor preamble or trailing note is expected). On a match
 * it stamps `seedIngestedAt` as before. On a mismatch it records
 * `seedMismatch` instead and does NOT stamp `seedIngestedAt`, so a corrupted
 * delivery never latches as "consumed". This hook RECORDS and always exits 0
 * — it never blocks the prompt (exit 2) even on a detected mismatch;
 * `bin/lib/tmux.ts`'s `seedCorrupted()` predicate is what turns a recorded
 * mismatch into a launch failure, on the NEXT retry attempt, not this turn.
 *
 * Self-detection: exits 0 cleanly when no flow slug resolves (no `FLOW_SLUG`,
 * and no pane carrying `@flow-slug` — a normal coding session), or when
 * state.json is missing — making it safe to register in a flow-scoped settings file passed
 * to `claude --settings`. It writes ONLY the per-pipeline state file under
 * `~/.flow/state/`, never the user's global Claude Code settings; the marker is
 * idempotent (re-stamping a state that already carries it is a no-op, so it
 * never churns the file or the supervisor's own `updatedAt`).
 */

import { spawnSync } from "node:child_process";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { squash } from "./lib/seed-delivery";
import {
  nowIso as defaultNowIso,
  readState,
  writeState,
  type PipelineState,
} from "./lib/state";

export type Deps = {
  /** FLOW_SLUG env value (env-first ambient slug; both launcher backends set it). */
  flowSlugEnv?: string | undefined;
  tmuxPane: string | undefined;
  showFlowSlug: (pane: string) => string;
  loadState: (slug: string) => PipelineState | null;
  saveState: (state: PipelineState) => void;
  nowIso: () => string;
  /** UserPromptSubmit payload JSON on stdin. Drained lazily — see `run`. */
  readStdin: () => Promise<string>;
};

/** Delegates to seed-delivery's exported `squash` so the two can't drift. */
export function squashPrompt(s: string): string {
  return squash(s);
}

/** Containment, never equality — a supervisor preamble/trailing note is expected. */
export function seedIntact(expected: string, submitted: string): boolean {
  return squashPrompt(submitted).includes(squashPrompt(expected));
}

export async function run(deps: Deps): Promise<number> {
  // Env-first slug resolution: FLOW_SLUG (shape-validated) wins; the tmux
  // pane option is the fallback for tmux-launched sessions.
  let slug =
    resolveSlugFromEnv({ FLOW_SLUG: deps.flowSlugEnv } as NodeJS.ProcessEnv) ??
    "";
  if (slug.length === 0) {
    const pane = deps.tmuxPane;
    if (pane) slug = deps.showFlowSlug(pane).trim();
  }
  if (slug.length === 0) return 0;

  const state = deps.loadState(slug);
  if (!state) return 0;

  // Idempotent: the first submit stamps the marker; subsequent prompts in the
  // same session are a no-op (the launch-time ingestion signal is already set).
  if (state.seedIngestedAt) return 0;

  // No recorded seed (old-format state, or a launch path that predates this
  // field) — behave exactly as today: stamp unconditionally, no comparison.
  if (state.seed == null) {
    deps.saveState({ ...state, seedIngestedAt: deps.nowIso() });
    return 0;
  }

  // Drain stdin LAZILY — only once a comparison is actually needed. This hook
  // fires on every prompt in a flow session; draining unconditionally would
  // add latency to every supervisor turn for the (common) already-ingested
  // and no-seed early-exits above.
  let raw = "";
  try {
    raw = await deps.readStdin();
  } catch {
    // A stdin read hiccup must never block the prompt; behave as today.
  }

  let prompt: string | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "prompt" in parsed) {
      const p = (parsed as { prompt?: unknown }).prompt;
      if (typeof p === "string") prompt = p;
    }
  } catch {
    // Malformed/empty stdin: behave as today (no comparison possible).
  }

  // Unreadable/malformed stdin, or a payload with no `prompt` — behave
  // exactly as today: stamp unconditionally, no comparison.
  if (prompt === undefined) {
    deps.saveState({ ...state, seedIngestedAt: deps.nowIso() });
    return 0;
  }

  if (seedIntact(state.seed, prompt)) {
    // Clear any earlier seedMismatch: launchWithRetry reuses this closure
    // across attempts (the two fresh-create sites), and a resume retry can
    // also self-heal across a dead-pane attempt 1 followed by an intact
    // attempt 2 — a corrupted attempt 1 followed by an intact attempt 2 must
    // not leave the stale mismatch latched, otherwise seedCorrupted() keeps
    // reporting `failed` even though delivery ultimately succeeded.
    deps.saveState({
      ...state,
      seedIngestedAt: deps.nowIso(),
      seedMismatch: undefined,
    });
  } else if (state.seedMismatch == null) {
    // Launch-window scoped, moved into this branch (not a top-of-function
    // early return): a mismatch already recorded for THIS launch is left
    // alone rather than re-recorded against a later, unrelated prompt — but
    // the comparison itself still runs every time, so an intact retry after
    // a recorded mismatch reaches the branch above and clears it. The two
    // fresh-create sites rewrite base state INSIDE launchWithRetry's loop;
    // the two resume sites clear seed*/seedMismatch exactly once, BEFORE the
    // loop — a top-of-function gate would strand a resume retry that
    // delivered intact after a dead-pane attempt 1 (the dead-pane branch in
    // tmux.ts's createWindowVerified precedes the seedCorrupted() check, so
    // the fail-fast doesn't short-circuit that attempt).
    deps.saveState({
      ...state,
      seedMismatch: {
        at: deps.nowIso(),
        expectedBytes: Buffer.byteLength(state.seed, "utf8"),
        submittedBytes: Buffer.byteLength(prompt, "utf8"),
      },
    });
  }
  return 0;
}

export function defaultShowFlowSlug(pane: string): string {
  const r = spawnSync(
    "tmux",
    ["show-options", "-w", "-t", pane, "-q", "-v", "@flow-slug"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return "";
  return r.stdout ?? "";
}

// Copied from bin/flow-session-start-hook.ts (bin/flow-stop-guard.ts carries
// the second copy) — a third small, self-contained copy is acceptable rather
// than introducing a shared module for a ~15-line timeout-guarded stdin drain.
async function defaultReadStdin(): Promise<string> {
  // Bun.stdin reads to EOF; on a TTY (no piped input) this can hang, so the
  // helper bails after a short wait. Claude Code always pipes JSON when
  // invoking a UserPromptSubmit hook, so the hang case is only hit when a
  // developer runs the helper by hand.
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    process.stdin.on("data", (c) => chunks.push(c as Uint8Array));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 250);
  });
}

if (import.meta.main) {
  run({
    flowSlugEnv: process.env.FLOW_SLUG,
    tmuxPane: process.env.TMUX_PANE,
    showFlowSlug: defaultShowFlowSlug,
    loadState: (slug) => readState(slug),
    saveState: (state) => writeState(state),
    nowIso: defaultNowIso,
    readStdin: defaultReadStdin,
  }).then((code) => process.exit(code));
}
