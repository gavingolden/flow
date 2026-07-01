import { describe, expect, it } from "vitest";
import {
  DEFAULT_EPIC_AUTO_REDIRECT,
  DEFAULT_EPIC_JUDGMENT,
  DEFAULT_EPIC_MAX_REDIRECTS,
  DEFAULT_EPIC_MAX_RETRIES,
  DEFAULT_MAX_PARALLEL,
  readEpicAutoRedirect,
  readEpicJudgment,
  readEpicMaxParallel,
  readEpicMaxRedirects,
  readEpicMaxRetries,
  type ReadConfigFile,
} from "./epic-config";

// Inject the config-read seam so the real ~/.flow/config.json is never touched.
// Mirrors copilot-config.test.ts's `reader` helper.
const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("readEpicMaxParallel", () => {
  it("defaults to 3 when the config is unreadable (undefined)", () => {
    expect(readEpicMaxParallel(reader(undefined))).toBe(DEFAULT_MAX_PARALLEL);
    expect(DEFAULT_MAX_PARALLEL).toBe(3);
  });

  it("defaults to 3 when the epic key is absent", () => {
    expect(readEpicMaxParallel(reader({}))).toBe(3);
  });

  it("defaults to 3 when epic.maxParallel is absent", () => {
    expect(readEpicMaxParallel(reader({ epic: {} }))).toBe(3);
  });

  it("returns the configured positive integer", () => {
    expect(readEpicMaxParallel(reader({ epic: { maxParallel: 5 } }))).toBe(5);
    expect(readEpicMaxParallel(reader({ epic: { maxParallel: 1 } }))).toBe(1);
  });

  it("falls back to 3 for 0", () => {
    expect(readEpicMaxParallel(reader({ epic: { maxParallel: 0 } }))).toBe(3);
  });

  it("falls back to 3 for a negative value", () => {
    expect(readEpicMaxParallel(reader({ epic: { maxParallel: -2 } }))).toBe(3);
  });

  it("falls back to 3 for a non-integer (float)", () => {
    expect(readEpicMaxParallel(reader({ epic: { maxParallel: 2.5 } }))).toBe(3);
  });

  it("falls back to 3 for a wrong-typed value (string)", () => {
    expect(readEpicMaxParallel(reader({ epic: { maxParallel: "4" } }))).toBe(3);
  });

  it("falls back to 3 when epic is wrong-typed (array)", () => {
    expect(readEpicMaxParallel(reader({ epic: [3] }))).toBe(3);
  });

  it("never throws and defaults when the seam itself throws-then-collapses (returns undefined)", () => {
    // The production reader collapses a parse error to `undefined`; assert the
    // resolver maps that to the default rather than propagating an error.
    expect(() => readEpicMaxParallel(reader(undefined))).not.toThrow();
  });
});

describe("readEpicJudgment", () => {
  it("defaults to true (on) when the config is unreadable (undefined)", () => {
    expect(readEpicJudgment(reader(undefined))).toBe(DEFAULT_EPIC_JUDGMENT);
    expect(DEFAULT_EPIC_JUDGMENT).toBe(true);
  });

  it("defaults to true when the epic key is absent", () => {
    expect(readEpicJudgment(reader({}))).toBe(true);
  });

  it("defaults to true when epic.judgment is absent", () => {
    expect(readEpicJudgment(reader({ epic: {} }))).toBe(true);
  });

  it("honours an explicit false (opt-out)", () => {
    expect(readEpicJudgment(reader({ epic: { judgment: false } }))).toBe(false);
  });

  it("honours an explicit true", () => {
    expect(readEpicJudgment(reader({ epic: { judgment: true } }))).toBe(true);
  });

  it("defaults to true for a wrong-typed value (string)", () => {
    expect(readEpicJudgment(reader({ epic: { judgment: "false" } }))).toBe(
      true,
    );
  });

  it("defaults to true for a wrong-typed value (number)", () => {
    expect(readEpicJudgment(reader({ epic: { judgment: 0 } }))).toBe(true);
  });

  it("defaults to true when epic is wrong-typed (array)", () => {
    expect(readEpicJudgment(reader({ epic: [false] }))).toBe(true);
  });
});

