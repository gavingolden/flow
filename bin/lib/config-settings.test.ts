import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSettingsRows, SETTINGS_KEYS } from "./config-settings";
import { DELEGATE_MODEL_DEFAULTS } from "./delegate-models";
import { resolveModels } from "../flow-research-run";
import type { ReadConfigFile } from "./models-config";

const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("buildSettingsRows", () => {
  // vitest.setup.ts sets FLOW_KEEP_AWAKE=0 suite-wide; unset it so the
  // power.keepAwake row reflects the config, not the suite's env opt-out.
  beforeEach(() => vi.stubEnv("FLOW_KEEP_AWAKE", undefined as never));
  afterEach(() => vi.unstubAllEnvs());

  it("power.keepAwake reports the FLOW_KEEP_AWAKE=0 env opt-out", () => {
    vi.stubEnv("FLOW_KEEP_AWAKE", "0");
    const row = buildSettingsRows(reader(undefined)).find(
      (r) => r.setting === "power.keepAwake",
    );
    expect(row?.value).toBe("false");
    expect(row?.source).toBe("env (FLOW_KEEP_AWAKE=0)");
  });

  // SETTINGS_KEYS collapses the 14 individual delegate.models.*/
  // delegate.timeouts.* rows down to their two existing doc-table glob
  // entries (see config-settings.ts's SETTINGS_KEYS doc comment), so a
  // rendered row's `setting` is either a literal SETTINGS_KEYS entry or
  // matches one of those two glob prefixes.
  const matchesSettingsKeys = (setting: string): boolean =>
    SETTINGS_KEYS.includes(setting) ||
    setting.startsWith("delegate.models.") ||
    setting.startsWith("delegate.timeouts.");

  it("every rendered row has a non-empty meaning and maps onto SETTINGS_KEYS", () => {
    const rows = buildSettingsRows(reader(undefined));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(matchesSettingsKeys(row.setting), row.setting).toBe(true);
      expect(row.meaning.length).toBeGreaterThan(0);
      expect(row.value.length).toBeGreaterThan(0);
      expect(row.source.length).toBeGreaterThan(0);
    }
  });

  it("a set delegate.models.researchGather with research.model unset attributes the source to the delegate key", () => {
    const rows = buildSettingsRows(
      reader({ delegate: { models: { researchGather: "Gemini X" } } }),
    );
    const row = rows.find((r) => r.setting === "research.model");
    expect(row).toMatchObject({
      value: "Gemini X",
      source: "config (delegate.models.researchGather)",
    });
  });

  it("research.model set directly wins over a delegate.models.researchGather override", () => {
    const rows = buildSettingsRows(
      reader({
        research: { model: "Direct Model" },
        delegate: { models: { researchGather: "Gemini X" } },
      }),
    );
    const row = rows.find((r) => r.setting === "research.model");
    expect(row).toMatchObject({
      value: "Direct Model",
      source: "config (research.model)",
    });
  });

  it("research.refuteModel: a collision with the gather model renders the diversity-guard substitution, not the configured value", () => {
    const rows = buildSettingsRows(
      reader({ research: { model: "X", refuteModel: "X" } }),
    );
    const row = rows.find((r) => r.setting === "research.refuteModel");
    expect(row?.value).not.toBe("X");
    expect(row?.source).toContain("diversity guard");
    expect(row?.source).toContain("X collides with gather");
    expect(row?.value).toBe(DELEGATE_MODEL_DEFAULTS.researchRefuteFallback);
  });

  it("research.refuteModel: a configured fallback stand-in is attributed to its config key", () => {
    const rows = buildSettingsRows(
      reader({
        research: { model: "X", refuteModel: "X" },
        delegate: { models: { researchRefuteFallback: "Fallback Test (Low)" } },
      }),
    );
    const row = rows.find((r) => r.setting === "research.refuteModel");
    expect(row?.value).toBe("Fallback Test (Low)");
    expect(row?.source).toContain(
      "config (delegate.models.researchRefuteFallback",
    );
  });

  it("research.refuteModel row matches flow-research-run's resolved refute model for every collision shape", () => {
    const d = DELEGATE_MODEL_DEFAULTS;
    const fb = "Fallback Test (Low)";
    const configs: unknown[] = [
      {},
      { research: { model: "X", refuteModel: "X" } },
      {
        research: { model: "X", refuteModel: "X" },
        delegate: { models: { researchRefuteFallback: fb } },
      },
      {
        research: {
          model: d.researchRefuteFallback,
          refuteModel: d.researchRefuteFallback,
        },
      },
      {
        research: { model: fb, refuteModel: fb },
        delegate: { models: { researchRefuteFallback: fb } },
      },
    ];
    for (const cfg of configs) {
      const row = buildSettingsRows(reader(cfg)).find(
        (r) => r.setting === "research.refuteModel",
      );
      expect(row?.value, JSON.stringify(cfg)).toBe(
        resolveModels(cfg, () => {}).refuteModel,
      );
    }
  });

  it("an absent config renders a full built-ins-only table with exit-0-safe defaults", () => {
    const rows = buildSettingsRows(reader(undefined));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toMatch(/^built-in/);
    }
  });

  it("a malformed (junk-parsed) config renders a full built-ins-only table", () => {
    const rows = buildSettingsRows(reader("not-an-object"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toMatch(/^built-in/);
    }
  });

  it("a throwing reader degrades to the full built-ins-only table rather than throwing", () => {
    const throwing: ReadConfigFile = () => {
      throw new Error("boom");
    };
    expect(() => buildSettingsRows(throwing)).not.toThrow();
    const rows = buildSettingsRows(throwing);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toMatch(/^built-in/);
    }
  });

  it("no stderr warning is emitted for a delegate override", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    buildSettingsRows(
      reader({ delegate: { models: { researchGather: "Gemini X" } } }),
    );
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("renders 14 individual delegate rows (12 models + 2 timeouts)", () => {
    const rows = buildSettingsRows(reader(undefined));
    const modelRows = rows.filter((r) =>
      r.setting.startsWith("delegate.models."),
    );
    const timeoutRows = rows.filter((r) =>
      r.setting.startsWith("delegate.timeouts."),
    );
    expect(modelRows.length).toBe(12);
    expect(timeoutRows.length).toBe(2);
  });

  it("renders a Claude lensReroute override as built-in with the default value", () => {
    const row = buildSettingsRows(
      reader({
        delegate: { models: { lensReroute: "Claude Opus 5.5 (High)" } },
      }),
    ).find((r) => r.setting === "delegate.models.lensReroute");
    expect(row?.value).toBe(DELEGATE_MODEL_DEFAULTS.lensReroute);
    expect(row?.source).toMatch(/^built-in/);
  });

  it("renders the claudeLenses row off by default, with a plain-language name", () => {
    const row = buildSettingsRows(reader(undefined)).find(
      (r) => r.setting === "delegate.models.claudeLenses",
    );
    expect(row?.value).toBe("(none)");
    expect(row?.meaning).toContain("the delegated Claude review lenses");
    expect(row?.source).toBe("built-in (none)");
  });

  it("describes the scout row as live (agy first, Claude Task scout fallback), never 'reserved'", () => {
    const row = buildSettingsRows(reader(undefined)).find(
      (r) => r.setting === "delegate.models.scout",
    );
    expect(row?.meaning).toContain("Claude Task scout as the fallback");
    expect(row?.meaning).not.toContain("reserved");
    expect(row?.meaning).not.toContain("not yet wired");
    expect(row?.value).toBe("(none)");
  });

  it("renders delegate.lenses: none by default, the configured set when present", () => {
    const find = (raw: unknown) =>
      buildSettingsRows(reader(raw)).find(
        (r) => r.setting === "delegate.lenses",
      );
    expect(find(undefined)).toMatchObject({
      value: "(none)",
      source: "built-in (none)",
    });
    expect(
      find({ delegate: { lenses: ["bug-detection", "test-coverage"] } }),
    ).toMatchObject({
      value: "bug-detection, test-coverage",
      source: "config (delegate.lenses)",
    });
  });

  it("strict-false opt-out research/review keys default to true", () => {
    const rows = buildSettingsRows(reader(undefined));
    for (const key of [
      "research.deepResearchFallback",
      "review.lensGates",
      "review.deltaScope",
      "review.product",
      "review.planReviewClaudeFallback",
    ]) {
      const row = rows.find((r) => r.setting === key);
      expect(row?.value, key).toBe("true");
    }
  });

  it("strict-true opt-in research/review keys default to false", () => {
    const rows = buildSettingsRows(reader(undefined));
    for (const key of ["research.discovery", "review.gemini"]) {
      const row = rows.find((r) => r.setting === key);
      expect(row?.value, key).toBe("false");
    }
  });

  // The whole point of this view is that it never states a value it did not
  // resolve. Attributing source by comparing the resolved value against the
  // built-in default breaks exactly that: a user who configures a value
  // identical to the default is told flow is ignoring them.
  describe("source attribution is a presence check, never value-vs-default", () => {
    const sourceOf = (raw: unknown, key: string): string | undefined =>
      buildSettingsRows(reader(raw)).find((r) => r.setting === key)?.source;

    it("reads as config when the configured value equals the built-in default", () => {
      expect(
        sourceOf(
          { bots: { copilot: "copilot-pull-request-reviewer" } },
          "bots.copilot.login",
        ),
      ).toBe("config (bots.copilot)");
      expect(
        sourceOf(
          { bots: { copilot: { login: "copilot-pull-request-reviewer" } } },
          "bots.copilot.login",
        ),
      ).toBe("config (bots.copilot.login)");
      expect(
        sourceOf({ bots: { copilotSkipWait: false } }, "bots.copilotSkipWait"),
      ).toBe("config (bots.copilotSkipWait)");
      expect(sourceOf({ epic: { maxParallel: 3 } }, "epic.maxParallel")).toBe(
        "config (epic.maxParallel)",
      );
    });

    it("reads as built-in when the key is absent", () => {
      expect(sourceOf(undefined, "bots.copilot.login")).toMatch(/^built-in /);
      expect(sourceOf(undefined, "bots.copilotSkipWait")).toMatch(/^built-in /);
      expect(sourceOf(undefined, "epic.maxParallel")).toMatch(/^built-in /);
    });

    it("reads as built-in when the entry is present but the reader rejects it", () => {
      // A wrong-typed entry is ignored by the real consumer, so the value the
      // row shows IS the built-in — saying `config` there would be the same
      // class of lie, inverted.
      expect(
        sourceOf({ bots: { copilotSkipWait: "yes" } }, "bots.copilotSkipWait"),
      ).toMatch(/^built-in /);
      expect(
        sourceOf({ epic: { maxParallel: 0 } }, "epic.maxParallel"),
      ).toMatch(/^built-in /);
      expect(
        sourceOf({ epic: { maxParallel: 2.5 } }, "epic.maxParallel"),
      ).toMatch(/^built-in /);
    });

    // Widened from three hand-written descriptors to a table over EVERY
    // strict-boolean gate row, so a new descriptor can't opt out of this
    // guard by omission — the exact regression the PR body names as its
    // top risk (a new row silently reverting to value-vs-default
    // attribution).
    const PRESENCE_CASES: [raw: unknown, key: string, expected: string][] = [
      [
        { update: { checkFor: "notify" } },
        "update.checkFor",
        "config (update.checkFor)",
      ],
      [
        { update: { autoUpgrade: false } },
        "update.autoUpgrade",
        "config (update.autoUpgrade)",
      ],
      [{ product: { judge: true } }, "product.judge", "config (product.judge)"],
      [{ ui: { critique: true } }, "ui.critique", "config (ui.critique)"],
      [
        { review: { lensGates: true } },
        "review.lensGates",
        "config (review.lensGates)",
      ],
      [
        { review: { deltaScope: true } },
        "review.deltaScope",
        "config (review.deltaScope)",
      ],
      [
        { review: { product: true } },
        "review.product",
        "config (review.product)",
      ],
      [
        { research: { deepResearchFallback: true } },
        "research.deepResearchFallback",
        "config (research.deepResearchFallback)",
      ],
      [
        { research: { discovery: false } },
        "research.discovery",
        "config (research.discovery)",
      ],
      [
        { review: { gemini: false } },
        "review.gemini",
        "config (review.gemini)",
      ],
      [
        { power: { keepAwake: true } },
        "power.keepAwake",
        "config (power.keepAwake)",
      ],
    ];
    for (const [raw, key, expected] of PRESENCE_CASES) {
      it(`${key}: reads as config even when the configured value equals the built-in default`, () => {
        expect(sourceOf(raw, key)).toBe(expected);
      });
    }

    describe("power.keepAwakeMaxMinutes", () => {
      const rowOf = (raw: unknown) =>
        buildSettingsRows(reader(raw)).find(
          (r) => r.setting === "power.keepAwakeMaxMinutes",
        );

      it("should report the configured minutes when set", () => {
        expect(rowOf({ power: { keepAwakeMaxMinutes: 90 } })).toMatchObject({
          value: "90",
          source: "config (power.keepAwakeMaxMinutes)",
        });
      });

      it("should report the clamped minutes when below the floor", () => {
        expect(rowOf({ power: { keepAwakeMaxMinutes: 10 } })).toMatchObject({
          value: "30",
          source: "config (power.keepAwakeMaxMinutes)",
        });
      });

      it("should report the built-in default when unset", () => {
        expect(rowOf({})).toMatchObject({
          value: "120",
          source: "built-in (120)",
        });
      });
    });
  });
});
