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

  it("planReview/planReviewSecond stay on DIFFERENT vendor families, with no runtime guard to fall back on", () => {
    // Verified asymmetry (2026-09-05): flow-research-run.ts and
    // flow-blind-survey.ts each carry a runtime equality guard for their
    // pairs (see the two distinctness tests above), but flow-plan-review.ts
    // resolves MODEL and SECOND_MODEL and never compares them at runtime —
    // planReview/planReviewSecond is the one adversarial pair with NO
    // runtime protection, so this static default-level guard is the only
    // thing standing between it and a same-family collapse.
    const planFamily = DELEGATE_MODEL_DEFAULTS.planReview!.split(/\s+/)[0];
    const secondFamily =
      DELEGATE_MODEL_DEFAULTS.planReviewSecond!.split(/\s+/)[0];
    expect(planFamily).not.toBe(secondFamily);
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

  it("adversarial pairs stay on DIFFERENT product-line prefixes, not merely different strings", () => {
    // The two distinctness guards above test string inequality, which is all
    // flow-research-run.ts' resolveModels and flow-blind-survey enforce at
    // runtime. That is too weak for the property those pairs actually exist
    // to hold: gather-vs-refute and survey-vs-second are ADVERSARIAL, so two
    // different models from the SAME product line (e.g. "Gemini 3.1 Pro
    // (High)" refuting "Gemini 3.8 Flash (High)") would pass both string
    // checks while collapsing the cross-line tension into intra-line
    // confirmation, with nothing warning. Scope is defaults only; a config
    // override stays deliberately unguarded (see the researchRefute comment
    // block in delegate-models.ts). NOTE: `family()` here derives a
    // product-line PREFIX (first whitespace token, e.g. "Claude" / "Gemini"
    // / "GPT-OSS"), not a vendor — "Claude Opus" and "Claude Sonnet" both
    // reduce to "Claude" and would NOT be caught by this guard; that's a
    // known narrower-than-the-name gap, not a bug in this assertion.
    const family = (value: string) => value.split(/\s+/)[0]!;
    for (const [a, b] of [
      ["researchGather", "researchRefute"],
      ["blindSurvey", "blindSurveySecond"],
    ] as const) {
      const va = DELEGATE_MODEL_DEFAULTS[a];
      const vb = DELEGATE_MODEL_DEFAULTS[b];
      expect(va).not.toBeNull();
      expect(vb).not.toBeNull();
      const famA = family(va as string);
      const famB = family(vb as string);
      expect(famA.length).toBeGreaterThan(0);
      expect(famB.length).toBeGreaterThan(0);
      expect(famA).not.toBe(famB);
    }
  });

  it("docs/configuration.md's delegate-models table cannot drift from the code defaults", () => {
    // PR #644 shipped a code flip whose docs/configuration.md "default today"
    // row went stale, and only a human reviewer caught it. This makes that
    // class of drift mechanical for THIS ONE FILE. Two other sites pin the
    // same researchGather/researchRefute strings byte-exactly and are
    // deliberately NOT covered here (different formats — prose + a shell
    // read_budget call, not a markdown table row):
    // skills/universal/flow-research/SKILL.md:85-86,158,386-387,391-392 and
    // skills/pipeline/flow-product-planning/references/discovery-instructions.md:106-107,114,117.
    // Reads the doc module-relative, the same way
    // the consumer-routing test above does (NOT cwd-relative — a cwd-relative
    // read here would ENOENT under any invocation whose cwd isn't the repo
    // root, e.g. a single-file vitest run from an editor).
    const doc = fs
      .readFileSync(
        new URL("../../docs/configuration.md", import.meta.url),
        "utf8",
      )
      .split("\n");
    // Anchor the search to the "## Delegate models" table specifically: the
    // doc also has a "## Delegate timeouts" table AND a namespace-distinct
    // `models.scout` row under "## Per-phase models" that both match a bare
    // `` `scout` `` substring search, so scanning the whole document would
    // silently pick the wrong row the moment `scout`'s default flips non-null.
    const tableStart = doc.findIndex((line) =>
      line.startsWith("## Delegate models"),
    );
    expect(
      tableStart,
      "docs/configuration.md is missing the Delegate models heading",
    ).toBeGreaterThanOrEqual(0);
    const nextHeadingOffset = doc
      .slice(tableStart + 1)
      .findIndex((line) => line.startsWith("## "));
    const tableEnd =
      nextHeadingOffset === -1
        ? doc.length
        : tableStart + 1 + nextHeadingOffset;
    const tableLines = doc.slice(tableStart, tableEnd);
    for (const surface of ALL_SURFACES) {
      const value = DELEGATE_MODEL_DEFAULTS[surface];
      if (value === null) continue;
      const row = tableLines.find(
        (line) =>
          line.trimStart().startsWith("|") && line.includes(`\`${surface}\``),
      );
      expect(
        row,
        `no docs/configuration.md Delegate models table row for ${surface}`,
      ).toBeDefined();
      expect(row, `stale doc row for ${surface}: expected ${value}`).toContain(
        value,
      );
    }
  });
});
