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
 * `skills/pipeline/flow-pr-review/references/manual-test-rubric.md`). The guard
 * blocks on ANY unchecked item; over-blocking is the safe default.
 *
 * Three modes:
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
 *   flow-merge-guard merge <PR> [--slug <slug>]
 *       Merge mode. The gate-checked merge itself: re-derives every gate
 *       input at call time and runs the squash merge only when the PR is OPEN
 *       and this pipeline's own (`state.pr`), the check-mode verdict is
 *       `clear`, `autoMerge` is not false (or a fresh override token exists),
 *       and CI has no pending or failed check. Writes `merging`, then runs a
 *       bare `gh pr merge --squash <PR>` from the base checkout
 *       (`state.repo`). Prints one JSON line and writes the same JSON to
 *       `<worktree>/.flow-tmp/merge-result.json`. `merge` MUST stay the first
 *       argv token: flow's launch-settings allow rule
 *       (flow-launched sessions only) `Bash(flow-merge-guard merge *)` only matches that shape, and
 *       `--record-override` is deliberately a usage error here so recording
 *       an override stays outside the pre-approval.
 *         exit 0 merged (or already MERGED) / 1 refused / 3 merge failed /
 *         2 usage, gh error, no slug.
 *
 * `--slug` is optional when a pipeline is live: it auto-resolves from
 * `$FLOW_SLUG`, same as `flow-gate-decide`. Merge mode additionally requires
 * a valid slug shape and, when `$FLOW_SLUG` is set, that `--slug` equals it:
 * the pre-approved shape must act only on the calling pipeline's own state.
 *
 * Exit codes:
 *   0 — clear (check mode) / token recorded (record mode) / merged (merge mode)
 *   1 — blocked (check mode) / refused (merge mode)
 *   2 — bad CLI args, gh failure, or unresolvable slug
 *   3 — merge mode only: the squash merge itself failed
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseTestStepsSection,
  fetchPrInputs,
  type GhRunner,
} from "./flow-gate-decide";
import { readState, writeState, type PipelineState } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { resolveSlugAmbient } from "./lib/session-identity";
import { advancePhase } from "./lib/phase-advance";
import { isValidSlug } from "./lib/slug";
import {
  deriveCheckState,
  PASSED_CHECK_STATES,
  type Check,
  type CheckState,
} from "./lib/ci-decision";

/**
 * A recorded gate-override token is honoured only when it matches the PR
 * being merged AND was confirmed within this window. The window closes the
 * stale-token hole: a token left in state.json by an earlier run (e.g. a
 * crash-then-`flow feature resume`) must not silently authorise a merge in a
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

const defaultGhInRepo =
  (cwd: string): GhRunner =>
  (argv) => {
    const r = spawnSync("gh", argv, { cwd, encoding: "utf8" });
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
  /** Merge mode's gh factory, rooted at `state.repo` so gate inputs and the merge target are one repo. Ignored when `gh` is given. */
  ghInRepo?: (cwd: string) => GhRunner;
  stateDir?: string;
  resolveSlug?: () => string | null;
  now?: () => number;
  /** Test seam for the squash merge; default shells `gh pr merge --squash <pr>` in `cwd`. */
  runMerge?: (pr: number, cwd: string) => { exitCode: number; stderr: string };
};

// --- merge mode -------------------------------------------------------------

export type MergeOutcome = {
  decision: "merged" | "refused" | "merge-failed" | "error";
  reason: string;
  failureClass?: "conflict" | "other";
  stderr?: string;
  uncheckedItems?: string[];
};

/** `gh pr merge` stderr fragments that mean a branch conflict the resolver can fix. */
export const CONFLICT_STDERR_PATTERNS: readonly string[] = [
  "Pull Request is not mergeable",
  "not mergeable: the merge commit cannot be cleanly created",
  "merge conflict between",
];

/** Pure precondition check for merge mode; `checks` is the error-aware CI read. */
export function evaluateMergePreconditions(input: {
  body: string;
  prState: string;
  state: PipelineState | null;
  pr: number;
  checks: CheckState;
  nowMs: number;
}): { ok: true } | { ok: false; reason: string; uncheckedItems?: string[] } {
  const { body, prState, state, pr, checks, nowMs } = input;
  if (!state) return { ok: false, reason: "no-state" };
  if (state.pr !== pr) {
    return {
      ok: false,
      reason: `pr-not-owned: state.pr is ${state.pr ?? "unset"}, not #${pr}`,
    };
  }
  if (prState !== "OPEN")
    return { ok: false, reason: `pr-not-open: ${prState}` };
  const verdict = evaluateMergeGuard(body, state, pr, nowMs);
  if (verdict.decision !== "clear") {
    return {
      ok: false,
      reason: `gate-blocked: ${verdict.reason}`,
      uncheckedItems: verdict.uncheckedItems,
    };
  }
  if (state.autoMerge === false && !tokenIsFresh(state, pr, nowMs)) {
    return {
      ok: false,
      reason:
        "auto-merge-disabled: autoMerge is false and no fresh override token",
    };
  }
  if (checks.kind === "pending") return { ok: false, reason: "checks-pending" };
  if (checks.kind === "failed") {
    return {
      ok: false,
      reason: `checks-failed: ${checks.failedChecks.map((c) => c.name).join(", ")}`,
    };
  }
  return { ok: true };
}

