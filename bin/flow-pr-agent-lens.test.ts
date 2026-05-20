import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_LENS_MAP,
  parseArgs,
  route,
  run,
  SYNTHETIC_SUPPLY_CHAIN,
  type AgentName,
} from "./flow-pr-agent-lens";
import type { AnalysisResult, Finding, LensName } from "./flow-pr-static-analysis/types";

// Runtime list of LensName values; source of truth: bin/flow-pr-static-analysis/types.ts.
const ALL_LENS_NAMES: readonly LensName[] = ["security", "types", "coverage", "lint", "dependencies"];

const EXPECTED_AGENTS: readonly AgentName[] = [
  "bug-detection",
  "security",
  "pattern-consistency",
  "performance",
  "supply-chain",
  "test-coverage",
];

const f = (file: string, rule_id: string, source: Finding["source"]): Finding => ({
  file,
  line: 1,
  rule_id,
  message: rule_id,
  confidence: 80,
  source,
});

function makeEnvelope(): AnalysisResult {
  return {
    security: [f("s.ts", "S1", "semgrep")],
    types: [f("t.ts", "T1", "tsc")],
    coverage: [f("c.ts", "C1", "coverage")],
    lint: [f("l.ts", "L1", "biome")],
    dependencies: [f("package.json", "D1", "npm-audit")],
    meta: {
      security: { ran: true, duration_ms: 10 },
      types: { ran: true, duration_ms: 20 },
      coverage: { ran: true, duration_ms: 30 },
      lint: { ran: true, duration_ms: 40 },
      dependencies: { ran: true, duration_ms: 50 },
      pr: 1,
      min_confidence: 50,
      duration_ms: 150,
    },
  };
}

describe("AGENT_LENS_MAP", () => {
  it("Object.keys matches the six expected kebab-name set", () => {
    expect(new Set(Object.keys(AGENT_LENS_MAP))).toEqual(new Set(EXPECTED_AGENTS));
  });

  it("security maps to both 'security' and 'dependencies' (set membership)", () => {
    expect(new Set(AGENT_LENS_MAP.security)).toEqual(new Set(["security", "dependencies"]));
  });

  it("supply-chain is the synthetic sentinel marker only", () => {
    expect([...AGENT_LENS_MAP["supply-chain"]]).toEqual([SYNTHETIC_SUPPLY_CHAIN]);
  });

  it("each non-supply-chain agent has 1-2 valid LensName values", () => {
    for (const agent of EXPECTED_AGENTS) {
      if (agent === "supply-chain") continue;
      const lenses = AGENT_LENS_MAP[agent];
      expect(lenses.length, `agent ${agent}`).toBeGreaterThanOrEqual(1);
      expect(lenses.length, `agent ${agent}`).toBeLessThanOrEqual(2);
      for (const lens of lenses) {
        expect(
          (ALL_LENS_NAMES as readonly string[]).includes(lens),
          `agent ${agent} lens ${lens} must be a valid LensName`,
        ).toBe(true);
      }
    }
  });

  it("union of all lens values is a subset of LensName ∪ {synthetic sentinel}", () => {
    const allowed = new Set<string>([...ALL_LENS_NAMES, SYNTHETIC_SUPPLY_CHAIN]);
    for (const lenses of Object.values(AGENT_LENS_MAP)) {
      for (const lens of lenses) expect(allowed.has(lens)).toBe(true);
    }
  });
});

describe("route()", () => {
  const env = makeEnvelope();

  it("bug-detection emits flat single-lens shape from .types", () => {
    expect(route(env, "bug-detection")).toEqual({ findings: env.types, meta: env.meta.types });
  });

  it("security concatenates findings and keys meta by lens", () => {
    expect(route(env, "security")).toEqual({
      findings: [...env.security, ...env.dependencies],
      meta: { security: env.meta.security, dependencies: env.meta.dependencies },
    });
  });

  it("pattern-consistency emits flat .lint shape", () => {
    expect(route(env, "pattern-consistency")).toEqual({ findings: env.lint, meta: env.meta.lint });
  });

  it("performance emits flat .lint shape (shared with pattern-consistency)", () => {
    expect(route(env, "performance")).toEqual({ findings: env.lint, meta: env.meta.lint });
  });

  it("test-coverage emits flat .coverage shape", () => {
    expect(route(env, "test-coverage")).toEqual({
      findings: env.coverage,
      meta: env.meta.coverage,
    });
  });

  it("supply-chain emits the synthetic envelope verbatim", () => {
    expect(route(env, "supply-chain")).toEqual({
      findings: [],
      meta: { ran: false, skipped_reason: "no supply-chain pre-digest lens", duration_ms: 0 },
    });
  });
});

