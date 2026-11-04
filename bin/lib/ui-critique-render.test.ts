import { describe, expect, it } from "vitest";

import { parseTestSteps } from "./test-steps-parse";
import {
  emptyLoopLog,
  type CritiqueFinding,
  type LoopLog,
} from "./ui-critique";
import {
  renderUiReview,
  residualDecisionItem,
  UI_REVIEW_CLOSE,
  UI_REVIEW_DECISION_MARKER,
  UI_REVIEW_OPEN,
  uiReviewDecisionItem,
  upsertUiReview,
} from "./ui-critique-render";
import type { SectionShot } from "./ui-driver-schema";

const shot = (
  section: string,
  viewport: SectionShot["viewport"] = "phone",
): SectionShot => ({
  route: "/",
  section,
  viewport,
  part: "whole",
  path: `/wt/.flow-tmp/ui-evidence/${section}-${viewport}.png`,
});
const finding = (over: Partial<CritiqueFinding> = {}): CritiqueFinding => ({
  id: "f",
  severity: "defect",
  route: "/",
  section: "Pricing",
  viewport: "phone",
  shot: "/wt/.flow-tmp/ui-evidence/Pricing-phone.png",
  observation: "text overlaps the price",
  rule: "visual-design.md",
  fix: "separate them",
  introduced: true,
  ...over,
});
const log = (over: Partial<LoopLog> = {}): LoopLog => ({
  ...emptyLoopLog(),
  ...over,
});

describe("renderUiReview", () => {
  it("renders a marker-wrapped section with a before/after table of relative refs", () => {
    const out = renderUiReview({
      before: [shot("Pricing")],
      after: [shot("Pricing")],
      log: log({
        outcome: "kept",
        round: {
          kind: "critique",
          preSha: "a",
          open: false,
          reason: "improved",
        },
        costUsd: 0.456,
      }),
      demotion: null,
    });
    expect(out.startsWith(`${UI_REVIEW_OPEN}\n## UI review`)).toBe(true);
    expect(out.endsWith(UI_REVIEW_CLOSE)).toBe(true);
    expect(out).toContain("Critique round kept: improved.");
    expect(out).toContain(
      "![Pricing phone before](.flow-tmp/ui-evidence/Pricing-phone.png)",
    );
    expect(out).toContain(
      "![Pricing phone after](.flow-tmp/ui-evidence/Pricing-phone.png)",
    );
    expect(out).toContain("Cost: $0.46");
    expect(out).not.toContain("/wt/");
  });

  it("caps the table at eight pairs", () => {
    const before = Array.from({ length: 12 }, (_, i) => shot(`S${i}`));
    const out = renderUiReview({
      before,
      after: null,
      log: log({ outcome: "list-only" }),
      demotion: null,
    });
    expect(out.match(/before\]/g)).toHaveLength(8);
    expect(out).toContain("| Section | Viewport | Shot |");
  });

  it("groups residual findings by severity and names persistent defects, demotion and omissions", () => {
    const out = renderUiReview({
      before: [],
      after: null,
      log: log({
        outcome: "list-only",
        residual: [
          finding(),
          finding({ severity: "minor", observation: "tight" }),
        ],
        persistent: ["[xs] anchor: #x lands under chrome"],
        omittedSections: 2,
      }),
      demotion: "3 reverts",
    });
    expect(out.indexOf("Unresolved defect")).toBeLessThan(
      out.indexOf("Unresolved minor"),
    );
    expect(out).toContain("- Pricing @ phone — text overlaps the price");
    expect(out).toContain("- [xs] anchor: #x lands under chrome");
    expect(out).toContain("Demoted to list-only: 3 reverts");
    expect(out).toContain("2 section(s) were left out");
  });

  it("renders a stub when the loop did not run", () => {
    const out = renderUiReview({
      before: [],
      after: null,
      log: log({ skip: "browser checks did not run (mcp-not-available)" }),
      demotion: null,
    });
    expect(out).toContain(
      "Not run: browser checks did not run (mcp-not-available)",
    );
    expect(out).not.toContain("Cost:");
  });

  it("maps a helper skip code to a plain reason", () => {
    const out = renderUiReview({
      before: [],
      after: null,
      log: log({ skip: "unparseable-result" }),
      demotion: null,
    });
    expect(out).toContain("Not run: the reviewer's reply could not be read");
  });
});

describe("residualDecisionItem", () => {
  it("is null without a defect or persistent defect", () => {
    expect(
      residualDecisionItem([finding({ severity: "major" })], []),
    ).toBeNull();
    expect(residualDecisionItem([], [])).toBeNull();
  });

  it("counts defects and persistent defects and names the top one (≤80 chars)", () => {
    const item = residualDecisionItem(
      [finding({ observation: "x".repeat(200) })],
      ["[xs] leak: token"],
    );
    expect(item).toMatch(
      /^- \[ \] DECISION: accept this UI with 2 unresolved defect\(s\) listed under UI review \(top: Pricing @ phone — x+\), or redirect to fix them$/,
    );
    expect(item?.match(/top: (.*)\), or/)?.[1].length).toBeLessThanOrEqual(80);
  });

  it("falls back to the first persistent defect", () => {
    expect(residualDecisionItem([], ["[xs] leak: token"])).toContain(
      "(top: [xs] leak: token)",
    );
  });
});

