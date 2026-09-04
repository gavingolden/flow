import { describe, expect, it, vi } from "vitest";
import { scoreFiles, toTiers, main } from "./flow-test-audit";
import { REQUIRED_LINTERS } from "./lib/test-audit-core";

function timings(entries: [string, { wallMs: number; assertions: number }][]) {
  return new Map(entries);
}
function sources(entries: [string, string][]) {
  return new Map(entries);
}

describe(scoreFiles, () => {
  it("computes msPerAssertion as wallMs / assertions", () => {
    const [score] = scoreFiles({
      timings: timings([["a.test.ts", { wallMs: 100, assertions: 4 }]]),
      sources: sources([]),
    });
    expect(score.msPerAssertion).toBe(25);
  });

  it("computes medianRatio against the repo-wide median", () => {
    const scores = scoreFiles({
      timings: timings([
        ["a.test.ts", { wallMs: 10, assertions: 10 }], // 1 ms/assert
        ["b.test.ts", { wallMs: 20, assertions: 10 }], // 2 ms/assert (median)
        ["c.test.ts", { wallMs: 40, assertions: 10 }], // 4 ms/assert
      ]),
      sources: sources([]),
    });
    const b = scores.find((s) => s.path === "b.test.ts")!;
    expect(b.medianRatio).toBe(1);
    const c = scores.find((s) => s.path === "c.test.ts")!;
    expect(c.medianRatio).toBe(2);
  });

  it("sets spawnsSubprocess when the source matches a spawn pattern", () => {
    const [score] = scoreFiles({
      timings: timings([["a.test.ts", { wallMs: 10, assertions: 1 }]]),
      sources: sources([["a.test.ts", "spawnSync('git', ['status'])"]]),
    });
    expect(score.spawnsSubprocess).toBe(true);
  });

  it("sets scansRepoTree for a module-scope repo read and NOT for a read inside an it() callback", () => {
    const moduleScope = "const x = fs.readFileSync('README.md', 'utf8');";
    const insideIt =
      "describe('d', () => { it('reads', () => { fs.readFileSync('README.md', 'utf8'); }); });";
    const scores = scoreFiles({
      timings: timings([
        ["module.test.ts", { wallMs: 10, assertions: 1 }],
        ["inside-it.test.ts", { wallMs: 10, assertions: 1 }],
      ]),
      sources: sources([
        ["module.test.ts", moduleScope],
        ["inside-it.test.ts", insideIt],
      ]),
    });
    expect(scores.find((s) => s.path === "module.test.ts")!.scansRepoTree).toBe(
      true,
    );
    expect(
      scores.find((s) => s.path === "inside-it.test.ts")!.scansRepoTree,
    ).toBe(false);
  });

  it("assigns quadrant expensive-avoidable for a high-cost low-assertion file", () => {
    const scores = scoreFiles({
      timings: timings([
        ["cheap-a.test.ts", { wallMs: 10, assertions: 10 }], // 1 ms/assert
        ["cheap-b.test.ts", { wallMs: 10, assertions: 10 }], // 1 ms/assert
        ["cheap-c.test.ts", { wallMs: 10, assertions: 10 }], // 1 ms/assert (median = 1)
        ["expensive.test.ts", { wallMs: 5000, assertions: 2 }], // 2500 ms/assert
      ]),
      sources: sources([]),
    });
    expect(scores.find((s) => s.path === "expensive.test.ts")!.quadrant).toBe(
      "expensive-avoidable",
    );
  });

  it("assigns quadrant cheap-valuable for a low-cost high-density file", () => {
    const scores = scoreFiles({
      timings: timings([["a.test.ts", { wallMs: 10, assertions: 20 }]]),
      sources: sources([]),
    });
    expect(scores[0].quadrant).toBe("cheap-valuable");
  });

  it("assigns tier deferToCi only when the file spawns AND exceeds the wall-time threshold", () => {
    const scores = scoreFiles({
      timings: timings([
        ["cheap-spawner.test.ts", { wallMs: 500, assertions: 5 }],
        ["expensive-spawner.test.ts", { wallMs: 3000, assertions: 5 }],
      ]),
      sources: sources([
        ["cheap-spawner.test.ts", "spawnSync('git')"],
        ["expensive-spawner.test.ts", "spawnSync('git')"],
      ]),
    });
    expect(
      scores.find((s) => s.path === "cheap-spawner.test.ts")!.tier,
    ).not.toBe("deferToCi");
    expect(
      scores.find((s) => s.path === "expensive-spawner.test.ts")!.tier,
    ).toBe("deferToCi");
  });

  it("assigns tier alwaysRun for a repo-tree-scanning file", () => {
    const [score] = scoreFiles({
      timings: timings([["lint.test.ts", { wallMs: 10, assertions: 5 }]]),
      sources: sources([
        ["lint.test.ts", "const c = fs.readFileSync('AGENTS.md', 'utf8');"],
      ]),
    });
    expect(score.tier).toBe("alwaysRun");
  });
});

