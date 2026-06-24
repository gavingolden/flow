import { describe, expect, it } from "vitest";
import {
  extractResearchConfig,
  readResearchConfig,
  type ReadConfigFile,
} from "./research-config";

// Inject the config-read seam so the real ~/.flow/config.json is never touched.
const reader =
  (raw: unknown): ReadConfigFile =>
  () =>
    raw;

describe("readResearchConfig", () => {
  it.each<[string, unknown, boolean]>([
    [
      "research.discovery: true → enabled",
      { research: { discovery: true } },
      true,
    ],
    [
      "bare research: true (wrong type) → default false",
      { research: true },
      false,
    ],
    ["missing research key → default false", { bots: {} }, false],
    ["non-object config (null) → default false", null, false],
    ["non-object config (array) → default false", [], false],
    ["non-object config (string) → default false", "research", false],
    [
      "unreadable / non-JSON (seam returns undefined) → default false",
      undefined,
      false,
    ],
    [
      "wrong inner type research.discovery: 'yes' → default false",
      { research: { discovery: "yes" } },
      false,
    ],
    [
      "research.discovery: false → default false",
      { research: { discovery: false } },
      false,
    ],
  ])("%s", (_label, raw, expected) => {
    expect(readResearchConfig(reader(raw))).toEqual({ discovery: expected });
  });

  it("defaults to the real config seam when no reader is injected (smoke)", () => {
    // No seam override: exercises the production defaultReadConfigFile path.
    // The result is environment-dependent but must always be a well-formed
    // { discovery: boolean } that never throws.
    const cfg = readResearchConfig();
    expect(typeof cfg.discovery).toBe("boolean");
  });
});

describe("extractResearchConfig", () => {
  it("only a strict boolean true enables discovery", () => {
    expect(extractResearchConfig({ research: { discovery: true } })).toEqual({
      discovery: true,
    });
    expect(extractResearchConfig({ research: { discovery: 1 } })).toEqual({
      discovery: false,
    });
  });
});
