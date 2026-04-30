import fs from "node:fs/promises";
import path from "node:path";

export interface ManagedBlock {
  tag: string;
  comment?: string;
  paths: string[];
}

export type UpdateResult = "created" | "updated" | "unchanged";

/**
 * Pure rewrite: produce the new .gitignore content for a managed block.
 *
 * - If the block is absent and `paths` is non-empty, append it (separated from
 *   prior content by a blank line if needed).
 * - If the block exists, replace its body in place (regardless of whether the
 *   prior body matches the new one — the caller decides whether the rewrite is
 *   worth writing to disk).
 * - If `paths` is empty, remove the block entirely.
 *
 * Block format:
 *
 *     # managed by flow <tag>
 *     # <optional comment>
 *     <path>
 *     <path>
 *     # end flow <tag>
 */
export function applyManagedBlock(input: string, block: ManagedBlock): string {
  const beginMarker = `# managed by flow ${block.tag}`;
  const endMarker = `# end flow ${block.tag}`;

  const lines = input.split("\n");
  const beginIdx = lines.indexOf(beginMarker);
  const endIdx = beginIdx >= 0 ? lines.indexOf(endMarker, beginIdx + 1) : -1;

  const renderedBlock = renderBlock(block, beginMarker, endMarker);

  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = lines.slice(0, beginIdx);
    const after = lines.slice(endIdx + 1);
    if (renderedBlock.length === 0) {
      // Block is being removed — also drop a single blank separator before it,
      // if present, so we don't leave a double blank line behind.
      if (before.length > 0 && before[before.length - 1] === "") before.pop();
      return joinLines([...before, ...after]);
    }
    return joinLines([...before, ...renderedBlock, ...after]);
  }

  if (renderedBlock.length === 0) {
    return ensureTrailingNewline(input);
  }

  // No existing block — append. Ensure exactly one blank line before the block
  // when the file already has content.
  const trimmed = trimTrailingBlankLines(lines);
  const out: string[] = [...trimmed];
  if (trimmed.length > 0) out.push("");
  out.push(...renderedBlock);
  return joinLines(out);
}

function renderBlock(block: ManagedBlock, begin: string, end: string): string[] {
  if (block.paths.length === 0) return [];
  const out: string[] = [begin];
  if (block.comment) out.push(`# ${block.comment}`);
  for (const p of block.paths) out.push(p);
  out.push(end);
  return out;
}

function joinLines(lines: string[]): string {
  return ensureTrailingNewline(lines.join("\n"));
}

function ensureTrailingNewline(s: string): string {
  if (s.length === 0) return "";
  return s.endsWith("\n") ? s : s + "\n";
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

/**
 * I/O wrapper. Reads `<repoRoot>/.gitignore` (treating missing as empty),
 * applies the managed block, and writes only when the contents change.
 */
export async function updateGitignoreBlock(
  repoRoot: string,
  block: ManagedBlock,
): Promise<UpdateResult> {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const existing = await readIfExists(gitignorePath);
  const next = applyManagedBlock(existing ?? "", block);

  if (existing === null) {
    if (next.length === 0) return "unchanged";
    await fs.writeFile(gitignorePath, next, "utf8");
    return "created";
  }
  if (next === existing) return "unchanged";
  await fs.writeFile(gitignorePath, next, "utf8");
  return "updated";
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read-side counterpart to `updateGitignoreBlock`. Returns the path lines
 * between the begin/end markers for `<tag>`, excluding the optional
 * `# <comment>` line that may sit just under the begin marker. Returns `[]`
 * if `.gitignore` is missing, the block is absent, or the block is empty.
 *
 * Used by `flow install --upgrade` to compute orphans (paths previously
 * managed by flow but no longer present in the source tree).
 */
export async function readManagedBlockPaths(
  repoRoot: string,
  tag: string,
): Promise<string[]> {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const existing = await readIfExists(gitignorePath);
  if (existing === null) return [];
  return parseManagedBlockPaths(existing, tag);
}

export function parseManagedBlockPaths(input: string, tag: string): string[] {
  const beginMarker = `# managed by flow ${tag}`;
  const endMarker = `# end flow ${tag}`;
  const lines = input.split("\n");
  const beginIdx = lines.indexOf(beginMarker);
  if (beginIdx < 0) return [];
  const endIdx = lines.indexOf(endMarker, beginIdx + 1);
  if (endIdx < 0) return [];
  const body = lines.slice(beginIdx + 1, endIdx);
  // Drop the optional comment line directly under the begin marker. The block
  // body otherwise contains only path entries — applyManagedBlock writes
  // exactly one comment line, so this is sufficient.
  if (body.length > 0 && body[0]!.startsWith("# ")) body.shift();
  return body.filter((l) => l.length > 0);
}
