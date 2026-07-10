import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildProbeScript,
  compareValue,
  diffSpecCapture,
  firstFontFamily,
  normalizeColor,
  probeSelectorsFromSpec,
  PROBE_PROPERTIES,
} from "./flow-design-spec";
import {
  validateDesignCapture,
  validateDesignSpec,
  type DesignCapture,
  type DesignSpec,
} from "./lib/design-spec-schema";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "flow-design-spec.ts");
const FIXTURES = path.join(HERE, "fixtures", "design-spec");
const SPEC_PATH = path.join(FIXTURES, "spec.json");
const MATCHING_PATH = path.join(FIXTURES, "captured-matching.json");
const DIVERGENT_PATH = path.join(FIXTURES, "captured-divergent.json");

function readFixture<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function runCli(args: string[]) {
  return spawnSync("bun", [CLI, ...args], { encoding: "utf8" });
}

describe("probe-script emission", () => {
  it("emits getComputedStyle over exactly the declared selectors", () => {
    const script = buildProbeScript([".nav a.active"]);
    expect(script).toContain("getComputedStyle");
    expect(script).toContain('".nav a.active"');
    expect(script).toContain("querySelector");
    // Only declared selectors — never a whole-page walk.
    expect(script).not.toContain("querySelectorAll");
    expect(script).not.toContain('"*"');
  });

  it("embeds the fixed property set plus getBoundingClientRect", () => {
    const script = buildProbeScript([".x"]);
    for (const prop of PROBE_PROPERTIES) expect(script).toContain(prop);
    expect(script).toContain("getBoundingClientRect");
    expect(script).toContain("rect-width");
  });

  it("safely embeds selectors that contain quotes", () => {
    const script = buildProbeScript(['a[href="/x"]']);
    expect(script).toContain(JSON.stringify(['a[href="/x"]']));
  });

  it("derives probe selectors from the spec, skipping judged and source-read assertions", () => {
    const spec = readFixture<DesignSpec>(SPEC_PATH);
    // `.nav` still probes (nav-surface-bg is computed-style); judged/source-read
    // entries add no selector of their own.
    expect(probeSelectorsFromSpec(validated(spec))).toEqual([
      ".nav a.active",
      ".nav",
    ]);
  });
});

