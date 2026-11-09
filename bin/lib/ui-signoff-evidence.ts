/**
 * What the owner needs to tick a `SUBJECTIVE:` item without opening the PR:
 * per open item, the views it names, the screenshots attached and which views
 * are missing; plus whether the design review passed cleanly. Pure — the gate
 * verdict carries it, the GATED render prints it, nothing here ticks anything.
 */
import { isLocalTarget } from "./image-refs";
import {
  missingViews,
  requiredViews,
  shotView,
  type ItemShot,
  type SignoffView,
} from "./signoff-views";
import { isGating, type LoopLog } from "./ui-critique";
import type { UiReviewGate } from "./ui-review-gate";
import { parseTestSteps } from "./test-steps-parse";

export { requiredViews };
export type { ItemShot, SignoffView };

export type ItemEvidence = {
  item: string;
  required: SignoffView[];
  shots: ItemShot[];
  missing: SignoffView[];
  unlabelled: number;
  partial?: string;
  noScreenshot?: string;
};

export type UiReviewSummary = {
  passed: boolean;
  outcome: string | null;
  judgedSha: string | null;
  gatingMajor: number;
  gatingDefect: number;
};

export type UiSignoff = { items: ItemEvidence[]; uiReview: UiReviewSummary };

const COMPLETED = ["clean", "kept", "reverted", "list-only"];

export function collectSubjectiveEvidence(
  body: string,
  resolveRef: (ref: string) => string = (r) => r,
): ItemEvidence[] {
  const out: ItemEvidence[] = [];
  for (const step of parseTestSteps(body).steps) {
    if (step.kind !== "subjective" || step.checked) continue;
    const required = requiredViews(step.fullText);
    const shots: ItemShot[] = step.images.map((im) => ({
      view: shotView(im.alt, im.ref),
      ref: isLocalTarget(im.ref) ? resolveRef(im.ref) : im.ref,
    }));
    const unlabelled = shots.filter((s) => s.view === null).length;
    const item: ItemEvidence = {
      item: step.text,
      required,
      shots,
      missing: step.noScreenshot !== null ? [] : missingViews(required, shots),
      unlabelled,
    };
    if (step.partial !== null) item.partial = step.partial;
    if (step.noScreenshot !== null) item.noScreenshot = step.noScreenshot;
    out.push(item);
  }
  return out;
}

export function summarizeUiReview(
  log: LoopLog | null,
  gate: UiReviewGate | undefined,
): UiReviewSummary {
  const none: UiReviewSummary = {
    passed: false,
    outcome: log?.outcome ?? null,
    judgedSha: log?.headSha ?? null,
    gatingMajor: 0,
    gatingDefect: 0,
  };
  if (!log) return none;
  const gating = log.skip ? [] : log.residual.filter(isGating);
  const counts = {
    gatingMajor: gating.filter((f) => f.severity === "major").length,
    gatingDefect:
      gating.filter((f) => f.severity === "defect").length +
      log.persistent.length,
  };
  const passed =
    gate?.required === true &&
    gate.satisfied === true &&
    gate.reason === null &&
    log.outcome != null &&
    COMPLETED.includes(log.outcome) &&
    !log.skip &&
    log.required !== false;
  return { ...none, ...counts, passed };
}
