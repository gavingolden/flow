/**
 * Sync gitignore managed-block parser/writer for the Bun bin. Used by
 * `flow migrate` to detect and strip the two managed blocks
 * (`install-skills`, `install-scripts`) that the legacy per-repo
 * `flow install` left behind in target repos.
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
