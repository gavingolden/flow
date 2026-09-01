#!/usr/bin/env bun
/**
 * Cross-model (AGY) plan review for `/flow-pipeline` Step 3's Layer-2 pass.
 *
 * When the consumer opts into `review.gemini`, this adds one-or-two
 * genuinely-different-model reviewer(s) of the PRD, pressure-testing it
 * against its own `**Goal:**` line via `bin/lib/plan-review-prompt.ts`'s
 * adversarial battery, delegated to the user's Google AI Ultra quota via
 * `flow-delegate` (agy). Config-gated, opt-in, purely additive: every
 * failure path is a graceful exit-0 skip; callers branch on the envelope's
 * `ran`, never the exit code. Unlike `flow-gemini-lens`, AGY's output here is
 * RAW PROSE the supervisor weighs — not a `{findings}` schema — so the raw
 * agy artifact is copied straight to `--out` with no JSON extraction/
 * validation tail.
 *
 * Depth tiers (`--depth auto|standard|deep`, default `auto`): STANDARD runs
 * one reviewer (MODEL, unchanged from the original single-reviewer shape).
 * DEEP runs TWO reviewers (MODEL + SECOND_MODEL) serially via
 * `flow-delegate-fanout` — a 2-entry manifest handed to the fanout BINARY,
 * never two direct `Bun.spawn` calls (see `computeDepth`/the deep branch
 * below for why). `auto` resolves via `computeDepth`: a plan whose task
 * breakdown or Decision-analysis section is large enough to be
 * consequential gets the extra reviewer; a trivial plan stays on the fast,
 * single-reviewer path. A DEEP run's two prose outputs are combined into one
 * `--out` file behind a CONVERGENCE RULE preamble: a material point BOTH
 * reviewers raised independently is presumptively accepted by the
 * supervisor; a single-reviewer point remains input to weigh, same as
 * today's single-reviewer prose.
 *
 * Skip vocabulary: `plan-review-disabled` (gate off), `plan-unreadable`,
 * `no-decision-analysis` (omit-when-empty ⇒ nothing to review),
 * `decision-analysis-unchanged` (the widened hashed inputs — `**Goal:**` +
 * `## Decision analysis` + `## Cut list`, each normalized — are unchanged
 * since the last reviewed revision; see the hash helpers below),
 * `worktree-not-provided` (`--worktree` omitted on the review path — a
 * wiring bug, distinct from an environment condition), `worktree-not-found`
 * (`--worktree` points at a non-directory), `reviewer-empty` /
 * `reviewer-not-engaged` (a reviewer's raw prose failed
 * `bin/lib/plan-review-engagement.ts`'s substance floor or lens-engagement
 * floor — see `resolveReviewer` below), `agy-not-found` (propagated from a
 * `ran:false` delegate/fanout entry), `agy-error` (delegate output
 * unparseable), and the local IO-throw defensive skips `plan-prep-failed`,
 * `plan-output-unreadable`, `plan-finalize-failed`. `reviewer-timeout` is a
 * per-reviewer `agy-timeout` (a `--print-timeout` kill, distinct from a
 * genuine `agy-error`) mapped by `mapReviewerSkipReason`, with a
 * duration-based fallback in `resolveReviewer` for the case where a killed
 * agentic run still exits 0 with a partial. `review-timed-out` (unchanged)
 * is `--check`'s own give-up verdict when a still-alive worker outlives
 * `maxElapsedSec()`; `reviewer-worker-died` is a dead worker with no result
 * file; `plan-review-not-started` is `--check` run with no `planReview`
 * record. A DEEP run where BOTH reviewers skip (including both demoted for
 * non-engagement) propagates the FIRST reviewer's skip reason exactly as a
 * standard-tier skip would — `depth`/`reviewers` are additive fields that
 * appear ONLY on a `ran:true` envelope, NEVER on a skip — `depth:"standard"`
 * with a single reviewer entry on the standard tier, `depth:"deep"` with two
 * on the deep tier (a partial deep failure — one reviewer ran, one
 * skipped/demoted — is also `ran:true`, degraded to the surviving
 * reviewer's prose, with the failed reviewer's skip reason recorded in its
 * `reviewers[]` entry, which also carries each reviewer's `lensesEngaged`
 * count out of 6). AMENDED skip-envelope invariant (was: "every skip
 * envelope stays byte-identical to the single-reviewer era"; per D2, this
 * still holds for `depth`/`reviewers` — those two fields never appear on a
 * skip — but a skip MAY now additionally carry `partialArtifactPath`
 * (a retained reviewer transcript that `cleanScratch` was told not to
 * delete) and/or `stderrTail` (a redacted, capped agy stderr excerpt),
 * both omit-when-absent. Exit 2 only on a usage error.
 *
 * The convergence preamble (below) requires TWO GENUINELY ENGAGED reviewers
 * — see the `survivors` computation in the deep-tier branch for the
 * authoritative statement of that invariant.
 *
 * Invocation modes: default (no `--start`/`--check`) is the synchronous
 * WORKER body — today's single-process review, unchanged, plus one
 * addition: when `--result-file` is given, the final envelope is written to
 * `${resultFile}.tmp` then renamed into place (atomic handoff) in addition
 * to stdout. `--start` is the one-shot decider half of the async spine: it
 * resolves every cheap gate synchronously and, on a pass, detaches this
 * same worker body via `flow-spawn --detach` (registry-recorded) and writes
 * a durable `planReview` anchor to `~/.flow/state/<slug>.json`. `--check` is
 * the OTHER one-shot decider half: it owns all state and all decisions,
 * re-deriving elapsed time from `planReview.startedAt` (never from this
 * process's own age, so a suspended `--check` can never fabricate a false
 * `review-timed-out`). The pattern — and the async spine's whole
 * rationale — is copied from `bin/flow-ci-check.ts` / `bin/flow-ci-wait.ts`;
 * `bin/flow-plan-review-wait.ts` is the dumb waiter half, mirroring
 * `flow-ci-wait.ts`.
 *
 * Revision-pass re-fire: on a step-3 re-entry the supervisor re-runs this
 * helper unconditionally; the `decision-analysis-unchanged` skip is what makes
 * the re-fire cost-free when the reviewed inputs did not change. The
 * supervisor embeds a `<!-- flow-plan-review-hash: <sha> -->` marker for the
 * next pass to compare against — but it must source that hash from the
 * compute-only `--print-hash` mode run on the FINAL plan AFTER it revises the
 * `## Decision analysis` body per AGY feedback, NOT from the `ran:true`
 * envelope's `decisionAnalysisHash` (which is computed over the pre-revision
 * body and would embed a stale marker that falsely re-fires the next pass). The
 * hash is over NORMALIZED bodies (not raw bytes) so incidental whitespace /
 * bullet-char churn during an unrelated revision edit does not needlessly
 * re-fire the review; a missing or malformed prior marker re-fires
 * (safe/wasteful) and self-heals (the run re-emits the hash), never a
 * wrong-skip.
 *
 * --print-hash: a compute-only mode that prints `computeDecisionHash` of the
 * plan named by `--plan-file` with NO agy call and NO config gate — tolerant
 * (an unreadable plan or absent sections prints the empty-body hash, exit 0).
 * It is how the supervisor re-embeds a fresh marker over the final revised body.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { buildBatteryPrompt, extractGoalLine } from "./lib/plan-review-prompt";
import { classifyEngagement } from "./lib/plan-review-engagement";
import { resolveDelegateModel } from "./lib/delegate-models";
import { readState, writeState, type PlanReviewRecord } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { isLive, pidStartEpoch } from "./lib/liveness";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { stderrTail as redactedStderrTail } from "./flow-delegate";
import { forwardSignal } from "./flow-spawn";

export { extractGoalLine };

const DEFAULT_TASK = "plan-review";

// Bounds each agy call explicitly rather than relying on flow-delegate's own
// default. `--start` (see the async spine below) detaches the worker that
// makes these calls, so NEITHER cap is bounded above by any Bash-tool
// ceiling anymore — each is bounded ONLY BELOW, by what an agentic six-lens
// run actually needs (measured live against this repo: ~1m35-1m50 for
// Gemini/reviewer 1, ~4m30-4m50 engaged for Opus/reviewer 2, with a full
// 362s of pure unbounded verification observed on a ~550-line plan before
// Task 1's battery-prompt bounds existed).
//
// REVIEWER_2_TIMEOUT is `15m`: ~3x the measured engaged run and ~2.5x the
// observed unbounded-verification burn, so a bounded reviewer (Task 1) has
// real writing headroom well past the point that killed the unbounded one.
// REVIEWER_1_TIMEOUT stays `3m` — with the sum constraint gone, there is no
// reason to haircut it below its measured ~1m50 margin.
//
// The deep tier still runs its two reviewers SERIALLY (see the fanout
// call's `concurrency: 1` and the comment there), so 3m + 15m = 18m is
// still the wall-clock SUM a live deep run can take — it is simply no
// longer a call-lifetime ceiling anyone must budget under. It IS the give-up
// cap `--check` must accommodate before declaring a still-alive worker
// `review-timed-out`; that cap is DERIVED via `maxElapsedSec()` below
// (REVIEWER_1_TIMEOUT + REVIEWER_2_TIMEOUT + slack), never restated as a
// number here, so it can never drift from the constants it guards. The
// standard tier runs only reviewer 1 (MODEL, i.e. Gemini), so it uses the
// REVIEWER_1_TIMEOUT value.
const REVIEWER_1_TIMEOUT = "3m";
const REVIEWER_2_TIMEOUT = "15m";

// Parses a "godur"-shaped duration string ("3m", "15m", "90s", "2m30s")
// into whole seconds. Throws on anything else — callers only ever feed it
// this module's own REVIEWER_*_TIMEOUT constants, so a throw here is a
// programmer error, not a runtime input-validation path.
export function godurToSec(value: string): number {
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(value.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) {
    throw new Error(`invalid duration: "${value}"`);
  }
  const minutes = m[1] !== undefined ? parseInt(m[1], 10) : 0;
  const seconds = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  return minutes * 60 + seconds;
}

// Slack added on top of the two reviewer caps to derive `--check`'s give-up
// cap — covers bun startup, two agy spawns, and the fanout's own overhead,
// none of which count against either reviewer's own timeout.
const WORKER_SLACK_SEC = 300;

/**
 * The derived wall-clock cap `--check` gives a detached worker before
 * declaring it `review-timed-out` and killing it. NEVER a hardcoded number
 * — always re-derived from the live REVIEWER_*_TIMEOUT constants so it can
 * never silently drift from the caps it is meant to guard (1380s / 23m
 * deep, 480s / 8m standard, at today's `3m`/`15m` split).
 */
