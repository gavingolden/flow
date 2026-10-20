import { describe, expect, it } from "vitest";
import type { AgentName } from "../flow-pr-agent-lens";
import type { GateVerdict } from "./review-lens-gates";
import {
  composeSpawnSet,
  DEEP_FILES_THRESHOLD,
  DEEP_LOC_THRESHOLD,
  LIGHT_FILES_THRESHOLD,
  LIGHT_LOC_THRESHOLD,
  LIGHT_TIER_DROPPED,
  resolveTier,
  type TierSignals,
} from "./review-tier";

const ALL_LENSES: readonly AgentName[] = [
  "bug-detection",
  "security",
  "pattern-consistency",
  "performance",
  "supply-chain",
  "test-coverage",
];

function allRunGates(): Record<AgentName, GateVerdict> {
  const out = {} as Record<AgentName, GateVerdict>;
  for (const lens of ALL_LENSES) {
    out[lens] = { run: true, reason: "not docs-only" };
  }
  return out;
}

function baseSignals(overrides: Partial<TierSignals> = {}): TierSignals {
  return {
    additions: 0,
    deletions: 0,
    files: [],
    hasDependencyChange: false,
    planHighStakes: false,
    commitPrefix: null,
    ...overrides,
  };
}

describe("resolveTier", () => {
  it("resolves standard by default on an ordinary diff that is neither all-low nor high-risk", () => {
    const { tier, reasons } = resolveTier(
      baseSignals({
        additions: 50,
        deletions: 10,
        files: ["src/foo.ts", "src/bar.ts", "src/baz.ts", "src/qux.ts"],
      }),
    );
    expect(tier).toBe("standard");
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("forces deep on a security-sensitive path even when every other signal is low", () => {
    const { tier, reasons } = resolveTier(
      baseSignals({
        additions: 1,
        deletions: 0,
        files: ["bin/lib/auth/session.ts"],
      }),
    );
    expect(tier).toBe("deep");
    expect(reasons.join(" ")).toMatch(/security-sensitive/);
  });

  it("forces deep on a dependency change even when every other signal is low", () => {
    const { tier, reasons } = resolveTier(
      baseSignals({
        additions: 1,
        deletions: 0,
        files: ["src/foo.ts"],
        hasDependencyChange: true,
      }),
    );
    expect(tier).toBe("deep");
    expect(reasons.join(" ")).toMatch(/dependency change/);
  });

  it("forces deep when the plan flags high stakes even when every other signal is low", () => {
    const { tier, reasons } = resolveTier(
      baseSignals({
        additions: 1,
        deletions: 0,
        files: ["src/foo.ts"],
        planHighStakes: true,
      }),
    );
    expect(tier).toBe("deep");
    expect(reasons.join(" ")).toMatch(/high-stakes/);
  });

  it("forces deep on a large diff by changed LOC", () => {
    const { tier, reasons } = resolveTier(
      baseSignals({
        additions: DEEP_LOC_THRESHOLD,
        deletions: 0,
        files: ["src/foo.ts"],
      }),
    );
    expect(tier).toBe("deep");
    expect(reasons.join(" ")).toMatch(/large diff/);
  });

  it("forces deep on a large diff by file count", () => {
    const files = Array.from(
      { length: DEEP_FILES_THRESHOLD },
      (_, i) => `src/f${i}.ts`,
    );
    const { tier, reasons } = resolveTier(
      baseSignals({ additions: 1, deletions: 0, files }),
    );
    expect(tier).toBe("deep");
    expect(reasons.join(" ")).toMatch(/large diff/);
  });

  it("resolves light only when every signal is low at once", () => {
    const { tier, reasons } = resolveTier(
      baseSignals({ additions: 5, deletions: 2, files: ["src/foo.ts"] }),
    );
    expect(tier).toBe("light");
    expect(reasons.join(" ")).toMatch(/every risk signal is low/);
  });

  it("lowers standard to light on a low-risk commit prefix", () => {
    const { tier, reasons } = resolveTier(
      baseSignals({
        additions: 50,
        deletions: 10,
        files: ["src/foo.ts", "src/bar.ts", "src/baz.ts", "src/qux.ts"],
        commitPrefix: "docs",
      }),
    );
    expect(tier).toBe("light");
    expect(reasons.join(" ")).toMatch(/low-risk commit prefix/);
  });

  it("does NOT lower a security-sensitive-path diff to light on a chore prefix — it stays deep via the path signal", () => {
    const { tier, reasons } = resolveTier(
      baseSignals({
        additions: 1,
        deletions: 0,
        files: ["bin/lib/auth/session.ts"],
        commitPrefix: "chore",
      }),
    );
    expect(tier).toBe("deep");
    expect(reasons.join(" ")).toMatch(/security-sensitive/);
  });

  it("LOC exactly at LIGHT_LOC_THRESHOLD (with files under LIGHT_FILES_THRESHOLD) is still light — the boundary is inclusive", () => {
    const { tier } = resolveTier(
      baseSignals({
        additions: LIGHT_LOC_THRESHOLD,
        deletions: 0,
        files: ["src/foo.ts"],
      }),
    );
    expect(tier).toBe("light");
  });

  it("LOC one above LIGHT_LOC_THRESHOLD (with files under LIGHT_FILES_THRESHOLD, below DEEP thresholds) falls to standard, not light", () => {
    const { tier } = resolveTier(
      baseSignals({
        additions: LIGHT_LOC_THRESHOLD + 1,
        deletions: 0,
        files: ["src/foo.ts"],
      }),
    );
    expect(tier).toBe("standard");
  });

  it("files count exactly at LIGHT_FILES_THRESHOLD (with LOC under LIGHT_LOC_THRESHOLD) is still light — the boundary is inclusive", () => {
    const files = Array.from(
      { length: LIGHT_FILES_THRESHOLD },
      (_, i) => `src/f${i}.ts`,
    );
    const { tier } = resolveTier(
      baseSignals({ additions: 1, deletions: 0, files }),
    );
    expect(tier).toBe("light");
  });

  it("files count one above LIGHT_FILES_THRESHOLD (with LOC under LIGHT_LOC_THRESHOLD, below DEEP thresholds) falls to standard, not light", () => {
    const files = Array.from(
      { length: LIGHT_FILES_THRESHOLD + 1 },
      (_, i) => `src/f${i}.ts`,
    );
    const { tier } = resolveTier(
      baseSignals({ additions: 1, deletions: 0, files }),
    );
    expect(tier).toBe("standard");
  });
});

describe("composeSpawnSet", () => {
  it("forces a static-analysis-hit lens on over a gate skip", () => {
    const gates = allRunGates();
    gates.security = { run: false, reason: "docs-only diff (1 files)" };
    const out = composeSpawnSet({
      gates,
      tier: "standard",
      staticAnalysisHits: ["security"],
    });
    expect(out.security).toEqual({
      run: true,
      reason: "static-analysis signal forces this lens on",
    });
  });

  it("forces a static-analysis-hit lens on over a light-tier drop", () => {
    const gates = allRunGates();
    const out = composeSpawnSet({
      gates,
      tier: "light",
      staticAnalysisHits: ["supply-chain"],
    });
    expect(out["supply-chain"].run).toBe(true);
  });

  it("leaves a gate-skipped lens skipped under a deep tier", () => {
    const gates = allRunGates();
    gates.performance = { run: false, reason: `docs-only diff (2 files)` };
    const out = composeSpawnSet({
      gates,
      tier: "deep",
      staticAnalysisHits: [],
    });
    expect(out.performance).toEqual(gates.performance);
  });

  it("drops exactly security/performance/supply-chain on a light tier and keeps the rest", () => {
    const gates = allRunGates();
    const out = composeSpawnSet({
      gates,
      tier: "light",
      staticAnalysisHits: [],
    });
    for (const lens of LIGHT_TIER_DROPPED) {
      expect(out[lens].run).toBe(false);
      expect(out[lens].reason).toMatch(/light review tier/);
    }
    expect(out["test-coverage"].run).toBe(true);
    expect(out["bug-detection"].run).toBe(true);
    expect(out["pattern-consistency"].run).toBe(true);
  });

  it("never drops test-coverage on a light tier (ALWAYS_ON_LENSES regression guard)", () => {
    const gates = allRunGates();
    const out = composeSpawnSet({
      gates,
      tier: "light",
      staticAnalysisHits: [],
    });
    expect(LIGHT_TIER_DROPPED).not.toContain("test-coverage");
    expect(out["test-coverage"]).toEqual(gates["test-coverage"]);
  });

  it("keeps a docs-only diff's test-coverage skip attributed to the gate, not the tier", () => {
    const gates = allRunGates();
    gates["test-coverage"] = { run: false, reason: "docs-only diff (2 files)" };
    const out = composeSpawnSet({
      gates,
      tier: "standard",
      staticAnalysisHits: [],
    });
    expect(out["test-coverage"]).toEqual({
      run: false,
      reason: "docs-only diff (2 files)",
    });
  });
});
