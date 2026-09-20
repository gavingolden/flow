/**
 * Typed parse + lint of a PR body's `## Test Steps` checklist.
 *
 * Section bounds and comment stripping come from the merge decision's own
 * `extractStrippedSection`, so the lint can never bless a section the gate
 * reads differently. Rules: skills/pipeline/flow-pr-review/references/
 * manual-test-rubric.md `## Mechanical lint`.
 */
import { extractStrippedSection } from "../flow-gate-decide";

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
  hasEvidence: boolean;
  hasImage: boolean;
  noScreenshotReason: boolean;
};

export type LintCode =
  | "generic-suite"
  | "presence-only"
  | "subjective-mixed"
  | "subjective-no-image"
  | "ticked-no-evidence"
  | "post-merge-step"
  | "human-only-ticked";

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
const NO_SCREENSHOT_RE = /no screenshot:\s*\S/i;

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
  let cursor = bodyLines.findIndex((l) => /^## Test Steps[ \t]*$/.test(l)) + 1;
  return (raw) => {
    const idx = bodyLines.indexOf(raw, cursor);
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
  const heads: { line: number; checked: boolean; text: string }[] = [];
  for (const raw of sectionLines) {
    const m = raw.match(ITEM_RE);
    if (!m) continue;
    heads.push({ line: locate(raw), checked: m[1] !== " ", text: m[2] });
  }

  let sectionEnd = bodyLines.length;
  const headingIdx = bodyLines.findIndex((l) =>
    /^## Test Steps[ \t]*$/.test(l),
  );
  for (let i = headingIdx + 1; i < bodyLines.length; i++) {
    if (/^## /.test(bodyLines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const steps = heads.map((head, i): ParsedStep => {
    const from = head.line;
    const next = heads[i + 1]?.line;
    const to = next && next > from ? next - 1 : sectionEnd;
    const span = from > 0 ? bodyLines.slice(from, to).join("\n") : "";
    return {
      line: head.line,
      checked: head.checked,
      kind: classify(head.text),
      text: head.text,
      hasEvidence: span.includes(EVIDENCE_MARKER),
      hasImage: IMAGE_RE.test(span) || IMAGE_RE.test(head.text),
      noScreenshotReason:
        NO_SCREENSHOT_RE.test(span) || NO_SCREENSHOT_RE.test(head.text),
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

const HINTS: Record<LintCode, string> = {
  "generic-suite":
    "CI already runs the whole suite; name the specific test file or case this PR adds.",
  "presence-only":
    "A string or file existing proves nothing about behaviour; assert the behaviour or drop the item.",
  "subjective-mixed":
    "A measurable clause sits inside a taste item; consider splitting it into its own runnable item.",
  "subjective-no-image":
    "Every SUBJECTIVE item needs a screenshot or a 'no screenshot: <reason>' line.",
  "ticked-no-evidence":
    "A ticked prose or browser item carries no evidence block; attach proof or untick it.",
  "post-merge-step":
    "Post-merge or post-deploy steps never go in Test Steps; move to the local follow-ups list.",
  "human-only-ticked":
    "SUBJECTIVE and DECISION items are ticked by a human only; untick it unless the user ticked it.",
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
    if (phase !== "review") continue;
    if (
      step.kind === "subjective" &&
      !step.hasImage &&
      !step.noScreenshotReason
    )
      add("subjective-no-image", step);
    if (
      step.checked &&
      !step.hasEvidence &&
      (step.kind === "prose" || step.kind === "browser")
    )
      add("ticked-no-evidence", step);
  }
  return out;
}
