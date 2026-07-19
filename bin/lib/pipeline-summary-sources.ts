/**
 * Per-category source parsers for `flow-pipeline-summary`'s
 * `## PIPELINE SNAPSHOT` block. Each `render*` returns the array of
 * body lines for one section (the caller indents them and prints the
 * section header). The explicit-`none` discipline lives here: an empty
 * or absent source yields `["none"]`, never a fabricated line.
 *
 * Split out of `flow-pipeline-summary.ts` to keep that file < 200 lines
 * (AGENTS.md), per the documented `bin/lib/` escape valve.
 */

import { validatePrReviewResult } from "./pr-review-result-schema";
import { collectFixApplierTolerant } from "./fix-applier-tolerant";
import {
  normalizeParsedFindings,
  validateConsolidatorResult,
} from "./agent-finding-schema";
import { formatDuration } from "./time";
import {
  formatPlainText,
  collectForeclosedEntries,
  isEmpty,
} from "./foreclosed-paths-format";

const NONE = ["none"];

/** CHANGES: one line from the `gh pr view` JSON, or `none`. */
export function renderChanges(raw: string): string[] {
  if (!raw.trim()) return NONE;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const additions = Number(o.additions ?? 0);
    const deletions = Number(o.deletions ?? 0);
    const changedFiles = Number(o.changedFiles ?? 0);
    const commits = Number(o.commits ?? 0);
    return [
      `${commits} commits, +${additions}/-${deletions} across ${changedFiles} files`,
    ];
  } catch {
    return ["(unreadable)"];
  }
}

/**
 * PHASES: one line per phaseLog entry in order, or `none`. Each line carries
 * the time spent in that phase — the gap from its `at` to the next entry's
 * `at` — as a ` (3m12s)` suffix. The final entry (no successor) and any entry
 * whose own or adjacent `at` is unparseable, zero, or out-of-order render with
 * no suffix rather than a garbage value.
 */
