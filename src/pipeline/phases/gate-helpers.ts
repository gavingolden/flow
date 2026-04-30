// Pure helpers shared by gate.ts. Kept separate so the parsing rules can
// be unit-tested without a temp filesystem and so a future caller (e.g. a
// `flow status` summary or a verify-gate cross-check) can reuse them.
//
// The strip-and-trim contract here is the single source of truth for
// "is the manual-validation section actually populated." The implement
// phase's `MANUAL_VALIDATION_RULE` documents the contract for the LLM;
// these helpers enforce it for the runner.

// Section regex shape mirrors `verify-gate.ts`'s `upsertCautionBlock` so
// the parsing rule is one consistent thing across the codebase. Capture
// group 1 is the section body (without the heading line). Anchored at
// column 0; matches through the next `## ` heading or end-of-input.
const MANUAL_VALIDATION_SECTION_RE =
  /^## Manual validation\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m;

// Multi-line HTML comments handled via `[\s\S]`. Non-greedy so multiple
// comments on one body don't collapse into a single match.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

export function extractManualValidationSection(body: string): string | null {
  const match = body.match(MANUAL_VALIDATION_SECTION_RE);
  if (!match) return null;
  return match[1] ?? "";
}

export function stripHtmlComments(s: string): string {
  return s.replace(HTML_COMMENT_RE, "");
}

export function isManualValidationEmpty(sectionBody: string): boolean {
  return stripHtmlComments(sectionBody).trim().length === 0;
}

export type ManualValidationDecision =
  | "empty"
  | "non-empty"
  | "section-missing";

export function decideManualValidation(body: string): ManualValidationDecision {
  const section = extractManualValidationSection(body);
  if (section === null) return "section-missing";
  return isManualValidationEmpty(section) ? "empty" : "non-empty";
}
