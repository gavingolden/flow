/**
 * Per-pipeline $ spend, derived from Claude Code's per-session JSONL.
 *
 * Pipeline → JSONL match: `flow new <description>` slugifies the
 * description and seeds the supervisor with the literal prompt
 * `Use the /flow-pipeline skill for: <description>`. We scan
 * `~/.claude/projects/<encoded-cwd>/` for the supervisor's starting
 * cwd (state.repo) and pick the JSONL whose first user-message
 * extracts back to the same slug. Each pipeline's seed is unique by
 * construction (slugs are unique window names), so concurrent
 * pipelines don't alias.
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
  const jsonl = await findSessionJsonl(projectDir, state.slug);
  if (!jsonl) return EMPTY_COST;
  return await parseAndPrice(jsonl);
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

async function findSessionJsonl(projectDir: string, slug: string): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(projectDir, entry.name);
    if (await jsonlMatchesSlug(file, slug)) return file;
  }
  return null;
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

function tryParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
