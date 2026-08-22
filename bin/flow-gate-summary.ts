#!/usr/bin/env bun
/**
 * Renders the supervisor's gate-summary block — the colon-delimited
 * template every `/flow-pipeline` end-state and pending-checkpoint
 * site prints to hand control back to the user.
 *
 * Why: the supervisor hands control back at ~12 distinct sites (every
 * terminal end-state, every NEEDS HUMAN escalation, the
 * plan-pending-review checkpoint, conflict-class merge failure). Each
 * used to emit a differently-shaped
 * block of ad-hoc prose. The user had to read the whole tail of
 * scrollback and infer whether any manual action was required and what
 * it was, separately for each shape. This helper renders one canonical
 * block — `STATUS:` / `PR:` / `WHY:` / `NEXT ACTION:` / optional
 * `CLEANUP:` / optional `FOLLOW-UPS:` / sentinel — so every site looks
 * the same.
 *
 * The follow-ups slot is named generically (not `DEFERRED:`) because
 * the captured block describes follow-ups in BOTH directions: noted
 * but deferred (gated / needs-human paths, captured via
 * `flow-followups run --note-only`) and already-executed (merged path,
 * captured via `flow-followups run`). `flow-followups.formatVerdict`
 * carries its own header prefix that disambiguates the two ("LOCAL
 * FOLLOW-UPS:" vs "LOCAL FOLLOW-UPS (deferred — PR not yet merged):"),
 * so the slot label only names the section.
 *
 * The final line of stdout is ALWAYS the sentinel: `MERGED` /
 * `GATED: <url>` / `NEEDS HUMAN: <reason>` / `cancelled` — preserving
 * the `# End conditions` table contract for `flow-stop-guard` and any
 * scrollback regex. `awaiting-approval` has no sentinel; its final two
 * lines are the worktree + plan-file path bullets (two-space indented,
 * no trailing punctuation — terminal URL auto-detection greedily eats
 * adjacent punctuation and breaks the click target).
 *
 * The per-reason NEXT_ACTION_BY_REASON mapping is the single source of
 * truth for NEEDS HUMAN escalation responses; when adding a new
 * escalation tag to `references/failure-recovery.md`, add a matching
 * entry here.
 *
 * Usage:
 *   flow-gate-summary --status <merged|gated|needs-human|awaiting-approval|cancelled>
 *                     [--pr-url <url>]
 *                     [--why <one-line reason>]
 *                     [--reason <needs-human-tag>]
 *                     [--validation-items-file <path>]
 *                     [--deferred-file <path>]
 *                     [--worktree <path>]
 *                     [--plan-file <path>]
 *                     [--echo-prose]   (awaiting-approval only; no-op elsewhere)
 *                     [--cleanup]      (renders the terminal-state reap verdict from state.reap)
 *
 * Empty / missing --validation-items-file and --deferred-file are
 * silently suppressed (same convention as `flow-followups.formatVerdict`'s
 * empty-return). The call site does not need to test-then-call.
 *
 * Exit codes:
 *   0 — block rendered to stdout.
 *   2 — bad CLI args.
 */

import * as fs from "node:fs";
import { renderEchoRecap } from "./lib/echo-recap";
import { readState, type ReapRecord } from "./lib/state";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { resolveLens, type OutputLens } from "./lib/output-lens";
import {
  TLDR_MAX_WORDS,
  buildManualAction,
  buildNeedsAttention,
  buildUntracked,
  clampTldr,
} from "./lib/gate-summary-rows";

export type Status =
  | "merged"
  | "gated"
  | "needs-human"
  | "awaiting-approval"
  | "cancelled";

/**
 * The four terminal-state reap verdicts `--cleanup` can render, resolved by
 * `resolveCleanupInput` from `~/.flow/state/<slug>.json`. `record` is the
 * fresh happy path (ok or unclean, both carry a `ReapRecord`); `stale` is a
 * record that predates this render's own `updatedAt` (see the KNOWN
 * STALENESS GAP comment on `renderCleanup`); `missing-record` is a pipeline
 * state file with no `reap` field at all; `no-state` is no resolvable slug
 * or no state file for it.
 */
export type CleanupInput =
  | { kind: "record"; record: ReapRecord }
  | { kind: "stale"; record: ReapRecord }
  | { kind: "missing-record" }
  | { kind: "no-state" };

