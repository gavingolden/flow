/**
 * Pure risk-tier resolver for /flow-pr-review's Step 3 fan-out. No I/O, no
 * `gh` calls — every input is a plain signal the caller (`flow-review-scope.ts`)
 * has already gathered.
 *
 * `resolveTier` picks a conservative default (`standard`) and only ever
 * moves ONE step off it per signal: any single HIGH-risk signal forces
 * `deep`, and `light` requires EVERY signal to be low at once. The
 * conventional-commit prefix is the one weak, asymmetric signal — it may
 * lower `standard` to `light`, but can never raise a tier and can never by
 * itself force `deep` (see `LOW_RISK_PREFIXES`).
 *
 * `composeSpawnSet` is the single site that reconciles the tier against the
 * content gates (`bin/lib/review-lens-gates.ts`) and the static-analysis
 * "never-skip-on-signal" override that used to live inside
 * `evaluateGates` itself — moved here so precedence is decided in exactly
 * one place instead of two files that could silently desync.
 */

import type { AgentName } from "../flow-pr-agent-lens";
import { matchesAny, SECURITY_SENSITIVE_GLOBS } from "./review-lens-gates";
import type { GateVerdict } from "./review-lens-gates";

export type ReviewTier = "light" | "standard" | "deep";

export type TierSignals = {
  additions: number;
  deletions: number;
  files: string[];
  hasDependencyChange: boolean;
  planHighStakes: boolean;
  commitPrefix: string | null;
};

/**
 * The three lowest-yield lenses, dropped on a `light` tier. `light` is
 * defined by SUBTRACTING these three from the full six-lens set, never by
 * `ALWAYS_ON_LENSES` (a vacuity classification, not a yield ranking) — a
 * light review still runs test-coverage, bug-detection, and
 * pattern-consistency.
 */
export const LIGHT_TIER_DROPPED: readonly AgentName[] = [
  "security",
  "performance",
  "supply-chain",
];

// Conservative judgment defaults, not calibrated against real recall data.
export const DEEP_LOC_THRESHOLD = 400;
export const DEEP_FILES_THRESHOLD = 15;
export const LIGHT_LOC_THRESHOLD = 30;
export const LIGHT_FILES_THRESHOLD = 3;

const LOW_RISK_PREFIXES: readonly string[] = ["docs", "chore", "style", "test"];

function isLowRiskPrefix(prefix: string | null): boolean {
  return prefix !== null && LOW_RISK_PREFIXES.includes(prefix.toLowerCase());
}

export function resolveTier(s: TierSignals): {
  tier: ReviewTier;
  reasons: string[];
} {
  const changedLoc = s.additions + s.deletions;
  const hasSecurityPath = s.files.some((f) =>
    matchesAny(f, SECURITY_SENSITIVE_GLOBS),
  );
  const isLargeDiff =
    changedLoc >= DEEP_LOC_THRESHOLD || s.files.length >= DEEP_FILES_THRESHOLD;

  const deepReasons: string[] = [];
  if (hasSecurityPath) {
    deepReasons.push("a changed file matches a security-sensitive path");
  }
  if (s.hasDependencyChange) {
    deepReasons.push("dependency change detected");
  }
  if (s.planHighStakes) {
    deepReasons.push("plan.md flags this work as high-stakes");
  }
  if (isLargeDiff) {
    deepReasons.push(
      `large diff (${changedLoc} changed LOC across ${s.files.length} files)`,
    );
  }

  if (deepReasons.length > 0) {
    return { tier: "deep", reasons: deepReasons };
  }

  const allLow =
    changedLoc <= LIGHT_LOC_THRESHOLD &&
    s.files.length <= LIGHT_FILES_THRESHOLD &&
    !hasSecurityPath &&
    !s.hasDependencyChange &&
    !s.planHighStakes;

  if (allLow) {
    return {
      tier: "light",
      reasons: [
        `every risk signal is low (${changedLoc} changed LOC across ${s.files.length} files, no security path, no dependency change, not plan high-stakes)`,
      ],
    };
  }

  if (isLowRiskPrefix(s.commitPrefix)) {
    return {
      tier: "light",
      reasons: [
        `low-risk commit prefix '${s.commitPrefix}' lowered standard to light`,
      ],
    };
  }

  return {
    tier: "standard",
    reasons: [
      `default tier: no high-risk signal but not every signal is low (${changedLoc} changed LOC across ${s.files.length} files)`,
    ],
  };
}

export function composeSpawnSet(input: {
  gates: Record<AgentName, GateVerdict>;
  tier: ReviewTier;
  staticAnalysisHits: readonly AgentName[];
}): Record<AgentName, GateVerdict> {
  const hits = new Set(input.staticAnalysisHits);
  const out = {} as Record<AgentName, GateVerdict>;

  for (const lens of Object.keys(input.gates) as AgentName[]) {
    if (hits.has(lens)) {
      out[lens] = {
        run: true,
        reason: "static-analysis signal forces this lens on",
      };
      continue;
    }

    const gate = input.gates[lens];
    if (!gate.run) {
      out[lens] = gate;
      continue;
    }

    if (input.tier === "light" && LIGHT_TIER_DROPPED.includes(lens)) {
      out[lens] = {
        run: false,
        reason: `light review tier drops ${lens}`,
      };
      continue;
    }

    out[lens] = gate;
  }

  return out;
}
