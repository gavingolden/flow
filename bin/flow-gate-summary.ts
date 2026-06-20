#!/usr/bin/env bun
/**
 * Renders the supervisor's gate-summary block — the colon-delimited
 * template every `/flow-pipeline` end-state and pending-checkpoint
 * site prints to hand control back to the user.
 *
 * Why: the supervisor hands control back at ~12 distinct sites (every
 * terminal end-state, every NEEDS HUMAN escalation, the
 * plan-pending-review checkpoint, candidate-issue overflow,
 * conflict-class merge failure). Each used to emit a differently-shaped
 * block of ad-hoc prose. The user had to read the whole tail of
 * scrollback and infer whether any manual action was required and what
 * it was, separately for each shape. This helper renders one canonical
 * block — `STATUS:` / `PR:` / `WHY:` / `NEXT ACTION:` / optional
 * `FOLLOW-UPS:` / sentinel — so every site looks the same.
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

export type Status =
  | "merged"
  | "gated"
  | "needs-human"
  | "awaiting-approval"
  | "cancelled";

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
export const NEXT_ACTION_BY_REASON: Record<string, string> = {
  "triage-ambiguous":
    "Attach (flow attach <slug>); restate the request with a clearer intent (feature / bug / refactor / docs / infra / chore)",
  "worktree-create-failed":
    "Inspect the flow-new-worktree stderr in scrollback; check disk space, branch-name collisions, then flow new --resume <slug>",
  "plan-missing":
    "Attach (flow attach <slug>); re-run /flow-pipeline with a more specific description, or invoke /product-planning manually in the worktree",
  "pr-missing":
    "PR creation failed upstream — check gh auth status, branch protection, and network reachability, then flow new --resume <slug>",
  "scout-missing":
    "Attach (flow attach <slug>); re-invoke /new-feature directly so the scout subagent runs again",
  "approval-ambiguous":
    "Attach (flow attach <slug>); reply with one of approve / redirect <new direction> / cancel",
  "implement-failed":
    "Attach (flow attach <slug>); inspect <worktree>/.flow-tmp/ for skill output, then redirect /new-feature with a fix hint",
  "verify-exhausted":
    "Attach (flow attach <slug>); redirect /verify with the failure hint from <worktree>/.flow-tmp/verify-failure-N.log",
  "ci-hang":
    "Attach (flow attach <slug>); inspect GitHub Actions for the stalled check, then flow new --resume <slug>",
  "pr-blocked":
    "Branch protection blocks the merge (failing required check, missing required review, CODEOWNERS, or linear-history) and waiting cannot clear it. Satisfy the protection rule on GitHub, then flow new --resume <slug>",
  "ci-fix-exhausted":
    "Attach (flow attach <slug>); inspect the last CI failure log, then redirect /new-feature mode=fix with a targeted fix hint",
  "review-fix-exhausted":
    "Attach (flow attach <slug>); inspect the unresolved /pr-review findings on the PR, then redirect /new-feature mode=fix",
  "review-failed":
    "Attach (flow attach <slug>); inspect <worktree>/.flow-tmp/pr-review-result.json (if present), then re-invoke /pr-review <PR>",
  "review-partial":
    "Attach (flow attach <slug>); inspect <worktree>/.flow-tmp/pr-review-result.json's .missed_steps, then re-invoke /pr-review <PR> --resume-from <step>",
  "gh-error":
    "Attach (flow attach <slug>); check gh auth status and network reachability, then flow new --resume <slug>",
  "pr-closed-without-merge":
    "Decide: reopen the PR (gh pr reopen <pr>) or run flow done <slug> to clean up",
  "pr-closed-mid-flight":
    "Decide: reopen the PR (gh pr reopen <pr>) or run flow done <slug> to clean up",
  "test-steps-section-missing":
    "Attach (flow attach <slug>); edit the PR body to add a ## Test Steps section, then flow new --resume <slug>",
  "gate-override-without-confirmation":
    "The PR is gated (unchecked Test Steps remain) and flow-merge-guard refused the merge. Validate the unchecked steps and merge through GitHub yourself, or reply with a fresh, explicit instruction to merge this gated PR anyway so the supervisor can confirm and record the override",
  "merge-failed":
    "Inspect <worktree>/.flow-tmp/merge-resolver-result.json (if present); resolve conflicts manually; then (cd <repo> && gh pr merge --squash <pr>)",
  "merge-resolver-missing-artifact":
    "Inspect <worktree>/.flow-tmp/ for partial resolver state; resolve conflicts manually; then (cd <repo> && gh pr merge --squash <pr>)",
  "branch-mismatch":
    "Inspect git reflog and git worktree list before any further git commands; do NOT auto-recover",
  "cross-branch-operation-attempted":
    "Inspect git worktree list and the failed command's stderr; the supervisor refused to cross worktrees; resolve manually",
  "task-tool-unavailable":
    "Restart claude (or upgrade the CLI) so the Task tool is surfaced top-level, then flow new --resume <slug>",
  "state-missing-on-resume":
    "Run flow new <description> afresh; ~/.flow/state/<slug>.json is missing so resume cannot proceed",
  "worktree-missing-on-resume":
    "Decide: recreate the worktree manually (git worktree add) or run flow done <slug> to clean up",
  "flow-setup-upgrade-failed":
    "Run flow setup --upgrade manually from the canonical install root and inspect its output",
  "fix-applier-missing-artifact":
    "Inspect git log on the feature branch and the PR body's Local Follow-ups section before re-invoking /pr-review",
  "pr-review-missing-artifact":
    "Attach (flow attach <slug>); inspect <worktree>/.flow-tmp/ for partial state, then re-invoke /pr-review <PR>",
  "coder-failed":
    "Attach (flow attach <slug>); inspect <worktree>/.flow-tmp/coder-result.json (if present), then re-invoke the caller skill",
};

type Args = {
  status: Status;
  prUrl?: string;
  why?: string;
  reason?: string;
  validationItemsFile?: string;
  deferredFile?: string;
  worktree?: string;
  planFile?: string;
  echoProse?: boolean;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // --echo-prose is a boolean flag with no value; handle it before the
    // value-required guard so it doesn't consume the next token.
    if (flag === "--echo-prose") {
      out.echoProse = true;
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
    return `${mapped} (spawn site: ${suffix})`;
  }
  return mapped;
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

function renderMerged(inputs: GateSummaryInputs): string {
  const lines: string[] = ["STATUS: MERGED"];
  if (inputs.prUrl) lines.push(`PR: ${inputs.prUrl}`);
  const why = oneLine(inputs.why);
  if (why) lines.push(`WHY: ${why}`);
  lines.push("NEXT ACTION: none (post-merge cleanup already ran)");
  appendFollowups(lines, inputs.deferredBlock);
  lines.push("MERGED");
  return lines.join("\n");
}

function renderGated(inputs: GateSummaryInputs): string {
  const lines: string[] = ["STATUS: GATED"];
  if (inputs.prUrl) lines.push(`PR: ${inputs.prUrl}`);
  const why = oneLine(inputs.why);
  if (why) lines.push(`WHY: ${why}`);
  const mergeVerb = inputs.prUrl
    ? `validate then run: gh pr merge --squash ${extractPrNumber(inputs.prUrl) ?? "<pr>"}`
    : "validate then run: gh pr merge --squash <pr>";
  lines.push(`NEXT ACTION: ${mergeVerb}`);
  const items = inputs.validationItems ?? [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    // Items may arrive pre-bulleted (e.g. read verbatim from a file
    // containing "- foo") or as bare text; normalise to the same
    // two-space indent + leading `- ` shape.
    const stripped = trimmed.replace(/^[-*]\s+/, "");
    lines.push(`  - ${stripped}`);
  }
  appendFollowups(lines, inputs.deferredBlock);
  const sentinel = inputs.prUrl ? `GATED: ${inputs.prUrl}` : "GATED:";
  lines.push(sentinel);
  return lines.join("\n");
}

function renderNeedsHuman(inputs: GateSummaryInputs): string {
  const lines: string[] = ["STATUS: NEEDS HUMAN"];
  if (inputs.prUrl) lines.push(`PR: ${inputs.prUrl}`);
  // The WHY field carries the inline context. When `--reason` is set
  // but `--why` is omitted, surface the bare reason tag — the user
  // still gets the escalation tag printed twice (once on the WHY
  // line, once on the sentinel) which matches the historical inline
  // `echo "NEEDS HUMAN: <reason>"` shape callers had to maintain by
  // hand.
  const why =
    oneLine(inputs.why) || (inputs.reason ? oneLine(inputs.reason) : "");
  if (why) lines.push(`WHY: ${why}`);
  lines.push(`NEXT ACTION: ${nextActionForReason(inputs.reason)}`);
  appendFollowups(lines, inputs.deferredBlock);
  const reasonText = inputs.reason ? oneLine(inputs.reason) : "<reason>";
  lines.push(`NEEDS HUMAN: ${reasonText}`);
  return lines.join("\n");
}

function renderAwaitingApproval(inputs: GateSummaryInputs): string {
  const lines: string[] = [];
  // --echo-prose PREPENDS the delimited recap block above STATUS. At
  // awaiting-approval no reviewable artifact exists yet, so only the path
  // fields are populated; review/CI/count fields render `none`. The block is
  // the SAME marker pair flow-pipeline-summary uses; --echo-prose is a strict
  // no-op on the four sentinel-bearing statuses (handled by their own
  // renderers, which never read inputs.echoProse).
  if (inputs.echoProse) {
    const recap = renderEchoRecap({ planFile: inputs.planFile });
    lines.push(recap, "");
  }
  lines.push("STATUS: AWAITING APPROVAL");
  const why = oneLine(inputs.why);
  if (why) lines.push(`WHY: ${why}`);
  lines.push("NEXT ACTION: reply approve / redirect <new direction> / cancel");
  // The two path bullets are the LAST lines of the block (no
  // sentinel). No trailing punctuation — most terminals greedily
  // extend URL auto-detection through trailing dots and break the
  // click target. See SKILL.md:629 for the canonical explanation.
  if (inputs.worktree) lines.push(`  - ${inputs.worktree}`);
  if (inputs.planFile) lines.push(`  - ${inputs.planFile}`);
  return lines.join("\n");
}

function renderCancelled(inputs: GateSummaryInputs): string {
  const lines: string[] = ["STATUS: CANCELLED"];
  const why = oneLine(inputs.why);
  if (why) lines.push(`WHY: ${why}`);
  lines.push("NEXT ACTION: none");
  lines.push("cancelled");
  return lines.join("\n");
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

export function run(argv: string[]): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-gate-summary: ${parsed.error}\n`);
    process.stderr.write(
      "usage: flow-gate-summary --status <merged|gated|needs-human|awaiting-approval|cancelled>\n" +
        "                         [--pr-url <url>] [--why <text>] [--reason <tag>]\n" +
        "                         [--validation-items-file <path>] [--deferred-file <path>]\n" +
        "                         [--worktree <path>] [--plan-file <path>] [--echo-prose]\n",
    );
    return 2;
  }
  const validationRaw = readFileOrEmpty(parsed.validationItemsFile);
  const validationItems = parseValidationItems(validationRaw);
  const deferredBlock = readFileOrEmpty(parsed.deferredFile);
  const block = render({
    status: parsed.status,
    prUrl: parsed.prUrl,
    why: parsed.why,
    reason: parsed.reason,
    validationItems,
    deferredBlock,
    worktree: parsed.worktree,
    planFile: parsed.planFile,
    echoProse: parsed.echoProse,
  });
  process.stdout.write(block + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
