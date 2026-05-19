#!/usr/bin/env bun
/**
 * Per-agent static-analysis lens routing for /pr-review's six-agent fan-out.
 *
 * Why: skills/pipeline/pr-review/SKILL.md used to inline six adjacent `jq`
 * invocations — one per agent — that sliced `.flow-tmp/static-analysis.json`
 * into the per-agent `{{STATIC_ANALYSIS_FACTS}}` block. PR #183 added the
 * `dependencies` lens and updated the Security row inline, exposing the
 * drift surface: routing knowledge was duplicated between the producer
 * (flow-pr-static-analysis), the SKILL.md prose, and per-agent Process-step
 * references in agent-prompts.md. This helper owns the routing as a single
 * `Record<AgentName, readonly LensKey[]>` and produces byte-equivalent JSON
 * to the previous jq calls; bin/skill-md-lint.test.ts pins the SKILL.md
 * agent table's bold names against the map's keys so future drift fails
 * loudly.
 */

import type { AnalysisResult, Finding, LensMeta, LensName } from "./flow-pr-static-analysis/types";

export type AgentName =
  | "bug-detection"
  | "security"
  | "pattern-consistency"
  | "performance"
  | "supply-chain"
  | "test-coverage";

export const SYNTHETIC_SUPPLY_CHAIN: "synthetic-supply-chain" = "synthetic-supply-chain";

export type LensKey = LensName | typeof SYNTHETIC_SUPPLY_CHAIN;

export const AGENT_LENS_MAP: Record<AgentName, readonly LensKey[]> = {
  "bug-detection": ["types"],
  security: ["security", "dependencies"],
  "pattern-consistency": ["lint"],
  performance: ["lint"],
  "supply-chain": [SYNTHETIC_SUPPLY_CHAIN],
  "test-coverage": ["coverage"],
};

const AGENT_NAMES: readonly AgentName[] = Object.keys(AGENT_LENS_MAP) as AgentName[];

export type SyntheticSupplyChainMeta = {
  ran: false;
  skipped_reason: "no supply-chain pre-digest lens";
  duration_ms: 0;
};

export type RouteOutput =
  | { findings: Finding[]; meta: LensMeta }
  | { findings: Finding[]; meta: Record<LensName, LensMeta> }
  | { findings: Finding[]; meta: SyntheticSupplyChainMeta };

export function route(envelope: AnalysisResult, agent: AgentName): RouteOutput {
  const lenses = AGENT_LENS_MAP[agent];

  if (lenses.length === 1 && lenses[0] === SYNTHETIC_SUPPLY_CHAIN) {
    return {
      findings: [],
      meta: { ran: false, skipped_reason: "no supply-chain pre-digest lens", duration_ms: 0 },
    };
  }

  if (lenses.length === 1) {
    const lens = lenses[0] as LensName;
    return { findings: envelope[lens], meta: envelope.meta[lens] };
  }

  const findings: Finding[] = [];
  const meta: Record<string, LensMeta> = {};
  for (const lens of lenses as readonly LensName[]) {
    findings.push(...envelope[lens]);
    meta[lens] = envelope.meta[lens];
  }
  return { findings, meta: meta as Record<LensName, LensMeta> };
}

export type ParsedArgs = {
  agent?: AgentName;
  in?: string;
  help: boolean;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      out.help = true;
      continue;
    }
    if (flag === "--agent") {
      out.agent = argv[i + 1] as AgentName | undefined;
      i++;
      continue;
    }
    if (flag === "--in") {
      out.in = argv[i + 1];
      i++;
      continue;
    }
  }
  return out;
}

function isAgentName(value: string | undefined): value is AgentName {
  return value !== undefined && (AGENT_NAMES as readonly string[]).includes(value);
}

function usage(): string {
  return [
    "usage: flow-pr-agent-lens --agent <name> [--in <path|->]",
    "",
    "Routes .flow-tmp/static-analysis.json (or --in <path>, or stdin when --in -) ",
    "to a per-agent {findings, meta} JSON object on stdout.",
    "",
    "valid agents: " + AGENT_NAMES.join(", "),
    "",
    "default --in: .flow-tmp/static-analysis.json (relative to cwd)",
    "",
  ].join("\n");
}

async function readEnvelope(inPath: string | undefined): Promise<AnalysisResult> {
  const resolved = inPath ?? ".flow-tmp/static-analysis.json";
  if (resolved === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const fs = await import("node:fs");
  if (!fs.existsSync(resolved)) {
    throw new Error(`envelope file not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (!isAgentName(parsed.agent)) {
    const name = parsed.agent ?? "<missing>";
    process.stderr.write(`unknown agent: ${name}\nvalid agents: ${AGENT_NAMES.join(", ")}\n`);
    return 2;
  }
  let envelope: AnalysisResult;
  try {
    envelope = await readEnvelope(parsed.in);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`flow-pr-agent-lens: ${msg}\n`);
    return 2;
  }
  process.stdout.write(JSON.stringify(route(envelope, parsed.agent)));
  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