export function maxElapsedSec(depth: "standard" | "deep"): number {
  return (
    godurToSec(REVIEWER_1_TIMEOUT) +
    (depth === "deep" ? godurToSec(REVIEWER_2_TIMEOUT) : 0) +
    WORKER_SLACK_SEC
  );
}

// The DEEP-tier combined --out preamble: names the convergence rule the
// supervisor applies when reading a two-reviewer file (kept in sync with
// flow-pipeline/SKILL.md's step-3 cross-model review block).
const CONVERGENCE_PREAMBLE =
  "_Convergence rule: a material point raised independently by BOTH reviewers is presumptively accepted by the supervisor; a single-reviewer point remains input to weigh, same as a single-reviewer run._";

export type DepthArg = "auto" | "standard" | "deep";

export type Args = {
  planFile: string;
  out: string;
  config: string;
  task: string;
  printHash: boolean;
  depth: DepthArg;
  // OPTIONAL by design: --print-hash needs no worktree, and a caller that
  // omits it on the review path hits the worktree-not-provided skip below
  // rather than a parseArgs usage error (parseArgs stays the light
  // required-flag validator; the worktree gate is a run()-time behavioral
  // skip, not a CLI-shape error).
  worktree?: string;
  // The async spine's two decider modes (see the file header's "Invocation
  // modes" paragraph). Mutually exclusive with each other; both are
  // valueless like --print-hash.
  start: boolean;
  check: boolean;
  // Sibling-of-`--out` scratch path the WORKER writes its final envelope to
  // (atomic tmp-then-rename) when set. Also the path `--check` reads.
  resultFile?: string;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // --print-hash/--start/--check are valueless booleans; handle them
    // before the value-required check every other flag falls through to.
    if (flag === "--print-hash") {
      out.printHash = true;
      continue;
    }
    if (flag === "--start") {
      out.start = true;
      continue;
    }
    if (flag === "--check") {
      out.check = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--plan-file":
        out.planFile = value;
        break;
      case "--out":
        out.out = value;
        break;
      case "--config":
        out.config = value;
        break;
      case "--task":
        out.task = value;
        break;
      case "--worktree":
        out.worktree = value;
        break;
      case "--result-file":
        out.resultFile = value;
        break;
      case "--depth":
        if (value !== "auto" && value !== "standard" && value !== "deep") {
          return {
            error: `--depth must be one of auto, standard, deep (got "${value}")`,
          };
        }
        out.depth = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (out.start && out.check) {
    return { error: "--start and --check are mutually exclusive" };
  }
  // --check needs only --out — it never reads the plan file itself, only
  // the durable planReview state record and the worker's result file.
  if (!out.check && out.planFile === undefined) {
    return { error: "--plan-file is required" };
  }
  // --out gates the review/start/check modes; --print-hash needs just
  // --plan-file. --check derives its scratch paths as `${out}.run.json`
  // etc, the same sibling-of-`--out` convention the worker uses.
  if (!out.printHash && out.out === undefined) {
    return { error: "--out is required" };
  }
  return {
    planFile: out.planFile ?? "",
    out: out.out ?? "",
    config: out.config ?? `${homedir()}/.flow/config.json`,
    task: out.task ?? DEFAULT_TASK,
    printHash: out.printHash ?? false,
    start: out.start ?? false,
    check: out.check ?? false,
    resultFile: out.resultFile,
    depth: out.depth ?? "auto",
    worktree: out.worktree,
  };
}

// Strict-boolean gate: enable ONLY when the parsed config is an object with
// `review` an object and `review.gemini === true`. Tolerant on input — an
// absent/malformed config (unparseable JSON, wrong shape) is `false`, never a
// throw. Reuses the exact `flow-gemini-lens` isGeminiLensEnabled shape so the
// same `review.gemini` opt-in gates the PR-review lens and this plan review;
// deliberately NOT imported (the two helpers stay independent).
export function isPlanReviewEnabled(rawConfigText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfigText);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const review = (parsed as Record<string, unknown>).review;
  if (typeof review !== "object" || review === null) return false;
  return (review as Record<string, unknown>).gemini === true;
}

