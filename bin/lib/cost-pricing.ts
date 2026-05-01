/**
 * Anthropic public model pricing in $/MTok.
 *
 * Last verified: 2026-05-01 — anthropic.com/pricing
 *
 * Each entry has the four rate buckets that match Claude Code's session
 * JSONL `usage` shape: input, cache_creation_input_tokens,
 * cache_read_input_tokens, output. Cache-creation tokens here are
 * priced at the 5m-ephemeral rate (the JSONL splits 5m vs 1h, but the
 * 1h rate is rare in practice and the difference is small enough to
 * defer until cost reporting actually surfaces a discrepancy).
 */

export type ModelPricing = {
  friendlyName: string;
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7": {
    friendlyName: "Opus 4.7",
    input: 15,
    cacheCreation: 18.75,
    cacheRead: 1.5,
    output: 75,
  },
  "claude-sonnet-4-6": {
    friendlyName: "Sonnet 4.6",
    input: 3,
    cacheCreation: 3.75,
    cacheRead: 0.3,
    output: 15,
  },
  "claude-haiku-4-5-20251001": {
    friendlyName: "Haiku 4.5",
    input: 1,
    cacheCreation: 1.25,
    cacheRead: 0.1,
    output: 5,
  },
};

export function friendlyName(modelId: string): string {
  return MODEL_PRICING[modelId]?.friendlyName ?? modelId;
}
