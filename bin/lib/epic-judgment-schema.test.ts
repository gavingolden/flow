import { describe, expect, it } from "vitest";
import { validateEpicJudgment } from "./epic-judgment-schema";

/**
 * Contract tests for the `/epic-run` judgment-decision shape
 * `{ action, reason, probableCause?, suggestedRedirect? }`. Mirrors
 * `coder-schema.test.ts`'s happy-path / wrong-type structure.
 */

const VALID_MINIMAL: unknown = {
  action: "retry",
  reason: "transient CI flake on the test sharder; under retry budget",
};

const VALID_FULL: unknown = {
  action: "escalate",
  reason: "deadlock — no halted blockers but frontier empty",
  probableCause: "orphaned feature stuck non-terminal; run-state binding stale",
  suggestedRedirect:
    "rebind foundation-design-system to re-do-app-design-system",
};

describe("validateEpicJudgment — happy paths", () => {
  it("accepts a minimal decision (action + reason only)", () => {
    expect(validateEpicJudgment(VALID_MINIMAL).ok).toBe(true);
  });

  it("accepts a decision with both optional fields", () => {
    const result = validateEpicJudgment(VALID_FULL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action).toBe("escalate");
      expect(result.value.probableCause).toContain("orphaned");
      expect(result.value.suggestedRedirect).toContain("rebind");
    }
  });

  it.each(["retry", "redirect", "escalate"])(
    "accepts the '%s' action literal",
    (action) => {
      expect(validateEpicJudgment({ action, reason: "x" }).ok).toBe(true);
    },
  );
});

describe("validateEpicJudgment — halt/deadlock artifact round-trips", () => {
  it("round-trips a halt-shaped judgment (action + reason)", () => {
    const result = validateEpicJudgment({
      action: "retry",
      reason: "flaky CI",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action).toBe("retry");
      expect(result.value.reason).toBe("flaky CI");
    }
  });

  it("round-trips a deadlock-shaped judgment (both optional fields)", () => {
    const result = validateEpicJudgment({
      action: "escalate",
      reason: "stuck orphan",
      probableCause: "orphan feature X",
      suggestedRedirect: "re-run flow new for X",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action).toBe("escalate");
      expect(result.value.probableCause).toBe("orphan feature X");
      expect(result.value.suggestedRedirect).toBe("re-run flow new for X");
    }
  });
});

describe("validateEpicJudgment — rejections", () => {
  it("rejects a non-object input", () => {
    expect(validateEpicJudgment(null).ok).toBe(false);
    expect(validateEpicJudgment([]).ok).toBe(false);
    expect(validateEpicJudgment("retry").ok).toBe(false);
    expect(validateEpicJudgment(42).ok).toBe(false);
  });

  it("rejects a bad action literal", () => {
    const result = validateEpicJudgment({ action: "merge", reason: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("action");
  });

  it("rejects a missing action", () => {
    const result = validateEpicJudgment({ reason: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("action");
  });

  it("rejects a missing reason", () => {
    const result = validateEpicJudgment({ action: "retry" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("reason");
  });

  it("rejects an empty reason", () => {
    const result = validateEpicJudgment({ action: "retry", reason: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("reason");
  });

  it("rejects a wrong-typed probableCause", () => {
    const result = validateEpicJudgment({
      action: "escalate",
      reason: "x",
      probableCause: 123,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("probableCause");
  });

  it("rejects a wrong-typed suggestedRedirect", () => {
    const result = validateEpicJudgment({
      action: "escalate",
      reason: "x",
      suggestedRedirect: { foo: "bar" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("suggestedRedirect");
  });
});
