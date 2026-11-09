/**
 * Typed parse + lint of a PR body's `## Test Steps` checklist.
 *
 * Section bounds and comment stripping come from the merge decision's own
 * `extractStrippedSection`, so the lint can never bless a section the gate
 * reads differently. Rules: skills/pipeline/flow-pr-review/references/
 * manual-test-rubric.md `## Mechanical lint`.
 */
import {
  extractStrippedSection,
  testStepsSectionBounds,
} from "../flow-gate-decide";
import { imageRefs } from "./image-refs";
import { fencedLineMask } from "./md-block-structure";
import { missingViews, requiredViews, shotView } from "./signoff-views";

export type StepKind =
  | "command"
  | "browser"
  | "subjective"
  | "decision"
  | "prose";

export type ParsedStep = {
  line: number;
  checked: boolean;
  kind: StepKind;
  text: string;
  /** `text` plus the indented continuation lines of a wrapped item,
   * single-spaced — what the browser-shape lints read. */
  fullText: string;
  hasEvidence: boolean;
  hasImage: boolean;
  noScreenshotReason: boolean;
  /** Image refs on the item (head, continuation lines, evidence span). */
  images: { alt: string; ref: string }[];
  /** Reason text of a `partial:` line, or null. */
  partial: string | null;
  /** Reason text of a `no screenshot:` line, or null. */
  noScreenshot: string | null;
};

export type LintCode =
  | "generic-suite"
  | "presence-only"
  | "subjective-mixed"
  | "subjective-no-image"
  | "subjective-missing-view"
  | "ticked-no-evidence"
  | "post-merge-step"
  | "human-only-ticked"
  | "browser-shape"
  | "browser-over-bound"
  | "browser-input-unsupported";

export type LintFinding = {
  code: LintCode;
  severity: "finding" | "suggestion";
  line: number;
  text: string;
  hint: string;
};

const ITEM_RE = /^\s*-\s+\[( |x|X)\]\s+(.*\S)\s*$/;
const EVIDENCE_MARKER = "<!-- flow:evidence -->";
const IMAGE_RE = /!\[[^\]]*\]\([^)]+\)|<img\s/i;
const NO_SCREENSHOT_RE = /no screenshot:\s*(\S.*)/i;
const PARTIAL_RE = /\bpartial:\s*(\S.*)/i;
const HEADING_RE = /^\s{0,3}#{1,6}(?:\s|$)/;
const OTHER_COMMENT_RE = /<!--(?!\s*flow:evidence\s*-->)[\s\S]*?-->/g;

function classify(text: string): StepKind {
  if (text.startsWith("SUBJECTIVE: ")) return "subjective";
  if (text.startsWith("DECISION: ")) return "decision";
  if (text.startsWith("Browser: ")) return "browser";
  if (/^Run\s+`[^`]+`/.test(text) || /^`[^`]+`/.test(text)) return "command";
  return "prose";
}

/**
 * `extractStrippedSection` drops comments, so section line indices do not
 * map onto body lines. Recover the 1-based body line by walking a cursor
 * forward over exact line matches from the heading.
 */
function bodyLineLocator(body: string): (raw: string) => number {
  const bodyLines = body.split("\n");
  const strippedLines = bodyLines.map((l) => l.replace(/<!--[\s\S]*?-->/g, ""));
  const fenced = fencedLineMask(bodyLines);
  let cursor = (testStepsSectionBounds(bodyLines)?.start ?? -1) + 1;
  const find = (lines: string[], raw: string): number => {
    for (let i = cursor; i < lines.length; i++) {
      if (!fenced[i] && lines[i] === raw) return i;
    }
    return -1;
  };
  return (raw) => {
    let idx = find(strippedLines, raw);
    if (idx < 0) idx = find(bodyLines, raw);
    if (idx < 0) return 0;
    cursor = idx + 1;
    return idx + 1;
  };
}

