import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PARALLEL,
  readEpicMaxParallel,
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
