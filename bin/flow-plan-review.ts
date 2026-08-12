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
 * `plan-output-unreadable`, `plan-finalize-failed`. A DEEP run where BOTH
 * reviewers skip (including both demoted for non-engagement) propagates the
 * FIRST reviewer's skip reason exactly as a standard-tier skip would — the
 * envelope shape for every skip path is unchanged from the single-reviewer
 * era; `depth`/`reviewers` are additive fields that appear on every
 * `ran:true` envelope — `depth:"standard"` with a single reviewer entry on
 * the standard tier, `depth:"deep"` with two on the deep tier (a partial
 * deep failure — one reviewer ran, one skipped/demoted — is also `ran:true`,
 * degraded to the surviving reviewer's prose, with the failed reviewer's
 * skip reason recorded in its `reviewers[]` entry, which also carries each
 * reviewer's `lensesEngaged` count out of 6). A `ran:false` skip carries
 * neither field, so every skip envelope stays byte-identical to the
 * single-reviewer era. Exit 2 only on a usage error.
 *
 * The convergence preamble (below) requires TWO GENUINELY ENGAGED reviewers
 * — see the `survivors` computation in the deep-tier branch for the
 * authoritative statement of that invariant.
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

export { extractGoalLine };

const DEFAULT_TASK = "plan-review";

// Bounds each agy call explicitly rather than relying on flow-delegate's own
// default: bounded ABOVE by the supervisor's 600000 ms (10m) Bash-tool
// ceiling (the caller must pass an explicit `timeout: 600000` to the Bash
// tool call that invokes this helper — see flow-pipeline/SKILL.md step 3),
// and bounded BELOW by what an agentic six-lens run actually needs (measured
// live against this repo: ~1m35-1m50 for Gemini/reviewer 1, ~4m30-4m50 for
// Opus/reviewer 2).
//
// The deep tier runs its two reviewers SERIALLY (see the fanout call's
// `concurrency: 1` and the comment there), so the ceiling constrains the
// SUM, not the max. A symmetric 2 x 5m = 10m split left ZERO real margin
// once four bun startups and two agy spawns are counted — it exactly
// equalled the ceiling, not stayed under it. Split ASYMMETRICALLY instead,
// sized to the measured durations: reviewer 1 (Gemini, fast) gets 3m,
// reviewer 2 (Opus, slow) gets 6m. INVARIANT: the sum must stay <= 9m,
// never == 10m — leaving ~60s of real margin under the 600000 ms ceiling
// while also raising Opus's own headroom from ~10s to ~70s. The standard
// tier runs only reviewer 1 (MODEL, i.e. Gemini), so it uses the
// REVIEWER_1_TIMEOUT value.
const REVIEWER_1_TIMEOUT = "3m";
const REVIEWER_2_TIMEOUT = "6m";

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
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // --print-hash is a valueless boolean (compute-only mode); handle it before
    // the value-required check every other flag falls through to.
    if (flag === "--print-hash") {
      out.printHash = true;
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
  if (out.planFile === undefined) {
    return { error: "--plan-file is required" };
  }
  // --out gates the review mode only; --print-hash needs just --plan-file.
  if (!out.printHash && out.out === undefined) {
    return { error: "--out is required" };
  }
  return {
    planFile: out.planFile,
    out: out.out ?? "",
    config: out.config ?? `${homedir()}/.flow/config.json`,
    task: out.task ?? DEFAULT_TASK,
    printHash: out.printHash ?? false,
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
  const combined = [goalLine, decisionBody, cutListBody].join("\n \n");
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
  mkdirp: (dir: string) => void;
  writeOut: (line: string) => void;
  // True when `path` exists and is a directory. Backs the worktree gate
  // below; injectable like the other deps.
  dirExists: (path: string) => boolean;
};

function emit(deps: Deps, envelope: Record<string, unknown>): number {
  deps.writeOut(JSON.stringify(envelope));
  return 0;
}

type ReviewerStatus = {
  model: string;
  ran: boolean;
  skipReason?: string;
  prose?: string;
  lensesEngaged?: number;
};

type FanoutEntry = NonNullable<FanoutAggregate["entries"]>[number];

// Resolves one deep-tier manifest entry's fanout result into a reviewer
// status: a skipped/missing entry stays unread; a `ran:true` entry whose
// artifact can't be read degrades to a skip rather than crashing the run;
// a `ran:true` entry whose prose doesn't clear the engagement bar (empty or
// non-engaging) is demoted to a skip too — a truncated/rubber-stamp run is
// not a genuine survivor for the deep-tier convergence rule.
function resolveReviewer(
  deps: Deps,
  entry: FanoutEntry | undefined,
  model: string,
): ReviewerStatus {
  if (!entry || entry.ran !== true) {
    return {
      model,
      ran: false,
      skipReason: entry?.skipReason ?? "agy-not-found",
    };
  }
  try {
    const prose = deps.readFile(entry.artifactPath ?? "");
    const result = classifyEngagement(prose);
    if (!result.engaged) {
      return {
        model,
        ran: false,
        skipReason: result.reason,
        lensesEngaged: result.lensesEngaged,
      };
    }
    return { model, ran: true, prose, lensesEngaged: result.lensesEngaged };
  } catch {
    return { model, ran: false, skipReason: "plan-output-unreadable" };
  }
}

export function run(argv: string[], depsOverride?: Partial<Deps>): number {
  const deps = resolveDeps(depsOverride);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-plan-review: ${parsed.error}`);
    console.error(
      "usage: flow-plan-review --plan-file <path> --out <path> --worktree <dir> [--config <path>] [--task <name>] [--depth auto|standard|deep]",
    );
    console.error("       flow-plan-review --print-hash --plan-file <path>");
    return 2;
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
  const cleanScratch = () => {
    deps.removeFile(promptPath);
    deps.removeFile(promptPathR2);
    deps.removeFile(rawPath);
    deps.removeFile(manifestPath);
    deps.removeFile(fanoutOutPath);
    deps.removeFile(deepArtifactR1);
    deps.removeFile(deepArtifactR2);
  };
  const skip = (skipReason: string): number => {
    cleanScratch();
    return emit(deps, { ran: false, skipReason });
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
    // even on a graceful agy-absent skip, propagated verbatim.
    if (!envelope.ran) {
      return skip(envelope.skipReason ?? "agy-not-found");
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
    return emit(deps, {
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
    });
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
  );
  const r2 = resolveReviewer(
    deps,
    entries.find((e) => e.task === manifest[1]!.task),
    SECOND_MODEL,
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
    // `depth`/`reviewers` fields on a skip, ever).
    return skip(r1.skipReason ?? r2.skipReason ?? "agy-not-found");
  }

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

  cleanScratch();
  return emit(deps, {
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
      },
      {
        model: r2.model,
        ran: r2.ran,
        skipReason: r2.skipReason,
        lensesEngaged: r2.lensesEngaged,
      },
    ],
  });
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
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    writeOut: o?.writeOut ?? ((line) => console.log(line)),
    dirExists:
      o?.dirExists ?? ((p) => existsSync(p) && statSync(p).isDirectory()),
  };
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
