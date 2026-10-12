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

describe("parseTestSteps — fenced content", () => {
  it("does not truncate the section at a fenced '## ' line", () => {
    const body = [
      "## Test Steps",
      "",
      "- [ ] first",
      "```",
      "## captured heading",
      "```",
      "- [ ] second",
      "",
      "## Notes",
    ].join("\n");
    const { steps } = parseTestSteps(body);
    expect(steps.map((s) => s.text)).toEqual(["first", "second"]);
    expect(steps[1].line).toBe(7);
  });

  it("maps a real item to its own line when a fenced line has the same text", () => {
    const body = [
      "## Test Steps",
      "",
      "```",
      "- [ ] echoed",
      "```",
      "- [ ] echoed",
      "",
    ].join("\n");
    const { steps } = parseTestSteps(body);
    expect(steps).toHaveLength(1);
    expect(steps[0].line).toBe(6);
  });
});

describe("lintTestSteps — Browser items the driver cannot run", () => {
  const BROWSER_CODES: LintCode[] = [
    "browser-shape",
    "browser-over-bound",
    "browser-input-unsupported",
  ];
  const browserCodes = (body: string, phase: "authoring" | "review") =>
    codes(body, phase).filter((c) => BROWSER_CODES.includes(c));

  // PR #950's items 10 and 11 (checklist positions only matter to the gate).
  const ITEM_10 =
    "- [ ] Browser: set up a dashboard with a line chart of GDP, add a second series, open the settings panel, set the range to 10y, click Save, navigate to the dashboard, open the chart menu, select Fit, hover the last point — expect the tooltip shows the latest value";
  const ITEM_11 =
    "- [ ] Browser: on that graph, hold Cmd and scroll the mouse wheel to zoom — expect the y-axis refits";

  it("flags PR #950 item 10 for shape and over-bound", () => {
    expect(browserCodes(bodyOf(ITEM_10), "authoring")).toEqual([
      "browser-shape",
      "browser-over-bound",
    ]);
  });

  it("flags PR #950 item 11 for shape and unsupported input", () => {
    expect(browserCodes(bodyOf(ITEM_11), "authoring")).toEqual([
      "browser-shape",
      "browser-input-unsupported",
    ]);
  });

  it("runs in both phases at finding severity, with a fix-naming hint", () => {
    const steps = parseTestSteps(bodyOf(ITEM_11)).steps;
    for (const phase of ["authoring", "review"] as const) {
      const f = lintTestSteps(steps, phase).filter((x) =>
        BROWSER_CODES.includes(x.code),
      );
      expect(f.map((x) => x.severity)).toEqual(["finding", "finding"]);
      expect(f[1].hint).toMatch(/fixture or URL|durable/);
    }
  });

  it.each([
    '- [ ] Browser: on /route, click Save — expect "Saved"',
    "- [ ] Browser: on /card/<id> at 375×667, tap the share button — expect the share sheet",
    "- [ ] Browser: on /pricing, click Upgrade — expect the plan dialog.",
  ])("does not flag a well-shaped item: %s", (item) => {
    expect(browserCodes(bodyOf(item), "authoring")).toEqual([]);
  });

  it("does not flag a wrapped item whose '— expect' is on the continuation line", () => {
    const body = bodyOf(
      "- [ ] Browser: on /card/<id> at 375×667, tap the card image — expect",
      "      the fullscreen view with no plate and no outline element.",
    );
    expect(parseTestSteps(body).steps[0].fullText).toBe(
      "Browser: on /card/<id> at 375×667, tap the card image — expect the fullscreen view with no plate and no outline element.",
    );
    expect(browserCodes(body, "authoring")).toEqual([]);
  });

  it("flags a wrapped item that never says '— expect'", () => {
    const body = bodyOf(
      "- [ ] Browser: on /card/<id>, tap the card image and",
      "      look at it.",
    );
    expect(browserCodes(body, "authoring")).toEqual(["browser-shape"]);
  });

  it("flags more than 8 actions but not exactly 8", () => {
    const eight =
      "- [ ] Browser: on /a, click A, click B, click C, click D, click E, click F, click G, click H — expect done";
    const nine = eight.replace("click H", "click H, click I");
    expect(browserCodes(bodyOf(eight), "authoring")).toEqual([]);
    expect(browserCodes(bodyOf(nine), "authoring")).toEqual([
      "browser-over-bound",
    ]);
  });

  it.each([
    "- [ ] Browser: on /a, pinch the map — expect it zooms",
    "- [ ] Browser: on /a, ctrl+scroll the chart — expect a zoom",
    "- [ ] Browser: on /a, shift drag the handle — expect a range",
  ])("flags wheel / pinch / modifier-held input: %s", (item) => {
    expect(browserCodes(bodyOf(item), "authoring")).toEqual([
      "browser-input-unsupported",
    ]);
  });

  it("does not flag plain scroll or an unrelated Control label", () => {
    expect(
      browserCodes(
        bodyOf(
          "- [ ] Browser: on /a, scroll to the footer — expect the Control panel link",
        ),
        "authoring",
      ),
    ).toEqual([]);
  });

  it("never lints non-browser items for browser codes", () => {
    expect(
      browserCodes(
        bodyOf("- [ ] Run `bun x.ts` — the wheel turns and exits 0."),
        "authoring",
      ),
    ).toEqual([]);
  });
});
