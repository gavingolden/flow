/**
 * Heading-parameterized idempotent PR-body section upsert.
 *
 * Extracted from `flow-followups.ts` so multiple helpers (local follow-ups,
 * foreclosed paths) share one splice implementation and cannot drift. The
 * heading (e.g. `## Local Follow-ups`, `## Foreclosed Paths`) is a parameter
 * rather than a hardcoded regex; everything else preserves the original
 * find-heading / splice-to-next-`^## ` / replace-in-place / append-when-absent
 * / no-op-on-identical behavior.
 */

/**
 * Build the anchor regex for a heading: matches the heading on its own line
 * (trailing whitespace tolerated), multiline. Regex metacharacters in the
 * heading are escaped so a heading like `## A.B` is matched literally.
 */
export function headingRegex(heading: string): RegExp {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}[ \\t]*$`, "m");
}

/**
 * Idempotent upsert of a `<heading>` section in a PR body. Replaces an
 * existing section in place (splicing up to the next `^## ` heading);
 * otherwise appends. Returns the body unchanged when the result is identical.
 * Same shape as the verify-exhausted `> [!CAUTION]` upsert pattern in
 * pr-review step 6.
 */
export function upsertPrBodySection(
  body: string,
  heading: string,
  section: string,
): string {
  const headingRe = headingRegex(heading);
  if (!headingRe.test(body)) {
    if (body.length === 0) return section + "\n";
    const trailingSep = body.endsWith("\n") ? "" : "\n";
    return body + trailingSep + "\n" + section + "\n";
  }
  const lines = body.split("\n");
  const startIdx = lines.findIndex((l) => headingRe.test(l));
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  const sectionLines = section.split("\n");
  const followingHeadingExists = endIdx < lines.length;
  const trailingBlanks = followingHeadingExists ? [""] : [];
  const newLines = [
    ...lines.slice(0, startIdx),
    ...sectionLines,
    ...trailingBlanks,
    ...lines.slice(endIdx),
  ];
  let result = newLines.join("\n");
  const hadTrailingNewline = body.endsWith("\n");
  if (hadTrailingNewline && !result.endsWith("\n")) result += "\n";
  return result;
}
