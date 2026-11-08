/**
 * Expiring coordination notes: `~/.flow/manager/notes.jsonl`. A note is about
 * one or more pipelines and lives only while at least one of them is
 * unfinished (`gated` and `needs-human` count as unfinished); prune drops it
 * once every named slug is finished or has no state file.
 */

import * as fs from "node:fs";
import { withFileLockSync } from "./lock";
import { managerFile, managerHome, managerLockPath } from "./manager-home";
import { FINISHED_PHASE_SET, type PipelineState } from "./state";

export type ManagerNote = {
  id: string;
  ts: string;
  about: string[];
  text: string;
  repo?: string;
};

function notesPath(home?: string): string {
  return managerFile("notes.jsonl", home ?? managerHome());
}

function locked<T>(home: string | undefined, fn: () => T): T {
  return withFileLockSync(managerLockPath("notes", home ?? managerHome()), fn);
}

function isNote(v: unknown): v is ManagerNote {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    typeof n.ts === "string" &&
    typeof n.text === "string" &&
    Array.isArray(n.about) &&
    n.about.every((s) => typeof s === "string") &&
    (n.repo === undefined || typeof n.repo === "string")
  );
}

/** Tolerant: a missing file reads as none; torn or shapeless lines are skipped. */
export function readNotes(home?: string): ManagerNote[] {
  let raw: string;
  try {
    raw = fs.readFileSync(notesPath(home), "utf8");
  } catch {
    return [];
  }
  const out: ManagerNote[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isNote(v)) out.push(v);
    } catch {
      // skip a torn or hand-edited line
    }
  }
  return out;
}

export function appendNote(n: ManagerNote, home?: string): void {
  fs.mkdirSync(home ?? managerHome(), { recursive: true });
  locked(home, () =>
    fs.appendFileSync(notesPath(home), `${JSON.stringify(n)}\n`),
  );
}

/** Replaces the whole file (prune only), via tmp + rename under the notes lock. */
export function rewriteNotes(notes: ManagerNote[], home?: string): void {
  fs.mkdirSync(home ?? managerHome(), { recursive: true });
  locked(home, () => {
    const tmp = `${notesPath(home)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, notes.map((n) => `${JSON.stringify(n)}\n`).join(""));
    fs.renameSync(tmp, notesPath(home));
  });
}

/** True when every named slug is finished or has no state; gated / needs-human keep a note alive. */
export function isNoteExpired(
  n: ManagerNote,
  readState: (slug: string) => PipelineState | null,
): boolean {
  return n.about.every((slug) => {
    const s = readState(slug);
    return s === null || FINISHED_PHASE_SET.has(s.phase);
  });
}
