import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BENCH_SURFACES,
  validateCase,
  validateResults,
  validateTruth,
} from "./model-bench-schema";

describe("validateCase", () => {
  const wellFormed = {
    id: "c1",
    surface: "scout",
    kind: "multi-file",
    promptFile: "prompt.md",
    inputFiles: ["a.ts", "b.ts"],
    authoredAtCommit: "abc1234",
    routable: true,
  };

  it("validates a well-formed case and returns the typed value", () => {
    const result = validateCase(wellFormed);
    expect(result).toEqual({ ok: true, value: wellFormed });
  });

  it("rejects a case with an empty authoredAtCommit, naming it", () => {
    const result = validateCase({ ...wellFormed, authoredAtCommit: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/authoredAtCommit/);
    }
  });

  it("rejects schemaAb:true without jsonSchemaFile", () => {
    const result = validateCase({ ...wellFormed, schemaAb: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/schemaAb/);
      expect(result.reason).toMatch(/jsonSchemaFile/);
    }
  });

  it("accepts schemaAb:true when jsonSchemaFile is present", () => {
    const result = validateCase({
      ...wellFormed,
      schemaAb: true,
      jsonSchemaFile: "schema.json",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a surface outside the BenchSurface union", () => {
    const result = validateCase({ ...wellFormed, surface: "bogus-surface" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/surface/);
    }
  });

  it("rejects 'fix-applier' and 'verify-loop' as surfaces (pins the deliberate exclusion)", () => {
    for (const surface of ["fix-applier", "verify-loop"]) {
      const result = validateCase({ ...wellFormed, surface });
      expect(result.ok).toBe(false);
    }
    expect(BENCH_SURFACES).not.toContain("fix-applier");
    expect(BENCH_SURFACES).not.toContain("verify-loop");
  });
});

describe("validateTruth", () => {
  const wellFormed = {
    caseId: "c1",
    required: ["mentions the bug"],
  };

  it("validates a well-formed truth", () => {
    expect(validateTruth(wellFormed)).toEqual({ ok: true, value: wellFormed });
  });

  it("rejects a truth with an empty 'required' array", () => {
    const result = validateTruth({ caseId: "c1", required: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/required/);
    }
  });
});

describe("validateResults", () => {
  const wellFormedResult = {
    caseId: "c1",
    arm: "schema" as const,
    model: "gemini-3.6-flash-high",
    repeat: 0,
    warmup: false,
    ran: true,
  };

  it("validates a results array", () => {
    const result = validateResults([wellFormedResult]);
    expect(result).toEqual({ ok: true, value: [wellFormedResult] });
  });

  it("rejects a non-array", () => {
    const result = validateResults(wellFormedResult);
    expect(result.ok).toBe(false);
  });
});

// Fixture sweeps over bin/fixtures/model-bench/*/. The sweeps iterate whatever
// dirs are present and pass vacuously on an empty/missing tree, so the
// contract module stays testable independently of the fixtures.
const FIXTURES_ROOT = path.resolve(__dirname, "..", "fixtures", "model-bench");

function caseDirs(): string[] {
  if (!existsSync(FIXTURES_ROOT)) return [];
  return readdirSync(FIXTURES_ROOT).filter((name) =>
    statSync(path.join(FIXTURES_ROOT, name)).isDirectory(),
  );
}

describe("fixture sweep: bin/fixtures/model-bench/*/", () => {
  it("places a 'reasoning' string property FIRST in every committed schema.json", () => {
    const dirs = caseDirs();
    for (const dir of dirs) {
      const schemaPath = path.join(FIXTURES_ROOT, dir, "schema.json");
      if (!existsSync(schemaPath)) continue;
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      const keys = Object.keys(schema.properties ?? {});
      expect(keys[0], `${dir}/schema.json properties order`).toBe("reasoning");
    }
    // vacuous pass when no fixtures exist yet
    expect(dirs).toEqual(dirs);
  });

  it("resolves every path inside every committed truth.json INSIDE its own case dir", () => {
    const dirs = caseDirs();
    for (const dir of dirs) {
      const truthPath = path.join(FIXTURES_ROOT, dir, "truth.json");
      if (!existsSync(truthPath)) continue;
      const caseRoot = path.join(FIXTURES_ROOT, dir);
      const truth = JSON.parse(readFileSync(truthPath, "utf8"));
      const defectFiles: string[] = Array.isArray(truth.defects)
        ? truth.defects.map((d: { file: string }) => d.file)
        : [];
      for (const rel of defectFiles) {
        const resolved = path.resolve(caseRoot, rel);
        expect(
          resolved.startsWith(caseRoot + path.sep),
          `${dir}/truth.json defect path "${rel}" escapes its case dir`,
        ).toBe(true);
      }
    }
    expect(dirs).toEqual(dirs);
  });

  // c10's prompt.md lifts the gatekeeper's documented skip rules verbatim so
  // the case measures the real job. Nothing otherwise couples the two, so a
  // later edit to the spawn prompt would silently leave the fixture scoring
  // against retired rules. Pin the enum both sides share.
  it("keeps c10's skip-rule vocabulary in sync with gatekeeper-spawn-prompt.md", () => {
    const promptPath = path.join(FIXTURES_ROOT, "c10-gatekeeper", "prompt.md");
    const sourcePath = path.resolve(
      __dirname,
      "..",
      "..",
      "skills",
      "pipeline",
      "flow-pr-review",
      "references",
      "gatekeeper-spawn-prompt.md",
    );
    if (!existsSync(promptPath) || !existsSync(sourcePath)) return;
    const source = readFileSync(sourcePath, "utf8");
    const kinds = [
      ...new Set(
        [...source.matchAll(/`skip_kind`?:?\s*"([a-z-]+)"/g)].map((m) => m[1]),
      ),
    ];
    expect(
      kinds.length,
      "no skip_kind values found in gatekeeper-spawn-prompt.md — the anchor drifted",
    ).toBeGreaterThan(0);
    const prompt = readFileSync(promptPath, "utf8");
    for (const kind of kinds) {
      expect(
        prompt.includes(kind),
        `c10-gatekeeper/prompt.md is missing skip_kind "${kind}" documented in gatekeeper-spawn-prompt.md — re-lift the rules into the fixture`,
      ).toBe(true);
    }
  });
});