/** Check states that let a merge through; anything outside this set and the pending/failed sets refuses. */
export const MERGE_PASSING_CHECK_STATES: ReadonlySet<string> = new Set([
  ...PASSED_CHECK_STATES,
  "NEUTRAL",
]);

/**
 * Error-aware CI read. Unlike `observeChecks` (which fails open to `[]` on any
 * gh error), a failed read refuses the merge — except gh's literal
 * "no checks reported", which is a legitimate empty CI. An entry without a
 * string name/state, or a state outside the pending/failed/passing sets
 * (ERROR, ACTION_REQUIRED, WAITING, ...), also refuses rather than passing.
 */
function readChecks(
  pr: number,
  gh: GhRunner,
):
  | { kind: "ok"; checks: CheckState }
  | { kind: "unreadable"; message: string }
  | { kind: "unrecognised"; message: string } {
  const r = gh(["pr", "checks", String(pr), "--json", "name,state"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = undefined;
  }
  // gh exits non-zero for pending/failing checks even with --json; a
  // parseable array is authoritative either way.
  if (Array.isArray(parsed)) {
    const checks = parsed.filter(
      (c): c is Check =>
        typeof c?.name === "string" && typeof c?.state === "string",
    );
    if (checks.length !== parsed.length) {
      return {
        kind: "unrecognised",
        message: "a check entry has no name/state",
      };
    }
    const derived = deriveCheckState(checks);
    if (derived.kind === "all-passed") {
      const odd = checks.filter(
        (c) => !MERGE_PASSING_CHECK_STATES.has(c.state),
      );
      if (odd.length > 0) {
        return {
          kind: "unrecognised",
          message: odd.map((c) => `${c.name}=${c.state}`).join(", "),
        };
      }
    }
    return { kind: "ok", checks: derived };
  }
  if (r.exitCode !== 0 && /no checks reported/i.test(r.stderr)) {
    return { kind: "ok", checks: deriveCheckState([]) };
  }
  return {
    kind: "unreadable",
    message: r.stderr.trim() || `gh pr checks unreadable (exit ${r.exitCode})`,
  };
}

const defaultRunMerge: NonNullable<Deps["runMerge"]> = (pr, cwd) => {
  const r = spawnSync("gh", ["pr", "merge", "--squash", String(pr)], {
    cwd,
    encoding: "utf8",
  });
  return { exitCode: r.status ?? -1, stderr: r.stderr ?? "" };
};

const MERGE_EXIT: Record<MergeOutcome["decision"], number> = {
  merged: 0,
  refused: 1,
  "merge-failed": 3,
  error: 2,
};

function emitMergeOutcome(
  outcome: MergeOutcome,
  state: PipelineState | null,
): number {
  const line = JSON.stringify(outcome);
  process.stdout.write(line + "\n");
  if (state?.worktree) {
    try {
      const dir = path.join(state.worktree, ".flow-tmp");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "merge-result.json"), line + "\n");
    } catch (e) {
      console.error(
        `flow-merge-guard: could not write merge-result.json: ${(e as Error).message}`,
      );
    }
  }
  return MERGE_EXIT[outcome.decision];
}

export function parseMergeArgs(
  argv: string[],
): { pr: number; slug?: string } | { error: string } {
  const [, first, ...rest] = argv;
  if (first === undefined) return { error: "PR number is required" };
  const pr = Number.parseInt(first, 10);
  if (!Number.isFinite(pr) || pr <= 0 || String(pr) !== first) {
    return { error: `PR must be a positive integer, got '${first}'` };
  }
  let slug: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--slug") {
      const v = rest[i + 1];
      if (!v || v.startsWith("--")) return { error: "--slug requires a value" };
      if (!isValidSlug(v)) return { error: `invalid slug '${v}'` };
      slug = v;
      i++;
      continue;
    }
    return { error: `merge mode does not accept ${rest[i]}` };
  }
  return { pr, slug };
}

