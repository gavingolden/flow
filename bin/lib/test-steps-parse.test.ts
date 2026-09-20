import { describe, expect, it } from "vitest";
import { parseTestStepsSection } from "../flow-gate-decide";
import {
  lintTestSteps,
  parseTestSteps,
  type LintCode,
} from "./test-steps-parse";

const RUBRIC_COMMENT = [
  "<!-- flow:authoring-rubric — for each `- [ ]` item below, the",
  "- [ ] this literal checkbox lives inside a comment",
  "three-question automation test applies. -->",
].join("\n");

function bodyOf(...items: string[]): string {
  return [
    "## Why",
    "",
    "- [ ] not a test step",
    "",
    "## Test Steps",
    "",
    RUBRIC_COMMENT,
    "",
    ...items,
    "",
    "## Notes",
    "",
    "- [ ] also not a test step",
  ].join("\n");
}

const CLEAN = bodyOf(
  "- [ ] Run `npm run test -- bin/lib/foo.test.ts` — the new case passes.",
  "- [ ] Browser: on /pricing, click Upgrade — expect the plan dialog.",
  "- [ ] DECISION: accept that the cache is dropped on upgrade.",
);

function codes(body: string, phase: "authoring" | "review"): LintCode[] {
  return lintTestSteps(parseTestSteps(body).steps, phase).map((f) => f.code);
}

describe("parseTestSteps", () => {
  it("reports a missing heading", () => {
    expect(parseTestSteps("## Why\n\n- [ ] x")).toEqual({
      headingPresent: false,
      steps: [],
    });
  });

  it("ignores checkboxes in comments and other sections, like the gate", () => {
    const { steps } = parseTestSteps(CLEAN);
    expect(steps.map((s) => s.kind)).toEqual([
      "command",
      "browser",
      "decision",
    ]);
    const gate = parseTestStepsSection(CLEAN);
    expect(gate.kind === "has-unchecked" && gate.uncheckedItems).toEqual(
      steps.map((s) => s.text),
    );
  });

  it("reports 1-based body line numbers", () => {
    const { steps } = parseTestSteps(CLEAN);
    const lines = CLEAN.split("\n");
    for (const s of steps) expect(lines[s.line - 1]).toContain(s.text);
  });

  it("detects ticks, evidence blocks, images and no-screenshot reasons", () => {
    const body = bodyOf(
      "- [x] The page loads.",
      "",
      "<details><!-- flow:evidence --><summary>Output</summary>",
      "",
      "![phone](.flow-tmp/ui-evidence/a.png)",
      "",
      "</details>",
      "",
      "- [ ] SUBJECTIVE: the swipe feels right.",
      "  no screenshot: motion cannot be photographed",
    );
    const [a, b] = parseTestSteps(body).steps;
    expect(a).toMatchObject({
      checked: true,
      kind: "prose",
      hasEvidence: true,
      hasImage: true,
    });
    expect(b).toMatchObject({
      checked: false,
      kind: "subjective",
      hasEvidence: false,
      hasImage: false,
      noScreenshotReason: true,
    });
  });
});

describe("lintTestSteps", () => {
  it("is silent on a clean body in both phases", () => {
    expect(codes(CLEAN, "authoring")).toEqual([]);
    expect(codes(CLEAN, "review")).toEqual([]);
  });

  const fixtures: [LintCode, "authoring" | "review", string][] = [
    ["generic-suite", "authoring", "- [ ] Run `npm run verify` — all green."],
    [
      "presence-only",
      "authoring",
      "- [ ] Run `grep -q 'fooBar' bin/foo.ts` — the symbol exists.",
    ],
    [
      "subjective-mixed",
      "authoring",
      "- [ ] SUBJECTIVE: the card looks balanced, no horizontal scroll at 390.",
    ],
    [
      "post-merge-step",
      "authoring",
      "- [ ] After merge, confirm the cron job picked up the new schedule.",
    ],
    [
      "human-only-ticked",
      "authoring",
      "- [x] DECISION: accept the slower cold start.",
    ],
    [
      "subjective-no-image",
      "review",
      "- [ ] SUBJECTIVE: the pricing page looks right.",
    ],
    ["ticked-no-evidence", "review", "- [x] The dialog opens on click."],
  ];

  it.each(fixtures)("%s fires on its fixture", (code, phase, item) => {
    expect(codes(bodyOf(item), phase)).toContain(code);
  });

  it("reports subjective-mixed as a suggestion, all else as findings", () => {
    for (const [code, phase, item] of fixtures) {
      const hit = lintTestSteps(parseTestSteps(bodyOf(item)).steps, phase).find(
        (f) => f.code === code,
      );
      expect(hit?.severity).toBe(
        code === "subjective-mixed" ? "suggestion" : "finding",
      );
    }
  });

  it("keeps the review-only codes out of the authoring phase", () => {
    const body = bodyOf(
      "- [ ] SUBJECTIVE: the pricing page looks right.",
      "- [x] The dialog opens on click.",
    );
    expect(codes(body, "authoring")).toEqual([]);
  });

  it("does not flag a SUBJECTIVE item carrying a no-screenshot reason", () => {
    const body = bodyOf(
      "- [ ] SUBJECTIVE: the haptic feels right.",
      "  no screenshot: real-device behaviour",
    );
    expect(codes(body, "review")).toEqual([]);
  });

  it("does not flag a targeted test run or a piped assertion", () => {
    const body = bodyOf(
      '- [ ] Run `npm run test -- bin/foo.test.ts -t "case"` — passes.',
      "- [ ] Run `bun x.ts | jq -e '.ok'` — exits 0.",
    );
    expect(codes(body, "authoring")).toEqual([]);
  });
});
