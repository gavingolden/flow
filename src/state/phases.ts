export const PHASE_ORDER = [
  "triage",
  "plan",
  "worktree",
  "implement",
  "verify",
  "ci",
  "review",
  "gate",
  "merge",
] as const;
export type PhaseName = (typeof PHASE_ORDER)[number];

export const TASK_STATUSES = [
  "triaged",
  "planning",
  "planned",
  "creating-worktree",
  "worktree-ready",
  "implementing",
  "pr-open",
  "verifying",
  "ci",
  "reviewing",
  "gated",
  "merged",
  "aborted",
  "needs-human",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const STATUS_TO_LAST_CHECKED: Record<TaskStatus, PhaseName> = {
  triaged: "triage",
  planning: "triage",
  planned: "plan",
  "creating-worktree": "plan",
  "worktree-ready": "worktree",
  implementing: "worktree",
  "pr-open": "implement",
  verifying: "implement",
  ci: "verify",
  reviewing: "ci",
  gated: "review",
  merged: "merge",
  // Transient/terminal states fall back to whatever has been visibly completed.
  // The body's Phase log captures the actual lineage; Progress is just a hint.
  aborted: "triage",
  "needs-human": "triage",
};

export function checkedThrough(status: TaskStatus): PhaseName {
  return STATUS_TO_LAST_CHECKED[status];
}

export function renderProgressSection(status: TaskStatus): string {
  const last = checkedThrough(status);
  const lastIdx = PHASE_ORDER.indexOf(last);
  const lines = PHASE_ORDER.map((phase, idx) => {
    const mark = idx <= lastIdx ? "x" : " ";
    return `- [${mark}] ${phase}`;
  });
  // Trailing empty entry produces a final "\n" so the next section
  // (e.g. "## Phase log") gets a blank line above it.
  return ["## Progress", "", ...lines, ""].join("\n");
}
