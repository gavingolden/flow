#!/usr/bin/env bun
/**
 * Claude Code UserPromptSubmit hook for the /flow-pipeline (and /flow-epic-create)
 * supervisor.
 *
 * When a prompt is submitted inside a flow session — slug resolved env-first
 * from `FLOW_SLUG`, falling back to the tmux pane's `@flow-slug` user option,
 * exactly like flow-stop-guard — this records a self-describing
 * `seedIngest` record on `~/.flow/state/<slug>.json` describing what the hook
 * could actually establish about the delivery. That record is the launch-time
 * signal the launcher's `consumed()` predicate wants: success can latch the
 * moment the seed is verified rather than waiting for the supervisor's first
 * phase write — but ONLY on `verified`, never on an outcome that merely means
 * "a prompt happened".
 *
 * Five outcomes (see `bin/lib/seed-ingest.ts` for the type and the
 * monotone-latch rule):
 *
 * - `not-applicable` — no seed recorded (or a blank one) for this launch.
 * - `unverified` — a prompt arrived but the hook could not compare it: stdin
 *   timed out or errored, the payload did not parse, or it carried no
 *   `prompt` field. Deliberately NOT a pass; the CLI prints a loud warning.
 * - `corrupt` — the prompt carried the seed's leading-line DELIVERY MARKER but
 *   not the seed intact: a truncated/garbled delivery.
 * - `verified` — the prompt contained the recorded seed intact.
 * - ABSENT — not yet ingested.
 *
 * The delivery-marker discriminator is what separates a truncated delivery
 * from a user-typed prompt: a prompt that does not even carry the seed's
 * leading line is FOREIGN (the human typed it), not corruption, so the hook
 * writes NOTHING at all rather than recording a false `corrupt` — which also
 * stops later unrelated chatter from rewriting a standing record.
 *
 * This hook RECORDS and always exits 0 — it never blocks the prompt (exit 2)
 * even on a detected corruption; `bin/lib/tmux.ts`'s `seedCorrupted()`
 * predicate is what turns a recorded `corrupt` into a launch failure, on the
 * NEXT retry attempt, not this turn.
 *
 * Self-detection: exits 0 cleanly when no flow slug resolves (no `FLOW_SLUG`,
 * and no pane carrying `@flow-slug` — a normal coding session), or when
 * state.json is missing — making it safe to register in a flow-scoped settings file passed
 * to `claude --settings`. It writes ONLY the per-pipeline state file under
 * `~/.flow/state/`, never the user's global Claude Code settings; the two
 * terminal outcomes (`verified`, `not-applicable`) short-circuit before the
 * stdin drain, so a steady-state supervisor turn costs nothing and never
 * churns the file or the supervisor's own `updatedAt`.
 */

import { spawnSync } from "node:child_process";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { splitSeed, squash } from "./lib/seed-delivery";
import { type SeedIngest } from "./lib/seed-ingest";
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
  /**
   * UserPromptSubmit payload JSON on stdin. Drained lazily — see `run`.
   * `complete` distinguishes a fully-read payload from one cut short by the
   * timeout/error backstop: a truncated READ must never be mistaken for a
   * truncated DELIVERY.
   */
  readStdin: () => Promise<{ text: string; complete: boolean }>;
};

/** Delegates to seed-delivery's exported `squash` so the two can't drift. */
export function squashPrompt(s: string): string {
  return squash(s);
}

/**
 * Containment, never equality — a supervisor preamble/trailing note is
 * expected. An EMPTY expectation can never match: `"".includes("")` is
 * vacuously true, which would pass every prompt as intact.
 */
export function seedIntact(expected: string, submitted: string): boolean {
  if (squashPrompt(expected).length === 0) return false;
  return squashPrompt(submitted).includes(squashPrompt(expected));
}

/**
 * Did this prompt come from flow's own seed delivery at all? Reuses
 * `seed-delivery`'s `splitSeed` so the hook and the delivery path cannot
 * disagree about what the leading line is — the leading line is exactly what
 * `deliverSeed` types alone and capture-verifies first, so its presence is
 * the strongest available evidence the prompt IS the delivery.
 */
export function deliveryMarkerPresent(
  seed: string,
  submitted: string,
): boolean {
  return seedIntact(splitSeed(seed).leadingLine, submitted);
}

/**
 * Backstop for the stdin drain. Deliberately looser than the 250 ms used by
 * `flow-session-start-hook`/`flow-stop-guard`: those block session start on
 * every `/clear` machine-wide, whereas this hook's cost is bounded to the
 * ONE prompt per session that has not yet reached a terminal outcome.
 */
export const STDIN_TIMEOUT_MS = 2000;

/**
 * Re-read immediately before every write: the drain above can take up to
 * STDIN_TIMEOUT_MS, which widens the read-modify-write window against a
 * concurrently-writing supervisor.
 *
 * `neverOverCorrupt` implements the monotone latch — `corrupt` may only be
 * replaced by `verified`, so later chatter can never downgrade a recorded
 * corruption, while PR #686's clear-on-intact-retry stays reachable.
 */