// The Layer-2 gate's second half: the PRD's omit-when-empty `## Decision
// analysis` section is the signal that discovery found ≥1 consequential
// diverging decision worth cross-reviewing. Its absence ⇒ nothing to review.
export function hasDecisionAnalysis(planText: string): boolean {
  return /^## Decision analysis/m.test(planText);
}

// --- Depth resolution (auto|standard|deep) ----------------------------------

// Strict task-heading regex — deliberately the SAME shape as
// flow-plan-lint.ts's checkTaskContracts, so "### Task breakdown" (no digit)
// never miscounts as a task heading the way a loose "### Task" prefix would.
const TASK_HEADING_RE = /^### Task \d+:[^\n]*$/gm;
// "### D<digit>" decision subsections under `## Decision analysis`
// (e.g. "### D1 — ..."), per the plan-artifact convention.
const DECISION_SUBSECTION_RE = /^### D\d/gm;

/**
 * Resolves the "auto" depth tier: `deep` when the plan is consequential
 * enough to warrant a second reviewer (>=4 `### Task N:` headings OR >=2
 * `### D` decision subsections under `## Decision analysis`), else
 * `standard`. Pure, never throws.
 */
export function computeDepth(planText: string): "standard" | "deep" {
  const taskCount = (planText.match(TASK_HEADING_RE) ?? []).length;
  if (taskCount >= 4) return "deep";
  const decisionBody = extractDecisionAnalysisBody(planText);
  const subsectionCount = (decisionBody.match(DECISION_SUBSECTION_RE) ?? [])
    .length;
  if (subsectionCount >= 2) return "deep";
  return "standard";
}

// --- Decision-analysis-unchanged skip (revision-pass re-fire guard) ---------

/**
 * Extracts the `## Decision analysis` section BODY — from the heading to the
 * next `## ` OR `# ` heading (Recommendation follows it on a lint-clean
 * plan) or EOF — EXCLUDING any `### Cross-model review (AGY)` subsection
 * this helper appends on a prior run. Excluding the subsection is
 * load-bearing: it is what lets a revision that only appends/edits the
 * review output hash equal, so the review does not re-fire on its own
 * footprint. Returns "" when the section is absent.
 *
 * Terminator regex bounds, both load-bearing:
 * (a) LOWER bound (why `/^## /` alone isn't enough): flow-plan-lint.ts's
 *     checkTaskContracts requires `## Recommendation` / `## Plan risks` /
 *     `## Cut list`, all ordered after `## Decision analysis` in the PRD
 *     template, so a `## ` heading always precedes the next `# ` heading on
 *     a lint-clean plan — BUT a malformed plan (lint violation) can have
 *     `## Decision analysis` immediately followed by the h1
 *     `# Task breakdown` with no intervening `## ` heading; widening to
 *     `/^#{1,2} /` closes that gap so the scan still terminates instead of
 *     running to EOF and swallowing the whole task breakdown.
 * (b) UPPER bound (why NOT `/^#{1,3} /` or wider): `### Cross-model review
 *     (AGY)` and `### D1`/`### D2` decision subsections legitimately live
 *     INSIDE the Decision analysis body. An h3 terminator would truncate
 *     the body early AND silently downgrade `computeDepth` from `"deep"` to
 *     `"standard"` (`DECISION_SUBSECTION_RE = /^### D\d/gm` above counts
 *     those subsections for the depth tier). Excluding the one h3 that
 *     *must* be excluded (the AGY subsection) is the separate exclusion
 *     loop's job below, not the terminator's — same discipline
 *     `extractCutListBody`'s docstring warns against generalizing.
 */
export function extractDecisionAnalysisBody(planText: string): string {
  const lines = planText.split("\n");
  const startIdx = lines.findIndex((l) => /^## Decision analysis/.test(l));
  if (startIdx === -1) return "";
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  let bodyEnd = endIdx;
  for (let i = startIdx + 1; i < endIdx; i++) {
    if (/^### Cross-model review \(AGY\)/.test(lines[i])) {
      bodyEnd = i;
      break;
    }
  }
  return lines.slice(startIdx + 1, bodyEnd).join("\n");
}

/**
 * Extracts the `## Cut list` section body — from the heading to the next
 * `## ` heading or EOF. Deliberately a PLAIN extractor: unlike
 * `extractDecisionAnalysisBody`, it does NOT exclude any subsection —
 * that truncation is a hidden invariant specific to Decision analysis'
 * own AGY-review footprint and must not be generalized here. Returns ""
 * when the section is absent.
 */
function extractCutListBody(planText: string): string {
  const lines = planText.split("\n");
  const startIdx = lines.findIndex((l) => /^## Cut list/.test(l));
  if (startIdx === -1) return "";
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx + 1, endIdx).join("\n");
}

/**
 * Normalizes a section body before hashing so only a SEMANTIC change
 * re-fires the review — a byte-for-byte SHA over LLM-generated markdown
 * is fragile (the AGY cross-model review flagged this). Normalization: trim
 * per-line trailing whitespace, normalize a leading `*`/`+` bullet marker to
 * `-`, collapse blank-line runs to one, and strip leading/trailing blank
 * lines. Pure string work — never throws. Shared by every hashed section
 * (Decision analysis and Cut list), not Decision-analysis-specific despite
 * the name.
 */
export function normalizeDecisionBody(body: string): string {
  const normed = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .map((l) => l.replace(/^(\s*)[*+](\s)/, "$1-$2"));
  const collapsed: string[] = [];
  let prevBlank = false;
  for (const l of normed) {
    const blank = l.trim() === "";
    if (blank && prevBlank) continue;
    collapsed.push(l);
    prevBlank = blank;
  }
  while (collapsed.length && collapsed[0].trim() === "") collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === "")
    collapsed.pop();
  return collapsed.join("\n");
}

/**
 * sha256 (hex) of the NORMALIZED, widened content key: the `**Goal:**` line
 * + the `## Decision analysis` body + the `## Cut list` body, each extracted
 * by its OWN tolerant extractor and normalized independently, then joined.
 * Widened (originally Decision-analysis-only) so a goal-conflicting edit or a
 * cut-list-only edit also re-fires the review. The revision-pass re-fire
 * guard compares this against the embedded marker.
 */
export function computeDecisionHash(planText: string): string {
  const goalLine = (extractGoalLine(planText) ?? "").trim();
  const decisionBody = normalizeDecisionBody(
    extractDecisionAnalysisBody(planText),
  );
  const cutListBody = normalizeDecisionBody(extractCutListBody(planText));
  const combined = [goalLine, decisionBody, cutListBody].join("\n\0\n");
  return createHash("sha256").update(combined).digest("hex");
}

/**
 * Parses the `<!-- flow-plan-review-hash: <sha> -->` marker a prior run's
 * supervisor embedded. Tolerant: returns null when the marker is absent or
 * malformed (a truncated / non-64-hex value), which re-fires the review — the
 * safe direction (wasteful, never a wrong-skip). Lowercased for a stable
 * compare against `computeDecisionHash`'s output.
 */
export function readPriorHash(planText: string): string | null {
  const m = planText.match(
    /<!--\s*flow-plan-review-hash:\s*([0-9a-fA-F]{64})\s*-->/,
  );
  return m ? m[1].toLowerCase() : null;
}

export type DelegateEnvelope = {
  ran?: boolean;
  skipReason?: string;
  artifactPath?: string;
  // Redacted, tail-most, byte-capped agy stderr — projected straight from
  // flow-delegate's own field (Task 2), through flow-delegate-fanout's
  // allowlist projection on the deep tier.
  stderrTail?: string;
};

