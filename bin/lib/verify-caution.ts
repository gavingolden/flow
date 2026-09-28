/**
 * Pointer-only `> [!CAUTION]` block for an exhausted verify loop.
 *
 * The block sits directly under the fence-aware `## Test Steps` heading,
 * delimited by marker comments so a re-run replaces it and a clean pass
 * removes it. It names the local excerpt file and NEVER carries the
 * failure output — this module does not read the excerpt. Sibling notes
 * (the UI-skip NOTE) must sit OUTSIDE the markers, or a clear removes them.
 */
import { testStepsSectionBounds } from "../flow-gate-decide";

const OPEN = "<!-- flow:verify-caution -->";
const CLOSE = "<!-- /flow:verify-caution -->";

export type UpsertResult =
  | { ok: true; body: string; replaced: boolean }
  | { ok: false; error: string };

function findBlock(lines: string[]): { from: number; to: number } | null {
  const from = lines.indexOf(OPEN);
  if (from < 0) return null;
  const close = lines.indexOf(CLOSE, from);
  if (close < 0) return null;
  // Also swallow the single blank line the insert adds after the block.
  const to = lines[close + 1] === "" ? close + 2 : close + 1;
  return { from, to };
}

export function clearVerifyCaution(body: string): {
  body: string;
  cleared: boolean;
} {
  const lines = body.split("\n");
  const block = findBlock(lines);
  if (!block) return { body, cleared: false };
  lines.splice(block.from, block.to - block.from);
  return { body: lines.join("\n"), cleared: true };
}

export function upsertVerifyCaution(
  body: string,
  excerptPath: string,
): UpsertResult {
  const { body: base, cleared } = clearVerifyCaution(body);
  const lines = base.split("\n");
  const bounds = testStepsSectionBounds(lines);
  if (!bounds) return { ok: false, error: "no ## Test Steps heading" };
  const block = [
    OPEN,
    "> [!CAUTION]",
    `> **Verify failed after 3 attempts.** The last failure output is in \`${excerptPath}\` on the machine that ran the pipeline — it is not published here.`,
    CLOSE,
    "",
  ];
  // One blank line after the heading, then the block.
  const at = bounds.start + 1;
  const insert = lines[at] === "" ? block : ["", ...block];
  lines.splice(lines[at] === "" ? at + 1 : at, 0, ...insert);
  return { ok: true, body: lines.join("\n"), replaced: cleared };
}
