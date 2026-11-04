import { describe, expect, it } from "vitest";

import { emptyLoopLog, type LoopLog } from "./ui-critique";
import {
  applyUiReview,
  checkUiReviewGate,
  collectUiReviewInputs,
  computeUiReviewGate,
} from "./ui-review-gate";
import type { DecisionResult } from "../flow-gate-decide";

const UI = ["src/lib/components/Panel.svelte"];
const MARKER = "<!-- flow:ui-review-not-run -->";
const DEFECT_MARKER = "<!-- flow:ui-review-decision -->";
const body = (steps: string) => `## Summary\n\n## Test Steps\n\n${steps}\n`;
const log = (over: Partial<LoopLog> = {}): LoopLog => ({
  ...emptyLoopLog(),
  required: true,
  ...over,
});
const check = (over: Partial<Parameters<typeof checkUiReviewGate>[0]> = {}) =>
  checkUiReviewGate({
    changedFiles: UI,
    changedSinceReview: [],
    log: null,
    body: body("- [x] `npm test` — pass"),
    enabled: true,
    ...over,
  });

describe("checkUiReviewGate — requirement", () => {
  it("does not apply to a diff with no rendered file", () => {
    expect(check({ changedFiles: ["bin/x.ts"] })).toEqual({
      required: false,
      satisfied: true,
      reason: null,
    });
  });

  it("is satisfied, still required, when the owner turned the reviewer off", () => {
    expect(check({ enabled: false })).toEqual({
      required: true,
      satisfied: true,
      reason: null,
    });
  });

  it("falls back to the log's recorded requirement when the diff is unreadable", () => {
    const r = check({ changedFiles: null, log: log({ required: true }) });
    expect(r).toMatchObject({ required: true, satisfied: false });
  });

  it("with neither diff nor log, passes and names the unreadable diff", () => {
    expect(check({ changedFiles: null })).toEqual({
      required: false,
      satisfied: true,
      reason: expect.stringContaining("branch diff could not be read"),
    });
  });
});

describe("checkUiReviewGate — a review that did not run", () => {
  it("is unsatisfied with no log at all", () => {
    expect(check()).toMatchObject({
      required: true,
      satisfied: false,
      reason: "UI review did not run: no UI review record for this PR",
    });
  });

  it("names the recorded skip reason in plain words", () => {
    const r = check({
      log: log({ outcome: "skipped", skip: "unparseable-result" }),
    });
    expect(r.reason).toBe(
      "UI review did not run: the reviewer's reply could not be read",
    );
  });

  it("is satisfied by a decision marker inside Test Steps", () => {
    const r = check({
      log: log({ outcome: "skipped", skip: "no-review-target" }),
      body: body(`- [x] DECISION: the UI review did not run ${MARKER}`),
    });
    expect(r.satisfied).toBe(true);
  });

  it("is NOT satisfied by a ticked residual-defects item (a different acceptance)", () => {
    const r = check({
      log: log({
        outcome: "skipped",
        skip: "no-review-target",
        persistent: ["x"],
      }),
      body: body(
        `- [x] DECISION: accept this UI with 1 defect ${DEFECT_MARKER}`,
      ),
    });
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain("UI review did not run");
  });

  it("is NOT satisfied by a marker outside Test Steps", () => {
    const r = check({
      log: log({ outcome: "skipped", skip: "no-review-target" }),
      body: `## UI review\n\n${MARKER}\n\n## Test Steps\n\n- [x] done\n`,
    });
    expect(r.satisfied).toBe(false);
  });

  it("is NOT satisfied by a marker in fenced output or an unterminated <details>", () => {
    const l = log({ outcome: "skipped", skip: "x-y" });
    const fenced = body("```\n" + MARKER + "\n```\n- [x] done");
    expect(check({ log: l, body: fenced }).satisfied).toBe(false);
    const trapped = body(`<details>\n<summary>evidence</summary>\n${MARKER}`);
    expect(check({ log: l, body: trapped }).satisfied).toBe(false);
  });
});

