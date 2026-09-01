import { describe, expect, it } from "vitest";
import { AGENT_LENS_MAP } from "../flow-pr-agent-lens";
import type { AnalysisResult } from "../flow-pr-static-analysis/types";
import { evaluateGates, isDocsOnly } from "./review-lens-gates";

const EMPTY_ANALYSIS: AnalysisResult = {
  security: [],
  types: [],
  lint: [],
  dependencies: [],
  meta: {
    security: { ran: true, duration_ms: 0 },
    types: { ran: true, duration_ms: 0 },
    lint: { ran: true, duration_ms: 0 },
    dependencies: { ran: true, duration_ms: 0 },
    pr: 1,
    min_confidence: 0,
    duration_ms: 0,
  },
};

describe("evaluateGates", () => {
  it("skips supply-chain when no changed file matches a manifest/lockfile", () => {
    const gates = evaluateGates(["src/foo.ts"], { enabled: true });
    expect(gates["supply-chain"].run).toBe(false);
    expect(gates["supply-chain"].reason).toContain("no manifest/lockfile among");
  });

  it("runs supply-chain when package.json or bun.lock changed", () => {
    expect(
      evaluateGates(["package.json"], { enabled: true })["supply-chain"].run,
    ).toBe(true);
    expect(
      evaluateGates(["bun.lock"], { enabled: true })["supply-chain"].run,
    ).toBe(true);
  });

  it("runs supply-chain when staticAnalysis.dependencies is non-empty even with no manifest change", () => {
    const analysis: AnalysisResult = {
      ...EMPTY_ANALYSIS,
      dependencies: [
        {
          file: "package.json",
          line: 1,
          rule_id: "audit",
          message: "vuln",
          confidence: 90,
          source: "npm-audit",
        },
      ],
    };
    const gates = evaluateGates(["src/foo.ts"], {
      enabled: true,
      staticAnalysis: analysis,
    });
    expect(gates["supply-chain"].run).toBe(true);
  });

  it("gates performance, security and test-coverage off on a docs-only file set and keeps bug-detection and pattern-consistency on", () => {
    const gates = evaluateGates(["docs/foo.md", "README.md"], {
      enabled: true,
    });
    expect(gates.performance.run).toBe(false);
    expect(gates.security.run).toBe(false);
    expect(gates["test-coverage"].run).toBe(false);
    expect(gates["bug-detection"].run).toBe(true);
    expect(gates["pattern-consistency"].run).toBe(true);
  });

  it("does not apply the docs-only rule when the set includes skills/**, agents/**, .github/**, AGENTS.md, CLAUDE.md or templates/**", () => {
    for (const file of [
      "skills/foo/SKILL.md",
      "agents/core/foo.md",
      ".github/workflows/ci.yml",
      "AGENTS.md",
      "CLAUDE.md",
      "templates/AGENTS.md.template",
    ]) {
      const gates = evaluateGates(["docs/x.md", file], { enabled: true });
      expect(gates.performance.run).toBe(true);
      expect(gates["test-coverage"].run).toBe(true);
    }
  });

  it("keeps security on for a docs-only set when staticAnalysis.security is non-empty", () => {
    const analysis: AnalysisResult = {
      ...EMPTY_ANALYSIS,
      security: [
        {
          file: "docs/foo.md",
          line: 1,
          rule_id: "secret",
          message: "leaked key",
          confidence: 90,
          source: "semgrep",
        },
      ],
    };
    const gates = evaluateGates(["docs/foo.md"], {
      enabled: true,
      staticAnalysis: analysis,
    });
    expect(gates.security.run).toBe(true);
  });

  it("returns run:true reason 'gates disabled' for every lens when enabled:false", () => {
    const gates = evaluateGates(["docs/foo.md"], { enabled: false });
    for (const name of Object.keys(AGENT_LENS_MAP)) {
      expect(gates[name as keyof typeof gates]).toEqual({
        run: true,
        reason: "gates disabled",
      });
    }
  });

  it("treats an empty file list as NOT docs-only so no lens is gated by the docs rule", () => {
    expect(isDocsOnly([])).toBe(false);
    const gates = evaluateGates([], { enabled: true });
    expect(gates.performance.run).toBe(true);
    expect(gates.security.run).toBe(true);
    expect(gates["test-coverage"].run).toBe(true);
  });

  it("produces a verdict for every AgentName key in AGENT_LENS_MAP", () => {
    const gates = evaluateGates(["src/foo.ts"], { enabled: true });
    expect(new Set(Object.keys(gates))).toEqual(
      new Set(Object.keys(AGENT_LENS_MAP)),
    );
  });
});
