import { fencedLineMask } from "./md-block-structure";

const HEADING_RE = /^## Test Steps[ \t]*$/m;

/**
 * Bounds of the `## Test Steps` section as `{start, end}` line indices
 * (`start` is the heading line, `end` is exclusive: the next `## ` heading
 * or end-of-input). Fenced lines are skipped for BOTH the heading search
 * and the section-end scan, so captured output echoing `## ...` never
 * moves either bound. Shared with `parseTestSteps` so the lint and the
 * gate read the same section.
 */
export function testStepsSectionBounds(
  lines: string[],
): { start: number; end: number } | null {
  const fenced = fencedLineMask(lines);
  const start = lines.findIndex((l, i) => !fenced[i] && HEADING_RE.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!fenced[i] && /^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

const FENCED_PLACEHOLDER = "\u0000fenced";

/**
 * Extract the `## Test Steps` section text (heading line to the next
 * `## ` heading at column 0, or end-of-input) with HTML comments
 * stripped. Fenced lines are replaced 1:1 by a non-blank inert
 * placeholder BEFORE the comment strip, so a `<!--` or `- [ ]` inside
 * captured output can neither hide later items nor be counted. Shared by
 * `parseTestStepsSection` and `findTrappedTestSteps` so the two agree on
 * exactly what text they're scanning.
 */
export function extractStrippedSection(body: string): string | null {
  const lines = body.split("\n");
  const bounds = testStepsSectionBounds(lines);
  if (bounds === null) return null;
  const fenced = fencedLineMask(lines);
  const startIdx = bounds.start;
  const endIdx = bounds.end;
  let section = lines
    .slice(startIdx + 1, endIdx)
    .map((l, i) => (fenced[startIdx + 1 + i] ? FENCED_PLACEHOLDER : l))
    .join("\n");

  // Strip HTML comments (multi-line, non-greedy). Same as `perl -0pe 's/<!--.*?-->//gs'`.
  // The strip is essential: the PR template's instructional comment carries no
  // `- [ ]` items, so on a pure-internal change the section has zero unchecked
  // items after the strip → auto-merge.
  section = section.replace(/<!--[\s\S]*?-->/g, "");
  return section;
}
