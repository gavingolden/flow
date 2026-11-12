import { describe, expect, it } from "vitest";
import { OWNER_NEEDED_PHASES } from "./epic-manage-board";
import {
  isWakePhase,
  MANAGER_SILENT_PHASES,
  MANAGER_WAKE_PHASES,
} from "./manager-phases";
import { PIPELINE_PHASES } from "./state";

describe("manager wake phases", () => {
  it("should wake on every owner-needed phase and the three end states", () => {
    for (const p of OWNER_NEEDED_PHASES) expect(isWakePhase(p)).toBe(true);
    for (const p of ["merged", "cancelled", "epic-approved"]) {
      expect(isWakePhase(p)).toBe(true);
    }
  });

  it("should stay silent through the CI and plan-review waits and ordinary steps", () => {
    for (const p of [
      "ci-wait",
      "ci-wait-pending",
      "plan-review-pending",
      "implementing",
      "verifying",
    ]) {
      expect(isWakePhase(p)).toBe(false);
      expect(MANAGER_SILENT_PHASES.has(p)).toBe(true);
    }
  });

  it("should split every pipeline phase into exactly one of the two sets", () => {
    for (const p of PIPELINE_PHASES) {
      expect(MANAGER_WAKE_PHASES.has(p)).not.toBe(MANAGER_SILENT_PHASES.has(p));
    }
    expect(MANAGER_WAKE_PHASES.size + MANAGER_SILENT_PHASES.size).toBe(
      new Set([...MANAGER_WAKE_PHASES, ...PIPELINE_PHASES]).size,
    );
  });

  it("should treat an unknown phase as not waking", () => {
    expect(isWakePhase("no-such-phase")).toBe(false);
  });
});