describe(toTiers, () => {
  it("emits a version-1 manifest with alwaysRun, deferToCi and forceFullOn", () => {
    const tiers = toTiers([]);
    expect(tiers.version).toBe(1);
    expect(Array.isArray(tiers.alwaysRun)).toBe(true);
    expect(Array.isArray(tiers.deferToCi)).toBe(true);
    expect(Array.isArray(tiers.forceFullOn)).toBe(true);
    expect(tiers.forceFullOn.length).toBeGreaterThan(0);
  });

  it("places every *.live.test.ts file in deferToCi regardless of measured cost", () => {
    const scores = scoreFiles({
      timings: timings([["cheap.live.test.ts", { wallMs: 1, assertions: 5 }]]),
      sources: sources([]),
    });
    const tiers = toTiers(scores);
    expect(tiers.deferToCi).toContain("cheap.live.test.ts");
  });

  it("derives the rest of alwaysRun from the scansRepoTree axis beyond the curated floor", () => {
    const scores = scoreFiles({
      timings: timings([
        ["lint.test.ts", { wallMs: 10, assertions: 5 }],
        ["plain.test.ts", { wallMs: 10, assertions: 5 }],
      ]),
      sources: sources([
        ["lint.test.ts", "const c = fs.readFileSync('AGENTS.md', 'utf8');"],
        ["plain.test.ts", "expect(1).toBe(1);"],
      ]),
    });
    const tiers = toTiers(scores);
    expect(tiers.alwaysRun).toEqual(["lint.test.ts"]);
  });

  it("floors a REQUIRED_LINTERS entry into alwaysRun even when its source gives no scansRepoTree signal", () => {
    const [floorPath] = REQUIRED_LINTERS;
    const scores = scoreFiles({
      timings: timings([[floorPath, { wallMs: 10, assertions: 5 }]]),
      sources: sources([[floorPath, "expect(1).toBe(1);"]]),
    });
    const tiers = toTiers(scores);
    expect(tiers.alwaysRun).toContain(floorPath);
  });

  it("does not pin an expensive spawner that only incidentally scansRepoTree into alwaysRun unless it's in the floor", () => {
    const scores = scoreFiles({
      timings: timings([
        ["expensive-lint.test.ts", { wallMs: 5000, assertions: 5 }],
      ]),
      sources: sources([
        [
          "expensive-lint.test.ts",
          "const c = fs.readFileSync('AGENTS.md', 'utf8'); spawnSync('git')",
        ],
      ]),
    });
    const tiers = toTiers(scores);
    expect(tiers.alwaysRun).not.toContain("expensive-lint.test.ts");
    expect(tiers.deferToCi).toContain("expensive-lint.test.ts");
  });

  it("drops a stale REQUIRED_LINTERS entry (a rename/removal) instead of erroring when it isn't among the scored files", () => {
    const scores = scoreFiles({
      timings: timings([["plain.test.ts", { wallMs: 10, assertions: 5 }]]),
      sources: sources([["plain.test.ts", "expect(1).toBe(1);"]]),
    });
    expect(() => toTiers(scores)).not.toThrow();
    const tiers = toTiers(scores);
    for (const required of REQUIRED_LINTERS) {
      expect(tiers.alwaysRun).not.toContain(required);
    }
  });
});

describe("flow-test-audit CLI", () => {
  it("re-scores from bin/__fixtures__/vitest-report.json via --from-json without running vitest, emitting a non-empty files array", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main([
        "--from-json",
        "bin/__fixtures__/vitest-report.json",
        "--json",
      ]);
      expect(code).toBe(0);
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.files.length).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("scores only files matching the vitest include globs (an evals/ fixture path is not scored)", async () => {
    const tmpReport = ".flow-tmp/flow-test-audit-cli-test-report.json";
    const fs = await import("node:fs");
    fs.mkdirSync(".flow-tmp", { recursive: true });
    fs.writeFileSync(
      tmpReport,
      JSON.stringify({
        testResults: [
          {
            name: "bin/lib/slug.test.ts",
            startTime: 0,
            endTime: 10,
            assertionResults: [{ duration: 1 }],
          },
          {
            name: "evals/verify-loop-isolation/s1-single-fix/fixture/src/slug.test.ts",
            startTime: 0,
            endTime: 10,
            assertionResults: [{ duration: 1 }],
          },
        ],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(["--from-json", tmpReport, "--json"]);
      expect(code).toBe(0);
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      const paths = output.files.map((f: { path: string }) => f.path);
      expect(paths).toContain("bin/lib/slug.test.ts");
      expect(paths.some((p: string) => p.startsWith("evals/"))).toBe(false);
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tmpReport, { force: true });
    }
  });
});
