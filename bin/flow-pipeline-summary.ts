#!/usr/bin/env bun
/**
 * Renders the supervisor's `## PIPELINE SNAPSHOT` block — an
 * artifact-sourced, phase-by-phase account printed ABOVE the
 * `flow-gate-summary` block at the post-review terminal states (MERGED,
 * GATED, NEEDS HUMAN).
 *
 * Why: the gate-summary block answers "did it merge / what's next" but not
 * "what did the pipeline actually do." Any richer trace was supervisor-
 * composed free prose — unsourced, inconsistently shaped, fabrication-prone
 * (the scrollback has scrolled past the evidence by the time the run ends).
 * This helper aggregates the structured artifacts the pipeline already
 * writes and renders ONLY sourced facts; every empty category prints an
 * explicit `none`, never a fabricated "looks like it passed."
 *
 * Six sections: CHANGES (commits/diff size), PHASES (state.json phaseLog),
 * FINDINGS (review verdict + fix-applier + consolidator + CI/Copilot),
 * FORECLOSED PATHS (fix-applier + consolidator foreclosed-path prose —
 * rejected alternatives + anti-patterns), FOLLOW-UP ISSUES (filed sweep URLs
 * + pr-review deferrals), MANUAL STEPS (the captured followups block).
 *
 * CRITICAL: this helper NEVER emits a flow-stop-guard sentinel
 * (`MERGED` / `GATED:` / `NEEDS HUMAN:` / `cancelled`). flow-gate-summary
 * owns the sentinel as the byte-exact last line of stdout; this block
 * prints above it. A shape-invalid artifact degrades that one category to
 * `(unreadable)` rather than crashing the whole snapshot.
 *
 * Durable persistence (`--post-comment <PR>`): on the MERGED status only,
 * the rendered block is ALSO posted as a top-level PR issue-comment so a
 * merged PR carries its own pipeline provenance beyond the transient tmux
 * scrollback. The write is idempotent — an HTML-comment marker
 * (`<!-- flow-pipeline-snapshot-v1 -->`) keys an edit-or-create upsert, so a
 * resume / re-run edits the existing comment in place rather than posting a
 * duplicate. The marker lives ONLY in the posted comment body, never in
 * stdout. The write is best-effort: a `gh` failure is reported to stderr and
 * never changes the exit code or the scrollback render (a peripheral
 * comment-post failure must not un-merge a PR).
 *
 * Usage:
 *   flow-pipeline-summary --status <merged|gated|needs-human>
 *                         [--state-file <path>] [--pr-changes-file <path>]
 *                         [--pr-review-result <path>] [--fix-applier-result <path>]
 *                         [--consolidator-result <path>] [--ci-wait-result <path>]
 *                         [--followups-block-file <path>] [--followups-jsonl <path>]
 *                         [--filed-issues-file <path>] [--post-comment <PR>]
 *
 * Exit codes: 0 — block rendered to stdout. 2 — bad CLI args.
 */

import * as fs from "node:fs";
import { readState } from "./lib/state";
import { readEntries, runEntries, formatVerdict } from "./flow-followups";
import { parsePrNumber } from "./flow-fetch-pr-review";
import {
  renderChanges,
  renderPhases,
  renderFindings,
  renderForeclosedPaths,
  renderFollowupIssues,
  renderManualSteps,
} from "./lib/pipeline-summary-sources";

/** Single-line HTML-comment dedup key for the persisted snapshot comment.
 *  Stable across releases (hence the -v1 suffix); it is the lookup key for
 *  the idempotent edit-or-create upsert. Lives only in the comment body. */
export const SNAPSHOT_MARKER = "<!-- flow-pipeline-snapshot-v1 -->";

type GhResult = { stdout: string; stderr: string; exitCode: number };
export type GhRunner = (argv: string[]) => GhResult;

const defaultGh: GhRunner = (argv) => {
  const r = Bun.spawnSync(["gh", ...argv], { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    exitCode: r.exitCode ?? -1,
  };
};

export type Status = "merged" | "gated" | "needs-human";

export type SummaryInputs = {
  status: Status;
  stateFile?: string;
  prChangesFile?: string;
  prReviewResult?: string;
  fixApplierResult?: string;
  consolidatorResult?: string;
  ciWaitResult?: string;
  followupsBlockFile?: string;
  followupsJsonl?: string;
  filedIssuesFile?: string;
  postComment?: string;
};

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "merged",
  "gated",
  "needs-human",
]);

