import { Task, readTask } from "../state/task-file.js";
import { TaskStatus } from "../state/phases.js";
import { runPlanPhase } from "./phases/plan.js";
import { runWorktreePhase } from "./phases/worktree.js";
import { runImplementPhase } from "./phases/implement.js";
import { PhaseResult } from "./types.js";
import { NoopLogger, type Logger } from "../util/logger.js";

type PhaseFn = (task: Task, logger: Logger) => Promise<PhaseResult>;

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

export async function runPipeline(
  task: Task,
  logger: Logger = NoopLogger,
): Promise<PhaseResult> {
  for (const spec of M2_PIPELINE) {
    if (!spec.unfinishedStatuses.includes(task.frontmatter.status)) continue;
    logger.phaseStart(spec.name);
    const start = Date.now();
    const result = await spec.phase(task, logger);
    const durationMs = Date.now() - start;
    const outcome = result.status === "ok" ? "ok" : result.status;
    logger.phaseEnd(spec.name, durationMs, outcome);
    if (result.status !== "ok") return result;
    // Reload — the phase mutated the task on disk.
    Object.assign(task, await readTask(task.path));
  }
  return { status: "ok" };
}
