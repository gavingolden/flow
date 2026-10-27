/**
 * Shared seams for the epic executive's plan and wave reviews: the injectable
 * dependency bundle, the headless child's envelope, decision ids, the one model
 * source, and the design excerpt both packets carry.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { managerDir } from "./epic-manager-log";
import { resolveManagerModelEffort } from "./epic-manager-model";
import type { checkPlanPreconditions } from "./exec-review-preconditions";
import { defaultReadConfigFile, type ReadConfigFile } from "./models-config";
import { defaultGh } from "./resume-probes";
import { recordEvent as recordTelemetry } from "./telemetry";
import {
  EFFORT_LEVELS,
  MODEL_ALIASES,
  type EffortLevel,
  type ModelAlias,
} from "./state";

export const EXEC_MAX_BUDGET_USD = 3;
export const EXEC_MAX_TURNS = 25;
export const EXEC_TIMEOUT_SEC = 480;

export type HeadlessEnvelope = {
  ran?: boolean;
  skipReason?: string;
  artifact?: string;
  total_cost_usd?: number;
};

export type ExecReviewDeps = {
  stateDir?: string;
  homeDir?: string;
  readConfig?: ReadConfigFile;
  spawnHeadless: (argv: string[], opts: { cwd: string }) => HeadlessEnvelope;
  readFile: (p: string) => string;
  writeFile: (p: string, c: string) => void;
  mkdtemp: () => string;
  removeDir: (d: string) => void;
  now: () => Date;
  random: () => string;
  recordEvent: (e: "exec.review", a: Record<string, unknown>) => void;
  /** Per-machine epic run-state root (`~/.flow/epics`); wave review only. */
  epicsDir?: string;
  /** PR title + body for a merged feature; wave review only. */
  fetchPr?: (pr: number) => { title: string; body: string } | null;
  /** Test seam for the precondition probes (file existence, lint). */
  preconditions?: Parameters<typeof checkPlanPreconditions>[1];
};

/** The child prints one JSON line last; anything unparseable is a skip. */
export function parseHeadlessStdout(stdout: string): HeadlessEnvelope {
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as HeadlessEnvelope)
      : { ran: false, skipReason: "headless-error" };
  } catch {
    return { ran: false, skipReason: "headless-error" };
  }
}

/** The one `flow-claude-headless` argv both reviews spawn, with their spend and tool limits. */
export function execHeadlessArgv(a: {
  promptPath: string;
  out: string;
  decisionId: string;
  model: ModelAlias;
  effort: EffortLevel;
}): string[] {
  return [
    "--prompt-file",
    a.promptPath,
    "--model",
    a.model,
    "--effort",
    a.effort,
    "--allowed-tools",
    "Read,Grep,Glob",
    "--max-budget-usd",
    String(EXEC_MAX_BUDGET_USD),
    "--max-turns",
    String(EXEC_MAX_TURNS),
    "--timeout-sec",
    String(EXEC_TIMEOUT_SEC),
    "--task",
    `exec-review-${a.decisionId}`,
    "--out",
    a.out,
  ];
}

export function defaultExecDeps(): ExecReviewDeps {
  return {
    spawnHeadless: (argv, opts) => {
      const r = Bun.spawnSync(["flow-claude-headless", ...argv], {
        cwd: opts.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      return parseHeadlessStdout(new TextDecoder().decode(r.stdout));
    },
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, c) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, c);
    },
    mkdtemp: () => fs.mkdtempSync(path.join(os.tmpdir(), "flow-exec-review-")),
    removeDir: (d) => void fs.rmSync(d, { recursive: true, force: true }),
    now: () => new Date(),
    random: () =>
      Math.floor(Math.random() * 0x10000)
        .toString(16)
        .padStart(4, "0"),
    recordEvent: (e, a) => recordTelemetry(e, a),
    fetchPr: (pr) => {
      const r = defaultGh(["pr", "view", String(pr), "--json", "title,body"]);
      if (r.exitCode !== 0) return null;
      try {
        const o = JSON.parse(r.stdout) as { title?: string; body?: string };
        return { title: o.title ?? "", body: o.body ?? "" };
      } catch {
        return null;
      }
    },
  };
}

export function makeDecisionId(
  kind: "plan" | "wave",
  deps: Pick<ExecReviewDeps, "now" | "random">,
): string {
  const t = deps.now().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${kind}-${t}-${deps.random()}`;
}

export function readManagerHints(
  epic: string,
  deps: Pick<ExecReviewDeps, "stateDir" | "readFile">,
): { flagModel?: ModelAlias; flagEffort?: EffortLevel } {
  try {
    const raw: unknown = JSON.parse(
      deps.readFile(path.join(managerDir(epic, deps.stateDir), "manager.json")),
    );
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      ...((MODEL_ALIASES as readonly string[]).includes(o.model as string)
        ? { flagModel: o.model as ModelAlias }
        : {}),
      ...((EFFORT_LEVELS as readonly string[]).includes(o.effort as string)
        ? { flagEffort: o.effort as EffortLevel }
        : {}),
    };
  } catch {
    return {};
  }
}

export function resolveExecModel(
  epic: string,
  deps: Pick<ExecReviewDeps, "stateDir" | "readFile" | "readConfig">,
): { model: ModelAlias; effort: EffortLevel } {
  const { model, effort } = resolveManagerModelEffort({
    ...readManagerHints(epic, deps),
    read: deps.readConfig ?? defaultReadConfigFile,
  });
  return { model, effort };
}

/** Reads the child's `.result` text from the headless artifact. */
export function readHeadlessResult(
  envelope: HeadlessEnvelope,
  fallbackPath: string,
  readFile: (p: string) => string,
): string | null {
  try {
    const artifact: unknown = JSON.parse(
      readFile(envelope.artifact ?? fallbackPath),
    );
    const result = (artifact as { result?: unknown } | null)?.result;
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

export function designExcerpt(
  designText: string | null,
  featureId?: string,
): string {
  if (!designText) return "(the epic design is not available)";
  const parts: string[] = [];
  const goal = /^\*\*Goal:\*\*[\s\S]*?(?:\n\n|$)/m.exec(designText);
  if (goal) parts.push(goal[0].trim());
  const feature =
    featureId === undefined
      ? null
      : new RegExp(
          `^### ${featureId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\\s\\S]*?(?=^#{2,3} |$(?![\\s\\S]))`,
          "m",
        ).exec(designText);
  if (feature) parts.push(feature[0].trim());
  return parts.length > 0 ? parts.join("\n\n") : designText.slice(0, 6000);
}