type Args = SummaryInputs;

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
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
      case "--state-file":
        out.stateFile = value;
        break;
      case "--pr-changes-file":
        out.prChangesFile = value;
        break;
      case "--pr-review-result":
        out.prReviewResult = value;
        break;
      case "--fix-applier-result":
        out.fixApplierResult = value;
        break;
      case "--consolidator-result":
        out.consolidatorResult = value;
        break;
      case "--ci-wait-result":
        out.ciWaitResult = value;
        break;
      case "--followups-block-file":
        out.followupsBlockFile = value;
        break;
      case "--followups-jsonl":
        out.followupsJsonl = value;
        break;
      case "--filed-issues-file":
        out.filedIssuesFile = value;
        break;
      case "--post-comment":
        out.postComment = value;
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
 * Pure render: takes the already-read source contents (and the state-file
 * path, which readState owns) and produces the snapshot block. The block's
 * last line is NEVER a stop-guard sentinel — that is gate-summary's job.
 */
export function render(inputs: {
  prChangesRaw: string;
  phaseLog: Array<{ phase: string; outcome?: string; at: string }> | null;
  prReviewRaw: string;
  fixApplierRaw: string;
  consolidatorRaw: string;
  ciWaitRaw: string;
  filedIssuesRaw: string;
  fixApplierForIssues: string;
  manualStepsBlock: string;
}): string {
  const lines: string[] = ["## PIPELINE SNAPSHOT"];
  lines.push("CHANGES:");
  for (const ln of renderChanges(inputs.prChangesRaw)) lines.push(`  ${ln}`);
  lines.push("PHASES:");
  for (const ln of renderPhases(inputs.phaseLog)) lines.push(`  ${ln}`);
  lines.push("FINDINGS:");
  for (const ln of renderFindings({
    prReviewRaw: inputs.prReviewRaw,
    fixApplierRaw: inputs.fixApplierRaw,
    consolidatorRaw: inputs.consolidatorRaw,
    ciWaitRaw: inputs.ciWaitRaw,
  })) {
    lines.push(`  ${ln}`);
  }
  lines.push("FORECLOSED PATHS:");
  for (const ln of renderForeclosedPaths({
    fixApplierRaw: inputs.fixApplierRaw,
    consolidatorRaw: inputs.consolidatorRaw,
  })) {
    lines.push(`  ${ln}`);
  }
  lines.push("FOLLOW-UP ISSUES:");
  for (const ln of renderFollowupIssues(
    inputs.filedIssuesRaw,
    inputs.fixApplierForIssues,
  )) {
    lines.push(`  ${ln}`);
  }
  lines.push("MANUAL STEPS:");
  for (const ln of renderManualSteps(inputs.manualStepsBlock)) {
    lines.push(`  ${ln}`);
  }
  return lines.join("\n");
}

function readFileOrEmpty(filePath: string | undefined): string {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** The posted comment body is the rendered block plus the dedup marker. The
 *  marker is appended ONLY here — the block written to stdout stays clean. */
export function buildCommentBody(block: string): string {
  return `${block}\n\n${SNAPSHOT_MARKER}`;
}

/** Scans a `gh api .../issues/<pr>/comments` list response for the first
 *  comment whose body carries the snapshot marker. Returns its id, or null
 *  when none is found or the response is unparseable (treated as "no prior
 *  comment" — the caller creates a fresh one).
 *
 *  `--slurp` wraps multi-page output as an array-of-pages (`[[...],[...]]`),
 *  so we `.flat()` one level before iterating. A single-page flat array
 *  (`[{...}]`) flattens to itself (its objects aren't arrays), so the same
 *  path handles both shapes. */
export function findMarkedCommentId(listStdout: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listStdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const c of parsed.flat()) {
    if (
      c !== null &&
      typeof c === "object" &&
      typeof (c as { body?: unknown }).body === "string" &&
      (c as { body: string }).body.includes(SNAPSHOT_MARKER) &&
      typeof (c as { id?: unknown }).id === "number"
    ) {
      return (c as { id: number }).id;
    }
  }
  return null;
}

export type SnapshotCommentResult =
  | { action: "created" }
  | { action: "updated"; id: number }
  | { action: "failed"; error: string };

/** Idempotent edit-or-create of the snapshot comment on a PR. Lists existing
 *  issue-comments, PATCHes the marked one if present, else POSTs a new one.
 *  Never throws — every gh failure maps to an `{ action: "failed" }` so the
 *  caller stays best-effort. Issue-comment endpoint (not /reviews) keeps this
 *  a top-level summary comment, consistent with /pr-review's convention. */