export type GateSummaryInputs = {
  status: Status;
  prUrl?: string;
  why?: string;
  reason?: string;
  validationItems?: string[];
  deferredBlock?: string;
  worktree?: string;
  planFile?: string;
  echoProse?: boolean;
  cleanup?: CleanupInput;
  /** One sentence, already clamped to TLDR_MAX_WORDS — see `clampTldr`. */
  tldr?: string;
  /**
   * Optional and defaults to `"dev"` at this pure-function layer — the
   * CLI (`run()`) is where `resolveLens` applies the real flag > config >
   * `"pm"` precedence and where every SKILL.md call site passes `--lens`
   * explicitly, so this default only governs a direct `render()` call
   * (e.g. every pre-existing test in `flow-gate-summary.test.ts`) that
   * omits `lens` — it must keep reproducing today's shape unchanged.
   */
  lens?: OutputLens;
  /** Pre-rendered `flow-untracked render --format gate --unfiled-only` lines. */
  untrackedBlock?: string;
  /** The one composed count line, e.g. "12 findings fixed, 2 deferred". */
  countsLine?: string;
};

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "merged",
  "gated",
  "needs-human",
  "awaiting-approval",
  "cancelled",
]);

// The fallback NEXT ACTION line used when --reason is omitted or maps
// to an unknown tag. Surfaced in tests so a new escalation tag added
// to references/failure-recovery.md without a corresponding helper
// entry still produces a printable (if generic) instruction.
export const DEFAULT_NEXT_ACTION =
  "Attach (flow attach <slug>); see scrollback above for context";

