/**
 * Sync gitignore managed-block parser/writer for the Bun bin.
 *
 * Duplicated from src/util/gitignore.ts (which is async/Node and slated for
 * deletion in PR 4). Keeps the bin self-contained so PR 4 can remove src/
 * without breaking the migrate verb.
 *
 * Block format:
 *   # managed by flow <tag>
 *   # <optional comment>
 *   <path>
 *   <path>
 *   # end flow <tag>
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ManagedBlock = {
  tag: string;
  comment?: string;
  paths: string[];
};

export function parseManagedBlockPaths(input: string, tag: string): string[] {
  const beginMarker = `# managed by flow ${tag}`;
  const endMarker = `# end flow ${tag}`;
  const lines = input.split("\n");
  const beginIdx = lines.indexOf(beginMarker);
  if (beginIdx < 0) return [];
  const endIdx = lines.indexOf(endMarker, beginIdx + 1);
  if (endIdx < 0) return [];
  const body = lines.slice(beginIdx + 1, endIdx);
  if (body.length > 0 && body[0]!.startsWith("# ")) body.shift();
  return body.filter((l) => l.length > 0);
}

/** Returns the gitignore content with the named block removed entirely. */
export function removeManagedBlock(input: string, tag: string): string {
  const beginMarker = `# managed by flow ${tag}`;
  const endMarker = `# end flow ${tag}`;
  const lines = input.split("\n");
  const beginIdx = lines.indexOf(beginMarker);
  if (beginIdx < 0) return input;
  const endIdx = lines.indexOf(endMarker, beginIdx + 1);
  if (endIdx < 0) return input;

  const before = lines.slice(0, beginIdx);
  const after = lines.slice(endIdx + 1);
  if (before.length > 0 && before[before.length - 1] === "") before.pop();
  return ensureTrailingNewline([...before, ...after].join("\n"));
}

/**
 * Upserts a managed block. Creates it if absent (after a blank-line
 * separator), replaces the body in place if present, removes the block
 * entirely if `block.paths` is empty.
 */
export function applyManagedBlock(input: string, block: ManagedBlock): string {
  const beginMarker = `# managed by flow ${block.tag}`;
  const endMarker = `# end flow ${block.tag}`;
  const lines = input.split("\n");
  const beginIdx = lines.indexOf(beginMarker);
  const endIdx = beginIdx >= 0 ? lines.indexOf(endMarker, beginIdx + 1) : -1;

  const rendered = renderBlock(block, beginMarker, endMarker);

  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = lines.slice(0, beginIdx);
    const after = lines.slice(endIdx + 1);
    if (rendered.length === 0) {
      if (before.length > 0 && before[before.length - 1] === "") before.pop();
      return ensureTrailingNewline([...before, ...after].join("\n"));
    }
    return ensureTrailingNewline([...before, ...rendered, ...after].join("\n"));
  }

  if (rendered.length === 0) return ensureTrailingNewline(input);

  const trimmed = trimTrailingBlankLines(lines);
  const out = [...trimmed];
  if (trimmed.length > 0) out.push("");
  out.push(...rendered);
  return ensureTrailingNewline(out.join("\n"));
}

function renderBlock(block: ManagedBlock, begin: string, end: string): string[] {
  if (block.paths.length === 0) return [];
  const out = [begin];
  if (block.comment) out.push(`# ${block.comment}`);
  for (const p of block.paths) out.push(p);
  out.push(end);
  return out;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

export function readGitignore(repoRoot: string): string | null {
  const p = path.join(repoRoot, ".gitignore");
  try {
    return fs.readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function writeGitignore(repoRoot: string, content: string): void {
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), content, "utf8");
}

function ensureTrailingNewline(s: string): string {
  if (s.length === 0) return "";
  return s.endsWith("\n") ? s : s + "\n";
}
