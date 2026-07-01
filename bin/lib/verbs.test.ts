import { describe, expect, it } from "vitest";
import { isVerb, VERBS } from "./verbs";

describe("VERBS / isVerb", () => {
  it("recognises the renamed work-item verbs", () => {
    expect(isVerb("feature")).toBe(true);
    expect(isVerb("install")).toBe(true);
  });

  it("hard-removes the old verbs (no compat aliases)", () => {
    // The rename ships without backwards-compat shims, so the old verbs must
    // fall through to the wrapper's `unknown verb` exit 1 path.
    expect(isVerb("new")).toBe(false);
    expect(isVerb("setup")).toBe(false);
    expect(isVerb("migrate")).toBe(false);
  });

  it("keeps the flat global verbs unchanged", () => {
    for (const v of ["epic", "ls", "attach", "a", "done", "completion"]) {
      expect(isVerb(v)).toBe(true);
    }
  });

  it("VERBS contains no removed entry", () => {
    for (const removed of ["new", "setup", "migrate"]) {
      expect(VERBS).not.toContain(removed);
    }
  });
});
