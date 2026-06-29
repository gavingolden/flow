#!/usr/bin/env bun
/**
 * Deterministic backstop for the discovery web-grounded research visibility
 * note. discovery Step 1.5 is *supposed* to write a `> [!NOTE]` blockquote into
 * plan.md (and echo it) whenever the research path was active but no research
 * ran — but that note is authored by an LLM sub-agent and was observed to be
 * skipped entirely. This helper is the reliable, non-LLM surface for that
 * user-visible note: the supervisor (step 3) always calls it, and it
 * self-no-ops when research actually ran, when the path was dormant, or when
 * the sub-agent already wrote a (more precise) note. It NEVER throws and NEVER
 * blocks the pipeline — every operational path exits 0.
 *
 * Usage:
 *   flow-research-note ensure --plan-file <path>
 *       [--forced <true|false>] [--status-file <path>] [--config <path>]
 *
 * Exit codes:
 *   0 — every operational path (note inserted, echoed, or silently skipped)
 *   2 — bad CLI args (missing subcommand / required flag, unknown flag)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const NOTE_RE = /Web-grounded research \(discovery Step 1\.5\)/;

export type ResearchStatus = { ran: boolean; reason?: string };

export type DecideInput = {
  active: boolean;
  forced: boolean;
  status: ResearchStatus | null;
  planText: string;
};

/**
 * Pure decision core. Returns null when nothing should be surfaced (path
 * dormant, or research actually ran). Otherwise returns the one-line note to
 * echo plus the block to insert — `insertedText` is null when plan.md already
 * carries a (possibly more precise) note, in which case the existing line is
 * echoed verbatim and the file is left untouched (idempotent).
 */
export function decideNote(
  input: DecideInput,
): { noteLine: string; insertedText: string | null } | null {
  const { active, forced, status, planText } = input;
  if (!active) return null;
  if (status && status.ran === true) return null;

  // Idempotency: a subagent-authored note wins — echo it, write nothing.
  if (NOTE_RE.test(planText)) {
    const existing = planText.split("\n").find((l) => NOTE_RE.test(l));
    const noteLine = (existing ?? "").replace(/^>\s?/, "").trim();
    return { noteLine, insertedText: null };
  }

  const reason = computeReason(status, forced);
  const noteLine = `Web-grounded research (discovery Step 1.5): ${reason}; force with \`flow new --research\`.`;
  return { noteLine, insertedText: `> [!NOTE]\n> ${noteLine}` };
}

function computeReason(status: ResearchStatus | null, forced: boolean): string {
  if (status && typeof status.reason === "string") {
    if (status.reason === "not-researchable")
      return "skipped — not a researchable question";
    if (status.reason === "agy-unavailable")
      return "skipped — agy unavailable on this host";
  }
  return forced
    ? "forced on, but no research ran — agy may be unavailable or the pre-check was skipped"
    : "did not run — if you expected web-grounded research, force it";
}

/** Inserts the note block after the first `# PRD` heading, else prepends. */
export function insertNote(planText: string, noteBlock: string): string {
  const lines = planText.split("\n");
  const idx = lines.findIndex((l) => /^#\s+PRD/.test(l));
  if (idx === -1) return `${noteBlock}\n\n${planText}`;
  const head = lines.slice(0, idx + 1);
  const tail = lines.slice(idx + 1);
  return [...head, "", noteBlock, "", ...tail].join("\n");
}

function readConfigDiscovery(configPath: string): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return cfg?.research?.discovery === true;
  } catch {
    return false;
  }
}

function readStatus(statusPath: string): ResearchStatus | null {
  try {
    const obj = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (obj && typeof obj.ran === "boolean") {
      return {
        ran: obj.ran,
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export type EnsureArgs = {
  planFile: string;
  forced: boolean;
  statusFile?: string;
  config?: string;
};

export function parseEnsureArgs(
  argv: string[],
): EnsureArgs | { error: string } {
  let planFile: string | undefined;
  let forced = false;
  let statusFile: string | undefined;
  let config: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--plan-file":
        planFile = value;
        break;
      case "--forced":
        forced = value === "true";
        break;
      case "--status-file":
        statusFile = value;
        break;
      case "--config":
        config = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }

  if (planFile === undefined)
    return { error: "missing required flag: --plan-file" };
  return { planFile, forced, statusFile, config };
}

export function runEnsure(argv: string[]): number {
  const parsed = parseEnsureArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-research-note: ${parsed.error}\n`);
    process.stderr.write(
      "usage: flow-research-note ensure --plan-file <path> [--forced <true|false>] [--status-file <path>] [--config <path>]\n",
    );
    return 2;
  }

  const statusFile =
    parsed.statusFile ??
    path.join(path.dirname(parsed.planFile), "research-status.json");
  const configFile =
    parsed.config ?? path.join(os.homedir(), ".flow", "config.json");

  const active = parsed.forced || readConfigDiscovery(configFile);
  if (!active) return 0; // dormant: stay silent

  let planText: string;
  try {
    planText = fs.readFileSync(parsed.planFile, "utf8");
  } catch (e) {
    process.stderr.write(
      `flow-research-note: could not read plan file ${parsed.planFile}: ${(e as Error).message}\n`,
    );
    return 0; // never block the pipeline
  }

  const decision = decideNote({
    active,
    forced: parsed.forced,
    status: readStatus(statusFile),
    planText,
  });
  if (!decision) return 0; // research ran → silent

  if (decision.insertedText !== null) {
    try {
      fs.writeFileSync(
        parsed.planFile,
        insertNote(planText, decision.insertedText),
      );
    } catch (e) {
      process.stderr.write(
        `flow-research-note: could not write note into ${parsed.planFile}: ${(e as Error).message}\n`,
      );
      return 0;
    }
  }

  process.stdout.write(decision.noteLine + "\n");
  return 0;
}

export function run(argv: string[]): number {
  if (argv.length === 0) {
    process.stderr.write(
      "flow-research-note: subcommand is required (ensure)\n",
    );
    return 2;
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case "ensure":
      return runEnsure(rest);
    default:
      process.stderr.write(`flow-research-note: unknown subcommand '${sub}'\n`);
      return 2;
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