describe("upsertUiReview", () => {
  const section = renderUiReview({
    before: [],
    after: null,
    log: log({ outcome: "clean" }),
    demotion: null,
  });
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

  it("inserts the block before ## Test Steps and leaves every other line alone", () => {
    const out = upsertUiReview(body, section, null);
    expect(out.indexOf(UI_REVIEW_OPEN)).toBeLessThan(
      out.indexOf("## Test Steps"),
    );
    expect(out.replace(section + "\n\n", "")).toBe(body);
  });

  it("replaces the block on a re-run instead of stacking", () => {
    const once = upsertUiReview(body, section, null);
    const second = renderUiReview({
      before: [],
      after: null,
      log: log({ outcome: "list-only" }),
      demotion: null,
    });
    const twice = upsertUiReview(once, second, null);
    expect(twice.match(new RegExp(UI_REVIEW_OPEN, "g"))).toHaveLength(1);
    expect(twice).toContain("Findings are listed only");
    expect(twice).not.toContain("Clean: the critique");
  });

  it("adds the DECISION line (marker after the text) as a human-only step, and removes it again", () => {
    const withDecision = upsertUiReview(body, section, decision);
    const steps = parseTestSteps(withDecision).steps;
    expect(steps.map((s) => s.kind)).toEqual([
      "subjective",
      "command",
      "decision",
    ]);
    expect(withDecision).toContain(` ${UI_REVIEW_DECISION_MARKER}`);
    expect(withDecision).toMatch(
      new RegExp(`^- \\[ \\] DECISION: .*${UI_REVIEW_DECISION_MARKER}$`, "m"),
    );
    const replaced = upsertUiReview(
      withDecision,
      section,
      decision.replace("1 unresolved", "2 unresolved"),
    );
    expect(
      replaced.match(new RegExp(UI_REVIEW_DECISION_MARKER, "g")),
    ).toHaveLength(1);
    expect(replaced).toContain("2 unresolved");
    const removed = upsertUiReview(replaced, section, null);
    expect(removed).not.toContain("DECISION:");
    expect(parseTestSteps(removed).steps.map((s) => s.kind)).toEqual([
      "subjective",
      "command",
    ]);
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
    const out = upsertUiReview(fenced, section, null);
    expect(out.indexOf("```")).toBeGreaterThan(out.indexOf("## UI review"));
  });

  it("appends at the end when there is no Test Steps section", () => {
    const out = upsertUiReview("## TLDR\n\nx", section, decision);
    expect(out).toContain(UI_REVIEW_OPEN);
    expect(out).not.toContain("DECISION:");
  });
});

describe("a required review that did not run", () => {
  const skipped = (over: Partial<LoopLog> = {}) =>
    log({
      required: true,
      outcome: "skipped",
      skip: "the browser drive captured no section screenshots",
      ...over,
    });
  const render = (l: LoopLog) =>
    renderUiReview({ before: [], after: null, log: l, demotion: null });

  it("renders a warning callout naming the reason instead of a one-line note", () => {
    const out = render(skipped());
    expect(out).toContain(
      "> [!WARNING]\n> UI review did not run: the browser drive captured no section screenshots",
    );
    expect(out).not.toContain("Not run:");
  });

  it("adds one unchecked DECISION item naming that reason", () => {
    const item = uiReviewDecisionItem(skipped());
    expect(item).toBe(
      "- [ ] DECISION: the UI review did not run (the browser drive captured no section screenshots) — merge without a design review of the changed screens, or redirect to fix the cause",
    );
  });

  it("the item is one Test Steps line and the upsert is idempotent", () => {
    const body = "## Summary\n\n## Test Steps\n\n- [ ] `npm test` — pass\n";
    const l = skipped();
    const section = render(l);
    const once = upsertUiReview(body, section, uiReviewDecisionItem(l));
    expect(once.match(/DECISION: the UI review did not run/g)).toHaveLength(1);
    expect(once).toContain(UI_REVIEW_DECISION_MARKER);
    expect(parseTestSteps(once).steps.filter((x) => !x.checked)).toHaveLength(
      2,
    );
    const twice = upsertUiReview(once, section, uiReviewDecisionItem(l));
    expect(twice).toBe(once);
  });

  it.each([
    ["no-review-target", "add a `## UI review targets` entry"],
    [
      "playwright-unavailable",
      "npm i -D @playwright/test && npx playwright install chromium",
    ],
    ["playwright-browsers-missing", "npx playwright install chromium"],
    ["fallback-capture-failed", "the fallback capture failed"],
  ])("maps %s to a plain reason", (code, fragment) => {
    const l = skipped({ skip: code });
    expect(render(l)).toContain(fragment);
    expect(uiReviewDecisionItem(l)).toContain(fragment);
  });

  it("a residual-defect item keeps precedence over the not-run item", () => {
    const l = skipped({ persistent: ["[xs] anchor: #x lands under chrome"] });
    expect(uiReviewDecisionItem(l)).toContain("unresolved defect(s)");
  });

  it("a skip when the diff did not require a review stays a quiet note with no item", () => {
    const l = log({ skip: "mcp-not-available", required: false });
    expect(render(l)).toContain(
      "Not run: the browser tools were not available",
    );
    expect(uiReviewDecisionItem(l)).toBeNull();
    expect(uiReviewDecisionItem(log({ skip: "mcp-not-available" }))).toBeNull();
  });

  it("reads Off, with no item, when the owner turned the reviewer off", () => {
    const l = skipped({ skip: "disabled-by-config" });
    expect(render(l)).toContain("Off: turned off in flow config.");
    expect(render(l)).not.toContain("[!WARNING]");
    expect(uiReviewDecisionItem(l)).toBeNull();
  });
});

