import { describe, expect, it } from "vitest";
import {
  attnTier,
  type AttnTier,
  badgeShort,
  closeVerdict,
  isOpenItem,
  verdictWord,
  windowLine,
} from "./close-verdict";
import type { PipelinePhase, PipelineState, UntrackedItem } from "./state";

function item(id: number, extra: Partial<UntrackedItem> = {}): UntrackedItem {
  return { id, title: `item ${id}`, source: "pr-review", at: "t", ...extra };
}

function st(
  phase: string,
  untracked: UntrackedItem[] = [],
  extra: Partial<PipelineState> = {},
): Pick<PipelineState, "slug" | "phase" | "kind" | "phaseLog" | "untracked"> {
  return { slug: "my-slug", phase, untracked, ...extra } as Pick<
    PipelineState,
    "slug" | "phase" | "kind" | "phaseLog" | "untracked"
  >;
}

describe("isOpenItem", () => {
  it("is open only when no resolution field is set", () => {
    expect(isOpenItem(item(1))).toBe(true);
    expect(isOpenItem(item(1, { filedAs: "u" }))).toBe(false);
    expect(isOpenItem(item(1, { droppedAt: "t" }))).toBe(false);
    expect(isOpenItem(item(1, { doneAt: "t" }))).toBe(false);
    expect(isOpenItem(item(1, { launchedAs: "s" }))).toBe(false);
  });
});

describe("closeVerdict", () => {
  it("is safe-to-close at merged with no open items, steps exactly flow done", () => {
    const v = closeVerdict(st("merged", [item(1, { filedAs: "u" })]));
    expect(v.kind).toBe("safe-to-close");
    expect(v.reason).toBe("nothing recorded as open");
    expect(v.steps).toEqual(["flow done my-slug"]);
  });

  it("is needs-you at merged with one open item", () => {
    const v = closeVerdict(st("merged", [item(1)]));
    expect(v.kind).toBe("needs-you");
    expect(v.reason).toBe("1 item undecided");
    expect(v.openItems).toHaveLength(1);
    expect(v.steps[v.steps.length - 1]).toBe("flow done my-slug");
    expect(v.steps).toHaveLength(2);
  });

  it("pluralises the undecided count", () => {
    expect(closeVerdict(st("cancelled", [item(1), item(2)])).reason).toBe(
      "2 items undecided",
    );
  });

  it("judges merging as merged when the phase override says so", () => {
    expect(closeVerdict(st("merging")).kind).toBe("working");
    const v = closeVerdict(st("merging"), { phase: "merged" });
    expect(v.kind).toBe("safe-to-close");
  });

  it("is needs-you at gated with the check count and item count", () => {
    expect(closeVerdict(st("gated"), { gatedChecks: 2 }).reason).toBe(
      "PR not merged; 2 checks to tick",
    );
    expect(
      closeVerdict(st("gated", [item(1)]), { gatedChecks: 1 }).reason,
    ).toBe("PR not merged; 1 check to tick · 1 item undecided");
  });

  it("is needs-you at needs-human", () => {
    const v = closeVerdict(st("needs-human"));
    expect(v.kind).toBe("needs-you");
    expect(v.reason).toContain("stalled");
  });

  it("is needs-you at a pending phase", () => {
    const v = closeVerdict(st("plan-pending-review"));
    expect(v).toMatchObject({
      kind: "needs-you",
      reason: "waiting on your reply",
    });
  });

  it("does not claim a PR or worktree exists at needs-human", () => {
    expect(closeVerdict(st("needs-human")).reason).not.toMatch(/PR|worktree/);
  });

  it("is working while CI or a detached reviewer runs", () => {
    for (const p of ["ci-wait-pending", "plan-review-pending"]) {
      expect(closeVerdict(st(p)).kind).toBe("working");
    }
  });

  it("offers only the verbs that act on the open items", () => {
    const manual = closeVerdict(st("merged", [item(1, { kind: "manual" })]))
      .steps[0];
    expect(manual).toContain("done all");
    expect(manual).not.toContain("file all");
    const work = closeVerdict(st("merged", [item(1)])).steps[0];
    expect(work).toContain("file all");
    expect(work).not.toContain("done");
    const both = closeVerdict(
      st("merged", [item(1), item(2, { kind: "manual" })]),
    ).steps[0];
    expect(both).toContain("file all, done all");
  });

  it("is working at an in-flight phase", () => {
    expect(closeVerdict(st("implementing")).kind).toBe("working");
  });

  it("is n/a for epic kinds", () => {
    expect(closeVerdict(st("merged", [], { kind: "epic-run" })).kind).toBe(
      "n/a",
    );
    expect(closeVerdict(st("epic-designing")).kind).toBe("n/a");
  });
});

