/**
 * Which Claude Code session JSONLs belong to a pipeline.
 *
 * `flow feature create` seeds the supervisor with one line carrying the
 * resolved slug (`[pipeline-slug: <slug>] Use the /flow-pipeline skill. ...`).
 * A JSONL belongs to a pipeline when its first real user message (after
 * `isMeta` entries and local-command echoes, read from a bounded prefix)
 * extracts back to that slug. A legacy free-text seed still matches as a
 * slugify(description) fallback — see `seedMatchesSlug`.
 *
 * A pipeline maps to many JSONLs: `flow feature resume` starts a fresh
 * session whose seed also matches the slug, and a repeated
 * `flow feature create <same desc>` after `flow done` leaves old JSONLs in
 * `~/.claude/projects/` (callers drop stale ones by time).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slugify } from "./slug";

export function defaultProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Claude Code's project-dir encoding: every character outside
 * `[A-Za-z0-9-]` in the absolute cwd becomes `-` (observed: `.flow-tmp`
 * paths land in `--flow-tmp-` dirs). The leading slash becomes a leading
 * `-` for free.
 */
export function encodeProjectSegment(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9-]/g, "-");
}

export async function findSessionJsonls(
  projectDir: string,
  slug: string,
): Promise<string[]> {
  return findSessionJsonlsSync(projectDir, slug);
}

export function findSessionJsonlsSync(
  projectDir: string,
  slug: string,
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(projectDir, e.name))
    .filter((file) => jsonlMatchesSlug(file, slug));
}

/**
 * A user entry that is not a real message: Claude Code's own `isMeta`
 * entries and the local-command echoes (`/clear` writes `<command-name>` and
 * `<local-command-stdout>` entries before the user's first real message).
 */
export function isLocalCommandEcho(entry: Record<string, unknown>): boolean {
  if (entry.isMeta === true) return true;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") return false;
  const head = content.trimStart();
  return (
    head.startsWith("<command-name>") || head.startsWith("<local-command-")
  );
}

const PREFIX_CHUNK_BYTES = 64 * 1024;
const PREFIX_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Tests the first real user message against the slug while reading only a
 * bounded prefix, in chunks: project dirs hold hundreds of MB of transcripts
 * and the first real message can sit behind large attachment/hook lines.
 */
function jsonlMatchesSlug(file: string, slug: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const chunk = Buffer.alloc(PREFIX_CHUNK_BYTES);
    let pending = "";
    let read = 0;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, read);
      const eof = n === 0;
      read += n;
      pending += chunk.toString("utf8", 0, n);
      const lines = pending.split("\n");
      pending = eof ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const verdict = firstMessageVerdict(line, slug);
        if (verdict !== null) return verdict;
      }
      if (eof || read >= PREFIX_MAX_BYTES) return false;
    }
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function firstMessageVerdict(line: string, slug: string): boolean | null {
  if (!line) return null;
  const event = tryParse(line);
  if (!event || event.type !== "user") return null;
  if (isLocalCommandEcho(event as Record<string, unknown>)) return null;
  const content = event.message?.content;
  if (typeof content !== "string") return null;
  return seedMatchesSlug(content, slug);
}

export function seedMatchesSlug(seed: string, slug: string): boolean {
  // First choice: the new single-line seed shape
  // (`[pipeline-slug: <slug>] Use the /flow-pipeline skill. REQUEST_FILE: <path>`)
  // carries the resolved slug directly — compare it as-is, never through
  // slugify(), which would mangle an already-valid slug's dashes/casing.
  const bracket = seed.match(/\[pipeline-slug:\s*([^\]]+)\]/);
  if (bracket) return bracket[1].trim() === slug;
  // Fallback: legacy transcripts recorded the old
  // `/flow-pipeline ... : <description>` seed shape, which never carried the
  // resolved slug — only the free-text description slugify() must derive it
  // from.
  const match = seed.match(/\/flow-pipeline\b[^:]*:\s*([\s\S]+)/i);
  if (!match) return false;
  return slugify(match[1]) === slug;
}

/** The `<projects>/<encoded-cwd>/<sessionId>/subagents` dir, or null. */
export function findSubagentsDir(
  sessionId: string,
  projectsRoot: string = defaultProjectsRoot(),
): string | null {
  let projectDirs: string[];
  try {
    projectDirs = fs
      .readdirSync(projectsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = path.join(projectsRoot, dir, sessionId, "subagents");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

type JsonlEvent = {
  type?: string;
  message?: { content?: unknown };
};

function tryParse(line: string): JsonlEvent | null {
  try {
    return JSON.parse(line) as JsonlEvent;
  } catch {
    return null;
  }
}
