/**
 * Gate-time fill-in: a required UI review that did not run and left no box for
 * the owner to tick would make the gate unsatisfiable, so the gate adds the
 * not-run DECISION line itself. The pure builder is `ensureNotRunBox`; the
 * only side effect is `addMissingNotRunBox`'s `gh pr edit`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { testStepsSectionBounds, type GhRunner } from "../flow-gate-decide";
import { emptyLoopLog, type LoopLog } from "./ui-critique";
import {
  notRunDecisionItem,
  plainReason,
  renderUiReview,
} from "./ui-critique-render";
import { insertSectionIfAbsent, upsertNotRunItem } from "./ui-review-body";
import { notRunAccepted, type UiReviewGate } from "./ui-review-gate";

export function ensureNotRunBox(
  body: string,
  ui: UiReviewGate,
  log: LoopLog | null,
): string | null {
  if (ui.satisfied || ui.stale || !ui.required) return null;
  if (testStepsSectionBounds(body.split("\n")) === null) return null;
  if (notRunAccepted(body)) return null;
  const code = log?.skip || "no-review-record";
  const section = renderUiReview({
    before: [],
    after: null,
    log: {
      ...emptyLoopLog(),
      required: true,
      skip: code,
      playwrightWarning: log?.playwrightWarning,
    },
    demotion: null,
  });
  const next = insertSectionIfAbsent(
    upsertNotRunItem(body, notRunDecisionItem(plainReason(code))),
    section,
  );
  return notRunAccepted(next) ? next : null;
}

export type AddBoxResult =
  | { kind: "unchanged" }
  | { kind: "written"; body: string }
  | { kind: "error"; message: string };

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";

/** Re-reads the PR body first so a tick made since the gate fetched survives. */
export function addMissingNotRunBox(i: {
  pr: number;
  ui: UiReviewGate;
  log: LoopLog | null;
  gh: GhRunner;
}): AddBoxResult {
  const view = i.gh([
    "pr",
    "view",
    String(i.pr),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  if (view.exitCode !== 0) {
    return {
      kind: "error",
      message: firstLine(view.stderr) || "gh pr view failed",
    };
  }
  const next = ensureNotRunBox(view.stdout.replace(/\n$/, ""), i.ui, i.log);
  if (next === null) return { kind: "unchanged" };
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ui-not-run-"));
    const file = path.join(dir, "body.md");
    fs.writeFileSync(file, next);
    const edit = i.gh(["pr", "edit", String(i.pr), "--body-file", file]);
    if (edit.exitCode !== 0) {
      return {
        kind: "error",
        message: firstLine(edit.stderr) || "gh pr edit failed",
      };
    }
    return { kind: "written", body: next };
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}