// Per-reason NEXT ACTION mapping. Keys are the canonical NEEDS HUMAN
// reason tags documented in references/failure-recovery.md's cap table
// (plus the inline ones across SKILL.md). New escalation tags added to
// the cap table must also be added here.
// Multi-action recipes carry an embedded newline: `<header>\n  1. <step>\n  2.
// <step>` — see `pushNextAction` below and `references/pause-output-contract.md`
// `## Step contract` for the shape rule. A recipe with only one discrete
// action (one copy-pasteable command or one decision) stays a plain
// single-line string; it is never padded into a one-item numbered list.
export const NEXT_ACTION_BY_REASON: Record<string, string> = {
  "triage-ambiguous": `The request's intent is ambiguous.
  1. Attach (flow attach <slug>).
  2. Restate the request with a clearer intent (feature / bug / refactor / docs / infra / chore).`,
  "worktree-create-failed": `Worktree creation failed.
  1. Inspect the flow-new-worktree stderr in scrollback for disk space or branch-name collisions.
  2. Once resolved, run flow feature resume <slug>`,
  "plan-missing": `The plan file is missing.
  1. Attach (flow attach <slug>).
  2. Re-run /flow-pipeline with a more specific description, or invoke /flow-product-planning manually in the worktree.`,
  "pr-missing": `PR creation failed upstream.
  1. Check gh auth status, branch protection, and network reachability.
  2. Then run flow feature resume <slug>`,
  "scout-missing": `The scout artifact is missing.
  1. Attach (flow attach <slug>).
  2. Re-invoke /flow-new-feature directly so the scout subagent runs again.`,
  "approval-ambiguous": `The approval reply is ambiguous.
  1. Attach (flow attach <slug>).
  2. Reply with one of approve / redirect <new direction> / cancel.`,
  "implement-failed": `Implementation failed.
  1. Attach (flow attach <slug>).
  2. Inspect <worktree>/.flow-tmp/ for skill output.
  3. Redirect /flow-new-feature with a fix hint.`,
  "verify-exhausted": `Verify retries are exhausted.
  1. Attach (flow attach <slug>).
  2. Redirect /flow-verify with the failure hint from <worktree>/.flow-tmp/verify-failure-N.log`,
  "ci-hang": `CI appears stalled.
  1. Attach (flow attach <slug>).
  2. Inspect GitHub Actions for the stalled check.
  3. Once resolved, run flow feature resume <slug>`,
  "pr-blocked": `Branch protection blocks the merge (failing required check, missing required review, CODEOWNERS, or linear-history), and waiting cannot clear it.
  1. Satisfy the protection rule on GitHub.
  2. Then run flow feature resume <slug>`,
  "ci-fix-exhausted": `CI-fix retries are exhausted.
  1. Attach (flow attach <slug>).
  2. Inspect the last CI failure log.
  3. Redirect /flow-new-feature mode=fix with a targeted fix hint.`,
  "review-fix-exhausted": `Review-fix retries are exhausted.
  1. Attach (flow attach <slug>).
  2. Inspect the unresolved /flow-pr-review findings on the PR.
  3. Redirect /flow-new-feature mode=fix`,
  "review-failed": `The review run failed.
  1. Attach (flow attach <slug>).
  2. Inspect <worktree>/.flow-tmp/pr-review-result.json (if present).
  3. Re-invoke /flow-pr-review <PR>`,
  "review-partial": `The review run stopped partway through.
  1. Attach (flow attach <slug>).
  2. Inspect <worktree>/.flow-tmp/pr-review-result.json's .missed_steps
  3. Re-invoke /flow-pr-review <PR> --resume-from <step>`,
  "gh-error": `A GitHub CLI call failed.
  1. Attach (flow attach <slug>).
  2. Check gh auth status and network reachability.
  3. Then run flow feature resume <slug>`,
  "pr-closed-without-merge":
    "Decide: reopen the PR (gh pr reopen <pr>) or run flow done <slug> to clean up",
  "pr-closed-mid-flight":
    "Decide: reopen the PR (gh pr reopen <pr>) or run flow done <slug> to clean up",
  "test-steps-section-missing": `The PR body has no Test Steps section.
  1. Attach (flow attach <slug>).
  2. Edit the PR body to add a ## Test Steps section.
  3. Then run flow feature resume <slug>`,
  "gate-override-without-confirmation":
    "The PR is gated (unchecked Test Steps remain) and flow-merge-guard refused the merge. Validate the unchecked steps and merge through GitHub yourself, or reply with a fresh, explicit instruction to merge this gated PR anyway so the supervisor can confirm and record the override",
  "merge-failed": `The merge-conflict resolver failed.
  1. Inspect <worktree>/.flow-tmp/merge-resolver-result.json (if present).
  2. Resolve conflicts manually.
  3. Then run (cd <repo> && gh pr merge --squash <pr>).`,
  "merge-resolver-missing-artifact": `The merge-conflict resolver artifact is missing.
  1. Inspect <worktree>/.flow-tmp/ for partial resolver state.
  2. Resolve conflicts manually.
  3. Then run (cd <repo> && gh pr merge --squash <pr>).`,
  "merge-resolver-spawn-denied": `The permission system refused the merge-resolver subagent spawn.
  1. Recover manually: run cd <worktree> && git fetch origin <base> && git merge origin/<base>
  2. STOP and resolve every conflict marker in your editor before committing.
  3. Once resolved, run git add <resolved-files>, git commit, git push
  4. If the push is rejected non-fast-forward, origin/<pr-branch> advanced (not the base) -- run git fetch origin <pr-branch> && git merge origin/<pr-branch>, then push again; do NOT force.
  5. Then run (cd <repo> && gh pr merge --squash <pr>).`,
  "branch-mismatch":
    "Inspect git reflog and git worktree list before any further git commands; do NOT auto-recover",
  "terminal-regression": `A terminal-phase state file was about to be regressed to a non-terminal phase (likely an ambient-pane slug race from 'flow feature create' inside a flow window).
  1. Inspect ~/.flow/state/<slug>.json
  2. If the victim is genuinely terminal, restore it with flow-state-update --phase <merged|gated|...> --force --slug <victim-slug>; do NOT auto-recover.`,
  "cross-branch-operation-attempted": `The supervisor refused to cross worktrees.
  1. Inspect git worktree list and the failed command's stderr.
  2. Resolve manually.`,
  "task-tool-unavailable": `The Task tool is unavailable.
  1. Restart claude (or upgrade the CLI) so the Task tool is surfaced top-level.
  2. Then run flow feature resume <slug>`,
  "state-missing-on-resume":
    "Run flow feature create <description> afresh; ~/.flow/state/<slug>.json is missing so resume cannot proceed",
  "worktree-missing-on-resume":
    "Decide: recreate the worktree manually (git worktree add) or run flow done <slug> to clean up",
  "flow-setup-upgrade-failed":
    "Run flow install --upgrade manually from the canonical install root and inspect its output",
  "fix-applier-missing-artifact": `Fix-applier's result artifact is missing.
  1. Inspect git log on the feature branch and the PR body's Local Follow-ups section.
  2. Then re-invoke /flow-pr-review`,
  "pr-review-missing-artifact": `The PR-review result artifact is missing.
  1. Attach (flow attach <slug>).
  2. Inspect <worktree>/.flow-tmp/ for partial state.
  3. Re-invoke /flow-pr-review <PR>`,
  "coder-failed": `The edit-applier subagent failed.
  1. Attach (flow attach <slug>).
  2. Inspect <worktree>/.flow-tmp/coder-result.json (if present).
  3. Re-invoke the caller skill.`,
  "smoketest-needs-creds": `The UI-smoke pass needs a test-user credential it could not infer.
  1. Provide the test-user credential env var(s) named in .flow/ui-validation.json's credentialEnvVars (in your local .env or shell env).
  2. Then run flow feature resume <slug>`,
  "state-file-missing-on-start": `The launch likely died before writing state.
  1. Check ~/.flow/state/<slug>.json
  2. If it is missing, never work inline on the base branch — re-run flow feature create "<description>"`,
};