export function postSnapshotComment(
  prNumber: number,
  block: string,
  gh: GhRunner,
): SnapshotCommentResult {
  const list = gh([
    "api",
    `repos/{owner}/{repo}/issues/${prNumber}/comments`,
    "--paginate",
    "--slurp",
  ]);
  if (list.exitCode !== 0) {
    return {
      action: "failed",
      error: list.stderr.trim() || `gh api list failed (${list.exitCode})`,
    };
  }
  const body = buildCommentBody(block);
  const existingId = findMarkedCommentId(list.stdout);
  if (existingId !== null) {
    const r = gh([
      "api",
      `repos/{owner}/{repo}/issues/comments/${existingId}`,
      "-X",
      "PATCH",
      "-f",
      `body=${body}`,
    ]);
    if (r.exitCode !== 0) {
      return {
        action: "failed",
        error: r.stderr.trim() || `gh api PATCH failed (${r.exitCode})`,
      };
    }
    return { action: "updated", id: existingId };
  }
  const r = gh([
    "api",
    `repos/{owner}/{repo}/issues/${prNumber}/comments`,
    "-f",
    `body=${body}`,
  ]);
  if (r.exitCode !== 0) {
    return {
      action: "failed",
      error: r.stderr.trim() || `gh api POST failed (${r.exitCode})`,
    };
  }
  return { action: "created" };
}

export function run(argv: string[], deps: { gh?: GhRunner } = {}): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-pipeline-summary: ${parsed.error}\n`);
    process.stderr.write(
      "usage: flow-pipeline-summary --status <merged|gated|needs-human>\n" +
        "                             [--state-file <path>] [--pr-changes-file <path>]\n" +
        "                             [--pr-review-result <path>] [--fix-applier-result <path>]\n" +
        "                             [--consolidator-result <path>] [--ci-wait-result <path>]\n" +
        "                             [--followups-block-file <path>] [--followups-jsonl <path>]\n" +
        "                             [--filed-issues-file <path>] [--post-comment <PR>]\n",
    );
    return 2;
  }
  const slug = parsed.stateFile?.replace(/\.json$/, "").replace(/.*\//, "");
  const stateDir = parsed.stateFile?.replace(/\/[^/]+$/, "");
  const state =
    slug !== undefined && stateDir !== undefined
      ? readState(slug, stateDir)
      : null;
  const fixApplierRaw = readFileOrEmpty(parsed.fixApplierResult);
  // MANUAL STEPS prefers the already-rendered block (preserves ran/failed
  // results captured by `flow-followups run` on the MERGED path). A
  // note-only JSONL re-read would lose them, so the block-file wins.
  const manualStepsBlock = parsed.followupsBlockFile
    ? readFileOrEmpty(parsed.followupsBlockFile)
    : parsed.followupsJsonl
      ? renderJsonlNoteOnly(parsed.followupsJsonl)
      : "";
  const block = render({
    prChangesRaw: readFileOrEmpty(parsed.prChangesFile),
    phaseLog: state?.phaseLog ?? null,
    prReviewRaw: readFileOrEmpty(parsed.prReviewResult),
    fixApplierRaw,
    consolidatorRaw: readFileOrEmpty(parsed.consolidatorResult),
    ciWaitRaw: readFileOrEmpty(parsed.ciWaitResult),
    filedIssuesRaw: readFileOrEmpty(parsed.filedIssuesFile),
    fixApplierForIssues: fixApplierRaw,
    manualStepsBlock,
  });
  process.stdout.write(block + "\n");

  // Durable persistence: MERGED only, opt-in via --post-comment. Best-effort —
  // a gh failure (or an unparseable PR arg) is reported to stderr and never
  // changes the exit code. The scrollback render above already happened.
  if (parsed.status === "merged" && parsed.postComment) {
    const gh = deps.gh ?? defaultGh;
    try {
      const prNumber = parsePrNumber(parsed.postComment);
      const result = postSnapshotComment(prNumber, block, gh);
      if (result.action === "failed") {
        process.stderr.write(
          `flow-pipeline-summary: snapshot comment post failed: ${result.error}\n`,
        );
      }
    } catch (e) {
      process.stderr.write(
        `flow-pipeline-summary: snapshot comment post failed: ${(e as Error).message}\n`,
      );
    }
  }

  return 0;
}

/**
 * Reads the local-followups JSONL and renders its note-only verdict.
 * `noteOnly: true` is load-bearing: it NEVER re-executes auto-allowlisted
 * entries (the MERGED path's `flow-followups run` already did), avoiding a
 * double-execution bug.
 */
function renderJsonlNoteOnly(jsonlPath: string): string {
  return formatVerdict(
    runEntries(readEntries(jsonlPath), { noteOnly: true }),
    true,
  );
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