export function parseTestSteps(body: string): {
  headingPresent: boolean;
  steps: ParsedStep[];
} {
  const section = extractStrippedSection(body);
  if (section === null) return { headingPresent: false, steps: [] };

  // The evidence marker is itself a comment, so the stripped section no
  // longer carries it; detect it from the raw lines between two items.
  const locate = bodyLineLocator(body);
  const bodyLines = body.split("\n");
  const sectionLines = section.split("\n");
  const heads: {
    line: number;
    checked: boolean;
    text: string;
    fullText: string;
  }[] = [];
  for (let i = 0; i < sectionLines.length; i++) {
    const raw = sectionLines[i];
    const m = raw.match(ITEM_RE);
    if (!m) continue;
    const parts = [m[2]];
    for (let j = i + 1; j < sectionLines.length; j++) {
      const next = sectionLines[j];
      if (!/^\s+\S/.test(next) || ITEM_RE.test(next)) break;
      parts.push(next.trim());
    }
    heads.push({
      line: locate(raw),
      checked: m[1] !== " ",
      text: m[2],
      fullText: parts.join(" "),
    });
  }

  const sectionEnd = testStepsSectionBounds(bodyLines)?.end ?? bodyLines.length;
  const fenced = fencedLineMask(bodyLines);

  const steps = heads.map((head, i): ParsedStep => {
    const from = head.line;
    const next = heads[i + 1]?.line;
    const to = next && next > from ? next - 1 : sectionEnd;
    let end = to;
    for (let k = from; k < to; k++) {
      if (!fenced[k] && HEADING_RE.test(bodyLines[k])) {
        end = k;
        break;
      }
    }
    const span = from > 0 ? bodyLines.slice(from, end).join("\n") : "";
    const readable =
      from > 0
        ? bodyLines
            .slice(from, end)
            .map((l, k) => (fenced[from + k] ? "" : l))
            .join("\n")
            .replace(OTHER_COMMENT_RE, "")
        : "";
    const scan = `${head.text}\n${readable}`;
    const images = imageRefs(scan).map((r) => ({ alt: r.alt, ref: r.target }));
    const reason = (re: RegExp): string | null =>
      (head.fullText.match(re) ?? readable.match(re))?.[1]?.trim() ?? null;
    const noScreenshot = reason(NO_SCREENSHOT_RE);
    return {
      line: head.line,
      checked: head.checked,
      kind: classify(head.text),
      text: head.text,
      fullText: head.fullText,
      hasEvidence: span.includes(EVIDENCE_MARKER),
      hasImage: images.length > 0 || IMAGE_RE.test(scan),
      noScreenshotReason: noScreenshot !== null,
      images,
      partial: reason(PARTIAL_RE),
      noScreenshot,
    };
  });
  return { headingPresent: true, steps };
}

const GENERIC_SUITE_RE =
  /`(?:env\s+\S+\s+)*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|verify|check|lint|typecheck|build)`/;
