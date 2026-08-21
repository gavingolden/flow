import { describe, expect, it } from "vitest";
import {
  evalSlug,
  loadSuite,
  SCENARIO_DEFAULTS,
  validateScenarioSpec,
  validateSuiteSpec,
  type LoadSuiteDeps,
} from "./eval-suite";

function memDeps(files: Record<string, string>): LoadSuiteDeps {
  return {
    readFile: (p) =>
      Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null,
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
  };
}

const validScenario = {
  id: "s1",
  title: "Scenario one",
  provenance: "test",
  prompt: "prompt.md",
  graders: [{ id: "g1", kind: "file", file: "out.txt", exists: true }],
};

const validSuite = {
  schemaVersion: 1,
  id: "my-suite",
  candidate: "my-candidate",
  description: "a suite",
  scenarios: ["s1"],
};

describe("validateSuiteSpec", () => {
  it("accepts a well-formed suite", () => {
    const result = validateSuiteSpec(validSuite);
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    const result = validateSuiteSpec("nope");
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong schemaVersion", () => {
    const result = validateSuiteSpec({ ...validSuite, schemaVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/schemaVersion/);
  });

  it("rejects an empty scenarios array", () => {
    const result = validateSuiteSpec({ ...validSuite, scenarios: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects a bad defaults shape", () => {
    const result = validateSuiteSpec({
      ...validSuite,
      defaults: { runs: "two" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateScenarioSpec", () => {
  it("accepts a well-formed scenario", () => {
    const result = validateScenarioSpec(validScenario);
    expect(result.ok).toBe(true);
  });

  it("rejects missing graders", () => {
    const { graders, ...rest } = validScenario;
    const result = validateScenarioSpec(rest);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown grader kind", () => {
    const result = validateScenarioSpec({
      ...validScenario,
      graders: [{ id: "g1", kind: "bogus" }],
    });
    expect(result.ok).toBe(false);
  });

  it("requires source+direction for metric graders", () => {
    const noSource = validateScenarioSpec({
      ...validScenario,
      graders: [{ id: "g1", kind: "metric", direction: "lower" }],
    });
    expect(noSource.ok).toBe(false);

    const noDirection = validateScenarioSpec({
      ...validScenario,
      graders: [
        { id: "g1", kind: "metric", source: "transcript.finalContextTokens" },
      ],
    });
    expect(noDirection.ok).toBe(false);

    const ok = validateScenarioSpec({
      ...validScenario,
      graders: [
        {
          id: "g1",
          kind: "metric",
          source: "transcript.finalContextTokens",
          direction: "lower",
        },
      ],
    });
    expect(ok.ok).toBe(true);
  });

  it("requires path + exactly one matcher for structured/json-file graders", () => {
    const noMatcher = validateScenarioSpec({
      ...validScenario,
      graders: [{ id: "g1", kind: "structured", path: "decision" }],
    });
    expect(noMatcher.ok).toBe(false);

    const twoMatchers = validateScenarioSpec({
      ...validScenario,
      graders: [
        {
          id: "g1",
          kind: "structured",
          path: "decision",
          equals: "x",
          contains: "y",
        },
      ],
    });
    expect(twoMatchers.ok).toBe(false);

    const jsonFileMissingFile = validateScenarioSpec({
      ...validScenario,
      graders: [
        { id: "g1", kind: "json-file", path: "phase", equals: "implementing" },
      ],
    });
    expect(jsonFileMissingFile.ok).toBe(false);

    const ok = validateScenarioSpec({
      ...validScenario,
      graders: [
        { id: "g1", kind: "structured", path: "decision", equals: "proceed" },
        {
          id: "g2",
          kind: "json-file",
          file: "$STATE",
          path: "phase",
          equals: "implementing",
        },
      ],
    });
    expect(ok.ok).toBe(true);
  });

  it("requires argv for command graders", () => {
    const result = validateScenarioSpec({
      ...validScenario,
      graders: [{ id: "g1", kind: "command" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate grader ids", () => {
    const result = validateScenarioSpec({
      ...validScenario,
      graders: [
        { id: "g1", kind: "file", file: "a.txt", exists: true },
        { id: "g1", kind: "file", file: "b.txt", exists: true },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/duplicate/);
  });

  it("accepts promptSeed values", () => {
    const resume = validateScenarioSpec({
      ...validScenario,
      promptSeed: "resume",
    });
    expect(resume.ok).toBe(true);
    const terminal = validateScenarioSpec({
      ...validScenario,
      promptSeed: "terminal",
    });
    expect(terminal.ok).toBe(true);
    const bad = validateScenarioSpec({ ...validScenario, promptSeed: "nope" });
    expect(bad.ok).toBe(false);
  });
});

describe("evalSlug", () => {
  it("builds the expected slug shape", () => {
    expect(evalSlug("haiku-gatekeeper", "s1-merged-skip", 1)).toBe(
      "eval-haiku-gatekeeper-s1-merged-skip-r1",
    );
  });

  it("preserves the run suffix while truncating only the scenario segment", () => {
    const longScenario = "s".repeat(100);
    const slug = evalSlug("suite", longScenario, 3);
    expect(slug.endsWith("-r3")).toBe(true);
    expect(slug.length).toBeLessThanOrEqual(60);
  });
});

describe("loadSuite", () => {
  it("resolves defaults in scenario > suite.defaults > SCENARIO_DEFAULTS order", () => {
    const deps = memDeps({
      "/e/s/suite.json": JSON.stringify({
        schemaVersion: 1,
        id: "s",
        candidate: "c",
        description: "d",
        scenarios: ["scenario-a", "scenario-b"],
        defaults: { runs: 5, maxBudgetUsd: 8 },
      }),
      "/e/s/scenario-a/case.json": JSON.stringify({
        id: "scenario-a",
        title: "A",
        provenance: "test",
        prompt: "prompt.md",
        runs: 9,
        graders: [{ id: "g1", kind: "file", file: "out.txt", exists: true }],
      }),
      "/e/s/scenario-a/prompt.md": "hi",
      "/e/s/scenario-a/out.txt": "hi",
      "/e/s/scenario-b/case.json": JSON.stringify({
        id: "scenario-b",
        title: "B",
        provenance: "test",
        prompt: "prompt.md",
        graders: [{ id: "g1", kind: "file", file: "out.txt", exists: true }],
      }),
      "/e/s/scenario-b/prompt.md": "hi",
      "/e/s/scenario-b/out.txt": "hi",
    });

    const result = loadSuite("/e/s", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenarios[0].runs).toBe(9); // scenario override wins
    expect(result.value.scenarios[1].runs).toBe(5); // suite.defaults wins
    expect(result.value.scenarios[1].maxBudgetUsd).toBe(8);
    expect(result.value.scenarios[1].timeoutSec).toBe(
      SCENARIO_DEFAULTS.timeoutSec,
    );
  });

  it("fails when a referenced file is missing", () => {
    const deps = memDeps({
      "/e/s/suite.json": JSON.stringify(validSuite),
      "/e/s/s1/case.json": JSON.stringify(validScenario),
      // out.txt intentionally absent
    });
    const result = loadSuite("/e/s", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not exist/);
  });

  it("fails when a non-shims reference escapes its scenario dir", () => {
    const deps = memDeps({
      "/e/s/suite.json": JSON.stringify(validSuite),
      "/e/s/s1/case.json": JSON.stringify({
        ...validScenario,
        prompt: "../../../etc/passwd",
      }),
      "/e/etc/passwd": "nope",
      "/e/s/s1/out.txt": "hi",
    });
    const result = loadSuite("/e/s", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/escapes its scenario dir/);
  });

  it("fails at validate time when resultSchema is not valid JSON", () => {
    const deps = memDeps({
      "/e/s/suite.json": JSON.stringify(validSuite),
      "/e/s/s1/case.json": JSON.stringify({
        ...validScenario,
        resultSchema: "result-schema.json",
      }),
      "/e/s/s1/prompt.md": "hi",
      "/e/s/s1/out.txt": "hi",
      "/e/s/s1/result-schema.json": "{ not valid json",
    });
    const result = loadSuite("/e/s", deps);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toMatch(/resultSchema.*not valid JSON/);
  });

  it("fails when the suite.json is missing", () => {
    const result = loadSuite("/e/s", memDeps({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing suite\.json/);
  });

  it("rejects a suite whose evalSlug would exceed the 60-char cap", () => {
    const longSuiteId = "suite-" + "x".repeat(60);
    const deps = memDeps({
      "/e/s/suite.json": JSON.stringify({
        ...validSuite,
        id: longSuiteId,
        scenarios: ["s1"],
      }),
      "/e/s/s1/case.json": JSON.stringify(validScenario),
      "/e/s/s1/prompt.md": "hi",
      "/e/s/s1/out.txt": "hi",
    });
    const result = loadSuite("/e/s", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/eval slug/);
  });

  it("resolves shim paths that climb out of the scenario dir", () => {
    const deps = memDeps({
      "/e/s/suite.json": JSON.stringify(validSuite),
      "/e/s/s1/case.json": JSON.stringify({
        ...validScenario,
        fixture: { shims: ["../../_shims/gh"] },
      }),
      "/e/s/s1/prompt.md": "hi",
      "/e/s/s1/out.txt": "hi",
      "/e/_shims/gh": "#!/usr/bin/env bun",
    });
    const result = loadSuite("/e/s", deps);
    expect(result.ok).toBe(true);
  });
});