// The one-line aggregate `flow-delegate-fanout` emits, as consumed here.
// Defined locally rather than imported so this module does not couple to the
// fanout module's surface (mirrors bin/flow-research-run.ts's own local
// `FanoutAggregate` type).
export type FanoutAggregate = {
  entries?: Array<{
    task: string;
    model?: string | null;
    ran?: boolean;
    artifactPath?: string;
    skipReason?: string;
    durationSeconds?: number;
    durationMs?: number;
    stderrTail?: string;
  }>;
  anyRan?: boolean;
  allSkipped?: boolean;
};

// A manifest entry shaped for flow-delegate-fanout, defined locally for the
// same reason as FanoutAggregate above.
type DeepManifestEntry = {
  task: string;
  model: string;
  promptFile: string;
  addDirs: string[];
  // Pins each reviewer's artifact to a scratch sibling of --out (rather than
  // flow-delegate-fanout's default `artifacts/<index>-<task>.md`) so
  // cleanScratch can name and remove it deterministically.
  out: string;
  // Explicit per-entry cap (see REVIEW_TIMEOUT above); flow-delegate-fanout
  // already accepts and forwards a manifest entry's `timeout` field, so no
  // change to that module is needed.
  timeout: string;
};

export type Deps = {
  readConfig: (path: string) => string;
  // Runs flow-delegate with the given argv and returns its parsed one-line
  // JSON envelope.
  runDelegate: (argv: string[]) => DelegateEnvelope;
  // Runs flow-delegate-fanout against a prepared manifest file and returns
  // its parsed one-line aggregate envelope. Used only on the DEEP tier.
  runFanout: (input: {
    manifestPath: string;
    outPath: string;
    concurrency: number;
  }) => FanoutAggregate;
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  removeFile: (path: string) => void;
  renameFile: (from: string, to: string) => void;
  mkdirp: (dir: string) => void;
  writeOut: (line: string) => void;
  // True when `path` exists and is a directory. Backs the worktree gate
  // below; injectable like the other deps.
  dirExists: (path: string) => boolean;
  // True when `path` exists (file or directory) — used only to decide
  // whether a partial artifact is worth naming in a skip envelope.
  fileExists: (path: string) => boolean;

  // --- Async spine (--start / --check) ------------------------------------
  // Launches the detached worker via `flow-spawn --detach ...` (argv
  // includes "flow-spawn" itself, matching runDelegate/runFanout's
  // Bun.spawnSync convention). Returns null on a spawn failure.
  spawnDetached: (argv: string[]) => { pid: number } | null;
  // Probes a freshly-spawned pid's start epoch (pairs with the pid to
  // defeat pid recycling on a later liveness check). Mirrors
  // bin/flow-spawn.ts's own buildRow-adjacent probe.
  probeStartEpoch: (pid: number) => number | null;
  readStateRecord: (slug: string) => PlanReviewRecord | undefined;
  writeStateRecord: (slug: string, rec: PlanReviewRecord) => void;
  isAlive: (pid: number, startEpoch: number | null) => boolean;
  killWorker: (pid: number) => void;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  // Reads a worker stderr log (best-effort — "" on any read failure) and
  // returns its redacted, tail-most, byte-capped excerpt (reuses
  // flow-delegate's own stderrTail helper).
  readWorkerStderrTail: (path: string) => string;
};

function emit(deps: Deps, envelope: Record<string, unknown>): number {
  deps.writeOut(JSON.stringify(envelope));
  return 0;
}

// Writes the WORKER's final envelope atomically (tmp-then-rename) to
// `resultFile` when set, in addition to the normal stdout emit — so
// `--check` and the waiter can never observe a half-written file. A write
// failure here is best-effort: the stdout envelope (still emitted) remains
// the authoritative record for a foreground run.
function finalizeAndEmit(
  deps: Deps,
  envelope: Record<string, unknown>,
  resultFile: string | undefined,
): number {
  if (resultFile) {
    try {
      const tmp = `${resultFile}.tmp`;
      deps.writeFile(tmp, JSON.stringify(envelope));
      deps.renameFile(tmp, resultFile);
    } catch {
      // best-effort — see docstring above.
    }
  }
  return emit(deps, envelope);
}

type ReviewerStatus = {
  model: string;
  ran: boolean;
  skipReason?: string;
  prose?: string;
  lensesEngaged?: number;
  // Retained on any ran:false status when the underlying delegate/fanout
  // entry named an artifact path or a redacted stderr tail — surfaced by
  // the deep-tier branch as the reviewer's own `reviewers[]` diagnostics.
  partialArtifactPath?: string;
  stderrTail?: string;
};

type FanoutEntry = NonNullable<FanoutAggregate["entries"]>[number];

// `flow-delegate`'s own `agy-timeout` (Task 2) is layer-correct for the
// delegate helper's generic vocabulary; `flow-plan-review` owns the
// `reviewer-`-prefixed vocabulary, so it maps here. Every other skipReason
// (including undefined, preserving today's default) passes through
// unchanged.
export function mapReviewerSkipReason(
  delegateSkipReason: string | undefined,
): string {
  if (delegateSkipReason === "agy-timeout") return "reviewer-timeout";
  return delegateSkipReason ?? "agy-not-found";
}

// A killed agentic run can still exit 0 with a partial (a 2026-08-11
// diagnosis of this same reviewer recorded exactly that: a long
// `--print-timeout` kill cancelled its subagents, wrote a partial, and
// exited 0 — under which `looksTimedOut` never fires because there is no
// non-zero exit to inspect). Mitigation: treat a demotion as
// `reviewer-timeout` whenever the entry's observed duration lands within
// this many seconds of the reviewer's configured cap, independent of exit
// code. Reads `durationMs` (the fanout POOL's wall-clock timing, always
// populated) rather than `durationSeconds` (the model's own self-reported
// timing, lifted only when the manifest entry sets `outputFormat: "json"` —
// which this module's manifest builder never does, so `durationSeconds` is
// permanently undefined on this path and would make every branch below
// dead code).
const NEAR_CAP_SLACK_SEC = 10;

function isNearCap(durationMs: number | undefined, capSec: number): boolean {
  return (
    durationMs !== undefined && capSec - durationMs / 1000 <= NEAR_CAP_SLACK_SEC
  );
}

// Resolves one deep-tier manifest entry's fanout result into a reviewer
// status: a skipped/missing entry stays unread; a `ran:true` entry whose
// artifact can't be read degrades to a skip rather than crashing the run;
// a `ran:true` entry whose prose doesn't clear the engagement bar (empty or
// non-engaging) is demoted to a skip too — a truncated/rubber-stamp run is
// not a genuine survivor for the deep-tier convergence rule. `capSec` is
// this reviewer's configured timeout (in seconds) — the near-cap mitigation
// above needs it to compare against the entry's observed duration.
function resolveReviewer(
  deps: Deps,
  entry: FanoutEntry | undefined,
  model: string,
  capSec: number,
): ReviewerStatus {
  if (!entry || entry.ran !== true) {
    const mapped = mapReviewerSkipReason(entry?.skipReason);
    const skipReason = isNearCap(entry?.durationMs, capSec)
      ? "reviewer-timeout"
      : mapped;
    return {
      model,
      ran: false,
      skipReason,
      partialArtifactPath: entry?.artifactPath,
      stderrTail: entry?.stderrTail,
    };
  }
  try {
    const prose = deps.readFile(entry.artifactPath ?? "");
    const result = classifyEngagement(prose);
    if (!result.engaged) {
      const skipReason = isNearCap(entry.durationMs, capSec)
        ? "reviewer-timeout"
        : result.reason;
      return {
        model,
        ran: false,
        skipReason,
        lensesEngaged: result.lensesEngaged,
        partialArtifactPath: entry.artifactPath,
        stderrTail: entry.stderrTail,
      };
    }
    return { model, ran: true, prose, lensesEngaged: result.lensesEngaged };
  } catch {
    const skipReason = isNearCap(entry.durationMs, capSec)
      ? "reviewer-timeout"
      : "plan-output-unreadable";
    return {
      model,
      ran: false,
      skipReason,
      partialArtifactPath: entry.artifactPath,
      stderrTail: entry.stderrTail,
    };
  }
}

