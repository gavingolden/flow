import path from "node:path";
import {
  Task,
  readTask,
  transitionStatus,
  updateTaskFrontmatter,
} from "../state/task-file.js";
import { TaskStatus } from "../state/phases.js";
import { isPaused } from "../state/pause-flag.js";
import { parseIntent } from "../state/triage.js";
import { runPlanPhase } from "./phases/plan.js";
import { runWorktreePhase } from "./phases/worktree.js";
import { runImplementPhase } from "./phases/implement.js";
import { runVerifyPhase } from "./phases/verify.js";
import { runCiWaitPhase } from "./phases/ci-wait.js";
import { runReviewPhase } from "./phases/review.js";
import { runGatePhase } from "./phases/gate.js";
import { runMergePhase } from "./phases/merge.js";
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
    // The pipeline only ever creates fresh PRs — `mode: "fix"` is reserved
    // for the PR 7 review loop-back that re-invokes the phase against an
    // existing PR. Adapter scopes that awkwardness to one line so
    // `PhaseFn` can stay generic.
    phase: (task, logger, jsonl) =>
      runImplementPhase(task, { mode: "create" }, logger, jsonl),
  },
  {
    name: "verify",
    unfinishedStatuses: ["pr-open", "verifying"],
    phase: runVerifyPhase,
  },
  {
    name: "ci-wait",
    unfinishedStatuses: ["ci"],
    phase: runCiWaitPhase,
  },
  {
    // The review phase keeps the task at status "reviewing" for the entire
    // review→implement(fix) loop, including across the inner fix call.
    // `unfinishedStatuses` is therefore just ["reviewing"]: a mid-loop
    // crash leaves the status at "reviewing" so the runner re-enters here,
    // reads the persisted `review_cycles` counter from frontmatter, and
    // continues from where it left off.
    name: "review",
    unfinishedStatuses: ["reviewing"],
    phase: runReviewPhase,
  },
  {
    // Gate enters from `reviewing` (immediately after a clean review),
    // re-enters from `gating` (mid-flight crash before a decision), and
    // re-enters from `gated` (resume to detect external user-merge of a
    // gated PR). All three branches converge on a fresh `gh pr view` so
    // the decision is always derived from current PR state.
    name: "gate",
    unfinishedStatuses: ["reviewing", "gating", "gated"],
    phase: runGatePhase,
  },
  {
    // Merge owns just `merging`. Idempotent re-entry detects an
    // already-MERGED PR via `gh pr view` and skips the merge call.
    name: "merge",
    unfinishedStatuses: ["merging"],
    phase: runMergePhase,
  },
];

// Union of `unfinishedStatuses` across the configured pipeline. A task
// in any of these states still has work to do and is therefore subject
// to claim acquisition. Terminal/settled statuses (`merged`, `aborted`,
// `needs-human`, etc.) bypass the claim entirely so the runner's
// existing no-op behaviour is preserved.
const CLAIMABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(
  M2_PIPELINE.flatMap((spec) => spec.unfinishedStatuses),
);

export function isClaimableStatus(status: TaskStatus): boolean {
  return CLAIMABLE_STATUSES.has(status);
}

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
    // Pause check at the phase boundary. Sits between the unfinished-status
    // gate (so we don't flap pause transitions on a no-op iteration) and
    // the phase invocation (so a phase already running is never
    // interrupted). `taskDir` is undefined in legacy unit tests that
    // exercise dispatch without a real on-disk task dir — those paths
    // bypass the check, preserving existing behaviour.
    if (opts.taskDir && isPaused(opts.taskDir)) {
      const pausedFrom = task.frontmatter.status;
      await updateTaskFrontmatter(task, { paused_from: pausedFrom });
      await transitionStatus(task, "needs-human", "user-paused");
      logger.event("task.status", "needs-human (user-paused)");
      const pauseSink = await createJsonlSink({
        taskDir: opts.taskDir,
        phase: "pause",
      });
      try {
        pauseSink.event("task.pause", { paused_from: pausedFrom });
      } finally {
        await pauseSink.close();
      }
      return { status: "needs-human", reason: "user-paused" };
    }
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
    //
    // Capture `durationMs` immediately after the phase returns/throws,
    // before any sink finalization. The success and throw branches share
    // the same measurement so `phaseEnd` durations don't include
    // sink close/flush overhead on one path but not the other.
    let result: PhaseResult;
    let durationMs: number;
    try {
      result = await spec.phase(task, logger, jsonl);
      durationMs = Date.now() - start;
    } catch (err) {
      durationMs = Date.now() - start;
      try { jsonl.event("result", { status: "failed", reason: (err as Error).message ?? String(err) }); } catch {}
      await jsonl.close();
      logger.phaseEnd(spec.name, durationMs, "threw");
      throw err;
    }
    try { jsonl.event("result", { status: result.status, ...(result.status !== "ok" ? { reason: result.reason } : {}) }); } catch {}
    await jsonl.close();
    const outcome = result.status === "ok" ? "ok" : result.status;
    logger.phaseEnd(spec.name, durationMs, outcome);
    if (result.status !== "ok") return result;
    // Reload — the phase mutated the task on disk.
    Object.assign(task, await readTask(task.path));
    // Post-plan checkpoint fork. Feature-intent tasks pause for review
    // here so the user can read the PRD before paying implement-phase
    // tokens. Other intents (bug, refactor, docs, infra, chore) flow
    // straight into implement, matching the pre-PR-12 behaviour. A
    // missing or malformed `intent` line is treated as non-feature so a
    // hand-edited task body never wedges the pipeline.
    if (spec.name === "plan" && parseIntent(task.body) === "feature") {
      await transitionStatus(task, "plan-pending-review", "intent: feature");
      logger.event("task.status", "plan-pending-review");
      return { status: "ok" };
    }
  }
  return { status: "ok" };
}

// Re-exported for callers that want to compute the standard task-dir path
// without duplicating the orchestrator's filesystem layout.
export function taskDirFor(targetRepo: string, taskId: string): string {
  return path.join(targetRepo, ".orchestrator", "tasks", taskId);
}