// One entry per NEXT_ACTION_BY_REASON key, listing the EXACT
// copy-pasteable command substrings each recipe's prose contains (or
// `[]` when the recipe is command-free). `bin/gate-summary-recipe-lint.test.ts`
// asserts every declared string is a verbatim substring of its recipe
// and that it shell-parses after placeholder substitution — this is
// the sibling-export shape rather than widening NEXT_ACTION_BY_REASON
// itself, so the render loop in flow-gate-summary.test.ts (which
// iterates Object.keys(NEXT_ACTION_BY_REASON) against a plain string
// value) stays untouched.
export const RECIPE_COMMANDS: Record<string, readonly string[]> = {
  "triage-ambiguous": ["flow attach <slug>"],
  "worktree-create-failed": ["flow feature resume <slug>"],
  "plan-missing": ["flow attach <slug>"],
  "pr-missing": ["gh auth status", "flow feature resume <slug>"],
  "scout-missing": ["flow attach <slug>"],
  "approval-ambiguous": ["flow attach <slug>"],
  "implement-failed": ["flow attach <slug>"],
  "verify-exhausted": ["flow attach <slug>"],
  "ci-hang": ["flow attach <slug>", "flow feature resume <slug>"],
  "pr-blocked": ["flow feature resume <slug>"],
  "ci-fix-exhausted": ["flow attach <slug>"],
  "review-fix-exhausted": ["flow attach <slug>"],
  "review-failed": ["flow attach <slug>"],
  "review-partial": ["flow attach <slug>"],
  "gh-error": [
    "flow attach <slug>",
    "gh auth status",
    "flow feature resume <slug>",
  ],
  "pr-closed-without-merge": ["gh pr reopen <pr>", "flow done <slug>"],
  "pr-closed-mid-flight": ["gh pr reopen <pr>", "flow done <slug>"],
  "test-steps-section-missing": [
    "flow attach <slug>",
    "flow feature resume <slug>",
  ],
  "gate-override-without-confirmation": [],
  "merge-failed": ["cd <repo> && gh pr merge --squash <pr>"],
  "merge-resolver-missing-artifact": ["cd <repo> && gh pr merge --squash <pr>"],
  "merge-resolver-spawn-denied": [
    "cd <worktree> && git fetch origin <base> && git merge origin/<base>",
    "git add <resolved-files>",
    "git commit",
    "git push",
    "git fetch origin <pr-branch> && git merge origin/<pr-branch>",
    "cd <repo> && gh pr merge --squash <pr>",
  ],
  "branch-mismatch": ["git reflog", "git worktree list"],
  "terminal-regression": [
    "flow feature create",
    "flow-state-update --phase <merged|gated|...> --force --slug <victim-slug>",
  ],
  "cross-branch-operation-attempted": ["git worktree list"],
  "task-tool-unavailable": ["flow feature resume <slug>"],
  "state-missing-on-resume": ["flow feature create <description>"],
  "worktree-missing-on-resume": ["git worktree add", "flow done <slug>"],
  "flow-setup-upgrade-failed": ["flow install --upgrade"],
  "fix-applier-missing-artifact": ["git log"],
  "pr-review-missing-artifact": ["flow attach <slug>"],
  "coder-failed": ["flow attach <slug>"],
  "smoketest-needs-creds": ["flow feature resume <slug>"],
  "state-file-missing-on-start": ['flow feature create "<description>"'],
};

// Rule-3 escape hatch: tags whose prose trips the high-recall
// command-word detector (a COMMAND_WORDS token appears somewhere in
// the prose) but carry no copy-pasteable command — every entry names
// the benign token that tripped the detector so the escape hatch stays
// auditable rather than a silent bypass.
export const RECIPE_COMMANDS_NONE: readonly string[] = [
  "gate-override-without-confirmation", // "flow-merge-guard" is narrated ("...and flow-merge-guard refused the merge"), not invoked with args
];

