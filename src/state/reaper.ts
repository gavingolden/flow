import {
  Task,
  readTask,
  readTaskSync,
  transitionStatus,
  transitionStatusSync,
} from "./task-file.js";
import type { TaskStatus } from "./phases.js";

// Statuses the runner considers "transient" — i.e. the pipeline was
// supposed to push past them. If the runner exits with the task still in
// one of these states, the reaper rewrites the status to `needs-human` so
// PR 10's `/flow-status` doesn't lie about what's in flight.
//
// `triaged` is included because a runner that exited before doing anything
// (immediate-exit race after `--detach`) leaves the task at `triaged` and
// no process is touching it; the user needs that surfaced.
//
// Settled-terminal states (`pr-open`, `verifying`, ..., `merged`,
// `aborted`, `needs-human`) are *not* in this set — they are valid
// pipeline outcomes and the reaper must not overwrite them.
const TRANSIENT_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "triaged",
  "creating-worktree",
  "planning",
  "implementing",
]);

export type ReaperReason =
  | "runner-crashed"
  | "signaled"
  | "immediate-exit";

// Re-read the task file fresh (the in-memory task may be stale — a phase
// may have transitioned status between our last read and now) and, if the
// status is still transient, transition it to `needs-human` with the
// reason recorded in the Phase log. The async path is for the
// catch/finally branch; the sync path is for the `'exit'` handler, which
// can't await.

export async function reapStatusAsync(
  taskPath: string,
  reason: ReaperReason,
): Promise<boolean> {
  let task: Task;
  try {
    task = await readTask(taskPath);
  } catch {
    // Task file gone or unreadable — nothing we can rewrite.
    return false;
  }
  if (!TRANSIENT_STATUSES.has(task.frontmatter.status)) return false;
  await transitionStatus(task, "needs-human", reason);
  return true;
}

export function reapStatusSync(
  taskPath: string,
  reason: ReaperReason,
): boolean {
  let task: Task;
  try {
    task = readTaskSync(taskPath);
  } catch {
    return false;
  }
  if (!TRANSIENT_STATUSES.has(task.frontmatter.status)) return false;
  transitionStatusSync(task, "needs-human", reason);
  return true;
}

export function isTransientStatus(status: TaskStatus): boolean {
  return TRANSIENT_STATUSES.has(status);
}
