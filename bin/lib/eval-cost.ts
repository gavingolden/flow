/**
 * Parse Claude Code stream-json output into USD cost + per-model token totals.
 *
 * Two sources of truth in the stream:
 *   - `assistant` events carry a `message.usage` block (input/output/cache tokens) and
 *     `message.model` so we can split tokens by model.
 *   - The terminal `result` event carries `total_cost_usd` — Claude Code's own
 *     billing total. Treat that as authoritative when present; use the price-map
 *     fallback only when the stream was truncated mid-run.
 *
 * Prices are an estimate captured 2026-Q2 (USD per million tokens). They go stale.
 * Source: https://www.anthropic.com/pricing — keep this comment in sync when bumping.
 */

import * as fs from "node:fs";

export type ModelTokens = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
};

export type CostResult = {
  /** USD; from result.total_cost_usd if present, else computed from price map. */
  usd: number;
  /** True when result.total_cost_usd was present and used. */
  authoritative: boolean;
  /** Aggregate tokens across every assistant event seen. */
  tokens: ModelTokens;
  /** Per-model token totals (model id → tokens). */
  perModel: Record<string, ModelTokens>;
};

type Price = {
  inputPerM: number;
  outputPerM: number;
  cacheCreationPerM: number;
  cacheReadPerM: number;
};

// 2026-Q2 estimates. Used only as a fallback when total_cost_usd is missing.
export const PRICE_MAP: Record<string, Price> = {
  "claude-opus-4-7": { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheReadPerM: 1.5 },
  "claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 },
  "claude-haiku-4-5": { inputPerM: 0.8, outputPerM: 4, cacheCreationPerM: 1, cacheReadPerM: 0.08 },
};

const ZERO_TOKENS: ModelTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

export function emptyCost(): CostResult {
  return { usd: 0, authoritative: false, tokens: { ...ZERO_TOKENS }, perModel: {} };
}

/** Parse a stream-json file at `path` and return cost + token totals. */
export function parseStreamJson(path: string): CostResult {
  const raw = fs.readFileSync(path, "utf8");
  return parseStreamJsonText(raw);
}

export function parseStreamJsonText(text: string): CostResult {
  const result = emptyCost();
  let resultUsd: number | undefined;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Tolerate partial lines from a truncated stream.
      continue;
    }
    if (!isObject(event)) continue;

    if (event.type === "result" && typeof event.total_cost_usd === "number") {
      resultUsd = event.total_cost_usd;
      continue;
    }
    if (event.type !== "assistant") continue;

    const message = event.message;
    if (!isObject(message)) continue;
    const usage = message.usage;
    if (!isObject(usage)) continue;
    const model = typeof message.model === "string" ? message.model : "unknown";

    const t: ModelTokens = {
      input: numberOr(usage.input_tokens, 0),
      output: numberOr(usage.output_tokens, 0),
      cacheCreation: numberOr(usage.cache_creation_input_tokens, 0),
      cacheRead: numberOr(usage.cache_read_input_tokens, 0),
    };

    addInto(result.tokens, t);
    if (!result.perModel[model]) result.perModel[model] = { ...ZERO_TOKENS };
    addInto(result.perModel[model], t);
  }

  if (resultUsd !== undefined) {
    result.usd = resultUsd;
    result.authoritative = true;
  } else {
    result.usd = computeUsd(result.perModel);
    result.authoritative = false;
  }
  return result;
}

/** USD computed from the price map; used when result.total_cost_usd is absent. */
export function computeUsd(perModel: Record<string, ModelTokens>): number {
  let usd = 0;
  for (const [model, tokens] of Object.entries(perModel)) {
    const price = PRICE_MAP[model];
    if (!price) continue;
    usd += (tokens.input * price.inputPerM) / 1_000_000;
    usd += (tokens.output * price.outputPerM) / 1_000_000;
    usd += (tokens.cacheCreation * price.cacheCreationPerM) / 1_000_000;
    usd += (tokens.cacheRead * price.cacheReadPerM) / 1_000_000;
  }
  return usd;
}

function addInto(target: ModelTokens, src: ModelTokens): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheCreation += src.cacheCreation;
  target.cacheRead += src.cacheRead;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Format USD with 4 decimal places — eval costs are typically sub-dollar. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}