// --- Async spine (--start / --check) ----------------------------------------

type CheapGateResult =
  | { skip: true; skipReason: string }
  | { skip: false; plan: string; depth: "standard" | "deep" };

// Mirrors run()'s own default-mode cheap-gate sequence (config gate →
// plan-unreadable → no-decision-analysis → decision-analysis-unchanged →
// worktree-not-provided → worktree-not-found → depth), so --start's skip
// envelope is byte-identical to the worker's own early skips (S4). Owns NO
// scratch files — nothing has been written yet at this point, so there is
// nothing to clean up on a skip.
function evaluateStartGates(deps: Deps, args: Args): CheapGateResult {
  let rawConfig = "";
  try {
    rawConfig = deps.readConfig(args.config);
  } catch {
    rawConfig = "";
  }
  if (!isPlanReviewEnabled(rawConfig)) {
    return { skip: true, skipReason: "plan-review-disabled" };
  }

  let plan: string;
  try {
    plan = deps.readFile(args.planFile);
  } catch {
    return { skip: true, skipReason: "plan-unreadable" };
  }
  if (!hasDecisionAnalysis(plan)) {
    return { skip: true, skipReason: "no-decision-analysis" };
  }

  const priorHash = readPriorHash(plan);
  if (priorHash !== null && priorHash === computeDecisionHash(plan)) {
    return { skip: true, skipReason: "decision-analysis-unchanged" };
  }

  if (!args.worktree) {
    return { skip: true, skipReason: "worktree-not-provided" };
  }
  if (!deps.dirExists(args.worktree)) {
    return { skip: true, skipReason: "worktree-not-found" };
  }

  const depth = args.depth === "auto" ? computeDepth(plan) : args.depth;
  return { skip: false, plan, depth };
}

/**
 * `--start`: resolves every cheap gate synchronously and, on a pass,
 * detaches this same worker body via `flow-spawn --detach` (registry-
 * recorded) and writes a durable `planReview` anchor. Idempotent by
 * `(planFile, decisionHash)`: a live matching cycle re-attaches rather than
 * spawning a second worker (the exact contention `concurrency: 1` exists to
 * prevent); a live NON-matching cycle (a revision-pass redirect) is killed
 * FIRST, so a plan revision never leaves two concurrent agy sessions.
 */
function runStart(deps: Deps, args: Args): number {
  const gate = evaluateStartGates(deps, args);
  if (gate.skip) {
    return emit(deps, { ran: false, skipReason: gate.skipReason });
  }
  const { depth } = gate;

  const slug = resolveSlugFromEnv(deps.env);
  const decisionHash = computeDecisionHash(gate.plan);
  const runRecordPath = `${args.out}.run.json`;
  const workerStdoutPath = `${args.out}.worker-stdout.log`;
  const workerStderrPath = `${args.out}.worker-stderr.log`;

  const priorRecord = slug !== null ? deps.readStateRecord(slug) : undefined;
  if (priorRecord) {
    const matches =
      priorRecord.planFile === args.planFile &&
      priorRecord.decisionHash === decisionHash;
    const alive = deps.isAlive(priorRecord.pid, priorRecord.startEpoch);
    if (matches && alive) {
      return emit(deps, {
        status: "started",
        reattached: true,
        pid: priorRecord.pid,
        depth: priorRecord.depth,
        resultPath: priorRecord.resultPath,
      });
    }
    if (!matches && alive) {
      // Stale worker from a superseded plan revision — kill it FIRST. Left
      // unfixed, a revision-pass redirect leaves the OLD worker alive and
      // burning quota while the new one starts — two concurrent agy
      // sessions, precisely the contention concurrency:1 is measured to
      // lose a reviewer to.
      deps.killWorker(priorRecord.pid);
      deps.removeFile(priorRecord.resultPath);
      deps.removeFile(priorRecord.stderrPath);
    }
  }

  // Unconditionally clear any stale run-record file before spawning, not
  // only on the alive-and-superseded branch above. The common revision-pass
  // path is matches===false && alive===false (the prior worker already
  // finished and exited on its own): without this, --check would read the
  // PREVIOUS cycle's envelope out of runRecordPath and hand the supervisor a
  // stale `decided` verdict for a review that never ran on the revised plan
  // — and additionally kill the freshly spawned worker below because it
  // sees a result already present alongside a live pid.
  deps.removeFile(runRecordPath);
  deps.removeFile(`${runRecordPath}.tmp`);

  const spawned = deps.spawnDetached([
    "flow-spawn",
    "--detach",
    "--class",
    "default",
    "--stdout",
    workerStdoutPath,
    "--stderr",
    workerStderrPath,
    "--",
    "flow-plan-review",
    "--plan-file",
    args.planFile,
    "--out",
    args.out,
    "--worktree",
    args.worktree as string,
    "--depth",
    depth,
    "--config",
    args.config,
    "--task",
    args.task,
    "--result-file",
    runRecordPath,
  ]);
  if (spawned === null) {
    return emit(deps, { ran: false, skipReason: "plan-review-spawn-failed" });
  }

  if (slug !== null) {
    const record: PlanReviewRecord = {
      planFile: args.planFile,
      decisionHash,
      depth,
      startedAt: deps.now().toISOString(),
      pid: spawned.pid,
      startEpoch: deps.probeStartEpoch(spawned.pid),
      resultPath: runRecordPath,
      stderrPath: workerStderrPath,
      lastObservedAt: null,
      checks: 0,
    };
    deps.writeStateRecord(slug, record);
  }

  return emit(deps, {
    status: "started",
    reattached: false,
    pid: spawned.pid,
    depth,
    resultPath: runRecordPath,
  });
}

/**
 * `--check`: the one-shot decider that owns ALL state and ALL decisions.
 * `elapsedSec` always re-derives from `planReview.startedAt` (never from
 * this process's own age), so a suspended `--check` invocation can never
 * fabricate a false `review-timed-out`. Absent `FLOW_SLUG`, degrades to
 * stateless mode exactly as `flow-ci-check` documents (Q8): anchors reset
 * every call, the wall-clock cap can never fire, and the verdict rests
 * purely on result-file presence and worker liveness.
 */
