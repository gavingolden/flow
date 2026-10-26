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
