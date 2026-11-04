/**
 * The auto-merge backstop for the design review: a UI diff that has neither a
 * completed review nor a not-run `DECISION:` item must not merge silently.
 * One implementation shared by `flow-gate-decide` and `flow-merge-guard`, so
 * the two never disagree.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DecisionResult } from "../flow-gate-decide";
import { testStepsSectionBounds } from "../flow-gate-decide";
import {
  fencedLineMask,
  findUnterminatedHtmlBlockLines,
} from "./md-block-structure";
import { parseLoopLog, type LoopLog } from "./ui-critique";
import { readUiCritiqueEnabled } from "./ui-critique-config";
import { plainReason, UI_REVIEW_DECISION_MARKER } from "./ui-critique-render";
import { branchChangedFiles, changedSinceCommit } from "./ui-review-diff";
import { isRenderBearing, uiReviewRequired } from "./ui-review-scope";

export type UiReviewGate = {
  required: boolean;
  satisfied: boolean;
  reason: string | null;
};

const COMPLETED: readonly string[] = ["clean", "kept", "reverted", "list-only"];
const UNREADABLE = "ui-review-check: diff unreadable";

/**
 * The marker is an HTML comment, which the Test Steps parse strips, so it is
 * found in the RAW lines of the section — skipping fenced output and a span
 * GitHub renders as raw HTML, where a reviewer could not have ticked it.
 */
function decisionMarked(body: string): boolean {
  const lines = body.split("\n");
  const bounds = testStepsSectionBounds(lines);
  if (bounds === null) return false;
  const fenced = fencedLineMask(lines);
  const section = lines.slice(bounds.start + 1, bounds.end);
  const trapped = findUnterminatedHtmlBlockLines(section.join("\n"));
  return section.some(
    (l, i) =>
      !fenced[bounds.start + 1 + i] &&
      !trapped.has(i) &&
      l.includes(UI_REVIEW_DECISION_MARKER),
  );
}

export function checkUiReviewGate(i: {
  changedFiles: string[] | null;
  /** `git diff --name-only <log.headSha>...HEAD`; null when unreadable. */
  changedSinceReview: string[] | null;
  log: LoopLog | null;
  body: string;
  enabled: boolean;
}): UiReviewGate {
  const ok = (
    required: boolean,
    reason: string | null = null,
  ): UiReviewGate => ({
    required,
    satisfied: true,
    reason,
  });
  const required =
    i.changedFiles !== null
      ? uiReviewRequired(i.changedFiles).required
      : (i.log?.required ?? null);
  if (required === null) return ok(false, UNREADABLE);
  if (!required) return ok(false);
  if (!i.enabled) return ok(true);

  const marked = decisionMarked(i.body);
  const completed = i.log?.outcome != null && COMPLETED.includes(i.log.outcome);
  if (!completed) {
    if (marked) return ok(true);
    const why = i.log?.skip
      ? plainReason(i.log.skip)
      : "no UI review record for this PR";
    return {
      required: true,
      satisfied: false,
      reason: `UI review did not run: ${why}`,
    };
  }

  const judged = i.log?.headSha;
  if (!judged) return ok(true);
  if (i.changedSinceReview === null) return ok(true, UNREADABLE);
  if (i.changedSinceReview.some(isRenderBearing) && !marked) {
    return {
      required: true,
      satisfied: false,
      reason: `UI changed after the design review (judged ${judged.slice(0, 7)})`,
    };
  }
  return ok(true);
}

const LOG_PATH = path.join(".flow-tmp", "ui-critique", "log.json");

export type UiReviewDeps = {
  readFile?: (p: string) => string | null;
  changedFiles?: (worktree: string, base?: string | null) => string[] | null;
  changedSince?: (worktree: string, sha: string) => string[] | null;
  home?: string;
};

function tryRead(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** `null` when verify never wrote a log for this worktree. */
export function readUiReviewLog(
  worktree: string,
  readFile: (p: string) => string | null = tryRead,
): LoopLog | null {
  const raw = readFile(path.join(worktree, LOG_PATH));
  return raw === null ? null : parseLoopLog(raw);
}

/** What the checker needs from the worktree and config, read once. */
export function collectUiReviewInputs(
  worktree: string,
  base: string | null | undefined,
  deps: UiReviewDeps = {},
): {
  changedFiles: string[] | null;
  changedSinceReview: string[] | null;
  enabled: boolean;
  log: LoopLog | null;
} {
  const readFile = deps.readFile ?? tryRead;
  const log = readUiReviewLog(worktree, readFile);
  const home = deps.home ?? os.homedir();
  return {
    changedFiles: (deps.changedFiles ?? branchChangedFiles)(worktree, base),
    changedSinceReview: log?.headSha
      ? (deps.changedSince ?? changedSinceCommit)(worktree, log.headSha)
      : null,
    enabled: readUiCritiqueEnabled(() =>
      readFile(path.join(home, ".flow", "config.json")),
    ),
    log,
  };
}

export function computeUiReviewGate(
  i: { worktree: string; base?: string | null; body: string },
  deps: UiReviewDeps = {},
): UiReviewGate {
  return checkUiReviewGate({
    ...collectUiReviewInputs(i.worktree, i.base, deps),
    body: i.body,
  });
}

/** The human-only item an unsatisfied check stands in for in a verdict. */
export const uiReviewItem = (reason: string | null): string =>
  `DECISION: ${reason ?? "UI review did not run"} — merge without it, or redirect to fix`;

/**
 * Folds the check into a test-steps verdict: an unsatisfied check turns an
 * auto-merge into a gate (human-only item, so `browser-retry` stays
 * possible) and is named in every other open-PR reason.
 */
export function applyUiReview(
  result: DecisionResult,
  ui: UiReviewGate | undefined,
): DecisionResult {
  const open = ["auto-merge", "gated", "browser-retry"];
  if (!ui || !open.includes(result.decision)) return result;
  const out: DecisionResult = { ...result, uiReview: ui };
  if (ui.satisfied) {
    if (ui.reason) out.reason = `${result.reason} (${ui.reason})`;
    return out;
  }
  const item = uiReviewItem(ui.reason);
  if (result.decision === "auto-merge") {
    return {
      ...out,
      decision: "gated",
      validationItems: [item],
      reason: ui.reason ?? item,
    };
  }
  return {
    ...out,
    validationItems: [...(result.validationItems ?? []), item],
    reason: `${result.reason} (${ui.reason})`,
  };
}
