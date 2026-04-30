import { existsSync } from "node:fs";
import { execa } from "execa";
import {
  Task,
  appendPhaseOutput,
  transitionStatus,
  updateTaskFrontmatter,
} from "../../state/task-file.js";
import { PhaseResult } from "../types.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import { NoopJsonlSink, type JsonlSink } from "../../util/jsonl-sink.js";
import {
  decideManualValidation,
  extractManualValidationSection,
} from "./gate-helpers.js";

interface GhPrViewPayload {
  body?: string;
  state?: string;
  mergeCommit?: { oid?: string } | null;
}

// Truncate the verbatim Manual-validation section we render into the
// phase output. A long checklist on a risky PR is fine in the body
// itself; the phase-output section is a snapshot for post-mortem and
// shouldn't dwarf the rest of the task file.
const PHASE_OUTPUT_SECTION_MAX = 2000;

export async function runGatePhase(
  task: Task,
  logger: Logger = NoopLogger,
  jsonl: JsonlSink = NoopJsonlSink,
): Promise<PhaseResult> {
  jsonl.event("gate.start", {
    pr: task.frontmatter.pr,
    status: task.frontmatter.status,
  });

  if (task.frontmatter.pr == null) {
    const reason = "gate phase requires task.frontmatter.pr (set by implement); got null";
    logger.error(reason);
    await appendPhaseOutput(
      task,
      "gate",
      `Cannot run gate: ${reason}`,
    );
    await transitionStatus(task, "needs-human", "pr-missing");
    jsonl.event("gate.exit", { result: "needs-human", reason: "pr-missing" });
    return { status: "needs-human", reason: "pr-missing" };
  }
  if (!task.frontmatter.worktree) {
    // Frontmatter-null is a structural break: the worktree phase never
    // populated `worktree`, so we can't even tell the user which path
    // got cleaned up. Mirror merge.ts:38-48 — distinct from the
    // "worktree path is set but the directory is gone" case below,
    // which falls back to target_repo as the gh-cwd.
    const reason = "gate phase requires a worktree path in frontmatter (set by worktree phase)";
    logger.error(reason);
    await appendPhaseOutput(
      task,
      "gate",
      `Cannot run gate: ${reason}`,
    );
    await transitionStatus(task, "needs-human", "worktree-missing");
    jsonl.event("gate.exit", { result: "needs-human", reason: "worktree-missing" });
    return { status: "needs-human", reason: "worktree-missing" };
  }

  const pr = task.frontmatter.pr;
  const worktree = task.frontmatter.worktree;
  // gh just needs *some* gh-aware cwd to identify the PR by number; the
  // worktree is preferred but not required. If the user manually removed
  // it before resuming a `gated` task whose PR was merged externally,
  // fall back to target_repo so Story 3 (resume-after-external-merge)
  // still completes the cleanup. Mirrors merge.ts:57.
  const ghCwd = existsSync(worktree) ? worktree : task.frontmatter.target_repo;

  // First-entry transition only. When resuming from `gated` with the PR
  // still OPEN and the section still non-empty, walking
  // `gated → gating → gated` re-fires the `gated` notifier on every
  // `flow run` because `transitionStatus` only short-circuits on
  // `from === to`. Restricting the transition to `reviewing → gating`
  // (and the no-op `gating → gating` re-entry) leaves a settled
  // `gated` task untouched until the decision actually changes.
  if (
    task.frontmatter.status === "reviewing" ||
    task.frontmatter.status === "gating"
  ) {
    await transitionStatus(task, "gating");
    logger.event("task.status", "gating");
  }

  logger.event("gate.gh.pr-view", `pr=#${pr}`);
  const view = await execa(
    "gh",
    ["pr", "view", String(pr), "--json", "body,state,mergeCommit"],
    { cwd: ghCwd, reject: false },
  );
  jsonl.event("gate.gh.pr-view", {
    pr,
    exitCode: view.exitCode,
    stderr: truncate(view.stderr ?? "", 500),
  });

  if (view.exitCode !== 0) {
    const detail = (view.stderr || view.stdout || `exit ${view.exitCode}`).trim();
    const reason = `gh pr view #${pr} failed: ${detail}`;
    logger.error(reason);
    await appendPhaseOutput(task, "gate", renderGhErrorSection(pr, detail));
    await transitionStatus(task, "needs-human", "gh-error");
    jsonl.event("gate.exit", { result: "needs-human", reason: "gh-error" });
    return { status: "needs-human", reason: "gh-error" };
  }

  let payload: GhPrViewPayload;
  try {
    payload = JSON.parse(view.stdout) as GhPrViewPayload;
  } catch (err) {
    const reason = `gh pr view #${pr} produced unparseable JSON: ${(err as Error).message}`;
    logger.error(reason);
    await appendPhaseOutput(task, "gate", renderGhErrorSection(pr, reason));
    await transitionStatus(task, "needs-human", "gh-error");
    jsonl.event("gate.exit", { result: "needs-human", reason: "gh-error" });
    return { status: "needs-human", reason: "gh-error" };
  }

  const state = (payload.state ?? "").toUpperCase();
  const body = payload.body ?? "";

  if (state === "MERGED") {
    // Resume path: the PR was merged externally (Story 3 — user clicked
    // Squash and merge in the GitHub UI on a `gated` PR), or gate is
    // re-entering against a `reviewing`/`gating` task whose PR was
    // already merged out-of-band. Either way, capture the SHA if we
    // don't already have it and hand off to merge for cleanup + archive.
    // (The merge phase only runs from `merging`, so a post-`gh pr merge`
    // crash never falls back here — the runner re-enters merge instead.)
    const oid = payload.mergeCommit?.oid?.trim() ?? null;
    if (oid && !task.frontmatter.merge_commit) {
      await updateTaskFrontmatter(task, { merge_commit: oid });
      logger.event("task.frontmatter", `merge_commit=${oid}`);
    }
    await appendPhaseOutput(
      task,
      "gate",
      renderMergedSection(pr, oid ?? task.frontmatter.merge_commit),
    );
    await transitionStatus(task, "merging");
    logger.event("task.status", "merging");
    jsonl.event("gate.exit", { result: "ok", decision: "already-merged" });
    return { status: "ok" };
  }

  if (state === "CLOSED") {
    // PR was closed without merge. Operator decides what to do (reopen,
    // recreate, abandon). We don't auto-merge or auto-abort.
    await appendPhaseOutput(task, "gate", renderClosedSection(pr));
    await transitionStatus(task, "needs-human", "pr-closed-without-merge");
    jsonl.event("gate.exit", {
      result: "needs-human",
      reason: "pr-closed-without-merge",
    });
    return { status: "needs-human", reason: "pr-closed-without-merge" };
  }

  // state === "OPEN" (or anything not MERGED/CLOSED — gh today only emits
  // OPEN/CLOSED/MERGED, but we treat the unknown case as "still open" and
  // defer the decision to body parsing rather than crashing on a future
  // schema addition).
  const decision = decideManualValidation(body);
  jsonl.event("gate.decision", { decision, pr, state });

  if (decision === "section-missing") {
    // The implement phase always writes the heading. Missing means a
    // hand-edited PR or a regression — surface to a human rather than
    // guessing intent.
    const reason =
      "gate: '## Manual validation' section missing from PR body — implement phase always writes the heading; PR body has likely been hand-edited";
    logger.error(reason);
    await appendPhaseOutput(task, "gate", renderSectionMissingSection(pr));
    await transitionStatus(
      task,
      "needs-human",
      "manual-validation-section-missing",
    );
    jsonl.event("gate.exit", {
      result: "needs-human",
      reason: "manual-validation-section-missing",
    });
    return { status: "needs-human", reason: "manual-validation-section-missing" };
  }

  if (decision === "empty") {
    await updateTaskFrontmatter(task, { manual_validation: false });
    logger.event("task.frontmatter", "manual_validation=false");
    await appendPhaseOutput(
      task,
      "gate",
      renderAutoMergeSection(pr),
    );
    await transitionStatus(task, "merging");
    logger.event("task.status", "merging");
    jsonl.event("gate.exit", { result: "ok", decision: "auto-merge" });
    return { status: "ok" };
  }

  // decision === "non-empty"
  await updateTaskFrontmatter(task, { manual_validation: true });
  logger.event("task.frontmatter", "manual_validation=true");
  const sectionBody = extractManualValidationSection(body) ?? "";
  await appendPhaseOutput(
    task,
    "gate",
    renderGatedSection(pr, sectionBody),
  );
  await transitionStatus(task, "gated", "manual-validation-required");
  jsonl.event("gate.exit", {
    result: "needs-human",
    reason: "manual-validation-required",
  });
  return { status: "needs-human", reason: "manual-validation-required" };
}

