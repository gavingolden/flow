/**
 * Per-pipeline $ spend, derived from Claude Code's per-session JSONL.
 *
 * Pipeline → JSONL match: `flow feature create <description>` seeds the
 * supervisor with a single control-char-free line carrying the RESOLVED
 * slug directly — `[pipeline-slug: <slug>] Use the /flow-pipeline skill.
 * REQUEST_FILE: <path>` (the description no longer rides the seed at all).
 * We scan `~/.claude/projects/<encoded-cwd>/` for the supervisor's starting
 * cwd (state.repo) and pick every JSONL whose first user-message
 * extracts back to the same slug — matched directly against the
 * `[pipeline-slug: ...]` bracket, not a slugify(description) round-trip.
 * Each pipeline's seed is unique by construction (slugs are unique window
 * names), so concurrent pipelines don't alias. A legacy free-text
 * `Use the /flow-pipeline skill for: <description>` seed (pre-migration
 * transcripts) is still matched as a slugify(description) fallback — see
 * `seedMatchesSlug` below.
 *
 * Why "every" not "first": `flow feature resume` spawns a fresh Claude
 * session — and therefore a fresh JSONL — that also seed-matches the
 * same slug (resume's seed is `Use the /flow-pipeline skill in
 * --resume mode for: <slug>`, which the regex below also accepts).
 * After a single resume there are at least two matching JSONLs for
 * the same pipeline; only summing across all of them reports the
 * true cost. The same applies to repeated `flow feature create <same desc>`
 * after `flow done` — old JSONLs accumulate in `~/.claude/projects/`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { collectRunAttribution } from "./run-attribution";
import { mergeWithPrior } from "./run-attribution-record";
import type { RunAttribution } from "./run-attribution-types";
import { slugify } from "./slug";
import type { PipelineState } from "./state";
import {
  type EffortRun,
  effortRunsOf,
  readTranscriptTurns,
} from "./transcript-turns";

export type CostBreakdown = {
  total: number;
  byModel: Record<string, number>;
  unknownModels: string[];
  hasData: boolean;
};

export const EMPTY_COST: CostBreakdown = {
  total: 0,
  byModel: {},
  unknownModels: [],
  hasData: false,
};

/**
 * `flow ls --cost` projection of the run-attribution collector merged with
 * the pipeline's latest durable row, so the cost column and `RAN ON:` always
 * show the same figure and sessions Claude Code has since pruned keep their
 * spend. `hasData` needs at least one session or spawn: an empty row stays
 * `—`, never `$0.00`.
 */
export async function computeCost(
  state: PipelineState,
  projectsRoot = defaultProjectsRoot(),
  latest: RunAttribution | null = null,
): Promise<CostBreakdown> {
  const merged = mergeWithPrior(
    collectRunAttribution(state, { projectsRoot }),
    latest,
  );
  if (merged.sessions.length + merged.spawns.length === 0) return EMPTY_COST;
  const byModel: Record<string, number> = {};
  for (const r of merged.totals.by_model_effort) {
    if (r.cost_usd) byModel[r.model] = (byModel[r.model] ?? 0) + r.cost_usd;
  }
  return {
    total: merged.totals.cost_usd,
    byModel,
    unknownModels: merged.totals.unpriced_models,
    hasData: true,
  };
}

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

export type TranscriptUsage = {
  input: number;
  cache_creation: number;
  cache_read: number;
  output: number;
  total: number;
  model: string | null;
  effortRuns: EffortRun[];
};

/**
 * Reusable transcript-usage summer for a single JSONL: sums every
 * assistant turn's `message.usage` fields, tracks the last-seen
 * `message.model` and the ordered effort runs. Never throws — malformed
 * lines are skipped, a missing/oversized file yields all-zero counts with
 * `model: null`. Dedupe (last line per `message.id` wins) lives in
 * `readTranscriptTurns`. Stays async because review telemetry awaits it.
 */
export async function sumTranscriptUsage(
  jsonlPath: string,
): Promise<TranscriptUsage> {
  const out: TranscriptUsage = {
    input: 0,
    cache_creation: 0,
    cache_read: 0,
    output: 0,
    total: 0,
    model: null,
    effortRuns: [],
  };
  const turns = readTranscriptTurns(jsonlPath);
  if (!turns) return out;
  for (const t of turns) {
    const input = num(t.usage.input_tokens);
    const cacheCreation = num(t.usage.cache_creation_input_tokens);
    const cacheRead = num(t.usage.cache_read_input_tokens);
    const output = num(t.usage.output_tokens);
    out.input += input;
    out.cache_creation += cacheCreation;
    out.cache_read += cacheRead;
    out.output += output;
    out.total += input + cacheCreation + cacheRead + output;
    if (t.model) out.model = t.model;
  }
  out.effortRuns = effortRunsOf(turns);
  return out;
}

/**
 * Records `value` as the line for message `id`, replacing any earlier line
 * with the same id (the last one carries the final usage) while keeping the
 * message's first-seen position. Id-less lines each count individually.
 * Callers pass only usage-bearing lines, so a usage-less last line never
 * erases an earlier one's usage.
 */
export function recordLastLine<T>(
  messages: Map<string, T>,
  id: unknown,
  value: T,
): void {
  const key = typeof id === "string" && id ? id : `\0line${messages.size}`;
  messages.set(key, value);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

type JsonlEvent = {
  type?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: unknown;
  };
};

function tryParse(line: string): JsonlEvent | null {
  try {
    return JSON.parse(line) as JsonlEvent;
  } catch {
    return null;
  }
}