function record(
  deps: Deps,
  slug: string,
  seedIngest: SeedIngest,
  neverOverCorrupt: boolean,
): void {
  const fresh = deps.loadState(slug);
  if (!fresh) return;
  if (neverOverCorrupt && fresh.seedIngest?.outcome === "corrupt") return;
  deps.saveState({ ...fresh, seedIngest });
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

  // Terminal outcomes short-circuit BEFORE the drain, so a steady-state
  // supervisor turn pays nothing. `unverified` and `corrupt` deliberately do
  // NOT short-circuit — both are still upgradable to `verified`.
  const standing = state.seedIngest?.outcome;
  if (standing === "verified" || standing === "not-applicable") return 0;

  // No recorded seed (old-format state, the plain backend, or a launch path
  // that predates the field) — there is nothing to verify. Recording this
  // explicitly is what closes the vacuous-pass door: an empty expectation
  // must never read as a successful comparison.
  const seed = state.seed;
  if (!seed?.trim()) {
    record(
      deps,
      slug,
      {
        at: deps.nowIso(),
        outcome: "not-applicable",
        reason: "no-seed-recorded",
      },
      true,
    );
    return 0;
  }

  // Drain stdin LAZILY — only once a comparison is actually needed. This hook
  // fires on every prompt in a flow session; draining unconditionally would
  // add latency to every supervisor turn for the (common) terminal-outcome
  // and no-seed early-exits above.
  let raw = "";
  let complete = false;
  try {
    ({ text: raw, complete } = await deps.readStdin());
  } catch {
    record(
      deps,
      slug,
      { at: deps.nowIso(), outcome: "unverified", reason: "stdin-error" },
      true,
    );
    return 0;
  }
  if (!complete) {
    record(
      deps,
      slug,
      { at: deps.nowIso(), outcome: "unverified", reason: "stdin-timeout" },
      true,
    );
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    record(
      deps,
      slug,
      {
        at: deps.nowIso(),
        outcome: "unverified",
        reason: "payload-unparsable",
      },
      true,
    );
    return 0;
  }

  let prompt: string | undefined;
  if (parsed !== null && typeof parsed === "object" && "prompt" in parsed) {
    const p = (parsed as { prompt?: unknown }).prompt;
    if (typeof p === "string") prompt = p;
  }
  if (prompt === undefined) {
    record(
      deps,
      slug,
      { at: deps.nowIso(), outcome: "unverified", reason: "no-prompt-field" },
      true,
    );
    return 0;
  }

  // FOREIGN PROMPT — write nothing. A prompt carrying none of the seed's
  // leading line was typed by the human, not delivered by flow: recording it
  // as `corrupt` would fail a healthy launch, and recording anything at all
  // would let later unrelated chatter rewrite a standing record.
  if (!deliveryMarkerPresent(seed, prompt)) return 0;

  if (seedIntact(seed, prompt)) {
    // MAY replace a standing `corrupt`: launchWithRetry reuses this closure
    // across attempts, so a corrupted attempt 1 followed by an intact attempt
    // 2 must not stay latched as failed.
    record(deps, slug, { at: deps.nowIso(), outcome: "verified" }, false);
  } else {
    record(
      deps,
      slug,
      {
        at: deps.nowIso(),
        outcome: "corrupt",
        expectedBytes: Buffer.byteLength(seed, "utf8"),
        submittedBytes: Buffer.byteLength(prompt, "utf8"),
      },
      true,
    );
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

// Deliberately NOT shared with bin/flow-session-start-hook.ts /
// bin/flow-stop-guard.ts: those two block session start on every `/clear`
// machine-wide and keep a 250 ms ceiling, while this copy needs both the
// longer STDIN_TIMEOUT_MS backstop and the `complete` flag. Exported so the
// early-resolve and backstop branches are directly specifiable.
export async function defaultReadStdin(): Promise<{
  text: string;
  complete: boolean;
}> {
  // Bun.stdin reads to EOF; on a TTY (no piped input) this can hang, so the
  // helper bails after STDIN_TIMEOUT_MS and reports `complete: false` so the
  // caller records `unverified` rather than comparing a truncated read.
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ text: Buffer.concat(chunks).toString("utf8"), complete });
    };
    process.stdin.on("data", (c) => {
      chunks.push(c as Uint8Array);
      // Claude Code pipes exactly one JSON object, so the first chunk
      // boundary at which the accumulated buffer parses IS the end of the
      // payload — resolve there rather than waiting for `end`.
      try {
        JSON.parse(Buffer.concat(chunks).toString("utf8"));
        finish(true);
      } catch {
        // Partial payload — keep draining.
      }
    });
    process.stdin.on("end", () => finish(true));
    process.stdin.on("error", () => finish(false));
    timer = setTimeout(() => finish(false), STDIN_TIMEOUT_MS);
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