function renderGhErrorSection(pr: number, detail: string): string {
  return [
    `- PR: #${pr}`,
    `- Decision: gh-error (gate could not fetch PR state)`,
    "",
    "```text",
    truncate(detail, 1000),
    "```",
  ].join("\n");
}

function renderMergedSection(pr: number, oid: string | null): string {
  return [
    `- PR: #${pr}`,
    `- State: MERGED`,
    `- Decision: already-merged → handing off to merge phase for cleanup`,
    `- merge_commit: ${oid ?? "(none reported by gh)"}`,
  ].join("\n");
}

function renderClosedSection(pr: number): string {
  return [
    `- PR: #${pr}`,
    `- State: CLOSED (without merge)`,
    `- Decision: needs-human — operator must reopen, recreate, or abandon`,
  ].join("\n");
}

function renderSectionMissingSection(pr: number): string {
  return [
    `- PR: #${pr}`,
    `- Decision: needs-human — '## Manual validation' section missing from PR body`,
    "",
    "The implement phase always writes the heading. Missing means a hand-edited",
    "PR or a regression. Re-add the section (with either an HTML-comment-only",
    "placeholder for auto-merge or concrete steps for gated) and re-run.",
  ].join("\n");
}

function renderAutoMergeSection(pr: number): string {
  return [
    `- PR: #${pr}`,
    `- State: OPEN`,
    `- manual_validation: false (section is HTML-comment-only after strip-and-trim)`,
    `- Decision: auto-merge → handing off to merge phase`,
  ].join("\n");
}

function renderGatedSection(pr: number, sectionBody: string): string {
  const trimmed = sectionBody.trim();
  return [
    `- PR: #${pr}`,
    `- State: OPEN`,
    `- manual_validation: true (section contains content beyond HTML comments)`,
    `- Decision: gated — perform the validation steps below, then merge manually`,
    "",
    "Validation steps from the PR body:",
    "",
    truncate(trimmed, PHASE_OUTPUT_SECTION_MAX),
  ].join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated]`;
}
