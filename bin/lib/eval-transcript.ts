/**
 * Parses a captured `claude -p ... --output-format stream-json --verbose`
 * transcript into events + the result envelope, and derives the metrics
 * `flow-eval`'s graders read via dotted `result.*`/`transcript.*` lookups.
 *
 * Tolerant by construction: `rate_limit_event`, `system/thinking_tokens`,
 * and any other unknown event type are kept in `events` (untyped) rather
 * than rejected, and an unparseable line increments `parseErrors` instead
 * of throwing — a captured transcript is real CLI output, not a
 * hand-authored fixture, and a future Claude Code release can add event
 * types this module has never seen.
 */

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type StreamEvent = {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: {
    role?: string;
    model?: string;
    usage?: Usage;
    content?: Array<{ type: string; name?: string }>;
  };
  [k: string]: unknown;
};

export type ResultEnvelope = {
  type: "result";
  subtype: string;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  duration_ms: number;
  session_id: string;
  usage: Usage;
  modelUsage: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUSD: number;
    }
  >;
  subagent_stats?: {
    spawned: number;
    max_depth: number;
    by_type?: Record<string, number>;
  };
  permission_denials: unknown[];
  structured_output?: unknown;
  result?: string;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isResultEnvelope(v: unknown): v is ResultEnvelope {
  return isPlainObject(v) && v.type === "result";
}

export function parseStream(text: string): {
  events: StreamEvent[];
  result: ResultEnvelope | null;
  parseErrors: number;
} {
  const events: StreamEvent[] = [];
  let result: ResultEnvelope | null = null;
  let parseErrors = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parseErrors++;
      continue;
    }
    if (!isPlainObject(parsed) || typeof parsed.type !== "string") {
      parseErrors++;
      continue;
    }
    const event = parsed as StreamEvent;
    events.push(event);
    if (isResultEnvelope(event)) {
      result = event;
    }
  }

  return { events, result, parseErrors };
}

export type TranscriptMetrics = {
  finalContextTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  assistantMessages: number;
  toolCalls: Record<string, number>;
  modelShare: Record<string, number>;
  subagentsSpawned: number;
  maxSubagentDepth: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  permissionDenials: number;
};

const MODEL_ALIASES = ["haiku", "sonnet", "opus", "fable"] as const;

/**
 * `modelShare[m]` = the fraction of total (input+output) tokens billed to
 * model `m`, PLUS an alias bucket (`haiku`/`sonnet`/`opus`/`fable`) whose
 * share is the sum of every canonical model id containing that substring —
 * `modelUsage` keys are dated canonical ids (e.g.
 * `claude-haiku-4-5-20251001`), and graders want to assert "mostly haiku"
 * without hardcoding a dated id that will drift.
 */
function computeModelShare(
  modelUsage: ResultEnvelope["modelUsage"] | undefined,
): Record<string, number> {
  const shares: Record<string, number> = {};
  if (!modelUsage) return shares;
  const totals: Record<string, number> = {};
  let grandTotal = 0;
  for (const [model, u] of Object.entries(modelUsage)) {
    const t = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    totals[model] = t;
    grandTotal += t;
  }
  if (grandTotal === 0) return shares;
  for (const [model, t] of Object.entries(totals)) {
    shares[model] = t / grandTotal;
  }
  for (const alias of MODEL_ALIASES) {
    let aliasTotal = 0;
    for (const [model, t] of Object.entries(totals)) {
      if (model.toLowerCase().includes(alias)) aliasTotal += t;
    }
    if (aliasTotal > 0) shares[alias] = aliasTotal / grandTotal;
  }
  return shares;
}

export function transcriptMetrics(
  events: StreamEvent[],
  result: ResultEnvelope | null,
): TranscriptMetrics {
  let finalContextTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let assistantMessages = 0;
  const toolCalls: Record<string, number> = {};

  // Top-level assistant events only — `parent_tool_use_id === null`.
  // Subagent turns stream through the same channel with a non-null
  // parent_tool_use_id, and finalContextTokens must describe the
  // supervisor's own context, not a spawned child's.
  let lastTopLevelAssistant: StreamEvent | null = null;

  for (const event of events) {
    if (event.type !== "assistant" || !event.message) continue;
    assistantMessages++;
    const usage = event.message.usage;
    if (usage) {
      totalInputTokens += usage.input_tokens ?? 0;
      totalOutputTokens += usage.output_tokens ?? 0;
    }
    for (const block of event.message.content ?? []) {
      if (block.type === "tool_use" && block.name) {
        toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
      }
    }
    if (
      event.parent_tool_use_id === null ||
      event.parent_tool_use_id === undefined
    ) {
      lastTopLevelAssistant = event;
    }
  }

  if (lastTopLevelAssistant?.message?.usage) {
    const u = lastTopLevelAssistant.message.usage;
    finalContextTokens =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
  }

  return {
    finalContextTokens,
    totalInputTokens,
    totalOutputTokens,
    assistantMessages,
    toolCalls,
    modelShare: computeModelShare(result?.modelUsage),
    subagentsSpawned: result?.subagent_stats?.spawned ?? 0,
    maxSubagentDepth: result?.subagent_stats?.max_depth ?? 0,
    costUsd: result?.total_cost_usd ?? 0,
    durationMs: result?.duration_ms ?? 0,
    numTurns: result?.num_turns ?? 0,
    permissionDenials: result?.permission_denials?.length ?? 0,
  };
}

/**
 * Resolves a dotted `result.*`/`transcript.*` path (e.g.
 * `transcript.toolCalls.Bash`, `result.total_cost_usd`) to a number.
 * Returns `undefined` when the source prefix is unrecognised or the path
 * does not resolve to a finite number — the caller (a `metric` grader)
 * treats that as "no value", never as `0`.
 */
export function metricSource(
  source: string,
  ctx: { result: ResultEnvelope | null; transcript: TranscriptMetrics },
): number | undefined {
  const parts = source.split(".");
  const [root, ...rest] = parts;
  let base: unknown;
  if (root === "result") base = ctx.result;
  else if (root === "transcript") base = ctx.transcript;
  else return undefined;

  let cur: unknown = base;
  for (const key of rest) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : undefined;
}

export type InitInfo = {
  claudeVersion?: string;
  model?: string;
  plugins: string[];
  agents: string[];
};

export function initInfo(events: StreamEvent[]): InitInfo {
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  if (!init) return { plugins: [], agents: [] };
  const plugins = Array.isArray(init.plugins)
    ? (init.plugins as unknown[])
        .map((p) =>
          isPlainObject(p) && typeof p.name === "string" ? p.name : undefined,
        )
        .filter((p): p is string => p !== undefined)
    : [];
  const agents = Array.isArray(init.agents)
    ? (init.agents as unknown[]).filter(
        (a): a is string => typeof a === "string",
      )
    : [];
  return {
    claudeVersion:
      typeof init.claude_code_version === "string"
        ? init.claude_code_version
        : undefined,
    model: typeof init.model === "string" ? init.model : undefined,
    plugins,
    agents,
  };
}
