import { describe, expect, it } from "vitest";

import { parseTestSteps } from "./test-steps-parse";
import { emptyLoopLog, type LoopLog } from "./ui-critique";
import {
  notRunDecisionItem,
  renderUiReview,
  UI_REVIEW_DECISION_MARKER,
  UI_REVIEW_NOT_RUN_MARKER,
  UI_REVIEW_OPEN,
  uiReviewDecisionItems,
} from "./ui-critique-render";
import { upsertNotRunItem, upsertUiReview } from "./ui-review-body";

const log = (over: Partial<LoopLog> = {}): LoopLog => ({
  ...emptyLoopLog(),
  ...over,
});
const render = (l: LoopLog) =>
  renderUiReview({ before: [], after: null, log: l, demotion: null });
const none = { defects: null, notRun: null };
const section = render(log({ outcome: "clean" }));
const body = [
  "## TLDR",
  "",
  "text",
  "",
  "## Test Steps",
  "",
  "- [ ] SUBJECTIVE: the page feels calm",
  "- [x] `npm test` — pass",
  "",
  "## Notes",
  "",
  "tail",
].join("\n");
const decision =
  "- [ ] DECISION: accept this UI with 1 unresolved defect(s) listed under UI review (top: a), or redirect to fix them";
const notRunItem = notRunDecisionItem("the reviewer call failed");

describe("upsertUiReview", () => {
  it("inserts the block before ## Test Steps and leaves every other line alone", () => {
    const out = upsertUiReview(body, section, none);
    expect(out.indexOf(UI_REVIEW_OPEN)).toBeLessThan(
      out.indexOf("## Test Steps"),
    );
    expect(out.replace(section + "\n\n", "")).toBe(body);
  });

  it("replaces the block on a re-run instead of stacking", () => {
    const once = upsertUiReview(body, section, none);
    const second = render(log({ outcome: "list-only" }));
    const twice = upsertUiReview(once, second, none);
    expect(twice.match(new RegExp(UI_REVIEW_OPEN, "g"))).toHaveLength(1);
    expect(twice).toContain("Findings are listed only");
    expect(twice).not.toContain("Clean: the critique");
  });

  it("adds the defects line (marker after the text) as a human-only step, and removes it again", () => {
    const withDecision = upsertUiReview(body, section, {
      defects: decision,
      notRun: null,
    });
    expect(parseTestSteps(withDecision).steps.map((s) => s.kind)).toEqual([
      "subjective",
      "command",
      "decision",
    ]);
    expect(withDecision).toMatch(
      new RegExp(`^- \\[ \\] DECISION: .*${UI_REVIEW_DECISION_MARKER}$`, "m"),
    );
    const replaced = upsertUiReview(withDecision, section, {
      defects: decision.replace("1 unresolved", "2 unresolved"),
      notRun: null,
    });
    expect(
      replaced.match(new RegExp(UI_REVIEW_DECISION_MARKER, "g")),
    ).toHaveLength(1);
    expect(replaced).toContain("2 unresolved");
    const removed = upsertUiReview(replaced, section, none);
    expect(removed).not.toContain("DECISION:");
  });

  it("never touches a fenced look-alike marker", () => {
    const fenced = [
      "## Test Steps",
      "",
      "```",
      UI_REVIEW_OPEN,
      "```",
      "",
      "- [ ] SUBJECTIVE: x",
    ].join("\n");
    const out = upsertUiReview(fenced, section, none);
    expect(out.indexOf("```")).toBeGreaterThan(out.indexOf("## UI review"));
  });

  it("appends at the end when there is no Test Steps section", () => {
    const out = upsertUiReview("## TLDR\n\nx", section, {
      defects: decision,
      notRun: null,
    });
    expect(out).toContain(UI_REVIEW_OPEN);
    expect(out).not.toContain("DECISION:");
  });
});

describe("the two decision slots", () => {
  const skipped = log({
    required: true,
    outcome: "skipped",
    skip: "headless-error",
    persistent: ["[xs] anchor: #x lands under chrome"],
  });

  it("a skipped review with persistent defects writes both lines, idempotently", () => {
    const items = uiReviewDecisionItems(skipped);
    const once = upsertUiReview(body, render(skipped), items);
    expect(once.match(/DECISION: the UI review did not run/g)).toHaveLength(1);
    expect(once.match(/DECISION: accept this UI/g)).toHaveLength(1);
    expect(parseTestSteps(once).steps.filter((x) => !x.checked)).toHaveLength(
      3,
    );
    expect(upsertUiReview(once, render(skipped), items)).toBe(once);
  });

  it("ticking only the defects line leaves the not-run line unticked", () => {
    const once = upsertUiReview(
      body,
      render(skipped),
      uiReviewDecisionItems(skipped),
    );
    const ticked = once.replace(
      "- [ ] DECISION: accept this UI",
      "- [x] DECISION: accept this UI",
    );
    const again = upsertUiReview(
      ticked,
      render(skipped),
      uiReviewDecisionItems(skipped),
    );
    expect(again).toContain("- [x] DECISION: accept this UI");
    expect(again).toContain("- [ ] DECISION: the UI review did not run");
  });

  it("re-rendering a ticked legacy two-marker line keeps the tick without duplicating", () => {
    const legacy = `${notRunItem.replace("- [ ]", "- [x]")} ${UI_REVIEW_DECISION_MARKER}`;
    const withLegacy = body.replace(
      "- [x] `npm test` — pass",
      `- [x] \`npm test\` — pass\n${legacy}`,
    );
    const out = upsertUiReview(withLegacy, section, {
      defects: null,
      notRun: notRunItem,
    });
    expect(out.match(/the UI review did not run/g)).toHaveLength(1);
    expect(out).toContain(
      `- [x] DECISION: the UI review did not run (the reviewer call failed) — merge without a design review of the changed screens, or redirect to fix the cause ${UI_REVIEW_NOT_RUN_MARKER}`,
    );
    expect(out).not.toContain(UI_REVIEW_DECISION_MARKER);
  });
});

describe("upsertNotRunItem", () => {
  it("separates a trailing </details> block from the appended line", () => {
    const html =
      "## Test Steps\n\n<details>\n<summary>x</summary>\n\n- a\n</details>";
    const out = upsertNotRunItem(html, notRunItem);
    expect(out.endsWith(`</details>\n\n${notRunItem}`)).toBe(true);
  });

  it("removes only the not-run line when the item is null", () => {
    const withBoth = upsertUiReview(body, section, {
      defects: decision,
      notRun: notRunItem,
    });
    const out = upsertNotRunItem(withBoth, null);
    expect(out).not.toContain(UI_REVIEW_NOT_RUN_MARKER);
    expect(out).toContain("DECISION: accept this UI");
  });
});

describe("upsertUiReview slot placement", () => {
  const section = render(log());

  it("separates the defects item from a trailing </details>", () => {
    const body =
      "## Test Steps\n\n- [x] ok\n\n<details>\n<summary>ev</summary>\n\n- out\n</details>";
    const out = upsertUiReview(body, section, {
      defects: "- [ ] DECISION: accept 1 defect",
      notRun: null,
    });
    expect(out).toMatch(/<\/details>\n\n- \[ \] DECISION: accept 1 defect/);
  });

  it("ignores a decision marker quoted outside Test Steps", () => {
    const body = `## Key decisions\n\n- uses ${UI_REVIEW_DECISION_MARKER} inline\n\n## Test Steps\n\n- [x] ok\n`;
    const out = upsertUiReview(body, section, { defects: null, notRun: null });
    expect(out).toContain(`- uses ${UI_REVIEW_DECISION_MARKER} inline`);
  });
});
