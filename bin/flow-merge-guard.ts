#!/usr/bin/env bun
/**
 * Mechanical merge-path guard for `/flow-pipeline` step 10.
 *
 * Why: the auto-merge gate (`flow-gate-decide`, step 9) computes a verdict,
 * but step 9 and step 10 are separate steps and a `gated` verdict is only
 * enforced by prose the supervisor can rationalize past. In the incident
 * this helper exists to prevent, a supervisor reclassified unchecked
 * functional Test Steps as "subjective UX", cited a stale "merge"
 * instruction given many turns earlier for an unrelated purpose, and ran
 * `gh pr merge` on a correctly-`gated` PR whose feature was in fact broken.
 * This guard re-derives the verdict from a FRESH `gh pr view` at the merge
 * moment and makes the merge path mechanically unreachable when unchecked
 * items remain without a fresh, recorded gate-override confirmation.
 *
 * It deliberately does NOT classify checkbox text as functional vs
 * subjective — that judgment stays with the supervisor in prose (see
 * `skills/pipeline/pr-review/references/manual-test-rubric.md`). The guard
 * blocks on ANY unchecked item; over-blocking is the safe default.
 *
 * Two modes:
 *
 *   flow-merge-guard <PR> [--slug <slug>]
 *       Check mode (default). Fetches the live PR body, re-parses the
 *       `## Test Steps` section, and emits a JSON verdict on stdout.
 *         decision "clear"   (exit 0) — zero unchecked items, OR unchecked
 *                                       items present but cleared by a
 *                                       fresh recorded gate-override token.
 *         decision "blocked" (exit 1) — unchecked items (or a missing
 *                                       heading) and no fresh override
 *                                       token. The supervisor must escalate
 *                                       NEEDS HUMAN, never merge.
 *         decision "error"   (exit 2) — bad args / gh failure / no slug.
 *
 *   flow-merge-guard <PR> --record-override [--slug <slug>]
 *       Record mode. Writes a `gateOverride: { pr, confirmedAt }` token to
 *       `~/.flow/state/<slug>.json`. The supervisor calls this ONLY after a
 *       fresh, in-context `AskUserQuestion` confirmation obtained AFTER the
 *       gate verdict was surfaced — see
 *       `skills/pipeline/flow-pipeline/references/redirect-handling.md`
 *       "Gate override". Emits `{ recorded: true, pr, confirmedAt }`,
 *       exit 0.
 *
 * `--slug` is optional inside a flow tmux pane: it auto-resolves from
 * `$TMUX_PANE`'s `@flow-slug` window option, same as `flow-gate-decide`.
 *
 * Exit codes:
 *   0 — clear (check mode) / token recorded (record mode)
 *   1 — blocked (check mode only)
 *   2 — bad CLI args, gh failure, or unresolvable slug
 */

import { spawnSync } from "node:child_process";
import {
  parseTestStepsSection,
  fetchPrInputs,
  type GhRunner,
} from "./flow-gate-decide";
import { readState, writeState, type PipelineState } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { resolveSlugFromPane } from "./lib/tmux";

/**
 * A recorded gate-override token is honoured only when it matches the PR
 * being merged AND was confirmed within this window. The window closes the
 * stale-token hole: a token left in state.json by an earlier run (e.g. a
 * crash-then-`flow new --resume`) must not silently authorise a merge in a
 * later session. 30 minutes is generous for a merge to follow its
 * confirmation, yet far too short for a token to survive into an unrelated
 * later resume.
 */
export const OVERRIDE_FRESHNESS_MS = 30 * 60 * 1000;

export type GuardDecision = "clear" | "blocked";

export type GuardResult = {
  decision: GuardDecision;
  uncheckedItems: string[];
  reason: string;
  overrideApplied: boolean;
};

/**
 * True when state.json carries a gate-override token that matches this PR
 * and was confirmed inside the freshness window. A token for a different
 * PR, a malformed `confirmedAt`, or a stale confirmation all return false.
 */
function tokenIsFresh(
  state: PipelineState | null,
  pr: number,
  nowMs: number,
): boolean {
  const ov = state?.gateOverride;
  if (!ov || ov.pr !== pr) return false;
  const confirmedMs = Date.parse(ov.confirmedAt);
  if (!Number.isFinite(confirmedMs)) return false;
  const age = nowMs - confirmedMs;
  return age >= 0 && age <= OVERRIDE_FRESHNESS_MS;
}

/**
 * Pure verdict. `body` is the live PR body, `state` the pipeline's
 * state.json (or null when absent), `pr` the PR number, `nowMs` the current
 * epoch ms.
 *
 * Reuses `parseTestStepsSection` from `flow-gate-decide` — the audited
 * single source of truth for the four-step parse. The guard never
 * re-implements it.
 */