function validated(spec: unknown): DesignSpec {
  const r = validateDesignSpec(spec);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

describe("normalization", () => {
  it("treats hex, rgb, and rgba spellings of one color as equal", () => {
    expect(normalizeColor("#1a2b3c")).toBe("rgb(26, 43, 60)");
    expect(normalizeColor("rgb(26,43,60)")).toBe("rgb(26, 43, 60)");
    expect(normalizeColor("rgba(26, 43, 60, 1)")).toBe("rgb(26, 43, 60)");
    expect(normalizeColor("#fff")).toBe("rgb(255, 255, 255)");
    expect(normalizeColor("#ffffff80")).toBe("rgba(255, 255, 255, 0.502)");
    expect(normalizeColor("600")).toBeNull();
    expect(compareValue("color", "#1a2b3c", "rgb(26, 43, 60)")).toBe(true);
    expect(compareValue("color", "#1a2b3c", "rgb(26, 43, 61)")).toBe(false);
  });

  it("resolves a font stack to its first family", () => {
    expect(firstFontFamily("Inter, ui-sans-serif, sans-serif")).toBe("inter");
    expect(firstFontFamily('"Inter"')).toBe("inter");
    expect(
      compareValue("font-family", "Inter, ui-sans-serif, sans-serif", "Inter"),
    ).toBe(true);
    expect(compareValue("font-family", "Inter, sans-serif", "Georgia")).toBe(
      false,
    );
  });

  it("compares px values within the ±1px default tolerance", () => {
    expect(compareValue("font-size", "14.5px", "15px")).toBe(true);
    expect(compareValue("font-size", "14px", "15px")).toBe(true);
    expect(compareValue("font-size", "14px", "15.5px")).toBe(false);
  });

  it("honors a per-assertion tolerance override", () => {
    expect(compareValue("font-size", "14.5px", "15px", 0)).toBe(false);
    expect(compareValue("font-size", "12px", "15px", 3)).toBe(true);
  });

  it("normalizes compound values token-wise (box-shadow rgba spacing)", () => {
    expect(
      compareValue(
        "box-shadow",
        "0px 1px 2px rgba(0,0,0,0.05)",
        "0px 1px 2px rgba(0, 0, 0, 0.05)",
      ),
    ).toBe(true);
    expect(
      compareValue(
        "box-shadow",
        "0px 1px 2px rgba(0,0,0,0.05)",
        "0px 1px 2px rgba(0, 0, 0, 0.5)",
      ),
    ).toBe(false);
  });
});

describe("diff verdicts on the fixtures", () => {
  const spec = validated(readFixture(SPEC_PATH));

  it("passes every mechanical assertion on the matching capture", () => {
    const capture = readFixture<DesignCapture>(MATCHING_PATH);
    const envelope = diffSpecCapture(spec, capture);
    expect(envelope.ok).toBe(true);
    const byId = Object.fromEntries(
      envelope.assertions.map((a) => [a.id, a.status]),
    );
    expect(byId).toEqual({
      "nav-active-weight": "pass",
      "nav-surface-bg": "pass",
      "nav-source-token": "pass",
      "nav-feel": "skipped-judged",
    });
  });

  it("fails exactly the seeded assertion id on the divergent capture", () => {
    const capture = readFixture<DesignCapture>(DIVERGENT_PATH);
    const envelope = diffSpecCapture(spec, capture);
    expect(envelope.ok).toBe(false);
    const failed = envelope.assertions.filter((a) => a.status === "fail");
    expect(failed.map((a) => a.id)).toEqual(["nav-active-weight"]);
    expect(failed[0].failing).toEqual(["font-weight"]);
    expect(failed[0].expected?.["font-weight"]).toBe("600");
    expect(failed[0].actual?.["font-weight"]).toBe("400");
  });

  it("reports judged-tier assertions as skipped-judged, never failing mechanically", () => {
    const capture = readFixture<DesignCapture>(DIVERGENT_PATH);
    const envelope = diffSpecCapture(spec, capture);
    const judged = envelope.assertions.find((a) => a.id === "nav-feel");
    expect(judged?.status).toBe("skipped-judged");
  });

  it("fails an assertion whose selector was never captured", () => {
    const capture = validCapture({ surface: "nav", captured: [] });
    const envelope = diffSpecCapture(spec, capture);
    const first = envelope.assertions.find((a) => a.id === "nav-active-weight");
    expect(first?.status).toBe("fail");
    expect(first?.actual).toBeNull();
  });

  it("throws a loud error for a capture surface the spec does not declare", () => {
    const capture = validCapture({ surface: "footer", captured: [] });
    expect(() => diffSpecCapture(spec, capture)).toThrow(/footer/);
  });
});

function validCapture(c: unknown): DesignCapture {
  const r = validateDesignCapture(c);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

describe("tolerant validate", () => {
  it("accepts the spec fixture", () => {
    expect(validateDesignSpec(readFixture(SPEC_PATH)).ok).toBe(true);
  });

  it("rejects wrong shapes with a loud reason, never a crash", () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /object/],
      [[], /object/],
      [{}, /surfaces/],
      [{ surfaces: [] }, /non-empty/],
      [{ surfaces: [{ name: "", route: "/", assertions: [] }] }, /name/],
      [{ surfaces: [{ name: "n", route: "/", assertions: [{}] }] }, /id/],
      [
        {
          surfaces: [
            {
              name: "n",
              route: "/",
              assertions: [{ id: "a", selector: ".x", tier: "vibes" }],
            },
          ],
        },
        /tier/,
      ],
      [
        {
          surfaces: [
            {
              name: "n",
              route: "/",
              assertions: [{ id: "a", selector: ".x", tier: "mechanical" }],
            },
          ],
        },
        /properties/,
      ],
    ];
    for (const [input, re] of cases) {
      const r = validateDesignSpec(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    }
  });

  it("rejects duplicate assertion ids across the spec", () => {
    const spec = readFixture<DesignSpec>(SPEC_PATH);
    spec.surfaces[0].assertions[1].id = "nav-active-weight";
    const r = validateDesignSpec(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unique/);
  });

  it("is permissive on extra keys in both shapes", () => {
    expect(validateDesignSpec(readFixture(SPEC_PATH)).ok).toBe(true); // _comment
    expect(validateDesignCapture(readFixture(MATCHING_PATH)).ok).toBe(true);
  });

  it("rejects malformed captures with a loud reason", () => {
    const r = validateDesignCapture({ surface: "nav", captured: [{}] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/selector/);
  });
});

describe("CLI exit codes", () => {
  it("probe-script exits 0 and emits getComputedStyle", () => {
    const r = runCli(["probe-script", "--selectors", ".nav a.active"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("getComputedStyle");
  });

  it("diff exits 0 on the matching fixture", () => {
    const r = runCli([
      "diff",
      "--spec",
      SPEC_PATH,
      "--captured",
      MATCHING_PATH,
    ]);
    expect(r.status).toBe(0);
  });

  it("diff exits 1 on the divergent fixture, naming the failing assertion id", () => {
    const r = runCli([
      "diff",
      "--spec",
      SPEC_PATH,
      "--captured",
      DIVERGENT_PATH,
      "--json",
    ]);
    expect(r.status).toBe(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(false);
    expect(
      envelope.assertions
        .filter((a: { status: string }) => a.status === "fail")
        .map((a: { id: string }) => a.id),
    ).toEqual(["nav-active-weight"]);
  });

  it("diff exits 2 with a loud stderr reason on malformed input", () => {
    const r = runCli(["diff", "--spec", SPEC_PATH, "--captured", SPEC_PATH]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/invalid capture/);
  });

  it("diff exits 2 on a missing file rather than crashing", () => {
    const r = runCli([
      "diff",
      "--spec",
      SPEC_PATH,
      "--captured",
      path.join(FIXTURES, "does-not-exist.json"),
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot read/);
  });

  it("validate exits 0 on the fixture and 1 on an invalid spec", () => {
    expect(runCli(["validate", SPEC_PATH]).status).toBe(0);
    const r = runCli(["validate", MATCHING_PATH]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/surfaces/);
  });

  it("unknown subcommand exits 2 with usage", () => {
    const r = runCli(["frobnicate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });
});
