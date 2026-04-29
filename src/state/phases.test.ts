import { describe, expect, it } from "vitest";
import {
  PHASE_ORDER,
  TASK_STATUSES,
  checkedThrough,
  renderProgressSection,
} from "./phases.js";

describe("TASK_STATUSES order", () => {
  it("places creating-worktree before worktree-ready", () => {
    expect(TASK_STATUSES.indexOf("creating-worktree")).toBeLessThan(
      TASK_STATUSES.indexOf("worktree-ready"),
    );
  });

  it("places worktree-ready before planning (worktree-first reorder)", () => {
    expect(TASK_STATUSES.indexOf("worktree-ready")).toBeLessThan(
      TASK_STATUSES.indexOf("planning"),
    );
  });

  it("places planned before implementing", () => {
    expect(TASK_STATUSES.indexOf("planned")).toBeLessThan(
      TASK_STATUSES.indexOf("implementing"),
    );
  });
});

describe("checkedThrough", () => {
  it("maps creating-worktree to triage (worktree not yet done)", () => {
    expect(checkedThrough("creating-worktree")).toBe("triage");
  });

  it("maps worktree-ready to worktree", () => {
    expect(checkedThrough("worktree-ready")).toBe("worktree");
  });

  it("maps planning to worktree (worktree was completed first)", () => {
    expect(checkedThrough("planning")).toBe("worktree");
  });

  it("maps planned to worktree (so the triage/plan/worktree row all tick)", () => {
    // PHASE_ORDER fixes plan at idx 1 and worktree at idx 2, so checking
    // through worktree ticks all three of triage/plan/worktree — which
    // matches what has actually completed by the time status is `planned`.
    expect(checkedThrough("planned")).toBe("worktree");
  });

  it("maps implementing to worktree (all three pre-implement phases done)", () => {
    expect(checkedThrough("implementing")).toBe("worktree");
  });
});

describe("renderProgressSection", () => {
  it("ticks triage, plan, and worktree at status worktree-ready", () => {
    // Visual order matches PHASE_ORDER (triage, plan, worktree), even though
    // execution is worktree-first. By worktree-ready, plan has not yet run —
    // a small visual lie tolerated to keep PHASE_ORDER stable.
    const out = renderProgressSection("worktree-ready");
    expect(out).toContain("- [x] triage");
    expect(out).toContain("- [x] plan");
    expect(out).toContain("- [x] worktree");
    expect(out).toContain("- [ ] implement");
  });

  it("ticks triage, plan, worktree at status planned", () => {
    const out = renderProgressSection("planned");
    expect(out).toContain("- [x] triage");
    expect(out).toContain("- [x] plan");
    expect(out).toContain("- [x] worktree");
    expect(out).toContain("- [ ] implement");
  });

  it("renders all phases in PHASE_ORDER sequence", () => {
    const out = renderProgressSection("triaged");
    const lines = out.split("\n");
    const phaseLines = lines.filter((l) => l.startsWith("- ["));
    expect(phaseLines).toHaveLength(PHASE_ORDER.length);
    PHASE_ORDER.forEach((phase, idx) => {
      expect(phaseLines[idx]).toContain(phase);
    });
  });
});
