/**
 * Permission rules that pre-approve the routine helpers an unattended
 * `/flow-pipeline` run calls at every step, so Claude Code's auto-mode
 * classifier does not stall or deny them. They ship in flow's generated
 * launch settings (`launchSettingsPermissions`) and apply to flow-launched
 * sessions only — never the owner's personal settings or a consumer repo.
 *
 * ACCEPTED RISK: once a rule applies, the classifier no longer reviews that
 * helper call — each helper's own argument validation is the only guard. The
 * list is named helper-by-helper (never a `Bash(flow-*)` wildcard). The two
 * comment helpers (`flow-post-findings`, `flow-reply-pr-comments`) publish
 * text to GitHub without classifier review; inside a pipeline each refuses any
 * PR that is not the pipeline's own. {@link FLOW_NEVER_ALLOW_HELPERS} never get
 * the routine bare + wildcard pair: `flow-merge-guard` carries its own rules,
 * and `flow-spawn` wraps arbitrary argv, so only the fixed-literal waiter
 * prefixes in {@link FLOW_NARROW_ALLOW_RULES} are allowed — any wildcard
 * before the wrapped command would launder every command. Every rule's
 * decision and the outcome of each shape left classifier-reviewed are in
 * docs/configuration.md.
 *
 * Also accepted: `flow-pre-commit` and `flow-new-worktree` run repo-defined
 * scripts (`npm run <check>`, `npm install` lifecycle scripts). An agent that
 * edits a package.json script and then calls either helper runs that shell
 * without classifier review; they are core routine steps, so the risk is
 * taken knowingly.
 *
 * Also accepted: `flow-ui-critique` spends model quota without classifier
 * review, bounded by its $3 per-call cap and its own once-per-phase refusal.
 *
 * Also accepted: `flow-exec-review review` spends model quota without
 * classifier review, bounded by its $3 per-call cap, its zero-spend refusal
 * for any epic without a grant, and a round cap of five per plan.
 * `flow-exec-review charter` writes the owner's values file and is
 * deliberately NOT pre-approved (never a bare `Bash(flow-exec-review *)`), so
 * the classifier still reviews every charter edit.
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
  "flow-annotate-pr",
  "flow-post-findings",
  "flow-reply-pr-comments",
  "flow-plan-review-wait",
  "flow-ui-critique",
];

export const FLOW_NEVER_ALLOW_HELPERS: readonly string[] = [
  "flow-merge-guard",
  "flow-spawn",
];

export const FLOW_NARROW_ALLOW_RULES: Readonly<
  Record<string, readonly string[]>
> = {
  "flow-spawn": [
    "Bash(flow-spawn --class default -- flow-ci-wait *)",
    "Bash(flow-spawn --class default -- flow-plan-review-wait *)",
  ],
};

export const FLOW_ROUTINE_ALLOW_RULES: readonly string[] =
  FLOW_ROUTINE_HELPERS.flatMap((h) => [`Bash(${h})`, `Bash(${h} *)`]);

/**
 * One rule per `flow-exec-review` subcommand — never a blanket
 * `Bash(flow-exec-review *)` and never `charter`, which writes the owner's
 * brief.
 */
export const FLOW_EXEC_REVIEW_ALLOW_RULES: readonly string[] = [
  "Bash(flow-exec-review status *)",
  "Bash(flow-exec-review review *)",
  "Bash(flow-exec-review order *)",
  "Bash(flow-exec-review outcome *)",
  "Bash(flow-exec-review stamp-check *)",
];
