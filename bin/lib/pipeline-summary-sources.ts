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
import { validateFixApplierResult } from "./fix-applier-schema";
import { validateConsolidatorResult } from "./agent-finding-schema";
import { formatDuration } from "./time";

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
    const v =
      parsed === undefined ? undefined : validateFixApplierResult(parsed);
    if (!v || !v.ok) lines.push("fixes: (unreadable)");
    else {
      const r = v.value;
      lines.push(
        `fixes: ${r.commits.length} fixed in-cycle, ${r.deferred.length} deferred, ${r.anti_patterns_found.length} anti-patterns noted`,
      );
    }
  }

  if (inputs.consolidatorRaw.trim()) {
    const parsed = parseJson(inputs.consolidatorRaw);
    const v =
      parsed === undefined ? undefined : validateConsolidatorResult(parsed);
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
    const v =
      parsed === undefined ? undefined : validateFixApplierResult(parsed);
    if (v && v.ok) {
      for (const d of v.value.deferred) {
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

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
