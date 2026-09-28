/**
 * Pointer-only `> [!CAUTION]` block for an exhausted verify loop.
 *
 * The block sits directly under the fence-aware `## Test Steps` heading,
 * delimited by marker comments so a re-run replaces it and a clean pass
 * removes it. It names the local excerpt file and NEVER carries the
 * failure output — this module does not read the excerpt. Sibling notes
 * (the UI-skip NOTE) must sit OUTSIDE the markers, or a clear removes them.
 */
import * as path from "node:path";
import { testStepsSectionBounds } from "../flow-gate-decide";
import { fencedLineMask } from "./md-block-structure";

const OPEN = "<!-- flow:verify-caution -->";
const CLOSE = "<!-- /flow:verify-caution -->";

export type UpsertResult =
  | { ok: true; body: string; replaced: boolean }
  | { ok: false; error: string };

function findBlock(lines: string[]): { from: number; to: number } | null {
  const fenced = fencedLineMask(lines);
  const unfenced = (marker: string, start: number): number => {
    for (let i = start; i < lines.length; i++) {
      if (lines[i] === marker && !fenced[i]) return i;
    }
    return -1;
  };
  const from = unfenced(OPEN, 0);
  if (from < 0) return null;
  const close = unfenced(CLOSE, from);
  if (close < 0) {
    // Orphan open marker (hand-edited body): drop it and the callout lines
    // that follow so a re-insert never stacks a second block.
    let end = from + 1;
    while (end < lines.length && lines[end].startsWith(">")) end++;
    return { from, to: lines[end] === "" ? end + 1 : end };
  }
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

/** Worktree-relative when the path sits under `root`; otherwise unchanged. */
export function displayExcerptPath(excerptPath: string, root?: string): string {
  if (!root) return excerptPath;
  const rel = path.relative(root, path.resolve(excerptPath));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? rel
    : excerptPath;
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
    "> Fix the failure, then resume the pipeline; this warning is removed automatically on the next clean verify.",
    CLOSE,
    "",
  ];
  // After the heading's blank line when present; the block carries its own
  // trailing blank, so clear restores the body byte-for-byte either way.
  const at = bounds.start + 1;
  lines.splice(lines[at] === "" ? at + 1 : at, 0, ...block);
  return { ok: true, body: lines.join("\n"), replaced: cleared };
}