describe("introduced and pre-existing findings", () => {
  const preExisting = finding({
    introduced: false,
    section: "Footer",
    observation: "old crowding",
  });

  it("lists a pre-existing defect under Pre-existing and adds no DECISION item", () => {
    const l = log({ outcome: "list-only", residual: [preExisting] });
    const out = renderUiReview({
      before: [],
      after: null,
      log: l,
      demotion: null,
    });
    expect(out).toContain("**Pre-existing (not gated):**");
    expect(out).toContain("- Footer @ phone — old crowding (defect)");
    expect(out).not.toContain("Unresolved defect");
    expect(uiReviewDecisionItem(l)).toBeNull();
  });

  it("an introduced defect still gates and a state-mismatch gates even when flagged pre-existing", () => {
    expect(
      uiReviewDecisionItem(log({ residual: [finding(), preExisting] })),
    ).toContain("1 unresolved defect(s)");
    const mismatch = finding({ introduced: false, rule: "state-mismatch" });
    expect(uiReviewDecisionItem(log({ residual: [mismatch] }))).toContain(
      "1 unresolved defect(s)",
    );
  });
});

describe("review context lines", () => {
  const render = (l: LoopLog) =>
    renderUiReview({ before: [], after: null, log: l, demotion: null });

  it("labels derived targets as not confirmed to show the change", () => {
    const out = render(
      log({
        outcome: "clean",
        targets: [
          { route: "/analysis/AVGO", state: "empty state", source: "plan" },
          { route: "/about", state: null, source: "route-file" },
        ],
      }),
    );
    expect(out).toContain("- /analysis/AVGO — empty state");
    expect(out).toContain(
      "- /about — derived — not confirmed to show the change",
    );
  });

  it("names the judged commit on a completed review", () => {
    const out = render(
      log({ outcome: "clean", completed: true, headSha: "abcdef0123456789" }),
    );
    expect(out).toContain("Judged commit: `abcdef0`");
  });

  it("opens with the Playwright warning even when the browser agent completed the review", () => {
    const out = render(
      log({
        outcome: "clean",
        completed: true,
        playwrightWarning: "UI review screenshots need Playwright in this repo",
      }),
    );
    const lines = out.split("\n");
    expect(lines[3]).toBe("> [!WARNING]");
    expect(lines[4]).toBe(
      "> UI review screenshots need Playwright in this repo",
    );
    expect(out).toContain("Clean: the critique found no defect");
  });
});

describe("sign-off screenshots (advisory)", () => {
  const render = (l: LoopLog) =>
    renderUiReview({ before: [], after: null, log: l, demotion: null });
  const signoff = (findings: CritiqueFinding[]) => ({
    findings,
    judgedSha: "abc",
  });

  it("lists introduced findings first and never adds a DECISION item", () => {
    const l = log({
      outcome: "clean",
      completed: true,
      signoff: signoff([
        finding({ introduced: false, observation: "old", section: "Menu" }),
        finding({ observation: "new clip", section: "Dialog" }),
      ]),
    });
    const out = render(l);
    expect(out).toContain("**Sign-off screenshots (advisory):**");
    expect(out.indexOf("new clip")).toBeLessThan(out.indexOf("old"));
    expect(out).toContain("(defect, pre-existing)");
    expect(uiReviewDecisionItem(l)).toBeNull();
  });

  it("omits the list when the advisory review found nothing", () => {
    expect(
      render(log({ outcome: "clean", signoff: signoff([]) })),
    ).not.toContain("Sign-off screenshots");
  });
});
