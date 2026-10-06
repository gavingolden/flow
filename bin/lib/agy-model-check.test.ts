import { describe, expect, it } from "vitest";
import { DELEGATE_MODEL_DEFAULTS } from "./delegate-models";
import {
  configuredAgyModels,
  missingAgyModels,
  parseAgyModelNames,
  surfaceLabel,
} from "./agy-model-check";

const LIVE =
  "Fetching available models...\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n";

describe("configuredAgyModels", () => {
  it("lists every non-null default surface when config is empty", () => {
    const got = configuredAgyModels({});
    const expected = Object.entries(DELEGATE_MODEL_DEFAULTS).filter(
      ([, v]) => v !== null,
    );
    expect(got).toHaveLength(expected.length);
    for (const [surface, model] of expected) {
      expect(got).toContainEqual({ surface, model });
    }
    expect(got.map((c) => c.surface)).not.toContain("scout");
  });

  it("replaces a default with the config override", () => {
    const got = configuredAgyModels({
      delegate: { models: { researchRefute: "Some Model (High)" } },
    });
    expect(got).toContainEqual({
      surface: "researchRefute",
      model: "Some Model (High)",
    });
    expect(got).not.toContainEqual({
      surface: "researchRefute",
      model: DELEGATE_MODEL_DEFAULTS.researchRefute,
    });
  });

  it("ignores a scout override (no runtime path consumes it)", () => {
    expect(
      configuredAgyModels({ delegate: { models: { scout: "Scout M" } } }).map(
        (c) => c.surface,
      ),
    ).not.toContain("scout");
  });

  it("falls back to defaults for malformed or non-object config", () => {
    const base = configuredAgyModels({});
    expect(configuredAgyModels(undefined)).toEqual(base);
    expect(configuredAgyModels("junk")).toEqual(base);
    expect(configuredAgyModels({ delegate: { models: 7 } })).toEqual(base);
    expect(
      configuredAgyModels({ delegate: { models: { reviewLens: "  " } } }),
    ).toEqual(base);
  });

  it("reports research.model / research.refuteModel INSTEAD of the defaults they shadow", () => {
    const got = configuredAgyModels({
      research: { model: "G Model", refuteModel: "R Model", maxCalls: 3 },
      delegate: { models: { researchGather: "Shadowed G", scout: "Scout M" } },
    });
    expect(got).toContainEqual({ surface: "research.model", model: "G Model" });
    expect(got).toContainEqual({
      surface: "research.refuteModel",
      model: "R Model",
    });
    const surfaces = got.map((c) => c.surface);
    expect(surfaces).not.toContain("researchGather");
    expect(surfaces).not.toContain("researchRefute");
    expect(surfaces).not.toContain("scout");
    expect(got.map((c) => c.model)).not.toContain("Shadowed G");
  });

  it("shadows only the surface whose research override is set", () => {
    const got = configuredAgyModels({ research: { refuteModel: "R Model" } });
    const surfaces = got.map((c) => c.surface);
    expect(surfaces).toContain("researchGather");
    expect(surfaces).not.toContain("researchRefute");
  });
});

describe("parseAgyModelNames", () => {
  it("parses display names from the live tab-separated format", () => {
    expect(parseAgyModelNames(LIVE)).toEqual(
      new Set(["Claude Opus 5.5 (High)", "Gemini 3.1 Pro (High)"]),
    );
  });

  it("ignores the progress header and non-row lines", () => {
    expect(parseAgyModelNames("Fetching available models...\n").size).toBe(0);
  });
});

describe("missingAgyModels", () => {
  it("returns only the configured models agy does not list", () => {
    const configured = [
      { surface: "a", model: "Claude Opus 5.5 (High)" },
      { surface: "b", model: "Claude Opus 4.6 (Thinking)" },
    ];
    expect(missingAgyModels(configured, parseAgyModelNames(LIVE))).toEqual([
      { surface: "b", model: "Claude Opus 4.6 (Thinking)" },
    ]);
  });
});

describe("surfaceLabel", () => {
  it("names every configured surface in plain words", () => {
    for (const { surface } of configuredAgyModels({
      research: { model: "G", refuteModel: "R" },
    })) {
      expect(surfaceLabel(surface), surface).not.toBe(surface);
    }
  });
});
