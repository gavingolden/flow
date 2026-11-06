import { describe, expect, it } from "vitest";
import {
  MAX_SEC_CAP,
  MAX_SEC_DEFAULT,
  parseStressArgs,
  shouldStopBurning,
} from "./flow-stress";

const usage = (r: unknown): string => (r as { usageError: string }).usageError;

describe("parseStressArgs", () => {
  it("should apply the default --max-sec and split the command at --", () => {
    expect(
      parseStressArgs(["--cpu", "2", "--", "go", "test", "-race"], 8),
    ).toEqual({
      cpu: 2,
      maxSec: MAX_SEC_DEFAULT,
      cmd: ["go", "test", "-race"],
    });
  });

  it("should accept an explicit --max-sec up to the cap", () => {
    expect(
      parseStressArgs(
        ["--cpu", "1", "--max-sec", String(MAX_SEC_CAP), "--", "x"],
        4,
      ),
    ).toMatchObject({ maxSec: MAX_SEC_CAP });
  });

  it("should reject a missing --cpu", () => {
    expect(usage(parseStressArgs(["--", "true"], 8))).toContain(
      "--cpu is required",
    );
  });

  it("should reject --cpu 0 and --cpu above the core count", () => {
    expect(usage(parseStressArgs(["--cpu", "0", "--", "true"], 8))).toContain(
      "between 1 and 8",
    );
    expect(usage(parseStressArgs(["--cpu", "9", "--", "true"], 8))).toContain(
      "between 1 and 8",
    );
  });

  it("should reject --max-sec above the cap or zero", () => {
    expect(
      usage(parseStressArgs(["--cpu", "1", "--max-sec", "3601", "--", "x"], 8)),
    ).toContain("--max-sec must be between");
    expect(
      usage(parseStressArgs(["--cpu", "1", "--max-sec", "0", "--", "x"], 8)),
    ).toContain("--max-sec must be between");
  });

  it("should reject a missing command or missing --", () => {
    expect(usage(parseStressArgs(["--cpu", "1"], 8))).toContain("after --");
    expect(usage(parseStressArgs(["--cpu", "1", "--"], 8))).toContain(
      "after --",
    );
  });

  it("should reject non-numeric values and unknown flags", () => {
    expect(usage(parseStressArgs(["--cpu", "x", "--", "true"], 8))).toContain(
      "whole number",
    );
    expect(usage(parseStressArgs(["--bogus", "--", "true"], 8))).toContain(
      "unknown argument",
    );
  });
});

describe("shouldStopBurning", () => {
  it("should keep burning while the parent is alive and before the deadline", () => {
    expect(
      shouldStopBurning({ nowMs: 1, deadlineMs: 10, parentAlive: true }),
    ).toBe(false);
  });

  it("should stop at the deadline", () => {
    expect(
      shouldStopBurning({ nowMs: 10, deadlineMs: 10, parentAlive: true }),
    ).toBe(true);
  });

  it("should stop as soon as the parent is dead", () => {
    expect(
      shouldStopBurning({ nowMs: 1, deadlineMs: 10, parentAlive: false }),
    ).toBe(true);
  });
});