function runCheck(deps: Deps, args: Args): number {
  const slug = resolveSlugFromEnv(deps.env);
  const stateless = slug === null;
  const record = stateless ? undefined : deps.readStateRecord(slug as string);

  if (!record) {
    return emit(deps, {
      status: "decided",
      ran: false,
      skipReason: "plan-review-not-started",
    });
  }

  // Result file present + parseable ⇒ decided, regardless of liveness — a
  // torn/partial read (the worker's write is tmp-then-rename, but belt-and-
  // braces here) is treated as still-waiting for one cycle rather than a
  // terminal verdict.
  let resultRaw: string | undefined;
  try {
    resultRaw = deps.readFile(record.resultPath);
  } catch {
    resultRaw = undefined;
  }
  if (resultRaw !== undefined) {
    let resultEnvelope: Record<string, unknown> | undefined;
    try {
      resultEnvelope = JSON.parse(resultRaw) as Record<string, unknown>;
    } catch {
      resultEnvelope = undefined;
    }
    if (resultEnvelope !== undefined) {
      if (deps.isAlive(record.pid, record.startEpoch)) {
        deps.killWorker(record.pid);
      }
      return emit(deps, { status: "decided", ...resultEnvelope });
    }
  }

  const alive = deps.isAlive(record.pid, record.startEpoch);
  const elapsedSec = stateless
    ? 0
    : Math.max(
        0,
        Math.floor(
          (deps.now().getTime() - Date.parse(record.startedAt)) / 1000,
        ),
      );

  if (alive) {
    // A live worker past the derived cap is exactly the hung-worker case the
    // cap exists for: agy's own --print-timeout can fail to land on a wedged
    // child, and without this branch --check reports `waiting` forever and the
    // worker is never reclaimed. Guarded on !stateless because stateless mode
    // has no durable anchor (elapsedSec is pinned at 0), so the cap must never
    // fire there — waiting longer is always safer than fabricating a timeout.
    if (!stateless && elapsedSec > maxElapsedSec(record.depth)) {
      deps.killWorker(record.pid);
      const hungTail = deps.readWorkerStderrTail(record.stderrPath);
      return emit(deps, {
        status: "decided",
        ran: false,
        skipReason: "review-timed-out",
        ...(hungTail ? { stderrTail: hungTail } : {}),
      });
    }
    if (!stateless) {
      deps.writeStateRecord(slug as string, {
        ...record,
        checks: record.checks + 1,
        lastObservedAt: deps.now().toISOString(),
      });
    }
    return emit(deps, {
      status: "waiting",
      nextCheckSec: 60,
      elapsedSec,
      pid: record.pid,
    });
  }

  // Stateless mode: never fires the wall-clock cap (there is no durable
  // anchor to derive it from) — the failure mode is waiting longer, never
  // fabricating a timeout.
  if (stateless) {
    return emit(deps, {
      status: "waiting",
      nextCheckSec: 60,
      elapsedSec: 0,
      pid: record.pid,
    });
  }

  if (elapsedSec > maxElapsedSec(record.depth)) {
    deps.killWorker(record.pid);
    const tail = deps.readWorkerStderrTail(record.stderrPath);
    return emit(deps, {
      status: "decided",
      ran: false,
      skipReason: "review-timed-out",
      ...(tail ? { stderrTail: tail } : {}),
    });
  }

  // Worker dead, no result: a named skip, never a hang.
  const tail = deps.readWorkerStderrTail(record.stderrPath);
  return emit(deps, {
    status: "decided",
    ran: false,
    skipReason: "reviewer-worker-died",
    ...(tail ? { stderrTail: tail } : {}),
  });
}

