import { describe, expect, it } from "vitest";
import { parseTestTiers, planSelection, type TestTiers } from "./test-tiers";

const validManifest = {
  version: 1,
  alwaysRun: ["bin/skill-md-lint.test.ts"],
  deferToCi: ["bin/flow-new-worktree.test.ts"],
  forceFullOn: ["vitest.config.ts", "tsconfig*.json"],
};

describe(parseTestTiers, () => {
  it("returns a TestTiers object for a well-formed manifest", () => {
    expect(parseTestTiers(validManifest)).toEqual(validManifest);
  });

  it("returns null when a required key is missing", () => {
    const { forceFullOn: _forceFullOn, ...rest } = validManifest;
    expect(parseTestTiers(rest)).toBeNull();
  });

  it("returns null when a tier field is not an array of strings", () => {
    expect(
      parseTestTiers({ ...validManifest, alwaysRun: "not-an-array" }),
    ).toBeNull();
    expect(
      parseTestTiers({ ...validManifest, deferToCi: [1, 2, 3] }),
    ).toBeNull();
  });

  it("returns null when version is not 1", () => {
    expect(parseTestTiers({ ...validManifest, version: 2 })).toBeNull();
  });

  it("never throws on arbitrary malformed input", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      "a string",
      ["an", "array"],
      { version: 1, alwaysRun: [{ nested: "wrong-type" }] },
    ];
    for (const input of inputs) {
      expect(() => parseTestTiers(input)).not.toThrow();
      expect(parseTestTiers(input)).toBeNull();
    }
  });
});

const tiers: TestTiers = {
  version: 1,
  alwaysRun: ["bin/skill-md-lint.test.ts", "bin/pane-read-lint.test.ts"],
  deferToCi: ["bin/lib/feature.test.ts"],
  forceFullOn: ["vitest.config.ts", "tsconfig*.json"],
};

describe(planSelection, () => {
  it("returns mode 'full' with reason 'no changed-file list' when changedFiles is undefined", () => {
    const plan = planSelection(undefined, tiers);
    expect(plan).toEqual({ mode: "full", reason: "no changed-file list" });
  });

  it("returns mode 'full' when a changed file matches a forceFullOn entry (exact path)", () => {
    const plan = planSelection(["vitest.config.ts"], tiers);
    expect(plan.mode).toBe("full");
    expect((plan as { reason: string }).reason).toContain("vitest.config.ts");
  });

  it("returns mode 'full' when a changed file matches a forceFullOn glob entry", () => {
    const plan = planSelection(["tsconfig.base.json"], tiers);
    expect(plan.mode).toBe("full");
    expect((plan as { reason: string }).reason).toContain("tsconfig.base.json");
  });

  it("includes every alwaysRun entry in explicitFiles for any selection", () => {
    const plan = planSelection(["bin/lib/foo.ts"], tiers);
    if (plan.mode !== "selected") throw new Error("expected selected mode");
    for (const f of tiers.alwaysRun) {
      expect(plan.explicitFiles).toContain(f);
    }
  });

  it("adds the colocated '<changed>.test.ts' sibling even when that sibling is in deferToCi", () => {
    const plan = planSelection(["bin/lib/feature.ts"], tiers);
    if (plan.mode !== "selected") throw new Error("expected selected mode");
    expect(plan.explicitFiles).toContain("bin/lib/feature.test.ts");
  });

  it("excludes deferToCi entries from `excluded` when they are not otherwise selected", () => {
    const plan = planSelection(["bin/lib/unrelated.ts"], tiers);
    if (plan.mode !== "selected") throw new Error("expected selected mode");
    expect(plan.excluded).toEqual(["bin/lib/feature.test.ts"]);
  });

  it("returns mode 'full' when explicitFiles would be shorter than alwaysRun (fail-closed)", () => {
    // Manifest rot: one of the two alwaysRun entries no longer exists on
    // disk, and the changed file isn't a .ts (so no colocated addition
    // makes up the difference) — the union can never recover the dropped
    // entry, so the selection falls back to the full suite.
    const plan = planSelection(["docs/readme.md"], tiers, {
      discoveredTestFiles: ["bin/pane-read-lint.test.ts"],
    });
    expect(plan.mode).toBe("full");
    expect((plan as { reason: string }).reason).toBe(
      "selection shorter than always-run set",
    );
  });

  it("returns empty relatedInputs and alwaysRun-only explicitFiles for a .md-only change list", () => {
    const plan = planSelection(["docs/readme.md"], tiers);
    if (plan.mode !== "selected") throw new Error("expected selected mode");
    expect(plan.relatedInputs).toEqual([]);
    expect(plan.explicitFiles).toEqual([...tiers.alwaysRun].sort());
  });

  it("drops alwaysRun and deferToCi entries absent from opts.discoveredTestFiles (manifest rot)", () => {
    const plan = planSelection(["bin/lib/unrelated.ts"], tiers, {
      discoveredTestFiles: [
        "bin/skill-md-lint.test.ts",
        "bin/pane-read-lint.test.ts",
      ],
    });
    if (plan.mode !== "selected") throw new Error("expected selected mode");
    expect(plan.excluded).toEqual([]);
  });

  it("lists a colocated file pulled back from deferToCi in isolatedFiles", () => {
    const plan = planSelection(["bin/lib/feature.ts"], tiers);
    if (plan.mode !== "selected") throw new Error("expected selected mode");
    expect(plan.isolatedFiles).toEqual(["bin/lib/feature.test.ts"]);
  });

  it("includes a changed test file directly in explicitFiles even though it has no colocated sibling (B1)", () => {
    const plan = planSelection(["bin/lib/slug.test.ts"], tiers, {
      discoveredTestFiles: [...tiers.alwaysRun, "bin/lib/slug.test.ts"],
    });
    if (plan.mode !== "selected") throw new Error("expected selected mode");
    expect(plan.explicitFiles).toContain("bin/lib/slug.test.ts");
  });

  it("still returns mode 'full' on manifest rot even when colocated additions would otherwise mask it (B2)", () => {
    // 5-entry alwaysRun where 4 entries have rotted off disk; the one
    // survivor is undermined by adding 4 colocated files from an unrelated
    // change so explicitFiles.length reaches 5 again — the union masks the
    // rot if compared against explicitFiles.length instead of the
    // rot-filtered alwaysRun length.
    const rotTiers: TestTiers = {
      version: 1,
      alwaysRun: [
        "bin/lib/a.test.ts",
        "bin/lib/b.test.ts",
        "bin/lib/c.test.ts",
        "bin/lib/d.test.ts",
        "bin/lib/survivor.test.ts",
      ],
      deferToCi: [],
      forceFullOn: [],
    };
    const plan = planSelection(
      [
        "bin/lib/one.ts",
        "bin/lib/two.ts",
        "bin/lib/three.ts",
        "bin/lib/four.ts",
      ],
      rotTiers,
      { discoveredTestFiles: ["bin/lib/survivor.test.ts"] },
    );
    expect(plan.mode).toBe("full");
    expect((plan as { reason: string }).reason).toBe(
      "selection shorter than always-run set",
    );
  });
});