describe("checkUiReviewGate — a completed review", () => {
  it.each(["clean", "kept", "reverted", "list-only"] as const)(
    "%s with no later UI change is satisfied",
    (outcome) => {
      expect(check({ log: log({ outcome, headSha: "aaaa111" }) })).toEqual({
        required: true,
        satisfied: true,
        reason: null,
      });
    },
  );

  it("is unsatisfied when a later commit changed a rendered file", () => {
    const r = check({
      log: log({ outcome: "clean", headSha: "abcdef0123" }),
      changedSinceReview: ["src/lib/components/Panel.svelte"],
    });
    expect(r).toMatchObject({
      satisfied: false,
      stale: true,
      reason: expect.stringContaining("the design review judged abcdef0"),
    });
  });

  it("ignores files that only came in from a merged base branch", () => {
    const r = check({
      log: log({ outcome: "clean", headSha: "abcdef0123" }),
      changedFiles: ["src/a.svelte"],
      changedSinceReview: ["src/other-pr.svelte"],
    });
    expect(r.satisfied).toBe(true);
  });

  it("a later commit changing only logic keeps it satisfied", () => {
    const r = check({
      log: log({ outcome: "clean", headSha: "abcdef0" }),
      changedSinceReview: ["src/lib/format.ts", "README.md"],
    });
    expect(r.satisfied).toBe(true);
  });

  it("a ticked residual-defects marker does not accept a post-review UI change", () => {
    const r = check({
      log: log({ outcome: "list-only", headSha: "abcdef0" }),
      changedFiles: ["a.svelte"],
      changedSinceReview: ["a.svelte"],
      body: body(`- [x] DECISION: accept ${DEFECT_MARKER}`),
    });
    expect(r.satisfied).toBe(false);
  });

  it("an unreadable staleness diff is not stale, and is named", () => {
    const r = check({
      log: log({ outcome: "clean", headSha: "abcdef0" }),
      changedSinceReview: null,
    });
    expect(r).toMatchObject({
      satisfied: true,
      reason: expect.stringContaining("branch diff could not be read"),
    });
  });
});

describe("collectUiReviewInputs / computeUiReviewGate", () => {
  const files = new Map<string, string>();
  const deps = {
    readFile: (p: string) => files.get(p) ?? null,
    changedFiles: (_w: string, base?: string | null) => {
      seen.push(base ?? null);
      return UI;
    },
    changedSince: () => ["x.svelte"],
    home: "/home/u",
  };
  const seen: (string | null)[] = [];

  it("reads the log, config and the diff against the PR base", () => {
    files.set(
      "/w/.flow-tmp/ui-critique/log.json",
      JSON.stringify({ outcome: "clean", required: true, headSha: "abc1234" }),
    );
    files.set(
      "/home/u/.flow/config.json",
      JSON.stringify({ ui: { critique: false } }),
    );
    const i = collectUiReviewInputs("/w", "release", deps);
    expect(seen).toEqual(["release"]);
    expect(i).toMatchObject({
      changedFiles: UI,
      changedSinceReview: ["x.svelte"],
      enabled: false,
    });
    expect(i.log?.headSha).toBe("abc1234");
  });

  it("computes the gate from those inputs", () => {
    files.clear();
    expect(
      computeUiReviewGate(
        { worktree: "/w", base: "main", body: body("") },
        deps,
      ),
    ).toMatchObject({ required: true, satisfied: false });
  });
});

describe("applyUiReview", () => {
  const autoMerge: DecisionResult = {
    decision: "auto-merge",
    reason: "no unchecked test steps; auto-merge",
    autoMerge: true,
  };
  const bad = {
    required: true,
    satisfied: false,
    reason: "UI review did not run: x",
  };

  it("turns an auto-merge into a gate with a human-only synthetic item", () => {
    const r = applyUiReview(autoMerge, bad);
    expect(r.decision).toBe("gated");
    expect(r.validationItems?.[0]).toMatch(
      /^DECISION: UI review did not run: x/,
    );
    expect(r.reason).toBe("UI review did not run: x");
    expect(r.uiReview).toEqual(bad);
  });

  it("names the failure in an already-gated reason and keeps browser-retry", () => {
    const gated: DecisionResult = {
      decision: "browser-retry",
      reason: "1 open Browser item(s)",
      validationItems: ["Browser: a"],
      autoMerge: true,
    };
    const r = applyUiReview(gated, bad);
    expect(r.decision).toBe("browser-retry");
    expect(r.reason).toContain("UI review did not run: x");
    expect(r.validationItems).toHaveLength(2);
  });

  it("leaves a satisfied check and non-open decisions alone", () => {
    const ok = { required: true, satisfied: true, reason: null };
    expect(applyUiReview(autoMerge, ok).decision).toBe("auto-merge");
    const merged: DecisionResult = {
      decision: "merged-externally",
      reason: "r",
      autoMerge: true,
    };
    expect(applyUiReview(merged, bad)).toBe(merged);
    expect(applyUiReview(autoMerge, undefined)).toBe(autoMerge);
  });
});
