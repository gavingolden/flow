/**
 * Builds the probe's manifest: one production-shaped fanout entry per
 * (surface, repeat, model), each prompt from the step's own production
 * builder with the step's read-access / web-search posture.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManifestEntry as FanoutManifestEntry } from "../../../bin/flow-delegate-fanout";
import { buildManifest as buildGatherManifest } from "../../../bin/flow-research-run";
import {
  AGENT_FINDINGS_JSON_SCHEMA,
  buildPrompt as buildLensPrompt,
} from "../../../bin/flow-gemini-lens";
import {
  buildPrompt as buildIntentPrompt,
  INTENT_GUESS_JSON_SCHEMA,
} from "../../../bin/flow-gemini-intent-guess";
import {
  buildBatteryPrompt,
  extractGoalLine,
} from "../../../bin/lib/plan-review-prompt";
import { buildSurveyPrompt } from "../../../bin/lib/blind-survey-prompt";
import type { ProbeSurface } from "./sizing";

export const PROBE_SURFACES: ProbeSurface[] = [
  "research-gather",
  "plan-review",
  "blind-survey",
  "intent-guess",
  "review-lens",
];
export const DEFAULT_MODELS = [
  "Gemini 4 Argon (High)",
  "Gemini 4 Argon (Medium)",
];
export const DEFAULT_REPEATS: Record<ProbeSurface, number> = {
  "research-gather": 3,
  "plan-review": 3,
  "blind-survey": 3,
  "intent-guess": 2,
  "review-lens": 2,
};
export const DEFAULT_TIMEOUT = "20m";
export const CAPPED_GATHER_REPEATS = 3;
export const GATHER_CAP_SENTENCE =
  " Use at most 3 searches and read at most 8 pages before answering.";

export type Io = {
  readFile: (p: string) => string;
  writeFile: (p: string, data: string) => void;
};
const realIo: Io = {
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, data) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  },
};

export type ProbeManifestOpts = {
  models: string[];
  repeats: Record<ProbeSurface, number>;
  worktree: string;
  inputsDir: string;
  timeout: string;
  // Prompts, schemas and raw answers live under outDir.
  outDir: string;
  cappedGather?: boolean;
  io?: Io;
};

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function changedFiles(diff: string): string {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) files.add(line.slice("+++ b/".length));
  }
  return (
    Array.from(files).join("\n") || "(unable to derive file list from diff)"
  );
}

export function buildProbeManifest(
  opts: ProbeManifestOpts,
): FanoutManifestEntry[] {
  const io = opts.io ?? realIo;
  const input = (name: string): string =>
    io.readFile(join(opts.inputsDir, name));
  const question = input("research-question.md").trim();
  const planText = input("plan.md");
  const brief = input("survey-brief.md");
  const diff = input("pr-941.diff");
  const { worktree } = opts;

  const intentSchema = join(opts.outDir, "intent-guess.schema.json");
  const lensSchema = join(opts.outDir, "review-lens.schema.json");
  io.writeFile(intentSchema, JSON.stringify(INTENT_GUESS_JSON_SCHEMA));
  io.writeFile(lensSchema, JSON.stringify(AGENT_FINDINGS_JSON_SCHEMA));

  // One production-shaped call per surface; `timeout`, `model`, task name and
  // artifact paths are stamped on below.
  const gather = buildGatherManifest(question, {
    gatherModel: "",
    refuteModel: "",
    timeout: opts.timeout,
  })[0]!;
  const shapes: Record<
    ProbeSurface | "research-gather-capped",
    () => Omit<
      FanoutManifestEntry,
      "task" | "model" | "timeout" | "out" | "promptFile"
    >
  > = {
    "research-gather": () => ({
      prompt: gather.prompt,
      skipPermissions: gather.skipPermissions,
      outputFormat: gather.outputFormat,
    }),
    "research-gather-capped": () => ({
      prompt: `${gather.prompt}${GATHER_CAP_SENTENCE}`,
      skipPermissions: gather.skipPermissions,
      outputFormat: gather.outputFormat,
    }),
    "plan-review": () => ({
      prompt: buildBatteryPrompt({
        planText,
        goalLine: extractGoalLine(planText),
        worktreePath: worktree,
      }),
      addDirs: [worktree],
    }),
    "blind-survey": () => ({
      prompt: buildSurveyPrompt({ brief, worktreePath: worktree }),
      addDirs: [worktree],
    }),
    "intent-guess": () => ({
      prompt: buildIntentPrompt(diff, changedFiles(diff), worktree),
      addDirs: [worktree],
      outputFormat: "json",
      jsonSchema: intentSchema,
    }),
    "review-lens": () => ({
      prompt: buildLensPrompt(diff, worktree),
      addDirs: [worktree],
      outputFormat: "json",
      jsonSchema: lensSchema,
    }),
  };

  const plan: Array<{
    surface: ProbeSurface | "research-gather-capped";
    repeat: number;
    model: string;
  }> = [];
  for (const surface of PROBE_SURFACES) {
    for (let repeat = 1; repeat <= opts.repeats[surface]; repeat++) {
      for (const model of opts.models) plan.push({ surface, repeat, model });
    }
  }
  if (opts.cappedGather) {
    const high = opts.models.filter((m) => /\(High\)/.test(m));
    for (let repeat = 1; repeat <= CAPPED_GATHER_REPEATS; repeat++) {
      for (const model of high.length ? high : opts.models.slice(0, 1)) {
        plan.push({ surface: "research-gather-capped", repeat, model });
      }
    }
  }

  return plan.map(({ surface, repeat, model }) => {
    const task = `${surface}__r${repeat}__${slug(model)}`;
    const { prompt, ...posture } = shapes[surface]();
    const promptFile = join(opts.outDir, "prompts", `${task}.md`);
    io.writeFile(promptFile, prompt ?? "");
    return {
      task,
      model,
      promptFile,
      timeout: opts.timeout,
      out: join(opts.outDir, "raw", `${task}.md`),
      ...posture,
    };
  });
}
