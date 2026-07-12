#!/usr/bin/env bun
/**
 * Attributes a pipeline's context/token spend to pipeline phase and to
 * tool-call class, from Claude Code session JSONL. Thin CLI over
 * bin/lib/transcript-audit.ts — all logic lives in the lib.
 *
 * Usage:
 *   flow-transcript-audit analyze [<jsonl-path>...] [--slug <slug>] [--repo <path>] [--format json|md]
 *   flow-transcript-audit --frontmatter <skills-dir> [--format json|md]
 *
 * `analyze` is the default mode — the literal `analyze` token is optional.
 * Either pass explicit JSONL path(s) or `--slug` (+ optional `--repo`,
 * default `process.cwd()`) to resolve the matching session file(s).
 *
 * Exit codes:
 *   0 — success (data printed)
 *   2 — bad CLI args (usage error, printed to stderr)
 *   3 — no-data: valid schema, nothing matched
 *   4 — schema-break: the transcript no longer matches the expected JSONL
 *       shape; this tool needs a feature update to support it (reason on
 *       stderr) — kept distinct from 3 so a caller can tell "empty input"
 *       apart from "we can no longer trust these numbers"
 */

import {
  analyzeTranscripts,
  estimateFrontmatterCost,
  resolveSessionJsonls,
  type AnalyzeOk,
  type FrontmatterEstimate,
} from "./lib/transcript-audit";

type Format = "json" | "md";

type ParsedArgs =
  | { mode: "frontmatter"; dir: string; format: Format }
  | {
      mode: "analyze";
      jsonlPaths: string[];
      slug?: string;
      repo?: string;
      format: Format;
    }
  | { error: string };

const USAGE =
  "usage: flow-transcript-audit [analyze] [<jsonl-path>...] [--slug <slug>] [--repo <path>] [--format json|md]\n" +
  "       flow-transcript-audit --frontmatter <skills-dir> [--format json|md]";

export function parseArgs(argv: string[]): ParsedArgs {
  let format: Format = "json";
  const rest: string[] = [];
  let frontmatterDir: string | undefined;
  let slug: string | undefined;
  let repo: string | undefined;
  const jsonlPaths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--format": {
        const value = argv[++i];
        if (value !== "json" && value !== "md") {
          return { error: `--format must be 'json' or 'md', got '${value}'` };
        }
        format = value;
        continue;
      }
      case "--frontmatter": {
        const value = argv[++i];
        if (!value)
          return { error: "--frontmatter requires a directory argument" };
        frontmatterDir = value;
        continue;
      }
      case "--slug": {
        const value = argv[++i];
        if (!value) return { error: "--slug requires a value" };
        slug = value;
        continue;
      }
      case "--repo": {
        const value = argv[++i];
        if (!value) return { error: "--repo requires a value" };
        repo = value;
        continue;
      }
      case "analyze":
        continue;
      default:
        rest.push(arg);
    }
  }

  if (frontmatterDir !== undefined) {
    if (rest.length > 0)
      return {
        error: `unexpected argument(s) with --frontmatter: ${rest.join(" ")}`,
      };
    return { mode: "frontmatter", dir: frontmatterDir, format };
  }

  jsonlPaths.push(...rest);
  if (jsonlPaths.length === 0 && slug === undefined) {
    return { error: "provide at least one JSONL path or --slug <slug>" };
  }
  return { mode: "analyze", jsonlPaths, slug, repo, format };
}

function renderAnalyzeMd(result: AnalyzeOk): string {
  const lines: string[] = [];
  lines.push(
    "## Phase totals (strict — unattributed is first-class, never carried forward)",
  );
  lines.push("| phase | input | output | cacheCreation | cacheRead |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const [phase, u] of Object.entries(result.phaseTotals)) {
    lines.push(
      `| ${phase} | ${u.input} | ${u.output} | ${u.cacheCreation} | ${u.cacheRead} |`,
    );
  }
  lines.push("");
  lines.push(
    "## Phase totals (carry-forward, secondary — null attribution inherits the prior phase)",
  );
  lines.push("| phase | input | output | cacheCreation | cacheRead |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const [phase, u] of Object.entries(result.carryForwardTotals)) {
    lines.push(
      `| ${phase} | ${u.input} | ${u.output} | ${u.cacheCreation} | ${u.cacheRead} |`,
    );
  }
  lines.push("");
  lines.push(
    "## Tool-class stats (payloadChars is a byte-size proxy, not a token count)",
  );
  lines.push("| class | count | payloadChars |");
  lines.push("| --- | --- | --- |");
  for (const [cls, s] of Object.entries(result.toolClassStats)) {
    lines.push(`| ${cls} | ${s.count} | ${s.payloadChars} |`);
  }
  lines.push("");
  lines.push("## Sub-agent spend");
  lines.push(
    `completed: ${result.subAgentSpend.completedCount} (totalTokens: ${result.subAgentSpend.totalTokens}), pending-async (spend unknown): ${result.subAgentSpend.pendingAsyncCount}`,
  );
  lines.push("");
  lines.push(
    "## In-process edit-size distribution (added+removed lines per Edit/Write)",
  );
  const d = result.editSizeDistribution;
  lines.push(
    `count: ${d.count}, min: ${d.min}, median: ${d.median}, max: ${d.max}, p50: ${d.p50}, p90: ${d.p90}, p99: ${d.p99}`,
  );
  return lines.join("\n");
}

function renderFrontmatterMd(result: FrontmatterEstimate): string {
  const lines: string[] = [];
  lines.push(
    `## Frontmatter cost estimate (~${result.charsPerToken} chars/token — a floor, not a point estimate)`,
  );
  lines.push("| skill | estimated tokens |");
  lines.push("| --- | --- |");
  for (const [skill, tokens] of Object.entries(result.perSkill).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| ${skill} | ${tokens} |`);
  }
  lines.push("");
  lines.push(`**Total: ${result.total} estimated tokens**`);
  return lines.join("\n");
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-transcript-audit: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }

  if (parsed.mode === "frontmatter") {
    const result = await estimateFrontmatterCost(parsed.dir);
    process.stdout.write(
      (parsed.format === "md"
        ? renderFrontmatterMd(result)
        : JSON.stringify(result, null, 2)) + "\n",
    );
    return 0;
  }

  let jsonlPaths = parsed.jsonlPaths;
  if (jsonlPaths.length === 0 && parsed.slug) {
    jsonlPaths = await resolveSessionJsonls(
      parsed.slug,
      parsed.repo ?? process.cwd(),
    );
  }

  const result = await analyzeTranscripts(jsonlPaths);

  if (result.status === "schema-break") {
    process.stderr.write(
      `flow-transcript-audit: transcript schema is unrecognized or has changed — this tool needs a feature update to support it.\nDetail: ${result.reason}\n`,
    );
    return 4;
  }
  if (result.status === "no-data") {
    process.stderr.write(
      "flow-transcript-audit: no matching data found (valid schema, nothing to report)\n",
    );
    return 3;
  }

  process.stdout.write(
    (parsed.format === "md"
      ? renderAnalyzeMd(result)
      : JSON.stringify(result, null, 2)) + "\n",
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
