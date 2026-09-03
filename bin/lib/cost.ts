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
import { MODEL_PRICING, type ModelPricing } from "./cost-pricing";
import { slugify } from "./slug";
import type { PipelineState } from "./state";

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

export async function computeCost(
  state: PipelineState,
  projectsRoot = defaultProjectsRoot(),
): Promise<CostBreakdown> {
  const projectDir = path.join(projectsRoot, encodeProjectSegment(state.repo));
  const jsonls = await findSessionJsonls(projectDir, state.slug);
  if (jsonls.length === 0) return EMPTY_COST;
  const partials = await Promise.all(jsonls.map(parseAndPrice));
  return mergeBreakdowns(partials);
}

export function defaultProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Claude Code's project-dir encoding: replace every `/` in the absolute
 * cwd with `-`. The leading slash becomes a leading `-` for free.
 */
export function encodeProjectSegment(absPath: string): string {
  return absPath.replace(/\//g, "-");
}

export async function findSessionJsonls(
  projectDir: string,
  slug: string,
): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(projectDir, e.name));
  const matches = await Promise.all(
    candidates.map(async (file) =>
      (await jsonlMatchesSlug(file, slug)) ? file : null,
    ),
  );
  return matches.filter((f): f is string => f !== null);
}

async function jsonlMatchesSlug(file: string, slug: string): Promise<boolean> {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream });
  try {
    for await (const line of rl) {
      if (!line) continue;
      const event = tryParse(line);
      if (!event || event.type !== "user") continue;
      const content = event.message?.content;
      if (typeof content !== "string") continue;
      return seedMatchesSlug(content, slug);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return false;
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

async function parseAndPrice(jsonl: string): Promise<CostBreakdown> {
  const stream = fs.createReadStream(jsonl);
  const rl = readline.createInterface({ input: stream });
  const byModel: Record<string, number> = {};
  const unknown = new Set<string>();
  let total = 0;
  for await (const line of rl) {
    if (!line) continue;
    const event = tryParse(line);
    if (!event || event.type !== "assistant") continue;
    const usage = event.message?.usage;
    if (!usage) continue;
    const model: string = event.message?.model ?? "";
    const pricing = MODEL_PRICING[model];
    if (!pricing) {
      if (model) unknown.add(model);
      continue;
    }
    const cost = priceUsage(usage, pricing);
    if (cost === 0) continue;
    byModel[model] = (byModel[model] ?? 0) + cost;
    total += cost;
  }
  return {
    total,
    byModel,
    unknownModels: [...unknown].sort(),
    hasData: true,
  };
}

function mergeBreakdowns(parts: CostBreakdown[]): CostBreakdown {
  const byModel: Record<string, number> = {};
  const unknown = new Set<string>();
  let total = 0;
  let hasData = false;
  for (const part of parts) {
    if (part.hasData) hasData = true;
    total += part.total;
    for (const [model, dollars] of Object.entries(part.byModel)) {
      byModel[model] = (byModel[model] ?? 0) + dollars;
    }
    for (const m of part.unknownModels) unknown.add(m);
  }
  return {
    total,
    byModel,
    unknownModels: [...unknown].sort(),
    hasData,
  };
}

export type TranscriptUsage = {
  input: number;
  cache_creation: number;
  cache_read: number;
  output: number;
  total: number;
  model: string | null;
};

/**
 * Reusable transcript-usage summer for a single JSONL: sums every
 * assistant event's `message.usage` fields and tracks the last-seen
 * `message.model`. Never throws — malformed lines are skipped, a missing
 * file yields all-zero counts with `model: null`. Kept separate from
 * `parseAndPrice` (module-private, priced in dollars) rather than
 * refactored into it, so a review-telemetry consumer gets raw token
 * counts without perturbing `computeCost`'s existing $ output.
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
  };
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(jsonlPath);
  } catch {
    return out;
  }
  const rl = readline.createInterface({ input: stream });
  try {
    for await (const line of rl) {
      if (!line) continue;
      const event = tryParse(line);
      if (!event || event.type !== "assistant") continue;
      const usage = event.message?.usage;
      if (!usage || typeof usage !== "object") continue;
      const u = usage as Record<string, unknown>;
      const input = num(u.input_tokens);
      const cacheCreation = num(u.cache_creation_input_tokens);
      const cacheRead = num(u.cache_read_input_tokens);
      const output = num(u.output_tokens);
      out.input += input;
      out.cache_creation += cacheCreation;
      out.cache_read += cacheRead;
      out.output += output;
      out.total += input + cacheCreation + cacheRead + output;
      const model = event.message?.model;
      if (typeof model === "string" && model) out.model = model;
    }
  } catch {
    // stream error mid-read (e.g. ENOENT surfaced async) — return partial/zero
  } finally {
    rl.close();
    stream.destroy();
  }
  return out;
}

function priceUsage(usage: unknown, p: ModelPricing): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const input = num(u.input_tokens);
  const cacheCreation = num(u.cache_creation_input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const output = num(u.output_tokens);
  return (
    (input * p.input +
      cacheCreation * p.cacheCreation +
      cacheRead * p.cacheRead +
      output * p.output) /
    1_000_000
  );
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

type JsonlEvent = {
  type?: string;
  message?: {
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
