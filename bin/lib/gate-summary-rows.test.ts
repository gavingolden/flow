import { describe, expect, it, vi } from "vitest";
import {
  buildNeedsAttention,
  needsInstallIndex,
  needsInstallLabel,
  parseNeedsInstall,
} from "./gate-summary-rows";

describe("needsInstallLabel", () => {
  it("names the new skill, not the existing verb the step quotes", () => {
    expect(needsInstallLabel({ name: "flow-new-thing", kind: "skill" })).toBe(
      " — needs this branch installed: run `flow feature create --skills-from <worktree>` to load `/flow-new-thing` from this branch, or mark the step `After merge:`",
    );
  });

  it("names the new helper, not an existing helper", () => {
    expect(needsInstallLabel({ name: "flow-gate-x", kind: "helper" })).toBe(
      " — needs this branch installed: run `bun bin/flow-gate-x.ts` in the worktree, or mark the step `After merge:`",
    );
  });

  it("names the verb's runnable form", () => {
    expect(needsInstallLabel({ name: "manage", kind: "verb" })).toContain(
      "bun bin/flow manage",
    );
  });

  it("falls back to the generic line without a name", () => {
    expect(needsInstallLabel({})).toContain("mark it `After merge:`");
  });
});

describe("parseNeedsInstall", () => {
  it("returns [] for empty input without warning", () => {
    const warn = vi.fn();
    expect(parseNeedsInstall("  \n", warn)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts strings and objects, dropping an invalid kind and invalid elements", () => {
    const raw = JSON.stringify([
      "plain step",
      { item: "a", name: "x", kind: "helper" },
      { item: "b", name: "y", kind: "bogus" },
      { item: "c", name: "" },
      { name: "no-item" },
      42,
    ]);
    expect(parseNeedsInstall(raw)).toEqual([
      { item: "plain step" },
      { item: "a", name: "x", kind: "helper" },
      { item: "b", name: "y" },
      { item: "c" },
    ]);
  });

  it("warns once and returns [] for malformed JSON", () => {
    const warn = vi.fn();
    expect(parseNeedsInstall("- not json", warn)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns once and returns [] for a non-array JSON value", () => {
    const warn = vi.fn();
    expect(parseNeedsInstall('{"item":"a"}', warn)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("needsInstallIndex", () => {
  it("keys by bullet-stripped item text", () => {
    const idx = needsInstallIndex([
      { item: "- [ ] Run `flow-x`", name: "flow-x", kind: "helper" },
    ]);
    expect(idx.get("Run `flow-x`")?.name).toBe("flow-x");
  });
});

describe("buildNeedsAttention", () => {
  it("labels only indexed items and matches bulleted and bare forms", () => {
    const lines = buildNeedsAttention(
      ["- [ ] Run `flow-x`", "Other step", "Run `flow-x`"],
      undefined,
      "plain",
      [{ item: "Run `flow-x`", name: "flow-x", kind: "helper" }],
    );
    expect(lines[1]).toContain("bun bin/flow-x.ts");
    expect(lines[2]).toBe("  - Other step");
    expect(lines[3]).toContain("bun bin/flow-x.ts");
  });
});