type Args = {
  status: Status;
  prUrl?: string;
  why?: string;
  reason?: string;
  tldr?: string;
  validationItemsFile?: string;
  deferredFile?: string;
  worktree?: string;
  planFile?: string;
  echoProse?: boolean;
  cleanup?: boolean;
  lens?: string;
  untrackedFile?: string;
  countsLine?: string;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // --echo-prose and --cleanup are boolean flags with no value; handle
    // them before the value-required guard so neither consumes the next
    // token.
    if (flag === "--echo-prose") {
      out.echoProse = true;
      continue;
    }
    if (flag === "--cleanup") {
      out.cleanup = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--status":
        if (!VALID_STATUSES.has(value)) {
          return {
            error: `--status must be one of ${[...VALID_STATUSES].join(", ")}, got '${value}'`,
          };
        }
        out.status = value as Status;
        break;
      case "--pr-url":
        out.prUrl = value;
        break;
      case "--why":
        out.why = value;
        break;
      case "--reason":
        out.reason = value;
        break;
      case "--tldr":
        out.tldr = value;
        break;
      case "--validation-items-file":
        out.validationItemsFile = value;
        break;
      case "--deferred-file":
        out.deferredFile = value;
        break;
      case "--worktree":
        out.worktree = value;
        break;
      case "--plan-file":
        out.planFile = value;
        break;
      case "--lens":
        out.lens = value;
        break;
      case "--untracked-file":
        out.untrackedFile = value;
        break;
      case "--counts-line":
        out.countsLine = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (!out.status) return { error: "--status is required" };
  return out as Args;
}

/**
 * Resolves the NEXT ACTION line for a NEEDS HUMAN escalation.
 *
 * `task-tool-unavailable:<site>` is a parameterised reason: the cap
 * table lists six sub-sites, but the helper carries one entry. The
 * suffix after the colon is interpolated into the returned NEXT ACTION
 * string so the rendered block names the exact spawn site that lost
 * its Task tool — without this, all six exemption sites collapse to
 * the same generic remediation line, defeating the per-tag mapping
 * pattern. Other unmapped reasons fall back to DEFAULT_NEXT_ACTION.
 */
function nextActionForReason(reason: string | undefined): string {
  if (!reason) return DEFAULT_NEXT_ACTION;
  // Split on first ':' so 'task-tool-unavailable: <site>' picks up the
  // base mapping; the suffix is interpolated as site context.
  const colonIdx = reason.indexOf(":");
  const head = colonIdx >= 0 ? reason.slice(0, colonIdx).trim() : reason.trim();
  const suffix = colonIdx >= 0 ? reason.slice(colonIdx + 1).trim() : "";
  const mapped = NEXT_ACTION_BY_REASON[head];
  if (!mapped) return DEFAULT_NEXT_ACTION;
  if (head === "task-tool-unavailable" && suffix.length > 0) {
    // For a multi-line recipe the suffix belongs on the header (first)
    // line, never on the last numbered step — it names the spawn site
    // the escalation is about, not a qualifier on the final action.
    const newlineIdx = mapped.indexOf("\n");
    if (newlineIdx === -1) {
      return `${mapped} (spawn site: ${suffix})`;
    }
    const header = mapped.slice(0, newlineIdx);
    const rest = mapped.slice(newlineIdx);
    return `${header} (spawn site: ${suffix})${rest}`;
  }
  return mapped;
}

/**
 * Pushes the NEXT ACTION row onto `lines`. A single-line recipe renders
 * exactly as before: `NEXT ACTION: <text>`. A multi-line recipe (an
 * embedded-newline `<header>\n  1. <step>\n  2. <step>` string — see
 * `references/pause-output-contract.md` `## Step contract`) renders its
 * header on the `NEXT ACTION:` row and every subsequent line verbatim,
 * one per array entry, so the numbered steps land on their own lines
 * once `lines` is newline-joined.
 */
function pushNextAction(lines: string[], text: string): void {
  const parts = text.split("\n");
  lines.push(`NEXT ACTION: ${parts[0]}`);
  for (let i = 1; i < parts.length; i++) {
    lines.push(parts[i]);
  }
}

// Collapse newlines + trim. The renderer accepts free-form `why`
// strings (e.g. `gh pr view` stderr) and must keep them on a single
// row. Length is not truncated — terminals wrap, and the WHY field is
// the user's primary diagnostic surface.
function oneLine(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/[\r\n]+/g, " ").trim();
}

function suppressed(content: string | undefined): boolean {
  if (content === undefined || content === null) return true;
  return content.trim() === "";
}

export function render(inputs: GateSummaryInputs): string {
  switch (inputs.status) {
    case "merged":
      return renderMerged(inputs);
    case "gated":
      return renderGated(inputs);
    case "needs-human":
      return renderNeedsHuman(inputs);
    case "awaiting-approval":
      return renderAwaitingApproval(inputs);
    case "cancelled":
      return renderCancelled(inputs);
  }
}

// Prepends `TLDR: <text>` as the literal first line — Q16/Task-9: "first
// row on every status" (including awaiting-approval and cancelled),
// independent of lens. Absent `tldr` ⇒ no row (never required — a missing
// --tldr must never block a terminal render).
function pushTldr(lines: string[], tldr: string | undefined): void {
  const t = oneLine(tldr);
  if (t) lines.unshift(`TLDR: ${t}`);
}

function effectiveLens(inputs: GateSummaryInputs): OutputLens {
  return inputs.lens ?? "dev";
}

function renderMerged(inputs: GateSummaryInputs): string {
  const lines: string[] = ["STATUS: MERGED"];
  if (inputs.prUrl) lines.push(`PR: ${inputs.prUrl}`);
  const pm = effectiveLens(inputs) === "pm";
  if (!pm) {
    const why = oneLine(inputs.why);
    if (why) lines.push(`WHY: ${why}`);
  }
  if (pm) {
    lines.push(...buildUntracked(inputs.untrackedBlock));
    if (inputs.countsLine) lines.push(oneLine(inputs.countsLine));
  }
  pushCleanup(lines, inputs.cleanup, pm);
  if (!pm) appendFollowups(lines, inputs.deferredBlock);
  lines.push("NEXT ACTION: none (post-merge cleanup already ran)");
  pushTldr(lines, inputs.tldr);
  lines.push("MERGED");
  return lines.join("\n");
}

