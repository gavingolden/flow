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
 * This table is the single source of every agy model default; skills and
 * docs name the step and its config key, never a model
 * (`model-name-literal-lint.test.ts` enforces it). Flip a default here once
 * a recorded run clears a (surface, candidate) pair.
 */

import {
  defaultReadConfigFile,
  REVIEW_LENS_NAMES,
  type ReadConfigFile,
  type ReviewLensName,
} from "./models-config";

export type DelegateSurface =
  | "intentGuess"
  | "reviewLens"
  | "researchGather"
  | "researchRefute"
  | "planReview"
  | "planReviewSecond"
  | "blindSurvey"
  | "blindSurveySecond"
  | "scout"
  | "claudeLenses"
  | "lensReroute"
  | "researchRefuteFallback";

// planReviewSecond corrects the plan's false claim that flow-plan-review.ts
// carries no model constant: it carries two (MODEL + SECOND_MODEL), and the
// second (deep-tier) reviewer needs its own config slot.
export const DELEGATE_MODEL_DEFAULTS: Record<DelegateSurface, string | null> = {
  // Evidence: docs/eval/carbon-4-smoke-2026-11.md (a smoke of time and
  // non-emptiness, n=1 per step) decides Carbon vs Argon per step; prior
  // quality evidence is docs/eval/argon-4-routing-2026-10.md. Carbon Medium
  // where the smoke gate passed; a step that failed keeps its pre-Carbon
  // default; full Carbon evaluation pending a separate eval.
  intentGuess: "Gemini 4 Carbon (Medium)",
  researchGather: "Gemini 4 Carbon (Medium)",
  blindSurvey: "Gemini 4 Carbon (Medium)",
  planReview: "Gemini 4 Carbon (Medium)",
  reviewLens: "Gemini 4 Argon (High)",
  // The Gemini re-run of a Claude review lens the content filter refused.
  lensReroute: "Gemini 4 Argon (Medium)",
  // Structural holds: the adversarial / second voter must be a different
  // vendor from its Gemini counterpart, whatever any bench says.
  researchRefute: "Claude Opus 5.5 (Medium)",
  planReviewSecond: "Claude Opus 5.5 (High)",
  blindSurveySecond: "Claude Opus 5.5 (High)",
  // Second refute voter, and the stand-in refuter when researchRefute
  // collides with researchGather.
  researchRefuteFallback: "GPT-OSS 120B (Medium)",
  // null means "use the Claude Task subagent" rather than delegating
  // scouting to an agy variant; setting it runs flow-agy-scout first.
  scout: null,
  // null means "delegation off": every Claude review lens runs as a Task
  // agent. The opt-in is `delegate.lenses`.
  claudeLenses: null,
};

// The seven real review lenses; intent-guess is a second artifact shape with
// its own consumer and is deliberately not delegatable.
export type DelegatableLens = Exclude<ReviewLensName, "intent-guess">;

export const DELEGATABLE_LENSES: readonly DelegatableLens[] =
  REVIEW_LENS_NAMES.filter((l): l is DelegatableLens => l !== "intent-guess");

// The lenses whose recorded recall check cleared — none as of 2026-10-06
// (docs/eval/agy-delegation-recall-2026-10.json; delegate-models.test.ts
// pins this list to the record). A user opts lenses in through
// `delegate.lenses`.
export const DEFAULT_DELEGATED_LENSES: readonly DelegatableLens[] = [];

// Fixed per-run agy budgets for the delegated Claude lenses and scout (not
// configurable; see delegate-timeouts.ts for the configurable surfaces and
// their 20m sanity bound).
export const DELEGATED_LENS_TIMEOUT = "8m";
export const DELEGATED_SCOUT_TIMEOUT = "8m";

// Fires at most once per surface per process. Without this, a maintainer
// who pinned a surface months ago via config would keep silently overriding
// a later PR's code-default flip with no visible signal in the logs.
const warnedOverrideSurfaces = new Set<DelegateSurface>();
const warnedTypeSurfaces = new Set<DelegateSurface>();
const warnedClaudeReroute = new Set<DelegateSurface>();

export function extractDelegateModelsKey(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  const delegate = (raw as Record<string, unknown>).delegate;
  if (typeof delegate !== "object" || delegate === null) return undefined;
  const models = (delegate as Record<string, unknown>).models;
  if (typeof models !== "object" || models === null) return undefined;
  return (models as Record<string, unknown>)[key];
}

/**
 * Resolves the agy variant string (or `null` for the scout / claudeLenses
 * surfaces, meaning "use the Claude Task agent") for a given delegate
 * surface: `delegate.models.<surface>` from `~/.flow/config.json` when
 * present and well-typed, else the seeded default. Never throws — a missing
 * file, malformed JSON, absent key, or wrong-typed value all collapse to the
 * default (the last case also warns on stderr once).
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

  if (isIgnoredOverride(surface, value)) {
    if (!warnedClaudeReroute.has(surface)) {
      warnedClaudeReroute.add(surface);
      console.error(
        `delegate.models.lensReroute: '${value}' is a Claude model, but the ` +
          `re-run exists because Claude refused the lens; ignoring and ` +
          `using the default.`,
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

let warnedLensesType = false;
const warnedLensNames = new Set<string>();

/**
 * Resolves the set of review lenses to delegate to agy: `delegate.lenses`
 * from `~/.flow/config.json` (an array of known lens names) else
 * DEFAULT_DELEGATED_LENSES. Unknown entries (including `intent-guess`) warn
 * once and drop; a wrong-typed value warns once and returns the default.
 * Never throws.
 */
export function resolveDelegatedLenses(
  readConfigFile: ReadConfigFile = defaultReadConfigFile,
): DelegatableLens[] {
  const raw = readConfigFile();
  const delegate =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>).delegate
      : undefined;
  const value =
    typeof delegate === "object" && delegate !== null
      ? (delegate as Record<string, unknown>).lenses
      : undefined;

  if (value === undefined) return [...DEFAULT_DELEGATED_LENSES];

  if (!Array.isArray(value)) {
    if (!warnedLensesType) {
      warnedLensesType = true;
      console.error(
        `delegate.lenses: '${String(value)}' is not an array of lens names; ` +
          `ignoring and using the default.`,
      );
    }
    return [...DEFAULT_DELEGATED_LENSES];
  }

  const out: DelegatableLens[] = [];
  for (const entry of value) {
    const known = DELEGATABLE_LENSES.find((l) => l === entry);
    if (known === undefined) {
      const key = String(entry);
      if (!warnedLensNames.has(key)) {
        warnedLensNames.add(key);
        console.error(
          `delegate.lenses: '${key}' is not a delegatable review lens ` +
            `(${DELEGATABLE_LENSES.join(", ")}); ignoring it.`,
        );
      }
      continue;
    }
    if (!out.includes(known)) out.push(known);
  }
  return out;
}

/** True for a Claude-family agy variant; the one rule both the lens schema and the refusal re-run key off. */
export function isClaudeModel(model: string): boolean {
  return /claude/i.test(model);
}

/** A configured override the runtime drops: a Claude re-run model would just be refused again. */
export function isIgnoredOverride(
  surface: DelegateSurface,
  value: string,
): boolean {
  return surface === "lensReroute" && isClaudeModel(value);
}