function mergePr(
  pr: number,
  slug: string,
  stateDir: string,
  deps: Deps,
  now: () => number,
  runMerge: NonNullable<Deps["runMerge"]>,
): number {
  const state = readState(slug, stateDir);
  if (state?.worktree) {
    // Drop a stale result so a reader never mistakes a prior call's outcome for this one.
    fs.rmSync(path.join(state.worktree, ".flow-tmp", "merge-result.json"), {
      force: true,
    });
  }
  const refuse = (reason: string, uncheckedItems?: string[]) =>
    emitMergeOutcome(
      {
        decision: "refused",
        reason,
        ...(uncheckedItems?.length ? { uncheckedItems } : {}),
      },
      state,
    );
  if (!state) {
    return emitMergeOutcome(
      {
        decision: "error",
        reason: `no-state: no state file for slug '${slug}'`,
      },
      null,
    );
  }
  const gh = deps.gh ?? (deps.ghInRepo ?? defaultGhInRepo)(state.repo);
  const fetched = fetchPrInputs(pr, gh);
  if (fetched.kind === "error") {
    return emitMergeOutcome(
      { decision: "error", reason: fetched.message },
      state,
    );
  }
  if (state.pr !== pr)
    return refuse(
      `pr-not-owned: state.pr is ${state.pr ?? "unset"}, not #${pr}`,
    );
  if (fetched.state === "MERGED") {
    return emitMergeOutcome(
      { decision: "merged", reason: "already-merged" },
      state,
    );
  }
  const read = fetched.state === "OPEN" ? readChecks(pr, gh) : null;
  if (read?.kind === "unreadable") {
    return refuse(`checks-unreadable: ${read.message}`);
  }
  if (read?.kind === "unrecognised") {
    return refuse(`checks-unrecognised: ${read.message}`);
  }
  const pre = evaluateMergePreconditions({
    body: fetched.body,
    prState: fetched.state,
    state,
    pr,
    checks: read?.kind === "ok" ? read.checks : { kind: "no-checks-reported" },
    nowMs: now(),
  });
  if (!pre.ok) return refuse(pre.reason, pre.uncheckedItems);

  const advance = advancePhase("merging", {
    slug,
    expectPr: pr,
    dir: stateDir,
  });
  if (!advance.advanced && state.phase !== "merging") {
    return refuse(`phase-not-advanceable: ${advance.reason}`);
  }
  const result = runMerge(pr, state.repo);
  if (result.exitCode === 0) {
    return emitMergeOutcome({ decision: "merged", reason: "merged" }, state);
  }
  const conflict = CONFLICT_STDERR_PATTERNS.some((p) =>
    result.stderr.includes(p),
  );
  return emitMergeOutcome(
    {
      decision: "merge-failed",
      reason: `gh pr merge exited ${result.exitCode}`,
      failureClass: conflict ? "conflict" : "other",
      stderr: result.stderr,
    },
    state,
  );
}

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
  // Side effect: advances `state.phase` to `merging` when the guard clears.
  // Step 10 now calls merge mode, which writes `merging` itself, so this
  // check mode is only reachable by hand. Deliberately NOT wired into
  // `recordOverrideToken` — that function serves the `--record-override`
  // fresh-confirmation path, not a pipeline transition, and its own
  // `writeState` would clobber an advance recorded there.
  const result = evaluateMergeGuard(fetched.body, state, pr, now());
  // Out of `gated` (the gate-override path), `merging` lands only when the
  // guard clears — a blocked override must leave the pipeline visibly gated,
  // not parked at `merging` with nothing merging.
  if (state?.phase !== "gated" || result.decision === "clear") {
    advancePhase("merging", { slug, expectPr: pr, dir: stateDir });
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  return result.decision === "clear" ? 0 : 1;
}

export function run(argv: string[], deps: Deps = {}): number {
  const gh = deps.gh ?? defaultGh;
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugAmbient());
  const now = deps.now ?? (() => Date.now());

  const usage =
    "usage: flow-merge-guard <PR> [--slug <slug>] [--record-override]\n" +
    "       flow-merge-guard merge <PR> [--slug <slug>]";
  const noSlug =
    "flow-merge-guard: no slug given and no FLOW_SLUG in the environment.\n" +
    "  pass --slug <slug>, or run inside a pipeline launched by `flow feature create`.";

  if (argv[0] === "merge") {
    const m = parseMergeArgs(argv);
    if ("error" in m) {
      console.error(`flow-merge-guard: ${m.error}`);
      console.error(usage);
      return 2;
    }
    const ambient = resolveSlug();
    const mergeSlug = m.slug ?? ambient;
    if (!mergeSlug) {
      console.error(noSlug);
      return 2;
    }
    if (!isValidSlug(mergeSlug)) {
      console.error(`flow-merge-guard: invalid slug '${mergeSlug}'`);
      return 2;
    }
    if (ambient && mergeSlug !== ambient) {
      console.error(
        `flow-merge-guard: --slug '${mergeSlug}' is not this pipeline's slug ('${ambient}'); merge mode acts only on its own pipeline.`,
      );
      return 2;
    }
    return mergePr(
      m.pr,
      mergeSlug,
      stateDir,
      deps,
      now,
      deps.runMerge ?? defaultRunMerge,
    );
  }

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-merge-guard: ${parsed.error}`);
    console.error(usage);
    return 2;
  }

  const slug = parsed.slug ?? resolveSlug();
  if (!slug) {
    console.error(noSlug);
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
