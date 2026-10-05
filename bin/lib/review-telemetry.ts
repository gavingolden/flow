/**
 * Pure per-lens review telemetry aggregation: composes a ReviewTelemetry
 * object from the on-disk `agent-output-<lens>.json` / consolidator /
 * fix-applier artifacts plus the lens transcripts. A lens's `tokens` always
 * come from its subagent transcript (attributed via the sibling
 * `.meta.json`, summed over every in-window transcript); the `--lens-tokens`
 * figure from each Task completion notification's `<usage><subagent_tokens>`
 * is the lens's final context size, a different unit, so it is kept apart
 * as `context_tokens` and never written into `tokens`.
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
  tokens_source: "subagent-transcript" | "unavailable";
  context_tokens: number | null;
  findings_emitted: number;
  findings_survived: number;
  findings_dropped: number;
  findings_acted: number;
  findings_deferred: number;
};

export type ReviewTelemetry = {
  version: 3;
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

/**
 * Parses repeatable `<lens>=<alias>` flags into a per-lens model map.
 * Mirrors `parseLensTokens`'s shape and error handling — a malformed
 * pair (no `=`, empty lens name/value) is silently skipped rather than
 * throwing, since this is a best-effort telemetry annotation.
 */
export function parseLensModels(
  flags: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    if (eq <= 0) continue;
    const lens = flag.slice(0, eq);
    const value = flag.slice(eq + 1);
    if (!lens || !value) continue;
    out[lens] = value;
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

    const survived = Array.isArray(inputs.consolidator?.consolidated_findings)
      ? inputs.consolidator!.consolidated_findings.filter(
          (f) => (f as Record<string, unknown>).agent_source === lens,
        ).length
      : 0;
    const dropped = Array.isArray(inputs.consolidator?.dropped_by_validation)
      ? inputs.consolidator!.dropped_by_validation.filter(
          (d) =>
            typeof d?.finding_id === "string" &&
            d.finding_id.startsWith(`${lens}:`),
        ).length
      : 0;
    const acted = Array.isArray(inputs.fixApplier?.commits)
      ? inputs.fixApplier!.commits.filter(
          (c) =>
            typeof c?.finding_id === "string" &&
            c.finding_id.startsWith(`${lens}:`),
        ).length
      : 0;
    const deferred = Array.isArray(inputs.fixApplier?.deferred)
      ? inputs.fixApplier!.deferred.filter(
          (d) =>
            typeof d?.finding_id === "string" &&
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

export function lensFromMeta(meta: {
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
  until?: Date,
): Promise<Record<string, TranscriptEntry>> {
  const out: Record<string, TranscriptEntry> = {};
  let entries: string[];
  try {
    entries = fs.readdirSync(subagentsDir);
  } catch {
    return out;
  }

  const filesByLens = new Map<string, { file: string; mtime: number }[]>();

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
    if (until && stat.mtimeMs > until.getTime()) continue;
    const files = filesByLens.get(lens) ?? [];
    files.push({ file: jsonlPath, mtime: stat.mtimeMs });
    filesByLens.set(lens, files);
  }

  for (const [lens, files] of filesByLens) {
    const sums = await Promise.all(
      files.map((f) => sumTranscriptUsage(f.file)),
    );
    const usage = {
      total: 0,
      input: 0,
      cache_creation: 0,
      cache_read: 0,
      output: 0,
    };
    for (const sum of sums) {
      usage.total += sum.total;
      usage.input += sum.input;
      usage.cache_creation += sum.cache_creation;
      usage.cache_read += sum.cache_read;
      usage.output += sum.output;
    }
    let newest = 0;
    for (let i = 1; i < files.length; i++) {
      if (files[i].mtime > files[newest].mtime) newest = i;
    }
    out[lens] = { file: files[newest].file, usage, model: sums[newest].model };
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
  lensModels?: Record<string, string>;
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

    const transcript = args.transcripts[lens];
    const tokens: TokenUsage | null = transcript?.usage ?? null;
    const tokens_source: LensTelemetry["tokens_source"] = transcript
      ? "subagent-transcript"
      : "unavailable";
    // An explicit --lens-model value wins over the transcript's model.
    const model = args.lensModels?.[lens] ?? transcript?.model ?? null;

    lenses[lens] = {
      ran: counts.ran,
      skip_reason: counts.skip_reason,
      model,
      tokens,
      tokens_source,
      context_tokens: args.lensTokens[lens] ?? null,
      findings_emitted: counts.findings_emitted,
      findings_survived: counts.findings_survived,
      findings_dropped: counts.findings_dropped,
      findings_acted: counts.findings_acted,
      findings_deferred: counts.findings_deferred,
    };
  }

  return {
    version: 3,
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