const PRESENCE_ONLY_RE =
  /`!?\s*(?:grep|rg|test\s+-[efdx]|ls|\[\s+-[efd])\b[^`|&;]*`/;
const POST_MERGE_RE =
  /\b(?:after|post|once|following)[ -](?:the\s+)?(?:pr\s+)?(?:is\s+)?(?:merge[ds]?|merging|deploy(?:ed|ment|s)?|release[ds]?)\b/i;
const MEASURABLE_RE =
  /\bno (?:horizontal|vertical) scroll|\b\d+\s?(?:px|ms|rem|%)|\bat least \d|\bat most \d|\bshows only\b|\bexactly \d|\bcontrast ratio\b|\bno console errors?\b|\bno layout shift\b/i;

const BROWSER_SHAPE_RE = /^Browser: on \S*\/[^,]*, .+ — expect .+/;
const BROWSER_ACTION_RE =
  /\b(?:click|type|fill|press|hold|scroll|drag|select|hover|navigate|open|add|set|save|log in|start)\b/gi;
const BROWSER_MAX_ACTIONS = 8;
const BROWSER_INPUT_RES = [
  /\b(?:wheel|pinch|trackpad)\b/i,
  /\b(?:hold(?:ing)?|press(?:ing)?)\s+(?:the\s+)?(?:cmd|ctrl|command|control|shift|alt|option)\b/i,
  /\b(?:cmd|ctrl|command|control|shift|alt|option)[-+ ](?:scroll|drag|wheel)\b/i,
];

const BROWSER_FIX =
  "split it into smaller Browser items, seed the state via a fixture or URL, or write a durable Playwright/vitest test.";

const HINTS: Record<LintCode, string> = {
  "generic-suite":
    "CI already runs the whole suite; name the specific test file or case this PR adds.",
  "presence-only":
    "A string or file existing proves nothing about behaviour; assert the behaviour or drop the item.",
  "subjective-mixed":
    "A measurable clause sits inside a taste item; consider splitting it into its own runnable item.",
  "subjective-no-image":
    "Every SUBJECTIVE item needs a screenshot or a 'no screenshot: <reason>' line.",
  "subjective-missing-view":
    "The item names a viewport the attached screenshots do not show; capture the missing view or add a 'partial: <reason>' line.",
  "ticked-no-evidence":
    "A ticked prose or browser item carries no evidence block; attach proof or untick it.",
  "post-merge-step":
    "Post-merge or post-deploy steps never go in Test Steps; move to the local follow-ups list.",
  "human-only-ticked":
    "SUBJECTIVE and DECISION items are ticked by a human only; untick it unless the user ticked it.",
  "browser-shape": `Browser items read 'Browser: on <route>, <action chain> — expect <result>'; rewrite to that shape, or ${BROWSER_FIX}`,
  "browser-over-bound": `The browser driver runs at most ${BROWSER_MAX_ACTIONS} actions per item; ${BROWSER_FIX}`,
  "browser-input-unsupported": `The browser driver cannot produce wheel, pinch or modifier-held scroll/drag input; seed the state via a fixture or URL, or write a durable Playwright/vitest test.`,
};

export function lintTestSteps(
  steps: ParsedStep[],
  phase: "authoring" | "review",
): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (code: LintCode, step: ParsedStep): void => {
    out.push({
      code,
      severity: code === "subjective-mixed" ? "suggestion" : "finding",
      line: step.line,
      text: step.text,
      hint: HINTS[code],
    });
  };

  for (const step of steps) {
    const humanOnly = step.kind === "subjective" || step.kind === "decision";
    if (step.kind === "command" && GENERIC_SUITE_RE.test(step.text))
      add("generic-suite", step);
    if (step.kind === "command" && PRESENCE_ONLY_RE.test(step.text))
      add("presence-only", step);
    if (step.kind === "subjective" && MEASURABLE_RE.test(step.text))
      add("subjective-mixed", step);
    if (POST_MERGE_RE.test(step.text)) add("post-merge-step", step);
    if (humanOnly && step.checked) add("human-only-ticked", step);
    if (step.kind === "browser") {
      if (!BROWSER_SHAPE_RE.test(step.fullText)) add("browser-shape", step);
      const chain = step.fullText.split(" — expect")[0];
      if ((chain.match(BROWSER_ACTION_RE) ?? []).length > BROWSER_MAX_ACTIONS)
        add("browser-over-bound", step);
      if (BROWSER_INPUT_RES.some((re) => re.test(chain)))
        add("browser-input-unsupported", step);
    }
    if (phase !== "review") continue;
    if (
      step.kind === "subjective" &&
      !step.hasImage &&
      !step.noScreenshotReason
    )
      add("subjective-no-image", step);
    if (
      step.kind === "subjective" &&
      !step.checked &&
      step.images.length > 0 &&
      !step.noScreenshotReason &&
      step.partial === null &&
      missingViews(
        requiredViews(step.fullText),
        step.images.map((im) => ({
          view: shotView(im.alt, im.ref),
          ref: im.ref,
        })),
      ).length > 0
    )
      add("subjective-missing-view", step);
    if (
      step.checked &&
      !step.hasEvidence &&
      (step.kind === "prose" || step.kind === "browser")
    )
      add("ticked-no-evidence", step);
  }
  return out;
}