describe("parseArgs()", () => {
  it("returns agent: undefined when --agent is omitted", () => {
    expect(parseArgs([])).toEqual({ help: false });
  });

  it("does not throw on unknown --agent values (route/run validates)", () => {
    expect(() => parseArgs(["--agent", "bogus"])).not.toThrow();
    expect(parseArgs(["--agent", "bogus"]).agent).toBe("bogus");
  });

  it("sets help:true for --help and -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("--in <path> populates the in field, --in - preserves stdin sentinel", () => {
    expect(parseArgs(["--in", "/tmp/foo.json"]).in).toBe("/tmp/foo.json");
    expect(parseArgs(["--in", "-"]).in).toBe("-");
  });

  it("default --in is undefined when omitted (run() resolves the default)", () => {
    expect(parseArgs(["--agent", "security"]).in).toBeUndefined();
  });
});

describe("run() CLI behaviour", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `flow-pr-agent-lens-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(makeEnvelope()));
  });

  afterEach(() => {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  it("--help exits 0 and stdout lists all six kebab-names", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const code = await run(["--help"]);
    spy.mockRestore();
    expect(code).toBe(0);
    for (const name of EXPECTED_AGENTS) expect(writes.join("")).toContain(name);
  });

  it("--agent security --in <path> exits 0 and emits the expected concatenated shape", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const code = await run(["--agent", "security", "--in", tmpPath]);
    spy.mockRestore();
    expect(code).toBe(0);
    const env = makeEnvelope();
    expect(JSON.parse(writes.join(""))).toEqual({
      findings: [...env.security, ...env.dependencies],
      meta: { security: env.meta.security, dependencies: env.meta.dependencies },
    });
  });

  it("--agent unknown exits 2 and stderr lists valid agents", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const code = await run(["--agent", "unknown"]);
    spy.mockRestore();
    expect(code).toBe(2);
    const stderr = writes.join("");
    expect(stderr).toContain("unknown agent: unknown");
    for (const name of EXPECTED_AGENTS) expect(stderr).toContain(name);
  });

  it("--agent security --in <missing> exits 2 and stderr names the missing file", async () => {
    const missing = path.join(os.tmpdir(), `flow-pr-agent-lens-missing-${Date.now()}-${Math.random()}.json`);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      writes.push(s.toString());
      return true;
    });
    const code = await run(["--agent", "security", "--in", missing]);
    spy.mockRestore();
    expect(code).toBe(2);
    const stderr = writes.join("");
    expect(stderr).toContain("envelope file not found");
    expect(stderr).toContain(missing);
  });
});

describe("CLI end-to-end smoke", () => {
  it("bun bin/flow-pr-agent-lens.ts --help exits 0 and stdout contains 'bug-detection'", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..");
    const r = spawnSync("bun", ["bin/flow-pr-agent-lens.ts", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("bug-detection");
  });

  it("--agent security --in - reads the envelope from stdin and emits the concatenated shape", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..");
    const r = spawnSync("bun", ["bin/flow-pr-agent-lens.ts", "--agent", "security", "--in", "-"], {
      cwd: repoRoot,
      encoding: "utf8",
      input: JSON.stringify(makeEnvelope()),
    });
    expect(r.status).toBe(0);
    const env = makeEnvelope();
    expect(JSON.parse(r.stdout)).toEqual({
      findings: [...env.security, ...env.dependencies],
      meta: { security: env.meta.security, dependencies: env.meta.dependencies },
    });
  });
});