export function run(argv: string[], depsOverride?: Partial<Deps>): number {
  const deps = resolveDeps(depsOverride);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-plan-review: ${parsed.error}`);
    console.error(
      "usage: flow-plan-review --plan-file <path> --out <path> --worktree <dir> [--config <path>] [--task <name>] [--depth auto|standard|deep] [--result-file <path>]",
    );
    console.error("       flow-plan-review --print-hash --plan-file <path>");
    console.error(
      "       flow-plan-review --start --plan-file <path> --out <path> --worktree <dir> [--config <path>] [--task <name>] [--depth auto|standard|deep]",
    );
    console.error("       flow-plan-review --check --out <path>");
    return 2;
  }

  if (parsed.start) {
    return runStart(deps, parsed);
  }
  if (parsed.check) {
    return runCheck(deps, parsed);
  }

  // Compute-only mode: print the current plan's widened content-key hash
  // with no agy call and no config gate. Tolerant — an unreadable plan
  // hashes the empty body (exit 0). The supervisor runs this on the FINAL
  // plan (after it revises `## Decision analysis`/`## Cut list` per AGY
  // feedback) so the embedded marker reflects the revised body, not the
  // pre-revision body the ran:true envelope captured.
  if (parsed.printHash) {
    let plan = "";
    try {
      plan = deps.readFile(parsed.planFile);
    } catch {
      plan = "";
    }
    deps.writeOut(computeDecisionHash(plan));
    return 0;
  }

  // Gate: read the config tolerantly and enable only on strict boolean true.
  let rawConfig = "";
  try {
    rawConfig = deps.readConfig(parsed.config);
  } catch {
    rawConfig = "";
  }
  if (!isPlanReviewEnabled(rawConfig)) {
    return emit(deps, { ran: false, skipReason: "plan-review-disabled" });
  }

  // Resolved at call time (matching flow-gemini-lens / flow-gemini-intent-
  // guess), not at module load: a module-load read hits the real
  // ~/.flow/config.json before any test can inject an override, defeating
  // the injectable-config-reader seam and breaking `npm run verify` for a
  // maintainer with `delegate.models.planReview*` set. Non-null: only the
  // "scout" surface's default is null; planReview / planReviewSecond's
  // defaults and every well-typed override are strings.
  const MODEL = resolveDelegateModel("planReview") as string;
  const SECOND_MODEL = resolveDelegateModel("planReviewSecond") as string;

  // Scratch: the raw agy artifact (standard tier) and the deep-tier
  // manifest + fanout aggregate are all scratch siblings of --out; --out is
  // finalized only on a ran:true delegate/fanout so a skip never leaves a
  // stale feedback file.
  const rawPath = `${parsed.out}.agy-raw`;
  const promptPath = `${parsed.out}.prompt`;
  const promptPathR2 = `${parsed.out}.prompt.r2`;
  const manifestPath = `${parsed.out}.fanout-manifest.json`;
  const fanoutOutPath = `${parsed.out}.fanout.json`;
  const deepArtifactR1 = `${parsed.out}.r1.md`;
  const deepArtifactR2 = `${parsed.out}.r2.md`;
  deps.removeFile(parsed.out);
  // `runRecordPath`/`workerStderrPath` are NEVER part of this removal list
  // — the worker owns the first (it is what --check reads) and --start owns
  // the second, and both are diagnostics that outlive the run (they go with
  // .flow-tmp/ at step 10), never scratch this module cleans up itself.
  const cleanScratch = (retain: string[] = []) => {
    const retainSet = new Set(retain);
    for (const p of [
      promptPath,
      promptPathR2,
      rawPath,
      manifestPath,
      fanoutOutPath,
      deepArtifactR1,
      deepArtifactR2,
    ]) {
      if (!retainSet.has(p)) deps.removeFile(p);
    }
  };
  // Task 7 amends the skip-envelope invariant (see the file header): a skip
  // MAY additionally carry `partialArtifactPath`/`stderrTail`, both
  // omit-when-absent; `depth`/`reviewers` still NEVER appear on a skip.
  const skip = (
    skipReason: string,
    opts?: {
      retain?: string[];
      partialArtifactPath?: string;
      stderrTail?: string;
    },
  ): number => {
    cleanScratch(opts?.retain ?? []);
    const envelope: Record<string, unknown> = { ran: false, skipReason };
    if (opts?.partialArtifactPath) {
      envelope.partialArtifactPath = opts.partialArtifactPath;
    }
    if (opts?.stderrTail) envelope.stderrTail = opts.stderrTail;
    return finalizeAndEmit(deps, envelope, parsed.resultFile);
  };

  let plan: string;
  try {
    plan = deps.readFile(parsed.planFile);
  } catch {
    return skip("plan-unreadable");
  }
  if (!hasDecisionAnalysis(plan)) {
    return skip("no-decision-analysis");
  }

  // Revision-pass re-fire guard: skip the (expensive) delegate/fanout call
  // when the widened content key is unchanged (modulo formatting) since the
  // last reviewed revision. Computed BEFORE the prompt/delegate so a
  // matching hash never spends agy quota. A missing/malformed prior marker
  // re-fires.
  const priorHash = readPriorHash(plan);
  if (priorHash !== null && priorHash === computeDecisionHash(plan)) {
    return skip("decision-analysis-unchanged");
  }

  // Worktree gate: both tiers pass the repository itself as the sole
  // --add-dir (see below), so a reviewer can verify the plan's claims
  // against real code rather than assuming them. Placed AFTER the
  // printHash early return so --print-hash stays gate-free.
  if (!parsed.worktree) {
    return skip("worktree-not-provided");
  }
  if (!deps.dirExists(parsed.worktree)) {
    return skip("worktree-not-found");
  }

  const depth = parsed.depth === "auto" ? computeDepth(plan) : parsed.depth;

  try {
    deps.mkdirp(dirname(parsed.out));
    deps.writeFile(
      promptPath,
      buildBatteryPrompt({
        planText: plan,
        goalLine: extractGoalLine(plan),
        worktreePath: parsed.worktree,
      }),
    );
  } catch {
    return skip("plan-prep-failed");
  }

  if (depth === "standard") {
    const envelope = deps.runDelegate([
      "--prompt-file",
      promptPath,
      "--model",
      MODEL,
      "--add-dir",
      parsed.worktree,
      "--out",
      rawPath,
      "--task",
      parsed.task,
      "--timeout",
      REVIEWER_1_TIMEOUT,
    ]);

    // Branch on the `ran` field (NEVER the exit code): flow-delegate exits 0
    // even on a graceful agy-absent skip, propagated verbatim. Mapped
    // through mapReviewerSkipReason so a --print-timeout kill (agy-timeout)
    // surfaces as this module's own reviewer-timeout vocabulary; the raw
    // artifact is retained (when it exists) and named, and the delegate
    // envelope's own redacted stderrTail is propagated.
    if (!envelope.ran) {
      return skip(mapReviewerSkipReason(envelope.skipReason), {
        retain: [rawPath],
        partialArtifactPath: deps.fileExists(rawPath) ? rawPath : undefined,
        stderrTail: envelope.stderrTail,
      });
    }

    let raw: string;
    try {
      raw = deps.readFile(envelope.artifactPath ?? rawPath);
    } catch {
      return skip("plan-output-unreadable");
    }

    // The standard tier has only one reviewer, so a non-engaging/empty
    // reviewer degrades the WHOLE run to a skip — there is no second
    // reviewer to fall back to, unlike the deep tier's per-reviewer
    // demotion below.
    const eng = classifyEngagement(raw);
    if (!eng.engaged) {
      // EngagementResult is a discriminated union: engaged:false guarantees
      // a present `reason`, so no non-null assertion is needed here.
      return skip(eng.reason);
    }

    try {
      deps.writeFile(parsed.out, raw);
    } catch {
      return skip("plan-finalize-failed");
    }

    cleanScratch();
    // Deliberately NOT emitting the pre-revision hash: the supervisor
    // re-embeds the marker from `--print-hash` run on the FINAL (revised)
    // plan, so a hash of the pre-revision body here would only invite a
    // stale-marker embed. `depth`/`reviewers` ARE emitted here as well as on
    // the deep path: step 3's chat summary is told to record the resolved
    // depth, so a standard run that omitted the field would be
    // indistinguishable from a pre-upgrade helper. Skip envelopes still carry
    // neither field — `ran:false` has no tier to report.
    return finalizeAndEmit(
      deps,
      {
        ran: true,
        feedbackPath: parsed.out,
        skipReason: null,
        depth: "standard",
        reviewers: [
          {
            model: MODEL,
            ran: true,
            skipReason: null,
            lensesEngaged: eng.lensesEngaged,
          },
        ],
      },
      parsed.resultFile,
    );
  }

  // --- DEEP tier: two reviewers via flow-delegate-fanout ---------------------
  //
  // We deliberately do NOT direct-Bun.spawn two flow-delegate calls: `run` is
  // synchronous and `import.meta.main` does `process.exit(run(...))`, so a
  // direct-spawn conversion would force an async rewrite touching every
  // existing synchronous call site. `flow-delegate-fanout` already solves
  // "run N flow-delegate calls concurrently, aggregate one JSON" without
  // requiring this module to become async, and — just as importantly — its
  // per-entry indexed artifact paths avoid both direct spawns writing to the
  // SAME `${rawPath}` and silently clobbering the first reviewer's output.
  const addDirs = [parsed.worktree];
  try {
    // Reviewer 2 is the SAME model family as the PRD's author (flow's PRDs
    // are drafted by the Claude discovery subagent, and SECOND_MODEL is
    // Claude too), so it gets its own prompt file with the opener's premise
    // swapped rather than the byte-identical prompt handed to reviewer 1.
    deps.writeFile(
      promptPathR2,
      buildBatteryPrompt({
        planText: plan,
        goalLine: extractGoalLine(plan),
        sameFamilyAsAuthor: true,
        worktreePath: parsed.worktree,
      }),
    );
  } catch {
    return skip("plan-prep-failed");
  }

  const manifest: DeepManifestEntry[] = [
    {
      task: `${parsed.task}-r1`,
      model: MODEL,
      promptFile: promptPath,
      addDirs,
      out: deepArtifactR1,
      timeout: REVIEWER_1_TIMEOUT,
    },
    {
      task: `${parsed.task}-r2`,
      model: SECOND_MODEL,
      promptFile: promptPathR2,
      addDirs,
      out: deepArtifactR2,
      timeout: REVIEWER_2_TIMEOUT,
    },
  ];

  try {
    deps.writeFile(manifestPath, JSON.stringify(manifest));
  } catch {
    return skip("plan-prep-failed");
  }

  // concurrency 1 — SERIAL, and load-bearing. Measured live on this repo:
  // with both reviewers now reading the repository, two simultaneous agy
  // sessions contend and one dies — 3/3 concurrent deep runs lost Gemini
  // (twice `reviewer-empty`, once `agy-error`) while the SAME reviewer
  // succeeded 4/4 when it was the only agy session running. Serialising
  // took the run to 2/2 reviewers engaged at 6/6 lenses each, in 6m27s.
  // Raising this back to 2 re-breaks the deep tier's whole premise: it
  // silently reduces a paid two-reviewer review to one, which is the exact
  // defect this helper was fixed to eliminate. REVIEW_TIMEOUT is sized
  // against this serialisation (see its comment).
  const aggregate = deps.runFanout({
    manifestPath,
    outPath: fanoutOutPath,
    concurrency: 1,
  });
  const entries = aggregate.entries ?? [];
  const r1 = resolveReviewer(
    deps,
    entries.find((e) => e.task === manifest[0]!.task),
    MODEL,
    godurToSec(REVIEWER_1_TIMEOUT),
  );
  const r2 = resolveReviewer(
    deps,
    entries.find((e) => e.task === manifest[1]!.task),
    SECOND_MODEL,
    godurToSec(REVIEWER_2_TIMEOUT),
  );

  // `survivors` is a resolveReviewer() output, and resolveReviewer() now
  // demotes a non-engaging/empty reviewer to `ran:false` (see above) — so
  // `survivors.length === 2` means "two GENUINELY ENGAGED reviewers", not
  // merely "two agy calls that returned artifacts". A later refactor must
  // not quietly re-admit a demoted (phantom) reviewer into this count, or
  // the convergence rule below would apply to input one of the two never
  // actually engaged with.
  const survivors = [r1, r2].filter((r) => r.ran);
  if (survivors.length === 0) {
    // Both reviewers skipped: propagate the FIRST reviewer's skip reason
    // exactly as a standard-tier skip would (same envelope shape — no
    // `depth`/`reviewers` fields on a skip, ever), retaining both
    // reviewers' artifacts and surfacing the FIRST reviewer's diagnostics.
    return skip(r1.skipReason ?? r2.skipReason ?? "agy-not-found", {
      retain: [deepArtifactR1, deepArtifactR2],
      partialArtifactPath: r1.partialArtifactPath ?? r2.partialArtifactPath,
      stderrTail: r1.stderrTail ?? r2.stderrTail,
    });
  }

  // A partial deep success (one reviewer ran, one skipped/demoted) still
  // needs the failed reviewer's transcript retained — cleanScratch below is
  // told about it, and its path/tail are added to that reviewer's
  // `reviewers[]` entry.
  const failedReviewer =
    survivors.length === 1 ? (survivors[0] === r1 ? r2 : r1) : undefined;

  const combined =
    survivors.length === 2
      ? [
          CONVERGENCE_PREAMBLE,
          "",
          `## Reviewer 1 — ${r1.model}`,
          "",
          (r1.prose ?? "").trim(),
          "",
          `## Reviewer 2 — ${r2.model}`,
          "",
          (r2.prose ?? "").trim(),
        ].join("\n")
      : (survivors[0]!.prose ?? "");

  try {
    deps.writeFile(parsed.out, combined);
  } catch {
    return skip("plan-finalize-failed");
  }

  cleanScratch(
    failedReviewer?.partialArtifactPath
      ? [failedReviewer.partialArtifactPath]
      : [],
  );
  return finalizeAndEmit(
    deps,
    {
      ran: true,
      feedbackPath: parsed.out,
      skipReason: null,
      depth: "deep",
      reviewers: [
        {
          model: r1.model,
          ran: r1.ran,
          skipReason: r1.skipReason,
          lensesEngaged: r1.lensesEngaged,
          ...(r1.partialArtifactPath
            ? { partialArtifactPath: r1.partialArtifactPath }
            : {}),
          ...(r1.stderrTail ? { stderrTail: r1.stderrTail } : {}),
        },
        {
          model: r2.model,
          ran: r2.ran,
          skipReason: r2.skipReason,
          lensesEngaged: r2.lensesEngaged,
          ...(r2.partialArtifactPath
            ? { partialArtifactPath: r2.partialArtifactPath }
            : {}),
          ...(r2.stderrTail ? { stderrTail: r2.stderrTail } : {}),
        },
      ],
    },
    parsed.resultFile,
  );
}

