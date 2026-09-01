/**
 * Pure per-lens review telemetry aggregation: composes a ReviewTelemetry
 * object from the on-disk `agent-output-<lens>.json` / consolidator /
 * fix-applier artifacts plus a token-usage source (primary: the
 * `--lens-tokens` figures sourced from each Task completion
 * notification's `<usage><subagent_tokens>`; fallback: subagent
 * transcript usage, attributed via the sibling `.meta.json`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sumTranscriptUsage, defaultProjectsRoot } from "./cost";
import {
  ALL_LENS_NAMES,
  type ConsolidatorResult,
} from "./agent-finding-schema";
import type { FixApplierResult } from "./fix-applier-schema";

export type TokenUsage = {
  total: number;
  input?: number;
  cache_creation?: number;
  cache_read?: number;
  output?: number;
};

export type LensTelemetry = {
  ran: boolean;
  skip_reason: string | null;
  model: string | null;
  tokens: TokenUsage | null;
  tokens_source: "task-notification" | "subagent-transcript" | "unavailable";
  findings_emitted: number;
  findings_survived: number;
  findings_dropped: number;
  findings_acted: number;
  findings_deferred: number;
};

export type ReviewTelemetry = {
  version: 1;
  run_id: string;
  ts: string;
  repo: string;
  slug: string | null;
  pr: number;
  session_id: string | null;
  scope: {
    kind: "full" | "delta";
    base_sha: string | null;
    head_sha: string;
    delta_files: number;
    delta_ratio: number | null;
  };
  widened: { value: boolean; reason: string | null };
  lenses: Record<string, LensTelemetry>;
};

export function parseLensTokens(
  flags: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    if (eq <= 0) continue;
    const lens = flag.slice(0, eq);
    const value = Number(flag.slice(eq + 1));
    if (!lens || !Number.isFinite(value)) continue;
    out[lens] = (out[lens] ?? 0) + value;
  }
  return out;
}

type CountsEntry = Pick<
  LensTelemetry,
  | "findings_emitted"
  | "findings_survived"
  | "findings_dropped"
  | "findings_acted"
  | "findings_deferred"
  | "ran"
  | "skip_reason"
>;

function isGated(v: unknown): v is { gated: { reason: string } } {
  return (
    typeof v === "object" &&
    v !== null &&
    "gated" in v &&
    typeof (v as Record<string, unknown>).gated === "object" &&
    (v as Record<string, unknown>).gated !== null
  );
}

export function aggregateCounts(inputs: {
  agentOutputs: Record<string, unknown | null>;
  consolidator: ConsolidatorResult | null;
  fixApplier: FixApplierResult | null;
}): Record<string, CountsEntry> {
  const out: Record<string, CountsEntry> = {};

  for (const [lens, output] of Object.entries(inputs.agentOutputs)) {
    let ran = true;
    let skip_reason: string | null = null;
    let findings_emitted = 0;

    if (output === null || output === undefined) {
      ran = false;
      skip_reason = "no artifact";
    } else if (isGated(output)) {
      ran = false;
      skip_reason = output.gated.reason;
    } else if (
      typeof output === "object" &&
      Array.isArray((output as Record<string, unknown>).findings)
    ) {
      findings_emitted = (
        (output as Record<string, unknown>).findings as unknown[]
      ).length;
    }

    const survived = inputs.consolidator
      ? inputs.consolidator.consolidated_findings.filter(
          (f) => (f as Record<string, unknown>).agent_source === lens,
        ).length
      : 0;
    const dropped = inputs.consolidator
      ? inputs.consolidator.dropped_by_validation.filter((d) =>
          d.finding_id.startsWith(`${lens}:`),
        ).length
      : 0;
    const acted = inputs.fixApplier
      ? inputs.fixApplier.commits.filter((c) =>
          c.finding_id.startsWith(`${lens}:`),
        ).length
      : 0;
    const deferred = inputs.fixApplier
      ? inputs.fixApplier.deferred.filter((d) =>
          d.finding_id.startsWith(`${lens}:`),
        ).length
      : 0;

    out[lens] = {
      ran,
      skip_reason,
      findings_emitted,
      findings_survived: survived,
      findings_dropped: dropped,
      findings_acted: acted,
      findings_deferred: deferred,
    };
  }

  return out;
}

type TranscriptEntry = {
  file: string;
  usage: TokenUsage;
  model: string | null;
};

function lensFromMeta(meta: {
  agentType?: unknown;
  description?: unknown;
}): string | null {
  if (typeof meta.agentType === "string") {
    const m = /flow-review-([a-z-]+)$/.exec(meta.agentType);
    if (m) return m[1];
  }
  if (typeof meta.description === "string") {
    const m = /^review lens:\s*([a-z-]+)$/.exec(meta.description.trim());
    if (m) return m[1];
  }
  return null;
}

export async function attributeTranscripts(
  subagentsDir: string,
  since: Date,
): Promise<Record<string, TranscriptEntry>> {
  const out: Record<string, TranscriptEntry> = {};
  let entries: string[];
  try {
    entries = fs.readdirSync(subagentsDir);
  } catch {
    return out;
  }

  const newestByLens = new Map<string, { file: string; mtime: number }>();

  for (const name of entries) {
    if (!name.endsWith(".meta.json")) continue;
    const metaPath = path.join(subagentsDir, name);
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      continue;
    }
    const lens = lensFromMeta(meta);
    if (!lens) continue;
    const jsonlName = name.replace(/\.meta\.json$/, ".jsonl");
    const jsonlPath = path.join(subagentsDir, jsonlName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(jsonlPath);
    } catch {
      continue;
    }
    if (stat.mtimeMs < since.getTime()) continue;
    const existing = newestByLens.get(lens);
    if (!existing || stat.mtimeMs > existing.mtime) {
      newestByLens.set(lens, { file: jsonlPath, mtime: stat.mtimeMs });
    }
  }

  for (const [lens, { file }] of newestByLens) {
    const usage = await sumTranscriptUsage(file);
    out[lens] = {
      file,
      usage: {
        total: usage.total,
        input: usage.input,
        cache_creation: usage.cache_creation,
        cache_read: usage.cache_read,
        output: usage.output,
      },
      model: usage.model,
    };
  }

  return out;
}

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

export function mergeTelemetry(args: {
  pr: number;
  repo: string;
  slug: string | null;
  sessionId: string | null;
  scope: {
    scope: "full" | "delta";
    base_sha: string | null;
    head_sha: string;
    delta_files: string[];
    delta_ratio: number | null;
  };
  widened: { value: boolean; reason: string | null };
  counts: Record<string, CountsEntry>;
  lensTokens: Record<string, number>;
  transcripts: Record<string, { usage: TokenUsage; model: string | null }>;
  startedAt: string;
}): ReviewTelemetry {
  const lenses: Record<string, LensTelemetry> = {};

  for (const lens of ALL_LENS_NAMES) {
    const counts = args.counts[lens] ?? {
      ran: false,
      skip_reason: "no artifact",
      findings_emitted: 0,
      findings_survived: 0,
      findings_dropped: 0,
      findings_acted: 0,
      findings_deferred: 0,
    };

    let tokens: TokenUsage | null = null;
    let tokens_source: LensTelemetry["tokens_source"] = "unavailable";
    let model: string | null = null;

    if (args.lensTokens[lens] !== undefined) {
      tokens = { total: args.lensTokens[lens] };
      tokens_source = "task-notification";
    } else if (args.transcripts[lens]) {
      tokens = args.transcripts[lens].usage;
      tokens_source = "subagent-transcript";
      model = args.transcripts[lens].model;
    }

    lenses[lens] = {
      ran: counts.ran,
      skip_reason: counts.skip_reason,
      model,
      tokens,
      tokens_source,
      findings_emitted: counts.findings_emitted,
      findings_survived: counts.findings_survived,
      findings_dropped: counts.findings_dropped,
      findings_acted: counts.findings_acted,
      findings_deferred: counts.findings_deferred,
    };
  }

  return {
    version: 1,
    run_id: `${args.pr}:${args.scope.head_sha}:${args.startedAt}`,
    ts: new Date().toISOString(),
    repo: args.repo,
    slug: args.slug,
    pr: args.pr,
    session_id: args.sessionId,
    scope: {
      kind: args.scope.scope,
      base_sha: args.scope.base_sha,
      head_sha: args.scope.head_sha,
      delta_files: args.scope.delta_files.length,
      delta_ratio: args.scope.delta_ratio,
    },
    widened: args.widened,
    lenses,
  };
}