function renderGated(inputs: GateSummaryInputs): string {
  const lines: string[] = ["STATUS: GATED"];
  if (inputs.prUrl) lines.push(`PR: ${inputs.prUrl}`);
  const pm = effectiveLens(inputs) === "pm";
  const items = inputs.validationItems ?? [];
  if (pm) {
    lines.push(...buildNeedsAttention(items, inputs.prUrl));
    lines.push(...buildManualAction(items, inputs.deferredBlock));
    lines.push(...buildUntracked(inputs.untrackedBlock));
    if (inputs.countsLine) lines.push(oneLine(inputs.countsLine));
    pushCleanup(lines, inputs.cleanup, pm);
    const mergeVerb = inputs.prUrl
      ? `gh pr merge --squash ${extractPrNumber(inputs.prUrl) ?? "<pr>"}`
      : "gh pr merge --squash <pr>";
    lines.push(`NEXT ACTION: tick the items above, then: ${mergeVerb}`);
  } else {
    const why = oneLine(inputs.why);
    if (why) lines.push(`WHY: ${why}`);
    const mergeVerb = inputs.prUrl
      ? `validate then run: gh pr merge --squash ${extractPrNumber(inputs.prUrl) ?? "<pr>"}`
      : "validate then run: gh pr merge --squash <pr>";
    lines.push(`NEXT ACTION: ${mergeVerb}`);
    for (const item of items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      // Items may arrive pre-bulleted (e.g. read verbatim from a file
      // containing "- foo") or as bare text; normalise to the same
      // two-space indent + leading `- ` shape.
      const stripped = trimmed.replace(/^[-*]\s+/, "");
      lines.push(`  - ${stripped}`);
    }
    pushCleanup(lines, inputs.cleanup, pm);
    appendFollowups(lines, inputs.deferredBlock);
  }
  pushTldr(lines, inputs.tldr);
  const sentinel = inputs.prUrl ? `GATED: ${inputs.prUrl}` : "GATED:";
  lines.push(sentinel);
  return lines.join("\n");
}

function renderNeedsHuman(inputs: GateSummaryInputs): string {
  const lines: string[] = ["STATUS: NEEDS HUMAN"];
  if (inputs.prUrl) lines.push(`PR: ${inputs.prUrl}`);
  const pm = effectiveLens(inputs) === "pm";
  // The WHY field carries the inline context. When `--reason` is set
  // but `--why` is omitted, surface the bare reason tag — the user
  // still gets the escalation tag printed twice (once on the WHY
  // line, once on the sentinel) which matches the historical inline
  // `echo "NEEDS HUMAN: <reason>"` shape callers had to maintain by
  // hand.
  if (!pm) {
    const why =
      oneLine(inputs.why) || (inputs.reason ? oneLine(inputs.reason) : "");
    if (why) lines.push(`WHY: ${why}`);
  }
  if (pm) {
    lines.push(...buildUntracked(inputs.untrackedBlock));
    if (inputs.countsLine) lines.push(oneLine(inputs.countsLine));
  }
  pushCleanup(lines, inputs.cleanup, pm);
  if (!pm) appendFollowups(lines, inputs.deferredBlock);
  pushNextAction(lines, nextActionForReason(inputs.reason));
  pushTldr(lines, inputs.tldr);
  const reasonText = inputs.reason ? oneLine(inputs.reason) : "<reason>";
  lines.push(`NEEDS HUMAN: ${reasonText}`);
  return lines.join("\n");
}

function renderAwaitingApproval(inputs: GateSummaryInputs): string {
  const lines: string[] = [];
  const pm = effectiveLens(inputs) === "pm";
  // --echo-prose PREPENDS the delimited recap block above STATUS. At
  // awaiting-approval no reviewable artifact exists yet, so only the path
  // fields are populated; review/CI/count fields render `none`. The block is
  // the SAME marker pair flow-pipeline-summary uses; --echo-prose is a strict
  // no-op on the four sentinel-bearing statuses (handled by their own
  // renderers, which never read inputs.echoProse). Under `pm`, the
  // eight always-`none` rows carry no decision value (calibration
  // sample 1) — suppressed via `suppressNone`.
  if (inputs.echoProse) {
    const recap = renderEchoRecap({
      planFile: inputs.planFile,
      suppressNone: pm,
    });
    lines.push(recap, "");
  }
  lines.push("STATUS: AWAITING APPROVAL");
  const why = oneLine(inputs.why);
  if (why) lines.push(`WHY: ${why}`);
  lines.push("NEXT ACTION: reply approve / redirect <new direction> / cancel");
  // Carried-over untracked items (file #N / drop #N replies), pm lens
  // only — omitted entirely when there are none, unlike the terminal
  // renderers' `UNTRACKED: none` default, since a plan-pending-review
  // pause usually has nothing carried over and the row would be pure
  // noise on every ordinary run.
  if (pm) {
    const trimmed = (inputs.untrackedBlock ?? "").trim();
    if (trimmed !== "") lines.push(...buildUntracked(inputs.untrackedBlock));
  }
  // The two path bullets are the LAST lines of the block (no
  // sentinel). No trailing punctuation — most terminals greedily
  // extend URL auto-detection through trailing dots and break the
  // click target. See SKILL.md:629 for the canonical explanation.
  if (inputs.worktree) lines.push(`  - ${inputs.worktree}`);
  if (inputs.planFile) lines.push(`  - ${inputs.planFile}`);
  pushTldr(lines, inputs.tldr);
  return lines.join("\n");
}

