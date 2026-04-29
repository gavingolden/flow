import path from "node:path";
import { Task, readTask } from "../state/task-file.js";
import { TaskStatus } from "../state/phases.js";
import { runPlanPhase } from "./phases/plan.js";
import { runWorktreePhase } from "./phases/worktree.js";
import { runImplementPhase } from "./phases/implement.js";
import { PhaseResult } from "./types.js";
import { NoopLogger, type Logger } from "../util/logger.js";
import {
  NoopJsonlSink,
  createJsonlSink,
  type JsonlSink,
} from "../util/jsonl-sink.js";

type PhaseFn = (
  task: Task,
  logger: Logger,
  jsonl: JsonlSink,
) => Promise<PhaseResult>;

interface PhaseSpec {
  name: string;
  // Statuses that mean "this phase has not yet completed" — i.e. the
  // runner should invoke it. The first entry is the canonical entry
  // status; later entries are mid-flight states from a crashed prior run.
  unfinishedStatuses: readonly TaskStatus[];
  phase: PhaseFn;
}

const M2_PIPELINE: readonly PhaseSpec[] = [
  {
    name: "worktree",
    unfinishedStatuses: ["triaged", "creating-worktree"],
    phase: runWorktreePhase,
  },
  {
    name: "plan",
    unfinishedStatuses: ["worktree-ready", "planning"],
    phase: runPlanPhase,
  },
  {
    name: "implement",
    unfinishedStatuses: ["planned", "implementing"],
    phase: runImplementPhase,
  },
];

export interface RunPipelineOptions {
  // Per-task directory for jsonl logs. When set, the runner opens a
  // per-phase sink at <taskDir>/logs/<phase>-<stamp>.jsonl. When unset,
  // phases receive `NoopJsonlSink` (existing test paths take this branch).
  taskDir?: string;
}

export async function runPipeline(
  task: Task,
  logger: Logger = NoopLogger,
  opts: RunPipelineOptions = {},
): Promise<PhaseResult> {
  for (const spec of M2_PIPELINE) {
    if (!spec.unfinishedStatuses.includes(task.frontmatter.status)) continue;
    logger.phaseStart(spec.name);
    const start = Date.now();
    const jsonl: JsonlSink = opts.taskDir
      ? await createJsonlSink({ taskDir: opts.taskDir, phase: spec.name })
      : NoopJsonlSink;
    if (opts.taskDir) {
      logger.event("jsonl.open", `${spec.name} → ${jsonl.filePath}`);
    }
    // Wrap so a phase that throws still emits a `phaseEnd` line with the
    // duration and a `threw` outcome, *and* closes the sink. Without this,
    // the persistent log file ends with an unterminated `▶ <phase>` line on
    // a crash and the jsonl write stream leaks an open fd.
    let result: PhaseResult;
    try {
      result = await spec.phase(task, logger, jsonl);
    } catch (err) {
      const durationMs = Date.now() - start;
      try { jsonl.event("result", { status: "failed", reason: (err as Error).message ?? String(err) }); } catch {}
      await jsonl.close();
      logger.phaseEnd(spec.name, durationMs, "threw");
      throw err;
    }
    try { jsonl.event("result", { status: result.status, ...(result.status !== "ok" ? { reason: result.reason } : {}) }); } catch {}
    await jsonl.close();
    const durationMs = Date.now() - start;
    const outcome = result.status === "ok" ? "ok" : result.status;
    logger.phaseEnd(spec.name, durationMs, outcome);
    if (result.status !== "ok") return result;
    // Reload — the phase mutated the task on disk.
    Object.assign(task, await readTask(task.path));
  }
  return { status: "ok" };
}

// Re-exported for callers that want to compute the standard task-dir path
// without duplicating the orchestrator's filesystem layout.
export function taskDirFor(targetRepo: string, taskId: string): string {
  return path.join(targetRepo, ".orchestrator", "tasks", taskId);
}
