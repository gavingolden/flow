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
  "creating-worktree",
  "worktree-ready",
  "planning",
  "planned",
  "plan-pending-review",
  "implementing",
  "pr-open",
  "verifying",
  "ci",
  "reviewing",
  "gating",
  "gated",
  "merging",
  "merged",
  "aborted",
  "needs-human",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// PHASE_ORDER puts `plan` before `worktree` (idx 1 vs 2) for visual continuity
// with the original architecture diagrams, but the actual execution order is
// worktree-first. As a result, statuses past `worktree-ready` map to
// `worktree` (idx 2) — checking through worktree visually ticks triage, plan,
// and worktree, which matches what has actually completed once the plan phase
// is in progress or done.
const STATUS_TO_LAST_CHECKED: Record<TaskStatus, PhaseName> = {
  triaged: "triage",
  "creating-worktree": "triage",
  "worktree-ready": "worktree",
  planning: "worktree",
  planned: "worktree",
  "plan-pending-review": "worktree",
  implementing: "worktree",
  "pr-open": "implement",
  verifying: "implement",
  ci: "verify",
  reviewing: "ci",
  gating: "review",
  // `gated` means the gate phase ran and decided "needs-human" — gate is
  // therefore the last completed phase (not review, even though review ran
  // immediately before).
  gated: "gate",
  merging: "gate",
  merged: "merge",
  // Transient/terminal states fall back to whatever has been visibly completed.
  // The body's Phase log captures the actual lineage; Progress is just a hint.
  aborted: "triage",
  "needs-human": "triage",
};

export function checkedThrough(status: TaskStatus): PhaseName {
  return STATUS_TO_LAST_CHECKED[status];
}

// Friendly "current phase" label for `flow status`. Distinct from
// `STATUS_TO_LAST_CHECKED`, which says "last completed phase" — this map
// says "phase the task is currently inside (or terminal label)". The two
// answer different questions: progress checkboxes vs roster column.
export const STATUS_TO_PHASE_LABEL: Record<TaskStatus, string> = {
  triaged: "triage",
  // `creating-worktree` is the in-progress status for the worktree phase
  // itself — not "between triage and worktree." Mapping it back to triage
  // hides the worktree phase from the roster while it's actively running.
  "creating-worktree": "worktree",
  "worktree-ready": "plan",
  planning: "plan",
  planned: "implement",
  "plan-pending-review": "plan-review",
  implementing: "implement",
  "pr-open": "implement",
  verifying: "verify",
  ci: "ci-wait",
  reviewing: "review",
  gating: "gate",
  gated: "gate",
  merging: "merge",
  merged: "merge",
  aborted: "aborted",
  "needs-human": "needs-human",
};

// Phase-label resolver. For most statuses, returns the static map entry.
// For `needs-human`, the static map is the placeholder string
// `"needs-human"` — the caller can supply a `fallbackFromLog` callback
// that returns the most recent non-`needs-human` status from the task's
// `## Phase log`, which is then mapped through `STATUS_TO_PHASE_LABEL`
// so the row reads `verify` instead of `needs-human` when verify was
// the phase that bailed out.
export function phaseLabelFor(
  status: TaskStatus,
  fallbackFromLog?: () => TaskStatus | null,
): string {
  if (status !== "needs-human") return STATUS_TO_PHASE_LABEL[status];
  const prior = fallbackFromLog?.();
  if (!prior || prior === "needs-human") return "needs-human";
  return STATUS_TO_PHASE_LABEL[prior];
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