function renderCancelled(inputs: GateSummaryInputs): string {
  const lines: string[] = ["STATUS: CANCELLED"];
  const pm = effectiveLens(inputs) === "pm";
  if (!pm) {
    const why = oneLine(inputs.why);
    if (why) lines.push(`WHY: ${why}`);
  }
  lines.push("NEXT ACTION: none");
  // No appendFollowups call on this path — cleanup sits directly between
  // NEXT ACTION and the sentinel here, not before a FOLLOW-UPS block.
  pushCleanup(lines, inputs.cleanup, pm);
  pushTldr(lines, inputs.tldr);
  lines.push("cancelled");
  return lines.join("\n");
}

/**
 * Renders exactly one `CLEANUP:` line plus at most one indented follow-on
 * ("re-run: ..."). `renderAwaitingApproval` never calls this — --cleanup is
 * a strict no-op on that status, same discipline as --echo-prose being a
 * no-op elsewhere.
 *
 * KNOWN STALENESS GAP: the invariant "the phase write follows the render"
 * is false at three call sites — the Step-4 Cancel bullet and the
 * mid-flight Cancel bullet in SKILL.md both write `phase: cancelled`
 * BEFORE the render, and the closed-no-merge row writes no phase at all —
 * so `stale` can never fire there. Accepted deliberately: moving the phase
 * write would break the render-before-transition ordering that keeps
 * state non-terminal on a render failure.
 */
export function renderCleanup(cleanup: CleanupInput): string[] {
  const rerun = "  - re-run: flow-browser-teardown --reap --dry-run";
  switch (cleanup.kind) {
    case "record": {
      const r = cleanup.record;
      if (r.status === "ok") {
        return [`CLEANUP: reap ok — ${r.summary} (recorded ${r.at})`];
      }
      return [`CLEANUP: REAP UNCLEAN — ${r.summary} (recorded ${r.at})`, rerun];
    }
    case "stale":
      return [
        `CLEANUP: REAP NOT RECORDED (stale) — this render's reap did not run; the record shown is from an earlier attempt (${cleanup.record.at})`,
        rerun,
      ];
    case "missing-record":
      return [
        "CLEANUP: REAP NOT RECORDED — the terminal-state reap did not run; spawned processes may still be alive",
        rerun,
      ];
    case "no-state":
      return ["CLEANUP: unknown — no pipeline state file for this run"];
  }
}

/**
 * `pm`-lens collapse: one row, no timestamp, no re-run follow-on bullet —
 * the reader gets the verdict, not the audit trail (`dev` keeps
 * `renderCleanup`'s full multi-line shape unchanged).
 */
function renderCleanupPm(cleanup: CleanupInput): string {
  switch (cleanup.kind) {
    case "record": {
      const r = cleanup.record;
      return r.status === "ok"
        ? `CLEANUP: reap ok — ${r.summary}`
        : `CLEANUP: REAP UNCLEAN — ${r.summary}`;
    }
    case "stale":
      return "CLEANUP: REAP NOT RECORDED (stale) — this render's reap did not run";
    case "missing-record":
      return "CLEANUP: REAP NOT RECORDED — the terminal-state reap did not run";
    case "no-state":
      return "CLEANUP: unknown — no pipeline state file for this run";
  }
}

function pushCleanup(
  lines: string[],
  cleanup: CleanupInput | undefined,
  pm = false,
): void {
  if (!cleanup) return;
  if (pm) {
    lines.push(renderCleanupPm(cleanup));
  } else {
    lines.push(...renderCleanup(cleanup));
  }
}

