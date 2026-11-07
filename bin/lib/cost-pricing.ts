/**
 * Anthropic list pricing in $/MTok: the single price table behind
 * `flow ls --cost`, the run-attribution row and review telemetry.
 *
 * Last verified: 2026-11-06 against the claude-api skill bundled with Claude
 * Code 2.1.317 (shared/models.md + shared/prompt-caching.md +
 * shared/model-migration.md): claude-opus-5, claude-opus-5-5,
 * claude-sonnet-5, claude-sonnet-5-5, claude-fable-5, claude-fable-5-1 and
 * claude-haiku-4-5. The claude-opus-4-7 and claude-sonnet-4-6 rows predate
 * the 5.x line and were not re-verified. claude-haiku-5-5 is deliberately
 * absent: its price depends on prompt size (a flat table cannot express it),
 * so it stays listed as an unpriced model rather than a wrong figure.
 *
 * Each entry has the five rate buckets of Claude Code's session JSONL
 * `usage` shape: input, 5-minute cache write, 1-hour cache write
 * (`usage.cache_creation.ephemeral_1h_input_tokens`), cache read, output.
 * docs/eval/token-spend-audit.ts keeps its own copy (it must run on any
 * checkout); a test in cost.test.ts fails when the two tables disagree.
 */

export type ModelPricing = {
  friendlyName: string;
  input: number;
  cacheCreation: number;
  cacheCreation1h: number;
  cacheRead: number;
  output: number;
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": {
    friendlyName: "Opus 5",
    input: 5,
    cacheCreation: 6.25,
    cacheCreation1h: 10,
    cacheRead: 0.5,
    output: 25,
  },
  "claude-opus-5-5": {
    friendlyName: "Opus 5.5",
    input: 4,
    cacheCreation: 5,
    cacheCreation1h: 8,
    cacheRead: 0.2,
    output: 20,
  },
  "claude-sonnet-5": {
    friendlyName: "Sonnet 5",
    input: 2,
    cacheCreation: 2.5,
    cacheCreation1h: 4,
    cacheRead: 0.2,
    output: 10,
  },
  "claude-sonnet-5-5": {
    friendlyName: "Sonnet 5.5",
    input: 2,
    cacheCreation: 2.5,
    cacheCreation1h: 4,
    cacheRead: 0.2,
    output: 10,
  },
  "claude-fable-5": {
    friendlyName: "Fable 5",
    input: 10,
    cacheCreation: 12.5,
    cacheCreation1h: 20,
    cacheRead: 1,
    output: 50,
  },
  "claude-fable-5-1": {
    friendlyName: "Fable 5.1",
    input: 10,
    cacheCreation: 12.5,
    cacheCreation1h: 20,
    cacheRead: 0.25,
    output: 50,
  },
  "claude-opus-4-7": {
    friendlyName: "Opus 4.7",
    input: 15,
    cacheCreation: 18.75,
    cacheCreation1h: 30,
    cacheRead: 1.5,
    output: 75,
  },
  "claude-sonnet-4-6": {
    friendlyName: "Sonnet 4.6",
    input: 3,
    cacheCreation: 3.75,
    cacheCreation1h: 6,
    cacheRead: 0.3,
    output: 15,
  },
  "claude-haiku-4-5-20251001": {
    friendlyName: "Haiku 4.5",
    input: 1,
    cacheCreation: 1.25,
    cacheCreation1h: 2,
    cacheRead: 0.1,
    output: 5,
  },
};

/** Exact id first, then the id with a trailing `-YYYYMMDD` date stripped. */
export function lookupModelPricing(modelId: string): ModelPricing | null {
  const exact = MODEL_PRICING[modelId];
  if (exact) return exact;
  const stripped = modelId.replace(/-\d{8}$/, "");
  return stripped !== modelId ? (MODEL_PRICING[stripped] ?? null) : null;
}

export function friendlyName(modelId: string): string {
  return lookupModelPricing(modelId)?.friendlyName ?? modelId;
}

/**
 * Dollar cost of one usage block. Cache writes are split into the 5-minute
 * and 1-hour buckets when `usage.cache_creation` carries them; otherwise all
 * `cache_creation_input_tokens` are priced at the 5-minute rate.
 */
export function priceUsage(usage: unknown, p: ModelPricing): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const split = u.cache_creation;
  let write5m = num(u.cache_creation_input_tokens);
  let write1h = 0;
  if (split && typeof split === "object") {
    const s = split as Record<string, unknown>;
    const has5m = s.ephemeral_5m_input_tokens !== undefined;
    const has1h = s.ephemeral_1h_input_tokens !== undefined;
    if (has5m || has1h) {
      write5m = num(s.ephemeral_5m_input_tokens);
      write1h = num(s.ephemeral_1h_input_tokens);
    }
  }
  return (
    (num(u.input_tokens) * p.input +
      write5m * p.cacheCreation +
      write1h * p.cacheCreation1h +
      num(u.cache_read_input_tokens) * p.cacheRead +
      num(u.output_tokens) * p.output) /
    1_000_000
  );
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
