/**
 * Tolerant per-surface resolver for `~/.flow/config.json`'s `delegate.models`
 * table.
 *
 * NAMESPACE NOTE: `config.models.scout` (see `models-config.ts`) ALREADY
 * EXISTS meaning "the Claude Code model alias for the Step-1b Task
 * subagent" (a `MODEL_ALIASES` value, e.g. "sonnet"). `config.delegate
 * .models.scout` means something else entirely: "delegate scouting to this
 * agy variant instead of spawning the Claude Task subagent" (an agy
 * display-name string, e.g. "Gemini 3.1 Pro (High)"). Same key suffix,
 * opposite meanings, disjoint value grammars — see docs/configuration.md
 * for both rows side by side.
 *
 * Reuses `models-config.ts`'s `ReadConfigFile` / `defaultReadConfigFile`
 * seam (tolerant boundary read, injectable for tests) but deliberately does
 * NOT reuse `readPhaseModel` — that function validates against Claude's
 * `MODEL_ALIASES` enum and would silently drop a well-formed agy variant
 * string like "Gemini 3.1 Pro (High)".
 *
 * Every default seeded here started BYTE-IDENTICAL to the surface's own
 * file (verified against source when this module was written;
 * `delegate-models.test.ts` pins the check so a drive-by constant edit
 * that forgets this module fails loudly). This module is the seam for
 * flipping individual defaults once a recorded benchmark clears a
 * (surface, candidate) pair — see `researchRefute`'s inline comment below
 * for why the PR #543 bench run (2026-08-05) did NOT flip that default.
 */

import { defaultReadConfigFile, type ReadConfigFile } from "./models-config";

export type DelegateSurface =
  | "intentGuess"
  | "reviewLens"
  | "researchGather"
  | "researchRefute"
  | "planReview"
  | "planReviewSecond"
  | "blindSurvey"
  | "blindSurveySecond"
  | "scout";

// planReviewSecond corrects the plan's false claim that flow-plan-review.ts
// carries no model constant: it carries two (MODEL + SECOND_MODEL), and the
// second (deep-tier) reviewer needs its own config slot.
export const DELEGATE_MODEL_DEFAULTS: Record<DelegateSurface, string | null> = {
  intentGuess: "Gemini 3.1 Pro (High)",
  reviewLens: "Gemini 3.1 Pro (High)",
  researchGather: "Gemini 3.1 Pro (High)",
  // NO FLIP (evaluated 2026-08-05, PR #543): both Gemini candidates
  // cleared research-refute on the hardened c8 fixture at N=10, and the
  // recommendation tie-break nominally preferred 3.1 Pro — NOT Flash.
  // 3.1 Pro can't be deployed: researchGather's default is already
  // "Gemini 3.1 Pro (High)", and a string-identical refute default trips
  // flow-research-run.ts' resolveModels cross-model diversity guard,
  // silently downgrading the runtime refuter to the wholly unbenched
  // FALLBACK_REFUTE_MODEL ("GPT-OSS 120B (Medium)"). Deploying the
  // non-preferred Flash variant instead was rejected too: c8 is weakly
  // discriminating (spread 0.100 schema / 0.020 free-form) and
  // research-refute is a critique-shaped surface — exactly the shape
  // where both candidates failed hardest (c9a recall 0.00 vs incumbent
  // 0.70). So the incumbent stands. A maintainer who wants a Gemini
  // refuter anyway can set delegate.models.researchRefute — no code
  // change needed — and an agy-delegated refuter keeps the spend on the
  // Google-AI-Ultra subscription either way.
  // RE-CHECKED, STILL NO FLIP (2026-08-17 run, gemini-3.7-flash-high):
  // 3.7 Flash reached c9a-pushback-wrong parity (its critique reject moved
  // to c9b, 0.90 vs 1.00), so the pushback-deficit premise above no longer
  // holds for it — but its research-refute verdict is a latency reject
  // (median 25.30s, not <= 60% of the incumbent's 40.53s) and recommend()
  // still nominates 3.1 Pro, which the diversity guard still blocks.
  researchRefute: "Claude Opus 4.6 (Thinking)",
  // FLIPPED (2026-08-17 run): gemini-3.7-flash-high cleared every
  // plan-review gate on c6-plan-review at N=10 (no defect regression,
  // mechanical parity, structured integrity, reliability, real latency
  // payoff) and recommend()'s quality-gated tie-break nominated it over
  // 3.1 Pro's clear — docs/model-bench/verdicts.json. Cross-model
  // diversity vs planReviewSecond (Claude Opus) is preserved.
  planReview: "Gemini 3.7 Flash (High)",
  // Does NOT flip despite plan-review's gemini-3.1-pro-high clear (same
  // bench run): the deep-tier second reviewer exists for cross-model
  // diversity against the Gemini first reviewer (the convergence rule
  // presumptively accepts points BOTH reviewers raise independently); two
  // same-family reviewers would hollow that rule out. The clear is
  // recorded here; the diversity rationale governs the default.
  planReviewSecond: "Claude Opus 4.6 (Thinking)",
  // Pinned judges for the Step-3 blind method survey (flow-blind-survey):
  // the dogfood run's judge A rode the unpinned agy session default, so
  // both surfaces are pinned here rather than left to whatever agy
  // resolves at invocation time.
  blindSurvey: "Gemini 3.1 Pro (High)",
  blindSurveySecond: "Claude Opus 4.6 (Thinking)",
  // null means "use the Claude Task subagent" (today's behaviour) rather
  // than delegating scouting to an agy variant. Both bench candidates were
  // rejected on a real-defect regression (c2b, docs/model-bench/report.md,
  // 2026-08-05) — null stays the verdict-consistent default.
  scout: null,
};

// Fires at most once per surface per process. Without this, a maintainer
// who pinned a surface months ago via config would keep silently overriding
// a later PR's code-default flip with no visible signal in the logs.
const warnedOverrideSurfaces = new Set<DelegateSurface>();
const warnedTypeSurfaces = new Set<DelegateSurface>();

function extractDelegateModelsKey(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  const delegate = (raw as Record<string, unknown>).delegate;
  if (typeof delegate !== "object" || delegate === null) return undefined;
  const models = (delegate as Record<string, unknown>).models;
  if (typeof models !== "object" || models === null) return undefined;
  return (models as Record<string, unknown>)[key];
}

/**
 * Resolves the agy variant string (or `null` for the scout Task-subagent
 * fallback) for a given delegate surface: `delegate.models.<surface>` from
 * `~/.flow/config.json` when present and well-typed, else the seeded
 * default. Never throws — a missing file, malformed JSON, absent key, or
 * wrong-typed value all collapse to the default (the last case also warns
 * on stderr once).
 */
export function resolveDelegateModel(
  surface: DelegateSurface,
  readConfigFile: ReadConfigFile = defaultReadConfigFile,
): string | null {
  const defaultValue = DELEGATE_MODEL_DEFAULTS[surface];
  const raw = readConfigFile();
  const value = extractDelegateModelsKey(raw, surface);

  if (value === undefined) return defaultValue;

  if (typeof value !== "string" || value.trim() === "") {
    if (!warnedTypeSurfaces.has(surface)) {
      warnedTypeSurfaces.add(surface);
      console.error(
        `delegate.models.${surface}: '${String(value)}' is not a valid ` +
          `model string; ignoring and using the default.`,
      );
    }
    return defaultValue;
  }

  if (value !== defaultValue && !warnedOverrideSurfaces.has(surface)) {
    warnedOverrideSurfaces.add(surface);
    console.error(
      `delegate.models.${surface}: config override active -> ${value}`,
    );
  }

  return value;
}