function appendFollowups(
  lines: string[],
  deferredBlock: string | undefined,
): void {
  if (suppressed(deferredBlock)) return;
  // Embed the flow-followups block under a FOLLOW-UPS header.
  // The deferred file content is captured stdout from
  // `flow-followups run --note-only` (or `flow-followups run` on the
  // MERGED path); flow-followups.formatVerdict carries its own
  // 2-space indent on entry lines and a blank line after the header
  // row. Strip those so this slot owns the indentation: the helper
  // is the single source of truth for what stdout looks like under
  // the FOLLOW-UPS: header. Empty lines (and the original header
  // separator) are collapsed; entries land at a clean 2-space indent.
  lines.push("FOLLOW-UPS:");
  const body = (deferredBlock as string).replace(/\n+$/, "");
  for (const raw of body.split("\n")) {
    // Drop the formatVerdict 2-space prefix on entry lines so we can
    // re-prefix uniformly. Trim trailing whitespace to avoid emitting
    // whitespace-only lines (e.g. the blank header separator becomes
    // a no-op).
    const stripped = raw.replace(/^ {2}/, "").replace(/\s+$/, "");
    if (stripped.length === 0) continue;
    lines.push(`  ${stripped}`);
  }
}

function extractPrNumber(url: string): string | null {
  // GitHub PR URLs end with /pull/<n>; also match /pr/<n> for test
  // shorthand and other Git hosts. Tolerant of trailing slash and an
  // optional fragment / query string. Returns null when no numeric
  // tail is present (the render falls back to literal `<pr>`).
  const m = url.match(/\/(?:pull|pr)\/(\d+)(?:[\/?#].*)?$/);
  return m ? m[1] : null;
}

function readFileOrEmpty(filePath: string | undefined): string {
  if (!filePath) return "";
  // Missing file → suppress silently. Same convention as
  // formatVerdict's empty-return; lets call sites pass
  // `--deferred-file "$WORKTREE/.flow-tmp/followups-block.txt"`
  // unconditionally without first stat-ing the path.
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseValidationItems(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .map((ln) => ln.replace(/\r$/, ""))
    .filter((ln) => ln.trim().length > 0);
}

/**
 * Resolves `--cleanup`'s `CleanupInput` from ambient session identity +
 * durable state. Both timestamp parses are guarded — an unparseable
 * timestamp on either side degrades to `record` (fresh), never to a false
 * stale alarm.
 */
function resolveCleanupInput(
  env: NodeJS.ProcessEnv,
  stateDir: string | undefined,
): CleanupInput {
  const slug = resolveSlugFromEnv(env);
  if (slug === null) return { kind: "no-state" };
  const state = readState(slug, stateDir);
  if (state === null) return { kind: "no-state" };
  if (!state.reap) return { kind: "missing-record" };
  const recordAt = Date.parse(state.reap.at);
  const updatedAt = Date.parse(state.updatedAt);
  if (
    !Number.isNaN(recordAt) &&
    !Number.isNaN(updatedAt) &&
    recordAt < updatedAt
  ) {
    return { kind: "stale", record: state.reap };
  }
  return { kind: "record", record: state.reap };
}

export function run(
  argv: string[],
  opts?: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    read?: Parameters<typeof resolveLens>[1];
  },
): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-gate-summary: ${parsed.error}\n`);
    process.stderr.write(
      "usage: flow-gate-summary --status <merged|gated|needs-human|awaiting-approval|cancelled>\n" +
        "                         [--pr-url <url>] [--why <text>] [--reason <tag>] [--tldr <text>]\n" +
        "                         [--validation-items-file <path>] [--deferred-file <path>]\n" +
        "                         [--worktree <path>] [--plan-file <path>] [--echo-prose]\n" +
        "                         [--cleanup] [--lens <pm|dev>] [--untracked-file <path>]\n" +
        "                         [--counts-line <text>]\n",
    );
    return 2;
  }
  const validationRaw = readFileOrEmpty(parsed.validationItemsFile);
  const validationItems = parseValidationItems(validationRaw);
  const deferredBlock = readFileOrEmpty(parsed.deferredFile);
  const cleanup = parsed.cleanup
    ? resolveCleanupInput(opts?.env ?? process.env, opts?.stateDir)
    : undefined;
  const lens = resolveLens(parsed.lens, opts?.read);
  let tldr = parsed.tldr;
  if (tldr !== undefined) {
    const clamped = clampTldr(tldr);
    if (clamped.truncated) {
      process.stderr.write(
        `flow-gate-summary: --tldr truncated to ${TLDR_MAX_WORDS} words (got ${clamped.words})\n`,
      );
    }
    tldr = clamped.text;
  }
  const untrackedBlock = readFileOrEmpty(parsed.untrackedFile);
  const block = render({
    status: parsed.status,
    prUrl: parsed.prUrl,
    why: parsed.why,
    reason: parsed.reason,
    tldr,
    validationItems,
    deferredBlock,
    worktree: parsed.worktree,
    planFile: parsed.planFile,
    echoProse: parsed.echoProse,
    cleanup,
    lens,
    untrackedBlock,
    countsLine: parsed.countsLine,
  });
  process.stdout.write(block + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