export function renderPhases(
  phaseLog: Array<{ phase: string; outcome?: string; at: string }> | null,
): string[] {
  if (!phaseLog || phaseLog.length === 0) return NONE;
  return phaseLog.map((e, i) => {
    const base =
      e.outcome !== undefined ? `${e.phase} -> ${e.outcome}` : e.phase;
    const next = phaseLog[i + 1];
    if (!next) return base;
    const start = Date.parse(e.at);
    const end = Date.parse(next.at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return base;
    const duration = formatDuration(end - start);
    return duration ? `${base} (${duration})` : base;
  });
}

/**
 * FINDINGS: review verdict + fix-applier counts + consolidator counts +
 * CI/Copilot. Any individual artifact failing its validator degrades to a
 * `(unreadable)` sub-line, not a crash. `none` only when NONE of these
 * artifacts are present.
 */
export function renderFindings(inputs: {
  prReviewRaw: string;
  fixApplierRaw: string;
  consolidatorRaw: string;
  ciWaitRaw: string;
}): string[] {
  const lines: string[] = [];
  const any =
    inputs.prReviewRaw.trim() ||
    inputs.fixApplierRaw.trim() ||
    inputs.consolidatorRaw.trim() ||
    inputs.ciWaitRaw.trim();
  if (!any) return NONE;

  if (inputs.prReviewRaw.trim()) {
    const parsed = parseJson(inputs.prReviewRaw);
    const v = parsed === undefined ? undefined : validatePrReviewResult(parsed);
    if (!v || !v.ok) lines.push("review: (unreadable)");
    else lines.push(`review: ${v.value.status} — ${v.value.summary}`);
  }

  if (inputs.fixApplierRaw.trim()) {
    const parsed = parseJson(inputs.fixApplierRaw);
    // Tolerant read: a single off-shape entry no longer nukes the valid
    // counts; only a genuinely-broken artifact (-> null) degrades to
    // (unreadable). A residual `(N unreadable)` marker surfaces dropped entries.
    const r = parsed === undefined ? null : collectFixApplierTolerant(parsed);
    if (!r) lines.push("fixes: (unreadable)");
    else {
      const residual = r.skipped > 0 ? ` (${r.skipped} unreadable)` : "";
      lines.push(
        `fixes: ${r.commits.length} fixed in-cycle, ${r.deferred.length} deferred, ${r.anti_patterns_found.length} anti-patterns noted${residual}`,
      );
    }
  }

  if (inputs.consolidatorRaw.trim()) {
    const parsed = parseJson(inputs.consolidatorRaw);
    const v =
      parsed === undefined
        ? undefined
        : validateConsolidatorResult(normalizeParsedFindings(parsed));
    if (!v || !v.ok) lines.push("consolidator: (unreadable)");
    else {
      const r = v.value;
      lines.push(
        `consolidator: ${r.consolidated_findings.length} findings, ${r.dropped_by_validation.length} dropped`,
      );
    }
  }

  if (inputs.ciWaitRaw.trim()) {
    // No schema validator exists for ci-wait-result.json — parse defensively.
    try {
      const o = JSON.parse(inputs.ciWaitRaw) as Record<string, unknown>;
      lines.push(`CI: ${String(o.decision ?? "(unknown)")}`);
      lines.push(`Copilot: ${copilotOutcome(o)}`);
    } catch {
      lines.push("CI: (unreadable)");
    }
  }

  return lines;
}

/**
 * FORECLOSED PATHS: full prose of the fix-applier + consolidator rejected
 * alternatives and anti-patterns, in plain-text mode (the PR-body section
 * shares the same core formatter). `none` when the entry set is empty; a
 * shape-invalid artifact degrades to an `(unreadable)` contribution for that
 * source rather than crashing.
 */
export function renderForeclosedPaths(inputs: {
  fixApplierRaw: string;
  consolidatorRaw: string;
}): string[] {
  if (isEmpty(collectForeclosedEntries(inputs))) return NONE;
  return formatPlainText(inputs);
}

function copilotOutcome(o: Record<string, unknown>): string {
  if (o.copilotConfigured === false) return "not configured";
  if (typeof o.copilotSkipReason === "string" && o.copilotSkipReason) {
    return `skipped (${o.copilotSkipReason})`;
  }
  return "reviewed";
}

/**
 * FOLLOW-UP ISSUES: filed sweep URLs + unfiled warnings from
 * --filed-issues-file, PLUS pr-review deferrals from fix-applier-result.
 * `none` when there are no filed lines and no deferrals.
 */
export function renderFollowupIssues(
  filedIssuesRaw: string,
  fixApplierRaw: string,
): string[] {
  const lines: string[] = [];
  for (const raw of filedIssuesRaw.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // The step-10 sweep writes `filed\t<url>` and `unfiled\t<title>`; a bare
    // `http…` line is also accepted as filed (resume / hand-authored files).
    if (line.startsWith("filed\t")) {
      lines.push(`filed: ${line.slice("filed\t".length)}`);
    } else if (line.startsWith("unfiled\t")) {
      lines.push(`sweep failed (unfiled): ${line.slice("unfiled\t".length)}`);
    } else if (line.startsWith("http")) {
      lines.push(`filed: ${line}`);
    }
  }
  if (fixApplierRaw.trim()) {
    const parsed = parseJson(fixApplierRaw);
    // Tolerant read (mirrors renderFindings): a sibling off-shape entry no
    // longer drops every valid deferral — only a genuinely-broken artifact
    // (-> null) contributes nothing here.
    const r = parsed === undefined ? null : collectFixApplierTolerant(parsed);
    if (r) {
      for (const d of r.deferred) {
        if (d.tracker_entry_url) {
          lines.push(`pr-review deferral: ${d.tracker_entry_url}`);
        } else {
          lines.push(`deferred (unfiled): ${d.reason || d.finding_id}`);
        }
      }
    }
  }
  return lines.length > 0 ? lines : NONE;
}

/**
 * MANUAL STEPS: the already-rendered followups block embedded verbatim
 * (preserves the ran/failed results `flow-followups run` captured), or
 * `none` when empty.
 */
export function renderManualSteps(block: string): string[] {
  const trimmed = block.replace(/\n+$/, "");
  if (!trimmed.trim()) return NONE;
  return trimmed.split("\n");
}

/**
 * Rejected decisions for the slim PR comment's DECISIONS section: the
 * `rejected_alternatives[]` from BOTH the fix-applier artifact (objects with
 * `finding_id` / `considered_approach` / `why_rejected`) AND the consolidator
 * artifact (plain strings). `none` when neither artifact carries any.
 */
function rejectedDecisionLines(
  fixApplierRaw: string,
  consolidatorRaw: string,
): string[] {
  const lines: string[] = [];
  if (fixApplierRaw.trim()) {
    const parsed = parseJson(fixApplierRaw);
    // Tolerant read (mirrors renderFindings): a sibling off-shape entry no
    // longer drops every valid rejected alternative.
    const r = parsed === undefined ? null : collectFixApplierTolerant(parsed);
    if (r) {
      for (const ra of r.rejected_alternatives) {
        lines.push(
          `${ra.finding_id}: ${ra.considered_approach} — ${ra.why_rejected}`,
        );
      }
    }
  }
  if (consolidatorRaw.trim()) {
    const parsed = parseJson(consolidatorRaw);
    const v =
      parsed === undefined
        ? undefined
        : validateConsolidatorResult(normalizeParsedFindings(parsed));
    if (v && v.ok) {
      for (const r of v.value.rejected_alternatives) lines.push(r);
    }
  }
  return lines.length > 0 ? lines : NONE;
}

/**
 * Slimmed, un-fenced PR-comment block (NOT the scrollback block). A plain
 * `PIPELINE SNAPSHOT` title line (no `##`) over three 2-space-indented
 * labeled sections: CHANGES (the one-line diff summary, reusing
 * renderChanges), REVIEW (the review/findings disposition, reusing
 * renderFindings), and DECISIONS (deferred + rejected). PHASES and MANUAL
 * STEPS are intentionally dropped. Pure over already-read inputs — mirrors
 * render(); never reads files.
 */
export function renderComment(inputs: {
  prChangesRaw: string;
  prReviewRaw: string;
  fixApplierRaw: string;
  consolidatorRaw: string;
  ciWaitRaw: string;
  filedIssuesRaw: string;
}): string {
  const lines: string[] = ["PIPELINE SNAPSHOT"];
  lines.push("CHANGES:");
  for (const ln of renderChanges(inputs.prChangesRaw)) lines.push(`  ${ln}`);
  lines.push("REVIEW:");
  for (const ln of renderFindings({
    prReviewRaw: inputs.prReviewRaw,
    fixApplierRaw: inputs.fixApplierRaw,
    consolidatorRaw: inputs.consolidatorRaw,
    ciWaitRaw: inputs.ciWaitRaw,
  })) {
    lines.push(`  ${ln}`);
  }
  lines.push("DECISIONS:");
  lines.push("  deferred:");
  for (const ln of renderFollowupIssues(
    inputs.filedIssuesRaw,
    inputs.fixApplierRaw,
  )) {
    lines.push(`    ${ln}`);
  }
  lines.push("  rejected:");
  for (const ln of rejectedDecisionLines(
    inputs.fixApplierRaw,
    inputs.consolidatorRaw,
  )) {
    lines.push(`    ${ln}`);
  }
  return lines.join("\n");
}

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
