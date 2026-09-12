import { describe, expect, it, vi } from "vitest";
import { buildSettingsRows, SETTINGS_KEYS } from "./config-settings";
import type { ReadConfigFile } from "./models-config";

const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("buildSettingsRows", () => {
  // SETTINGS_KEYS collapses the 11 individual delegate.models.*/
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

  it("renders 11 individual delegate rows (9 models + 2 timeouts)", () => {
    const rows = buildSettingsRows(reader(undefined));
    const modelRows = rows.filter((r) =>
      r.setting.startsWith("delegate.models."),
    );
    const timeoutRows = rows.filter((r) =>
      r.setting.startsWith("delegate.timeouts."),
    );
    expect(modelRows.length).toBe(9);
    expect(timeoutRows.length).toBe(2);
  });

  it("strict-false opt-out research/review keys default to true", () => {
    const rows = buildSettingsRows(reader(undefined));
    for (const key of [
      "research.deepResearchFallback",
      "review.lensGates",
      "review.deltaScope",
      "review.product",
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
          "bots.copilotLogin",
        ),
      ).toBe("config (bots.copilot)");
      expect(
        sourceOf(
          { bots: { copilot: { login: "copilot-pull-request-reviewer" } } },
          "bots.copilotLogin",
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
      expect(sourceOf(undefined, "bots.copilotLogin")).toMatch(/^built-in /);
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
  });
});