export function evaluateMergeGuard(
  body: string,
  state: PipelineState | null,
  pr: number,
  nowMs: number,
): GuardResult {
  const section = parseTestStepsSection(body);

  if (section.kind === "missing") {
    // A missing `## Test Steps` heading is an upstream regression, not
    // "unchecked steps the user chose to skip" — it is NOT overridable by
    // a gate-override token. Block unconditionally.
    return {
      decision: "blocked",
      uncheckedItems: [],
      reason:
        "## Test Steps heading missing — gate cannot confirm verification (not overridable)",
      overrideApplied: false,
    };
  }

  if (section.kind === "no-unchecked") {
    return {
      decision: "clear",
      uncheckedItems: [],
      reason: "no unchecked Test Steps items; clear to merge",
      overrideApplied: false,
    };
  }

  // has-unchecked: there is unverified work. Block unless a fresh
  // gate-override token authorises the merge.
  const uncheckedItems = section.uncheckedItems;
  const baseReason = `${uncheckedItems.length} unchecked Test Steps item(s) remain`;
  if (tokenIsFresh(state, pr, nowMs)) {
    return {
      decision: "clear",
      uncheckedItems,
      reason: `${baseReason}; cleared by a fresh gate-override confirmation`,
      overrideApplied: true,
    };
  }
  return {
    decision: "blocked",
    uncheckedItems,
    reason: baseReason,
    overrideApplied: false,
  };
}

// --- gh wiring -------------------------------------------------------------

const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

// --- CLI -------------------------------------------------------------------

type Args = { pr: number; slug?: string; recordOverride: boolean };

export function parseArgs(argv: string[]): Args | { error: string } {
  if (argv.length === 0) return { error: "PR number is required" };
  const [first, ...rest] = argv;
  if (first.startsWith("--")) {
    return { error: "PR number must be the first positional argument" };
  }
  const pr = Number.parseInt(first, 10);
  if (!Number.isFinite(pr) || pr <= 0 || String(pr) !== first) {
    return { error: `PR must be a positive integer, got '${first}'` };
  }
  let slug: string | undefined;
  let recordOverride = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--slug") {
      const v = rest[i + 1];
      if (!v || v.startsWith("--")) return { error: "--slug requires a value" };
      slug = v;
      i++;
      continue;
    }
    if (flag === "--record-override") {
      recordOverride = true;
      continue;
    }
    return { error: `unknown flag: ${flag}` };
  }
  return { pr, slug, recordOverride };
}

export type Deps = {
  gh?: GhRunner;
  stateDir?: string;
  resolveSlug?: () => string | null;
  now?: () => number;
};

function recordOverrideToken(
  pr: number,
  slug: string,
  stateDir: string,
  now: () => number,
): number {
  const state = readState(slug, stateDir);
  if (!state) {
    console.error(
      `flow-merge-guard: no state file for slug '${slug}' — cannot record a gate override.`,
    );
    return 2;
  }
  const confirmedAt = new Date(now()).toISOString();
  const updated: PipelineState = {
    ...state,
    gateOverride: { pr, confirmedAt },
    updatedAt: confirmedAt,
  };
  writeState(updated, stateDir);
  process.stdout.write(
    JSON.stringify({ recorded: true, pr, confirmedAt }) + "\n",
  );
  return 0;
}

function checkGuard(
  pr: number,
  slug: string,
  stateDir: string,
  gh: GhRunner,
  now: () => number,
): number {
  const fetched = fetchPrInputs(pr, gh);
  if (fetched.kind === "error") {
    process.stdout.write(
      JSON.stringify({ decision: "error", reason: fetched.message }) + "\n",
    );
    return 2;
  }
  if (fetched.state !== "OPEN") {
    // A non-OPEN PR is not this guard's concern — step 9's `flow-gate-decide`
    // already routes MERGED / CLOSED PRs away from the step 10 merge path.
    // Defer (clear) so the guard never blocks on a state it does not own.
    process.stdout.write(
      JSON.stringify({
        decision: "clear",
        uncheckedItems: [],
        reason: `PR is ${fetched.state}; not an open-PR merge — guard defers`,
        overrideApplied: false,
      }) + "\n",
    );
    return 0;
  }
  const state = readState(slug, stateDir);
  const result = evaluateMergeGuard(fetched.body, state, pr, now());
  process.stdout.write(JSON.stringify(result) + "\n");
  return result.decision === "clear" ? 0 : 1;
}

export function run(argv: string[], deps: Deps = {}): number {
  const gh = deps.gh ?? defaultGh;
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugFromPane());
  const now = deps.now ?? (() => Date.now());

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-merge-guard: ${parsed.error}`);
    console.error(
      "usage: flow-merge-guard <PR> [--slug <slug>] [--record-override]",
    );
    return 2;
  }

  const slug = parsed.slug ?? resolveSlug();
  if (!slug) {
    console.error(
      "flow-merge-guard: no slug given and could not resolve from $TMUX_PANE's @flow-slug option.\n" +
        "  pass --slug <slug>, or run inside a tmux window created by `flow new`.",
    );
    return 2;
  }

  if (parsed.recordOverride) {
    return recordOverrideToken(parsed.pr, slug, stateDir, now);
  }
  return checkGuard(parsed.pr, slug, stateDir, gh, now);
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
