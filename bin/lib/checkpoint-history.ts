/**
 * Append-only history log and artifact snapshot for a pipeline's checkpoint
 * folder (`checkpoints/<slug>/history.jsonl`, `snapshot/`). Everything here
 * is best-effort and never throws: a history failure must not change a
 * helper's exit code or stdout. The path builders are the only exception —
 * they delegate to `checkpointDir`, which throws on an invalid slug, so
 * every I/O function below wraps them.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkpointBodyPath,
  checkpointDir,
  type CheckpointSite,
} from "./checkpoint-freshness";
import { parseNoteItems, type ParsedItem } from "./checkpoint-decisions";
import { flowStateDir } from "./paths";
import type { PipelineState } from "./state";
import { FLOW_TMP_DIRNAME } from "./worktree-marker";

export type GateStatus = "merged" | "gated" | "needs-human" | "cancelled";

export type HistoryEvent =
  | {
      type: "note";
      at: string;
      phase: string;
      site: CheckpointSite | "unarmed";
      sha: string;
      body: string;
      items: ParsedItem[];
    }
  | {
      type: "gate";
      at: string;
      status: GateStatus;
      tldr?: string;
      prUrl?: string;
      reason?: string;
    }
  | { type: "snapshot"; at: string; files: string[]; skipped: string[] }
  | { type: "journal"; at: string; phase: string; body: string };

export const SNAPSHOT_FILES = [
  "plan.md",
  "body.md",
  "pr-body.md",
  "pr-description-draft.md",
  "scout.md",
  "pr-review-result.json",
  "fix-applier-result.json",
  "consolidator-result.json",
  "ci-wait-result.json",
  "pr-changes.json",
  "followups-block.txt",
  "filed-issues.txt",
  "intent-resolution.json",
  "epic-pr-body.md",
  "design-review.md",
] as const;

export const SNAPSHOT_FILE_MAX_BYTES = 524_288;

const EVENT_TYPES = new Set(["note", "gate", "snapshot", "journal"]);

export function historyLogPath(slug: string, dir = flowStateDir()): string {
  return path.join(checkpointDir(slug, dir), "history.jsonl");
}

export function snapshotDir(slug: string, dir = flowStateDir()): string {
  return path.join(checkpointDir(slug, dir), "snapshot");
}

export function historyFilePath(slug: string, dir = flowStateDir()): string {
  return path.join(checkpointDir(slug, dir), "history.md");
}

export function noteSha(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function appendHistoryEvent(
  slug: string,
  event: HistoryEvent,
  dir = flowStateDir(),
): boolean {
  try {
    fs.mkdirSync(checkpointDir(slug, dir), { recursive: true });
    fs.appendFileSync(historyLogPath(slug, dir), `${JSON.stringify(event)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function readHistoryEvents(
  slug: string,
  dir = flowStateDir(),
): HistoryEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(historyLogPath(slug, dir), "utf8");
  } catch {
    return [];
  }
  const events: HistoryEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const type = (parsed as { type?: unknown } | null)?.type;
      if (typeof type === "string" && EVENT_TYPES.has(type)) {
        events.push(parsed as HistoryEvent);
      }
    } catch {
      // A torn or foreign line must not hide the rest of the log.
    }
  }
  return events;
}

export function logNoteOnce(
  slug: string,
  body: string,
  meta: { phase: string; site: CheckpointSite | "unarmed" },
  dir = flowStateDir(),
): boolean {
  if (body.trim() === "") return false;
  const sha = noteSha(body);
  const seen = readHistoryEvents(slug, dir).some(
    (e) => e.type === "note" && e.sha === sha,
  );
  if (seen) return false;
  return appendHistoryEvent(
    slug,
    {
      type: "note",
      at: new Date().toISOString(),
      phase: meta.phase,
      site: meta.site,
      sha,
      body,
      items: parseNoteItems(body),
    },
    dir,
  );
}

/** True for the step-11 terminal one-liner, which the `gate` event already records. */
export function isTerminalOneLiner(body: string): boolean {
  const trimmed = body.trim();
  return (
    !trimmed.includes("\n") && /^Pipeline reached [A-Z-]+ at /.test(trimmed)
  );
}

export function logLiveNoteIfUnlogged(
  slug: string,
  phase: string,
  dir = flowStateDir(),
): boolean {
  try {
    const body = fs.readFileSync(checkpointBodyPath(slug, dir), "utf8");
    if (isTerminalOneLiner(body)) return false;
    return logNoteOnce(slug, body, { phase, site: "unarmed" }, dir);
  } catch {
    return false;
  }
}

export function appendJournal(
  slug: string,
  body: string,
  phase: string,
  dir = flowStateDir(),
): boolean {
  if (body.trim() === "") return false;
  return appendHistoryEvent(
    slug,
    { type: "journal", at: new Date().toISOString(), phase, body },
    dir,
  );
}

export function snapshotWorktreeArtifacts(
  slug: string,
  worktreeDir: string,
  dir = flowStateDir(),
): { files: string[]; skipped: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];
  try {
    const dest = snapshotDir(slug, dir);
    const src = path.join(worktreeDir, FLOW_TMP_DIRNAME);
    for (const name of SNAPSHOT_FILES) {
      try {
        const from = path.join(src, name);
        const stat = fs.statSync(from);
        if (!stat.isFile()) continue;
        if (stat.size > SNAPSHOT_FILE_MAX_BYTES) {
          skipped.push(name);
          continue;
        }
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(from, path.join(dest, name));
        files.push(name);
      } catch {
        // Absent or unreadable artifact: nothing to keep.
      }
    }
  } catch {
    // Invalid slug: nothing to snapshot into.
  }
  return { files, skipped };
}

export function resolveArtifactDir(
  state: Pick<PipelineState, "slug" | "worktree">,
  dir = flowStateDir(),
): string | null {
  try {
    if (state.worktree) {
      const live = path.join(state.worktree, FLOW_TMP_DIRNAME);
      if (fs.statSync(live).isDirectory()) return live;
    }
  } catch {
    // Worktree gone: fall through to the snapshot.
  }
  try {
    const snap = snapshotDir(state.slug, dir);
    if (fs.statSync(snap).isDirectory()) return snap;
  } catch {
    // No snapshot either.
  }
  return null;
}

export function recordGateOutcome(
  slug: string,
  gate: {
    status: GateStatus;
    tldr?: string;
    prUrl?: string;
    reason?: string;
  },
  worktree: string | null | undefined,
  dir = flowStateDir(),
): void {
  try {
    appendHistoryEvent(
      slug,
      { type: "gate", at: new Date().toISOString(), ...gate },
      dir,
    );
    if (worktree && fs.existsSync(worktree)) {
      const { files, skipped } = snapshotWorktreeArtifacts(slug, worktree, dir);
      if (files.length > 0 || skipped.length > 0) {
        appendHistoryEvent(
          slug,
          { type: "snapshot", at: new Date().toISOString(), files, skipped },
          dir,
        );
      }
    }
  } catch {
    // Best-effort: a history failure never changes the caller's outcome.
  }
}
