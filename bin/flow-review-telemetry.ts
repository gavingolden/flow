#!/usr/bin/env bun
/**
 * CLI over bin/lib/review-telemetry.ts. `collect` writes the per-PR
 * `review-telemetry.json` artifact (and optionally appends one idempotent
 * JSONL line to the cross-pipeline log); `print` renders the markdown
 * table Step 12 pastes into the review report. No `report` sub-command —
 * cut from v1 on both cross-model reviewers' independent advice; the
 * JSONL is `jq`-readable and #733 designs the aggregate around real data.
 *
 * Usage:
 *   flow-review-telemetry collect --worktree <dir> --pr <n>
 *     [--lens-tokens <lens>=<n> ...] [--session-id <id>] [--out <path>]
 *     [--append] [--jsonl <path>] [--widened <reason>]
 *   flow-review-telemetry print --in <path>
 *
 * Exit codes: 0 graceful (including every degraded-artifact case), 2 bad args.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  aggregateCounts,
  attributeTranscripts,
  findSubagentsDir,
  mergeTelemetry,
  parseLensTokens,
  type ReviewTelemetry,
} from "./lib/review-telemetry";
import { ALL_LENS_NAMES, type ConsolidatorResult } from "./lib/agent-finding-schema";
import type { FixApplierResult } from "./lib/fix-applier-schema";

export type Deps = {
  readFile: (p: string) => string | null;
  writeFile: (p: string, content: string) => void;
  appendFile: (p: string, content: string) => void;
  mkdir: (p: string) => void;
  git: (args: string[], cwd: string) => { stdout: string; exitCode: number };
  env: Record<string, string | undefined>;
  now: () => Date;
  homeDir: string;
  stdout: (s: string) => void;
};

const defaultDeps: Deps = {
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  },
  appendFile: (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, content);
  },
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  git: (args, cwd) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return { stdout: r.stdout.toString(), exitCode: r.exitCode ?? 1 };
  },
  env: process.env,
  now: () => new Date(),
  homeDir: os.homedir(),
  stdout: (s) => process.stdout.write(s),
};

// --- arg parsing ---

export type CollectArgs = {
  sub: "collect";
  worktree: string;
  pr: number;
  lensTokens: string[];
  sessionId?: string;
  out?: string;
  append: boolean;
  jsonl?: string;
  widened?: string;
};

export type PrintArgs = { sub: "print"; in: string };

export type ParsedArgs = CollectArgs | PrintArgs | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const [sub, ...rest] = argv;
  if (sub === "print") {
    let inPath: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--in") {
        inPath = rest[i + 1];
        i++;
      } else {
        return { error: `unknown flag: ${rest[i]}` };
      }
    }
    if (!inPath) return { error: "--in is required" };
    return { sub: "print", in: inPath };
  }
  if (sub === "collect") {
    let worktree: string | undefined;
    let pr: number | undefined;
    const lensTokens: string[] = [];
    let sessionId: string | undefined;
    let out: string | undefined;
    let append = false;
    let jsonl: string | undefined;
    let widened: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === "--append") {
        append = true;
        continue;
      }
      const value = rest[i + 1];
      switch (flag) {
        case "--worktree":
          worktree = value;
          i++;
          break;
        case "--pr": {
          const n = value !== undefined ? Number.parseInt(value, 10) : NaN;
          if (Number.isNaN(n)) return { error: `invalid --pr value: ${value}` };
          pr = n;
          i++;
          break;
        }
        case "--lens-tokens":
          if (value !== undefined) lensTokens.push(value);
          i++;
          break;
        case "--session-id":
          sessionId = value;
          i++;
          break;
        case "--out":
          out = value;
          i++;
          break;
        case "--jsonl":
          jsonl = value;
          i++;
          break;
        case "--widened":
          widened = value;
          i++;
          break;
        default:
          return { error: `unknown flag: ${flag}` };
      }
    }
    if (!worktree) return { error: "--worktree is required" };
    if (pr === undefined) return { error: "--pr is required" };
    return { sub: "collect", worktree, pr, lensTokens, sessionId, out, append, jsonl, widened };
  }
  return { error: "subcommand is required (collect | print)" };
}

// --- collect ---

function safeParse<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function runCollect(args: CollectArgs, deps: Deps): Promise<number> {
  const scopePath = path.join(args.worktree, ".flow-tmp", "review-scope.json");
  const scopeRaw = safeParse<{
    scope: "full" | "delta";
    base_sha: string | null;
    head_sha: string;
    delta_files: string[];
    delta_ratio: number | null;
    started_at: string;
  }>(deps.readFile(scopePath));

  let scope: {
    scope: "full" | "delta";
    base_sha: string | null;
    head_sha: string;
    delta_files: string[];
    delta_ratio: number | null;
  };
  let startedAt: string;
  if (scopeRaw) {
    scope = scopeRaw;
    startedAt = scopeRaw.started_at;
  } else {
    const headResult = deps.git(["rev-parse", "HEAD"], args.worktree);
    const headSha = headResult.exitCode === 0 ? headResult.stdout.trim() : "unknown";
    startedAt = deps.now().toISOString();
    scope = { scope: "full", base_sha: null, head_sha: headSha, delta_files: [], delta_ratio: null };
  }

  const agentOutputs: Record<string, unknown | null> = {};
  for (const lens of ALL_LENS_NAMES) {
    agentOutputs[lens] = safeParse(
      deps.readFile(path.join(args.worktree, ".flow-tmp", `agent-output-${lens}.json`)),
    );
  }

  const consolidator = safeParse<ConsolidatorResult>(
    deps.readFile(path.join(args.worktree, ".flow-tmp", "consolidator-result.json")),
  );
  const fixApplier = safeParse<FixApplierResult>(
    deps.readFile(path.join(args.worktree, ".flow-tmp", "fix-applier-result.json")),
  );

  let repo: string;
  const remoteResult = deps.git(["remote", "get-url", "origin"], args.worktree);
  if (remoteResult.exitCode === 0 && remoteResult.stdout.trim()) {
    repo = remoteResult.stdout.trim();
  } else {
    repo = path.basename(args.worktree);
  }

  let slug: string | null = null;
  const flowSlug = deps.env.FLOW_SLUG;
  if (flowSlug) {
    const state = safeParse<{ repo?: string; slug?: string }>(
      deps.readFile(path.join(deps.homeDir, ".flow", "state", `${flowSlug}.json`)),
    );
    if (state) {
      slug = state.slug ?? flowSlug;
      if (state.repo) repo = state.repo;
    } else {
      slug = flowSlug;
    }
  }

  const sessionId = args.sessionId ?? deps.env.CLAUDE_CODE_SESSION_ID ?? null;

  let transcripts: Record<string, { usage: { total: number }; model: string | null }> = {};
  if (sessionId) {
    const subagentsDir = findSubagentsDir(sessionId);
    if (subagentsDir) {
      const since = startedAt ? new Date(startedAt) : new Date(0);
      transcripts = await attributeTranscripts(subagentsDir, since);
    }
  }

  const lensTokens = parseLensTokens(args.lensTokens);
  const counts = aggregateCounts({ agentOutputs, consolidator, fixApplier });

  const telemetry = mergeTelemetry({
    pr: args.pr,
    repo,
    slug,
    sessionId,
    scope,
    widened: { value: !!args.widened, reason: args.widened ?? null },
    counts,
    lensTokens,
    transcripts,
    startedAt,
  });

  const outPath = args.out ?? path.join(args.worktree, ".flow-tmp", "review-telemetry.json");
  deps.writeFile(outPath, JSON.stringify(telemetry));

  if (args.append) {
    const jsonlPath = args.jsonl ?? path.join(deps.homeDir, ".flow", "telemetry", "review-lenses.jsonl");
    deps.mkdir(path.dirname(jsonlPath));
    const existing = deps.readFile(jsonlPath) ?? "";
    const alreadyPresent = existing
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        const parsed = safeParse<{ run_id?: string }>(line);
        return parsed?.run_id === telemetry.run_id;
      });
    if (!alreadyPresent) {
      deps.appendFile(jsonlPath, `${JSON.stringify(telemetry)}\n`);
    }
  }

  return 0;
}

// --- print ---

export function renderTable(t: ReviewTelemetry): string {
  const lines: string[] = [];
  const widenedSuffix = t.widened.value ? `, widened: ${t.widened.reason}` : "";
  lines.push(`scope: ${t.scope.kind} (${t.scope.delta_files} files${widenedSuffix})`);
  lines.push("");
  lines.push("| Lens | Ran | Tokens | Emitted | Survived | Acted | Deferred | Skip reason |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  let unavailableCount = 0;
  for (const [lens, l] of Object.entries(t.lenses)) {
    const tokensStr = l.tokens !== null ? String(l.tokens.total) : "n/a";
    const skipReason = l.skip_reason ?? "";
    lines.push(
      `| ${lens} | ${l.ran ? "yes" : "no"} | ${tokensStr} | ${l.findings_emitted} | ${l.findings_survived} | ${l.findings_acted} | ${l.findings_deferred} | ${skipReason} |`,
    );
    if (l.ran && l.tokens_source === "unavailable") unavailableCount++;
  }
  if (unavailableCount > 0) {
    lines.push("");
    lines.push(`NOTICE — tokens-unavailable: ${unavailableCount} lenses`);
  }
  return lines.join("\n");
}

async function runPrint(args: PrintArgs, deps: Deps): Promise<number> {
  const raw = deps.readFile(args.in);
  const parsed = safeParse<ReviewTelemetry>(raw);
  if (!parsed) {
    deps.stdout("scope: unknown (0 files)\n\nno telemetry available\n");
    return 0;
  }
  deps.stdout(`${renderTable(parsed)}\n`);
  return 0;
}

export async function run(argv: string[], deps: Deps = defaultDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-review-telemetry: ${parsed.error}\n`);
    return 2;
  }
  if (parsed.sub === "collect") return runCollect(parsed, deps);
  return runPrint(parsed, deps);
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