function resolveDeps(o?: Partial<Deps>): Deps {
  return {
    readConfig: o?.readConfig ?? ((p) => readFileSync(p, "utf8")),
    runDelegate:
      o?.runDelegate ??
      ((argv) => {
        try {
          const r = Bun.spawnSync(["flow-delegate", ...argv], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          });
          const stdout = r.stdout ? new TextDecoder().decode(r.stdout) : "";
          const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
          return JSON.parse(line) as DelegateEnvelope;
        } catch {
          return { ran: false, skipReason: "agy-error" };
        }
      }),
    runFanout:
      o?.runFanout ??
      ((input) => {
        try {
          const r = Bun.spawnSync(
            [
              "flow-delegate-fanout",
              "--manifest",
              input.manifestPath,
              "--concurrency",
              String(input.concurrency),
              "--out",
              input.outPath,
            ],
            { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
          );
          const stdout = r.stdout ? new TextDecoder().decode(r.stdout) : "";
          const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
          return JSON.parse(line) as FanoutAggregate;
        } catch {
          return { allSkipped: true, entries: [] };
        }
      }),
    readFile: o?.readFile ?? ((p) => readFileSync(p, "utf8")),
    writeFile: o?.writeFile ?? ((p, c) => writeFileSync(p, c)),
    removeFile: o?.removeFile ?? ((p) => void rmSync(p, { force: true })),
    renameFile: o?.renameFile ?? ((from, to) => renameSync(from, to)),
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    writeOut: o?.writeOut ?? ((line) => console.log(line)),
    dirExists:
      o?.dirExists ?? ((p) => existsSync(p) && statSync(p).isDirectory()),
    fileExists: o?.fileExists ?? ((p) => existsSync(p)),

    spawnDetached:
      o?.spawnDetached ??
      ((argv) => {
        try {
          const r = Bun.spawnSync(argv, {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          });
          if (r.exitCode !== 0) return null;
          const stdout = r.stdout ? new TextDecoder().decode(r.stdout) : "";
          const pid = parseInt(stdout.trim(), 10);
          return Number.isFinite(pid) ? { pid } : null;
        } catch {
          return null;
        }
      }),
    probeStartEpoch: o?.probeStartEpoch ?? ((pid) => pidStartEpoch(pid)),
    readStateRecord:
      o?.readStateRecord ??
      ((slug) => readState(slug, FLOW_STATE_DIR)?.planReview),
    writeStateRecord:
      o?.writeStateRecord ??
      ((slug, rec) => {
        const base = readState(slug, FLOW_STATE_DIR);
        // Fail-open, mirroring flow-ci-check's persistRecord: no readable
        // state file means this call's anchors simply do not persist —
        // never a crash, never a fabricated state file.
        if (base === null) return;
        writeState({ ...base, planReview: rec }, FLOW_STATE_DIR);
      }),
    isAlive:
      o?.isAlive ??
      ((pid, startEpoch) =>
        isLive({ pid, procStartedAt: startEpoch ?? undefined })),
    killWorker:
      o?.killWorker ??
      ((pid) => {
        // A detached worker is its own process-group leader (flow-spawn.ts
        // records pgid: args.pid), and the quota-burning descendant is
        // several hops down (flow-delegate-fanout -> flow-delegate -> agy),
        // not the worker shell itself. SIGTERM to the bare pid only kills
        // the shell blocked in Bun.spawnSync, leaving the wedged agy
        // session reparented to init and running to its own --print-timeout
        // — exactly the "two concurrent agy sessions" contention this call
        // site exists to prevent. Signal the whole group first.
        forwardSignal(pid, pid, "SIGTERM");
      }),
    now: o?.now ?? (() => new Date()),
    env: o?.env ?? process.env,
    readWorkerStderrTail:
      o?.readWorkerStderrTail ??
      ((p) => {
        try {
          return redactedStderrTail(readFileSync(p, "utf8"));
        } catch {
          return "";
        }
      }),
  };
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
