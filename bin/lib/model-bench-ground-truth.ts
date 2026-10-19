/**
 * Ground-truth gating for cases the incumbent comparison cannot judge.
 *
 * With `--ground-truth-floor`, two kinds of case are gated on the fixture's own
 * ground truth instead of on a comparison with the incumbent:
 *  - "ground truth only": no model in the baseline set has a single row for the
 *    case (a case authored after the baseline run, e.g. c11 / c12);
 *  - "at ceiling": every model scored on the case aced it, so the case cannot
 *    separate them and a comparison says nothing.
 * A candidate passes such a case on recall >= floor, no forbidden claim and no
 * vacuous field; below that it fails the mechanical-parity gate.
 */

import type { CaseScore, ModelCaseScore } from "./model-bench-score";

export type GroundTruthKind = "ground truth only" | "at ceiling";

export function groundTruthKind(
  cs: CaseScore,
  baselineModels: string[],
): GroundTruthKind | null {
  if (baselineModels.every((m) => !cs.perModel[m])) return "ground truth only";
  const all = Object.values(cs.perModel);
  if (all.length > 0 && all.every((m) => m.recall >= 1)) return "at ceiling";
  return null;
}

// null when the candidate clears the floor; otherwise why it does not.
export function groundTruthFailure(
  cand: ModelCaseScore,
  floor: number,
): string | null {
  const reasons: string[] = [];
  if (cand.recall < floor) {
    reasons.push(`recall ${cand.recall.toFixed(2)} < floor ${floor}`);
  }
  if (cand.falsePositives.length > 0) {
    reasons.push(`forbidden claim: ${cand.falsePositives.join("; ")}`);
  }
  if (cand.vacuous > 0) reasons.push(`${cand.vacuous} vacuous field(s)`);
  return reasons.length > 0 ? reasons.join(", ") : null;
}
