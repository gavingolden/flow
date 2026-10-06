/**
 * Pure helpers for `flow doctor`'s check that every agy model flow is
 * configured to use is still offered by `agy models`.
 */

import {
  DELEGATE_MODEL_DEFAULTS,
  extractDelegateModelsKey,
  type DelegateSurface,
} from "./delegate-models";

export type ConfiguredModel = { surface: string; model: string };

const nonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

const SURFACE_LABELS: Record<string, string> = {
  intentGuess: "intent guessing",
  reviewLens: "review lenses",
  researchGather: "research gathering",
  researchRefute: "research fact-check",
  planReview: "plan review's first reviewer",
  planReviewSecond: "plan review's second reviewer",
  blindSurvey: "method survey's first judge",
  blindSurveySecond: "method survey's second judge",
  claudeLenses: "the delegated Claude review lenses",
  "research.model": "research gathering",
  "research.refuteModel": "research fact-check",
};

export const surfaceLabel = (surface: string): string =>
  SURFACE_LABELS[surface] ?? surface;

// Resolves without `resolveDelegateModel` so a doctor run never emits its
// once-per-process "config override active" stderr notice. `scout` is skipped
// (no runtime path consumes it); a `research.model`/`research.refuteModel`
// override replaces the delegate surface it shadows, mirroring
// flow-research-run's `resolveModels` precedence.
export function configuredAgyModels(raw: unknown): ConfiguredModel[] {
  const out: ConfiguredModel[] = [];
  const research =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>).research
      : undefined;
  const legacy = (key: "model" | "refuteModel"): string | null => {
    const v =
      typeof research === "object" && research !== null
        ? (research as Record<string, unknown>)[key]
        : undefined;
    return nonEmptyString(v) ? v : null;
  };
  const shadowing: Record<string, ["model" | "refuteModel", string]> = {
    researchGather: ["model", "research.model"],
    researchRefute: ["refuteModel", "research.refuteModel"],
  };
  for (const surface of Object.keys(DELEGATE_MODEL_DEFAULTS)) {
    if (surface === "scout") continue;
    const shadow = shadowing[surface];
    const legacyValue = shadow ? legacy(shadow[0]) : null;
    if (shadow && legacyValue !== null) {
      out.push({ surface: shadow[1], model: legacyValue });
      continue;
    }
    const override = extractDelegateModelsKey(raw, surface);
    const model = nonEmptyString(override)
      ? override
      : DELEGATE_MODEL_DEFAULTS[surface as DelegateSurface];
    if (model !== null) out.push({ surface, model });
  }
  return out;
}

// `agy models` prints a progress line, then one `<slug>\t<Display Name>` row
// per model.
export function parseAgyModelNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!/^[\w.-]+\t\S/.test(line)) continue;
    names.add(line.slice(line.indexOf("\t") + 1).trim());
  }
  return names;
}

export function missingAgyModels(
  configured: ConfiguredModel[],
  listed: Set<string>,
): ConfiguredModel[] {
  return configured.filter((c) => !listed.has(c.model));
}
