import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELEGATE_MODEL_DEFAULTS,
  resolveDelegateModel,
  type DelegateSurface,
} from "./delegate-models";
import type { ReadConfigFile } from "./models-config";

// Inject the config-read seam so the real ~/.flow/config.json is never
// touched. Mirrors models-config.test.ts's `reader` helper.
const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

const ALL_SURFACES = Object.keys(DELEGATE_MODEL_DEFAULTS) as DelegateSurface[];

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("resolveDelegateModel", () => {
  it("resolves the seeded default for every surface when the config file is absent", () => {
    for (const surface of ALL_SURFACES) {
      expect(resolveDelegateModel(surface, reader(undefined))).toBe(
        DELEGATE_MODEL_DEFAULTS[surface],
      );
    }
  });

  it("resolves the default silently on malformed/non-object JSON", () => {
    expect(resolveDelegateModel("intentGuess", reader("not-an-object"))).toBe(
      DELEGATE_MODEL_DEFAULTS.intentGuess,
    );
    expect(resolveDelegateModel("intentGuess", reader(null))).toBe(
      DELEGATE_MODEL_DEFAULTS.intentGuess,
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("resolves the default when delegate.models key is absent", () => {
    expect(
      resolveDelegateModel("reviewLens", reader({ delegate: { models: {} } })),
    ).toBe(DELEGATE_MODEL_DEFAULTS.reviewLens);
    expect(resolveDelegateModel("reviewLens", reader({ delegate: {} }))).toBe(
      DELEGATE_MODEL_DEFAULTS.reviewLens,
    );
    expect(resolveDelegateModel("reviewLens", reader({}))).toBe(
      DELEGATE_MODEL_DEFAULTS.reviewLens,
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("a present well-typed override wins", () => {
    expect(
      resolveDelegateModel(
        "planReview",
        reader({
          delegate: { models: { planReview: "GPT-OSS 120B (Medium)" } },
        }),
      ),
    ).toBe("GPT-OSS 120B (Medium)");
  });

  it("a present wrong-typed value (number) warns on stderr and resolves the default", () => {
    expect(
      resolveDelegateModel(
        "researchGather",
        reader({ delegate: { models: { researchGather: 42 } } }),
      ),
    ).toBe(DELEGATE_MODEL_DEFAULTS.researchGather);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toContain(
      "delegate.models.researchGather",
    );
  });

  it("a present wrong-typed value (object) warns on stderr and resolves the default", () => {
    // A distinct surface from the number-typed case above: the once-per-
    // process warn dedup (see the next test) means re-using "researchGather"
    // here would silently record zero further calls, not re-prove the warn
    // path — that would be a false pass, not a real assertion.
    expect(
      resolveDelegateModel(
        "researchRefute",
        reader({ delegate: { models: { researchRefute: {} } } }),
      ),
    ).toBe(DELEGATE_MODEL_DEFAULTS.researchRefute);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toContain(
      "delegate.models.researchRefute",
    );
  });

  it("the override-active notice fires once per surface per process, even across repeated calls", () => {
    const cfg = reader({
      delegate: { models: { reviewLens: "GPT-OSS 120B (Medium)" } },
    });
    resolveDelegateModel("reviewLens", cfg);
    resolveDelegateModel("reviewLens", cfg);
    resolveDelegateModel("reviewLens", cfg);
    const overrideCalls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes("config override active"),
    );
    expect(overrideCalls.length).toBe(1);
  });

  it("scout's default is null, and a config override makes it non-null", () => {
    expect(DELEGATE_MODEL_DEFAULTS.scout).toBeNull();
    expect(resolveDelegateModel("scout", reader(undefined))).toBeNull();
    expect(
      resolveDelegateModel(
        "scout",
        reader({ delegate: { models: { scout: "Gemini 3.1 Pro (High)" } } }),
      ),
    ).toBe("Gemini 3.1 Pro (High)");
  });

  it("every consumer routes through resolveDelegateModel with its own surface key", () => {
    const intentGuessSrc = fs.readFileSync(
      new URL("../flow-gemini-intent-guess.ts", import.meta.url),
      "utf8",
    );
    expect(intentGuessSrc).toContain('resolveDelegateModel("intentGuess")');

    const lensSrc = fs.readFileSync(
      new URL("../flow-gemini-lens.ts", import.meta.url),
      "utf8",
    );
    expect(lensSrc).toContain('resolveDelegateModel("reviewLens")');

    const researchRunSrc = fs.readFileSync(
      new URL("../flow-research-run.ts", import.meta.url),
      "utf8",
    );
    expect(researchRunSrc).toContain(
      'defaultGatherModel = resolveDelegateModel("researchGather")',
    );
    expect(researchRunSrc).toContain(
      'defaultRefuteModel = resolveDelegateModel("researchRefute")',
    );

    const planReviewSrc = fs.readFileSync(
      new URL("../flow-plan-review.ts", import.meta.url),
      "utf8",
    );
    expect(planReviewSrc).toContain(
      'const MODEL = resolveDelegateModel("planReview")',
    );
    expect(planReviewSrc).toContain(
      'const SECOND_MODEL = resolveDelegateModel("planReviewSecond")',
    );

    const blindSurveySrc = fs.readFileSync(
      new URL("../flow-blind-survey.ts", import.meta.url),
      "utf8",
    );
    expect(blindSurveySrc).toContain('resolveDelegateModel("blindSurvey")');
    expect(blindSurveySrc).toContain(
      'resolveDelegateModel("blindSurveySecond")',
    );
  });

  it("every non-null default is a display-name form (ends in a parenthesised tier)", () => {
    // Pins the convention that production helpers pass agy DISPLAY NAMES,
    // while the benchmark harness pins SLUGS (a different namespace, since
    // `agy models` emits slugs). Nothing yet verifies the two forms name
    // the same underlying model — this guard only pins the FORM, which is
    // enough to catch silent cross-namespace drift (a slug landing here by
    // mistake) mechanically.
    for (const surface of ALL_SURFACES) {
      const value = DELEGATE_MODEL_DEFAULTS[surface];
      if (value === null) continue;
      expect(value).toMatch(/\(.*\)$/);
    }
  });

  it("gather/refute defaults stay distinct (flow-research-run diversity guard would silently downgrade an equal pair)", () => {
    expect(DELEGATE_MODEL_DEFAULTS.researchGather).not.toBe(
      DELEGATE_MODEL_DEFAULTS.researchRefute,
    );
  });

  it("blind-survey defaults stay distinct (flow-blind-survey diversity guard would silently downgrade an equal pair)", () => {
    expect(DELEGATE_MODEL_DEFAULTS.blindSurvey).not.toBe(
      DELEGATE_MODEL_DEFAULTS.blindSurveySecond,
    );
  });
});