describe("windowLine / verdictWord", () => {
  it("renders the gate grammar and round-trips through verdictWord", () => {
    const safe = windowLine(closeVerdict(st("merged")));
    expect(safe).toBe("WINDOW: ✓ safe to close — nothing recorded as open");
    expect(verdictWord(safe)).toBe("safe");
    const no = windowLine(closeVerdict(st("merged", [item(1), item(2)])));
    expect(no).toBe("WINDOW: ✗ not ready — 2 items undecided");
    expect(verdictWord(no)).toBe("not-ready");
    expect(verdictWord("nothing here")).toBeNull();
  });

  it("renders no row for working or n/a", () => {
    expect(windowLine(closeVerdict(st("implementing")))).toBe("");
    expect(
      windowLine(closeVerdict(st("merged", [], { kind: "epic-run" }))),
    ).toBe("");
  });
});

describe("badgeShort", () => {
  it("returns merged? / cancel? only with open items at finished phases", () => {
    expect(badgeShort(st("merged", [item(1)]))).toBe("merged?");
    expect(badgeShort(st("cancelled", [item(1)]))).toBe("cancel?");
    expect(badgeShort(st("merged", [item(1, { droppedAt: "t" })]))).toBeNull();
    expect(badgeShort(st("merged"))).toBeNull();
    expect(badgeShort(st("gated", [item(1)]))).toBeNull();
    expect(
      badgeShort(st("merged", [item(1)], { kind: "epic-run" })),
    ).toBeNull();
  });

  it("values are ASCII and at most 7 columns", () => {
    for (const v of [
      badgeShort(st("merged", [item(1)])),
      badgeShort(st("cancelled", [item(1)])),
    ]) {
      expect(v).toMatch(/^[\x20-\x7e]{1,7}$/);
    }
  });
});

// Typed Record<PipelinePhase, ...>: a new phase fails typecheck until tiered.
const PHASE_TIERS: Record<PipelinePhase, AttnTier> = {
  starting: "run",
  triaging: "run",
  "worktree-create": "run",
  planning: "run",
  implementing: "run",
  "installing-skills": "run",
  verifying: "run",
  "ci-wait": "run",
  reviewing: "run",
  gating: "run",
  merging: "run",
  "epic-designing": "run",
  "epic-validating": "run",
  "epic-pr-open": "run",
  "plan-pending-review": "needs",
  "plan-pending-interview": "needs",
  "plan-review-pending": "run",
  "triaged-no-change": "needs",
  "triage-pending-clarification": "needs",
  "triage-pending-interview": "needs",
  "approval-pending-clarification": "needs",
  "ci-wait-pending": "run",
  "browser-retry-pending": "needs",
  "checkpoint-pending-clear": "needs",
  "epic-plan-review-pending": "run",
  "epic-design-pending-review": "needs",
  merged: "close",
  gated: "needs",
  "needs-human": "needs",
  cancelled: "close",
  "epic-approved": "close",
};

describe("attnTier", () => {
  it.each(Object.entries(PHASE_TIERS))("tiers %s as %s", (phase, tier) => {
    expect(attnTier(st(phase))).toBe(tier);
  });

  it("keeps an open untracked item on a finished window at needs", () => {
    expect(attnTier(st("merged", [item(1)]))).toBe("needs");
    expect(attnTier(st("cancelled", [item(1)]))).toBe("needs");
    expect(attnTier(st("merged", [item(1, { droppedAt: "t" })]))).toBe("close");
  });

  it("tiers a recorded epic-design window by its own phase rule", () => {
    const k = { kind: "epic-design" } as const;
    expect(attnTier(st("cancelled", [], k))).toBe("close");
    expect(attnTier(st("epic-approved", [], k))).toBe("close");
    expect(attnTier(st("needs-human", [], k))).toBe("needs");
    expect(attnTier(st("epic-design-pending-review", [], k))).toBe("needs");
    expect(attnTier(st("epic-plan-review-pending", [], k))).toBe("run");
    expect(attnTier(st("epic-designing", [], k))).toBe("run");
  });

  it("derives epic-design from the paused phase at needs-human", () => {
    const phaseLog = [
      { phase: "epic-designing", at: "t" },
      { phase: "needs-human", at: "t" },
    ] as PipelineState["phaseLog"];
    expect(attnTier(st("needs-human", [], { phaseLog }))).toBe("needs");
  });

  it("is untiered (null) for recorded epic-run and manager kinds at any phase", () => {
    for (const kind of ["epic-run", "manager"] as const) {
      for (const phase of Object.keys(PHASE_TIERS)) {
        expect(attnTier(st(phase, [], { kind }))).toBeNull();
      }
    }
  });
});
