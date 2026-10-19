/**
 * Permission rules that pre-approve the routine helpers an unattended
 * `/flow-pipeline` run calls at every step, so Claude Code's auto-mode
 * classifier does not stall or deny them. They ship in flow's generated
 * launch settings (`launchSettingsPermissions`) and apply to flow-launched
 * sessions only — never the owner's personal settings or a consumer repo.
 *
 * ACCEPTED RISK: once a rule applies, the classifier no longer reviews that
 * helper call — each helper's own argument validation is the only guard. The
 * list is named helper-by-helper (never a `Bash(flow-*)` wildcard), and
 * {@link FLOW_NEVER_ALLOW_HELPERS} stay classifier-reviewed: `flow-merge-guard`
 * carries its own narrower rules, `flow-spawn` wraps arbitrary argv (an allow
 * rule would launder any command), and the helpers that post review comments,
 * replies, or annotations to GitHub. Opening the PR and updating its
 * description (`flow-open-pr`, `flow-review-finalize`, `flow-followups`' gh
 * path) are routine steps and stay pre-approved.
 *
 * Also accepted: `flow-pre-commit` and `flow-new-worktree` run repo-defined
 * scripts (`npm run <check>`, `npm install` lifecycle scripts). An agent that
 * edits a package.json script and then calls either helper runs that shell
 * without classifier review; they are core routine steps, so the risk is
 * taken knowingly.
 *
 * A rule only matches a standalone call; a `cd … &&` prefix or a chain of
 * helpers may still reach the classifier, so the supervisor calls helpers one
 * per Bash call.
 */

export const FLOW_ROUTINE_HELPERS: readonly string[] = [
  "flow-state-update",
  "flow-new-worktree",
  "flow-remove-worktree",
  "flow-ci-check",
  "flow-ci-wait",
  "flow-open-pr",
  "flow-gate-decide",
  "flow-gate-summary",
  "flow-untracked",
  "flow-followups",
  "flow-pre-commit",
  "flow-pipeline-summary",
  "flow-notify",
  "flow-resume-decide",
  "flow-candidate-issues",
  "flow-plan-lint",
  "flow-review-scope",
  "flow-review-prep",
  "flow-review-finalize",
  "flow-pr-diff",
  "flow-inject-evidence",
  "flow-checkpoint",
  "flow-browser-teardown",
  "flow-module-status",
  "flow-research-note",
  "flow-step3-route",
  "flow-rename-window",
  "flow-product-brief",
];

export const FLOW_NEVER_ALLOW_HELPERS: readonly string[] = [
  "flow-merge-guard",
  "flow-spawn",
  "flow-post-findings",
  "flow-reply-pr-comments",
  "flow-annotate-pr",
];

export const FLOW_ROUTINE_ALLOW_RULES: readonly string[] =
  FLOW_ROUTINE_HELPERS.flatMap((h) => [`Bash(${h})`, `Bash(${h} *)`]);