describe("readEpicMaxRetries", () => {
  it("defaults to 2 when the config is unreadable (undefined)", () => {
    expect(readEpicMaxRetries(reader(undefined))).toBe(
      DEFAULT_EPIC_MAX_RETRIES,
    );
    expect(DEFAULT_EPIC_MAX_RETRIES).toBe(2);
  });

  it("defaults to 2 when the epic key is absent", () => {
    expect(readEpicMaxRetries(reader({}))).toBe(2);
  });

  it("defaults to 2 when epic.maxRetries is absent", () => {
    expect(readEpicMaxRetries(reader({ epic: {} }))).toBe(2);
  });

  it("returns the configured non-negative integer", () => {
    expect(readEpicMaxRetries(reader({ epic: { maxRetries: 5 } }))).toBe(5);
    expect(readEpicMaxRetries(reader({ epic: { maxRetries: 1 } }))).toBe(1);
  });

  it("honours 0 (escalate on first halt — a legitimate budget)", () => {
    expect(readEpicMaxRetries(reader({ epic: { maxRetries: 0 } }))).toBe(0);
  });

  it("falls back to 2 for a negative value", () => {
    expect(readEpicMaxRetries(reader({ epic: { maxRetries: -1 } }))).toBe(2);
  });

  it("falls back to 2 for a non-integer (float)", () => {
    expect(readEpicMaxRetries(reader({ epic: { maxRetries: 2.5 } }))).toBe(2);
  });

  it("falls back to 2 for a wrong-typed value (string)", () => {
    expect(readEpicMaxRetries(reader({ epic: { maxRetries: "3" } }))).toBe(2);
  });

  it("falls back to 2 when epic is wrong-typed (array)", () => {
    expect(readEpicMaxRetries(reader({ epic: [2] }))).toBe(2);
  });
});

describe("readEpicAutoRedirect", () => {
  it("defaults to true (on) when the config is unreadable (undefined)", () => {
    expect(readEpicAutoRedirect(reader(undefined))).toBe(
      DEFAULT_EPIC_AUTO_REDIRECT,
    );
    expect(DEFAULT_EPIC_AUTO_REDIRECT).toBe(true);
  });

  it("defaults to true when the epic key is absent", () => {
    expect(readEpicAutoRedirect(reader({}))).toBe(true);
  });

  it("defaults to true when epic.autoRedirect is absent", () => {
    expect(readEpicAutoRedirect(reader({ epic: {} }))).toBe(true);
  });

  it("honours an explicit false (opt-out)", () => {
    expect(
      readEpicAutoRedirect(reader({ epic: { autoRedirect: false } })),
    ).toBe(false);
  });

  it("honours an explicit true", () => {
    expect(readEpicAutoRedirect(reader({ epic: { autoRedirect: true } }))).toBe(
      true,
    );
  });

  it("defaults to true for a wrong-typed value (string)", () => {
    expect(
      readEpicAutoRedirect(reader({ epic: { autoRedirect: "false" } })),
    ).toBe(true);
  });

  it("defaults to true for a wrong-typed value (number)", () => {
    expect(readEpicAutoRedirect(reader({ epic: { autoRedirect: 0 } }))).toBe(
      true,
    );
  });

  it("defaults to true when epic is wrong-typed (array)", () => {
    expect(readEpicAutoRedirect(reader({ epic: [false] }))).toBe(true);
  });
});

describe("readEpicMaxRedirects", () => {
  it("defaults to 1 when the config is unreadable (undefined)", () => {
    expect(readEpicMaxRedirects(reader(undefined))).toBe(
      DEFAULT_EPIC_MAX_REDIRECTS,
    );
    expect(DEFAULT_EPIC_MAX_REDIRECTS).toBe(1);
  });

  it("defaults to 1 when the epic key is absent", () => {
    expect(readEpicMaxRedirects(reader({}))).toBe(1);
  });

  it("defaults to 1 when epic.maxRedirects is absent", () => {
    expect(readEpicMaxRedirects(reader({ epic: {} }))).toBe(1);
  });

  it("returns the configured non-negative integer", () => {
    expect(readEpicMaxRedirects(reader({ epic: { maxRedirects: 3 } }))).toBe(3);
    expect(readEpicMaxRedirects(reader({ epic: { maxRedirects: 2 } }))).toBe(2);
  });

  it("honours 0 (escalate instead of redirecting — a legitimate budget)", () => {
    expect(readEpicMaxRedirects(reader({ epic: { maxRedirects: 0 } }))).toBe(0);
  });

  it("falls back to 1 for a negative value", () => {
    expect(readEpicMaxRedirects(reader({ epic: { maxRedirects: -1 } }))).toBe(
      1,
    );
  });

  it("falls back to 1 for a non-integer (float)", () => {
    expect(readEpicMaxRedirects(reader({ epic: { maxRedirects: 1.5 } }))).toBe(
      1,
    );
  });

  it("falls back to 1 for a wrong-typed value (string)", () => {
    expect(readEpicMaxRedirects(reader({ epic: { maxRedirects: "2" } }))).toBe(
      1,
    );
  });

  it("falls back to 1 when epic is wrong-typed (array)", () => {
    expect(readEpicMaxRedirects(reader({ epic: [1] }))).toBe(1);
  });
});
