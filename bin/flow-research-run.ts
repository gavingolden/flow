#!/usr/bin/env bun
/**
 * Deterministic forced-research runner for `flow new --research`.
 *
 * WHY: `flow new --research` sets `forceResearch: true`, which is meant to
 * force discovery Step 1.5's web-grounded research pre-check ON. But that
 * pre-check lives inside the discovery sub-agent's own judgment, and it was
 * observed to skip the fan-out even on the forced path. This helper makes the
 * forced path deterministic: the supervisor (step 3) runs THIS binary before
 * `/product-planning`, so the gather+refute agy fan-out actually executes
 * regardless of the sub-agent's behaviour, and the findings are folded into
 * the discovery invocation as prior context.
 *
 * It does the model work the SAME way discovery does — via `flow-delegate-fanout`
 * (agy on the user's Google AI Ultra quota), NOT a nested Claude/Task call. It
 * is purely additive and never blocks planning: every failure path (agy down,
 * unreadable artifact, unexpected error) degrades to a graceful skip that
 * writes `{ran:false,reason:"agy-unavailable"}` and exits 0.
 *
 * Flow (mirrors bin/flow-gemini-lens.ts: build -> delegate -> branch on the
 * envelope's `ran`/`allSkipped` field NEVER the exit code -> write artifact ->
 * graceful skip on any failure -> exit 0 on every operational path):
 *  1. Read budget/model overrides from ~/.flow/config.json tolerantly, reusing
 *     discovery's frozen defaults (maxCalls 12, timeout "3m", gather
 *     "Gemini 3.1 Pro (High)", refute "Claude Opus 4.6 (Thinking)" with the
 *     cross-model diversity guard).
 *  2. Build a deterministic 2-entry manifest (gather + adversarial refute).
 *  3. Run `flow-delegate-fanout` (concurrency pinned at 4 — 2 entries are one
 *     wave, ~3m bounded).
 *  4. `allSkipped` (agy unavailable) -> status {ran:false,reason:"agy-unavailable"}.
 *  5. Otherwise read the per-entry agy artifacts, build a BOUNDED findings
 *     block, write it to --out, and status {ran:true,reason:"ran"}.
 *
 * Exit codes: 0 on every operational path (callers branch on the status file's
 * `ran`); 2 only on a usage error (missing required flag).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

// Frozen to match discovery Step 1.5's budget defaults and model-variant pins
// (skills/pipeline/product-planning/references/discovery-instructions.md, the
// `read_budget` block). Keep these byte-identical to that source of truth.
const DEFAULT_MAX_CALLS = 12;
const DEFAULT_TIMEOUT = "3m";
const DEFAULT_GATHER_MODEL = "Gemini 3.1 Pro (High)";
const DEFAULT_REFUTE_MODEL = "Claude Opus 4.6 (Thinking)";
const FALLBACK_REFUTE_MODEL = "GPT-OSS 120B (Medium)";

const GATHER_TASK = "research-gather";
const REFUTE_TASK = "research-refute";

const FINDINGS_HEADING = "## Research findings (web-grounded, forced)";
const MAX_FINDINGS_LINES = 80;
const MAX_FINDINGS_CHARS = 4000;

export type Args = {
  task: string;
  out: string;
  statusFile: string;
  config: string;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--task":
        out.task = value;
        break;
      case "--out":
        out.out = value;
        break;
      case "--status-file":
        out.statusFile = value;
        break;
      case "--config":
        out.config = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  const REQUIRED_FLAG = {
    task: "--task",
    out: "--out",
    statusFile: "--status-file",
  } as const;
  for (const k of ["task", "out", "statusFile"] as const) {
    if (out[k] === undefined)
      return { error: `${REQUIRED_FLAG[k]} is required` };
  }
  return {
    task: out.task as string,
    out: out.out as string,
    statusFile: out.statusFile as string,
    config: out.config ?? `${homedir()}/.flow/config.json`,
  };
}

// A manifest entry shaped for flow-delegate-fanout. Defined locally rather than
// imported so this helper does not couple to the fanout module's surface.
export type ResearchManifestEntry = {
  task: string;
  model: string;
  prompt: string;
  timeout: string;
};

// Tolerant read of `.research` from a parsed config; any non-object yields {}.
function readResearchObject(config: unknown): Record<string, unknown> {
  if (typeof config !== "object" || config === null) return {};
  const research = (config as Record<string, unknown>).research;
  if (typeof research !== "object" || research === null) return {};
  return research as Record<string, unknown>;
}

// Resolve the gather/refute models with the cross-model diversity guard: a
// collision (refute === gather) falls back to a DIFFERENT pinned variant —
// GPT-OSS when gather is Opus, else Opus — so the refute pass never runs on
// the same model family as gather. Tolerant: a missing/wrong-type override
// silently takes its default.
export function resolveModels(config: unknown): {
  gatherModel: string;
  refuteModel: string;
} {
  const research = readResearchObject(config);
  const gatherModel =
    typeof research.model === "string" && research.model.trim()
      ? research.model
      : DEFAULT_GATHER_MODEL;
  let refuteModel =
    typeof research.refuteModel === "string" && research.refuteModel.trim()
      ? research.refuteModel
      : DEFAULT_REFUTE_MODEL;
  if (refuteModel === gatherModel) {
    refuteModel =
      gatherModel === DEFAULT_REFUTE_MODEL
        ? FALLBACK_REFUTE_MODEL
        : DEFAULT_REFUTE_MODEL;
  }
  return { gatherModel, refuteModel };
}

function resolveMaxCalls(config: unknown): number {
  const research = readResearchObject(config);
  const v = research.maxCalls;
  return typeof v === "number" && Number.isInteger(v) && v > 0
    ? v
    : DEFAULT_MAX_CALLS;
}

function resolveTimeout(config: unknown): string {
  const research = readResearchObject(config);
  const v = research.timeout;
  return typeof v === "string" && v.trim() ? v : DEFAULT_TIMEOUT;
}

// The deterministic 2-entry manifest: a GATHER entry that frames the task as a
// web-grounded research question, and a REFUTE entry that adversarially
// cross-checks. Every entry carries its resolved model + timeout.
export function buildManifest(
  task: string,
  opts: { gatherModel: string; refuteModel: string; timeout: string },
): ResearchManifestEntry[] {
  return [
    {
      task: GATHER_TASK,
      model: opts.gatherModel,
      timeout: opts.timeout,
      prompt: `You have native web search. Research current best practices, standards, APIs, security/correctness constraints, or factual considerations relevant to implementing this software change: ${task}. Return concise, web-grounded findings WITH cited source URLs and an explicit confidence label (high/medium/low) per claim. If nothing external is genuinely relevant, say so briefly.`,
    },
    {
      task: REFUTE_TASK,
      model: opts.refuteModel,
      timeout: opts.timeout,
      prompt: `Critically assess and try to refute common or assumed claims about: ${task}. Flag anything uncertain, outdated, or context-dependent.`,
    },
  ];
}

export type FanoutAggregate = {
  entries?: Array<{
    task: string;
    ran?: boolean;
    artifactPath?: string;
    skipReason?: string;
  }>;
  anyRan?: boolean;
  allSkipped?: boolean;
};

// Branch on the fan-out's `allSkipped`/`anyRan` envelope fields, NEVER the exit
// code (flow-delegate-fanout exits 0 even on an all-skip run). An allSkipped or
// nothing-ran aggregate means agy is unavailable — degrade to a graceful skip.
export function interpretFanout(aggregate: FanoutAggregate): {
  ran: boolean;
  reason: string;
} {
  // Require explicit evidence of a real run: a normal fanout aggregate sets
  // allSkipped:false. allSkipped:true, a missing field, or a malformed/empty
  // envelope all degrade to agy-unavailable (research never blocks planning).
  if (
    aggregate &&
    aggregate.allSkipped === false &&
    aggregate.anyRan !== false
  ) {
    return { ran: true, reason: "ran" };
  }
  return { ran: false, reason: "agy-unavailable" };
}

function firstNonEmptyLine(text: string, cap = 300): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

// Build a BOUNDED markdown findings block: the gather output capped to ~80
// lines / ~4000 chars (truncation-marked when clipped), plus a one-line refute
// caveat summary. Bounded because this gets folded into the /product-planning
// invocation — raw multi-thousand-line agy output would blow the context.
export function boundFindings(gatherText: string, refuteText: string): string {
  let body = (gatherText ?? "").trim();
  let truncated = false;
  const lines = body.split("\n");
  if (lines.length > MAX_FINDINGS_LINES) {
    body = lines.slice(0, MAX_FINDINGS_LINES).join("\n");
    truncated = true;
  }
  if (body.length > MAX_FINDINGS_CHARS) {
    body = body.slice(0, MAX_FINDINGS_CHARS);
    truncated = true;
  }
  if (!body) body = "_No web-grounded findings were returned._";

  const refute = (refuteText ?? "").trim();
  const refuteCaveat = refute
    ? `_Adversarial cross-check (refute) caveat: ${firstNonEmptyLine(refute)}_`
    : "_Adversarial cross-check produced no caveats._";

  const parts = [FINDINGS_HEADING, "", body];
  if (truncated) {
    parts.push("", "_[research findings truncated for brevity]_");
  }
  parts.push("", refuteCaveat);
  return parts.join("\n");
}

export type FanoutRunner = (input: {
  manifestPath: string;
  maxCalls: number;
  timeout: string;
  outPath: string;
}) => FanoutAggregate;

export type Deps = {
  readConfig: (path: string) => string;
  runFanout: FanoutRunner;
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  removeFile: (path: string) => void;
  mkdirp: (dir: string) => void;
  writeOut: (line: string) => void;
  writeErr: (line: string) => void;
};

type Status = { active: boolean; ran: boolean; reason: string };

function writeStatus(deps: Deps, path: string, status: Status): void {
  // Best-effort: the status file is a backstop signal, never load-bearing
  // enough to error the run. Research must never block planning.
  try {
    deps.mkdirp(dirname(path));
    deps.writeFile(path, JSON.stringify(status));
  } catch {
    // swallow — a status-write failure must not abort the operational path.
  }
}

function readEntryArtifact(
  deps: Deps,
  aggregate: FanoutAggregate,
  task: string,
): string {
  const entry = (aggregate.entries ?? []).find((e) => e.task === task);
  if (!entry || entry.ran !== true || !entry.artifactPath) return "";
  try {
    return deps.readFile(entry.artifactPath);
  } catch {
    return "";
  }
}

function execute(parsed: Args, deps: Deps): number {
  let rawConfig = "";
  try {
    rawConfig = deps.readConfig(parsed.config);
  } catch {
    rawConfig = "";
  }
  let config: unknown = {};
  try {
    config = JSON.parse(rawConfig);
  } catch {
    config = {};
  }

  const { gatherModel, refuteModel } = resolveModels(config);
  const timeout = resolveTimeout(config);
  const maxCalls = resolveMaxCalls(config);

  const manifest = buildManifest(parsed.task, {
    gatherModel,
    refuteModel,
    timeout,
  });
  const manifestPath = `${parsed.out}.manifest.json`;
  const fanoutOut = `${parsed.out}.fanout.json`;

  // Mirror flow-gemini-lens.ts's scratch discipline: the manifest + fanout
  // aggregate are transient; clear both on every exit (success, skip, throw)
  // so they don't accumulate in the worktree's .flow-tmp/.
  const cleanScratch = () => {
    deps.removeFile(manifestPath);
    deps.removeFile(fanoutOut);
  };

  deps.mkdirp(dirname(parsed.out));

  // Pre-clean any stale --out from a prior run on this reused worktree: every
  // path below either rewrites --out (ran) or leaves it absent (skip), so the
  // supervisor's step-3 "fold research-findings.md when present and non-empty"
  // never splices a previous successful run's findings into a fresh plan when
  // agy has since gone down. removeFile is idempotent (force) — absent is fine.
  deps.removeFile(parsed.out);

  try {
    deps.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const aggregate = deps.runFanout({
      manifestPath,
      maxCalls,
      timeout,
      outPath: fanoutOut,
    });
    const verdict = interpretFanout(aggregate);

    if (!verdict.ran) {
      writeStatus(deps, parsed.statusFile, {
        active: true,
        ran: false,
        reason: "agy-unavailable",
      });
      deps.writeErr(
        "flow-research-run: agy unavailable — research skipped, planning proceeds unchanged",
      );
      return 0;
    }

    const gatherText = readEntryArtifact(deps, aggregate, GATHER_TASK);
    const refuteText = readEntryArtifact(deps, aggregate, REFUTE_TASK);
    const findings = boundFindings(gatherText, refuteText);
    deps.writeFile(parsed.out, `${findings}\n`);
    writeStatus(deps, parsed.statusFile, {
      active: true,
      ran: true,
      reason: "ran",
    });
    deps.writeOut(
      `flow-research-run: wrote web-grounded findings to ${parsed.out}`,
    );
    return 0;
  } finally {
    cleanScratch();
  }
}

export function run(argv: string[], depsOverride?: Partial<Deps>): number {
  const deps = resolveDeps(depsOverride);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    deps.writeErr(`flow-research-run: ${parsed.error}`);
    deps.writeErr(
      "usage: flow-research-run --task <description> --out <findings-md-path> --status-file <status-json-path> [--config <path>]",
    );
    return 2;
  }

  // Defensive outer catch: any unexpected error past arg-parse degrades to a
  // graceful agy-unavailable skip with exit 0. Research must NEVER block planning.
  try {
    return execute(parsed, deps);
  } catch (err) {
    writeStatus(deps, parsed.statusFile, {
      active: true,
      ran: false,
      reason: "agy-unavailable",
    });
    deps.writeErr(
      `flow-research-run: degraded to skip (${(err as Error).message})`,
    );
    return 0;
  }
}

function defaultRunFanout(input: {
  manifestPath: string;
  maxCalls: number;
  timeout: string;
  outPath: string;
}): FanoutAggregate {
  // Spawn the flow-delegate-fanout BINARY and parse its one-line aggregate
  // envelope. --concurrency is pinned at 4 (2 entries => one wave, ~3m bounded).
  const argv = [
    "--manifest",
    input.manifestPath,
    "--max-calls",
    String(input.maxCalls),
    "--concurrency",
    "4",
    "--out",
    input.outPath,
    "--default-entry-timeout",
    input.timeout,
  ];
  const r = Bun.spawnSync(["flow-delegate-fanout", ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = r.stdout ? new TextDecoder().decode(r.stdout) : "";
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
  try {
    return JSON.parse(line) as FanoutAggregate;
  } catch {
    // An unparsable envelope is treated as agy-unavailable, never a hard fail.
    return { allSkipped: true };
  }
}

function resolveDeps(o?: Partial<Deps>): Deps {
  return {
    readConfig: o?.readConfig ?? ((p) => readFileSync(p, "utf8")),
    runFanout: o?.runFanout ?? defaultRunFanout,
    readFile: o?.readFile ?? ((p) => readFileSync(p, "utf8")),
    writeFile: o?.writeFile ?? ((p, c) => writeFileSync(p, c)),
    removeFile: o?.removeFile ?? ((p) => void rmSync(p, { force: true })),
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    writeOut: o?.writeOut ?? ((line) => console.log(line)),
    writeErr: o?.writeErr ?? ((line) => console.error(line)),
  };
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
