/**
 * Rule-based pruning of the manager home: drop expired notes, the grants of finished pipelines, ruling files older than 7 days and owner-words lines older than 30, roll log entries
 * older than 90 days into one `rollup` line per month and repo, and regenerate
 * `status.md`. No model, no judgement: every rule is a predicate on a field.
 * `proposals.json` is only ever read — an open proposal waits for the owner.
 *
 * The roll-up is computed before the log lock is taken; the critical section
 * is a re-read, a splice and a rename, so the sequencer's 500 ms append wait is
 * not at risk (a lock timeout there silently drops a sequencer log line).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLockSync } from "./lock";
import {
  managerFile,
  managerHome,
  managerLockPath,
  writeTextAtomic,
} from "./manager-home";
import { readGrants, withdrawPipelineGrant } from "./manager-grants";
import { logLockPath, logPath, type ManagerLogEntry } from "./manager-log";
import { dropNotes, isNoteExpired, readNotes } from "./manager-notes";
import { identityForState } from "./manager-scope";
import { readProposals } from "./manager-proposals";
import { writeManagerStatus } from "./manager-status";
import { FINISHED_PHASE_SET, listStates, readState } from "./state";

export const ROLLUP_AGE_DAYS = 90;
export const RULING_AGE_DAYS = 7;
export const OWNER_WORDS_AGE_DAYS = 30;

export type PruneResult = {
  notesDropped: number;
  grantsDropped: number;
  /** Grants removed whose `grant-withdrawn` log line could not be written. */
  grantLogErrors: string[];
  entriesRolled: number;
  monthsRolled: number;
  openProposals: number;
  statusPath: string;
  rulingsDropped: number;
  ownerWordsDropped: number;
};

/** A `pipeline:` grant is keyed by slug alone, so one whose pipeline is finished or gone must not outlive it and cover a later pipeline that reuses the slug. */
function dropDeadPipelineGrants(
  now: Date,
  readSlug: (slug: string) => ReturnType<typeof readState>,
  home: string,
): { dropped: number; logErrors: string[] } {
  let dropped = 0;
  const logErrors: string[] = [];
  for (const g of readGrants(home)) {
    if (!g.scope.startsWith("pipeline:")) continue;
    const slug = g.scope.slice("pipeline:".length);
    const st = readSlug(slug);
    if (st && !FINISHED_PHASE_SET.has(st.phase)) continue;
    const r = withdrawPipelineGrant(slug, {
      repo: (prior) => (st ? identityForState(st).repo : (prior ?? "unknown")),
      reason: "pipeline-finished",
      now,
      home,
    });
    if (r.removed) dropped++;
    if (r.logError !== undefined) logErrors.push(`${slug}: ${r.logError}`);
  }
  return { dropped, logErrors };
}

/** Ruling files are one-shot hand-offs, so one untouched for a week is consumed or expired. */
function dropOldRulings(now: Date, home: string): number {
  const dir = managerFile("rulings", home);
  let dropped = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - RULING_AGE_DAYS * 86_400_000;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs >= cutoff) continue;
      fs.rmSync(file);
      dropped++;
    } catch {
      // raced with the consumer: leave it
    }
  }
  return dropped;
}

/** Drops `owner-words.jsonl` lines older than 30 days; a line with no readable `ts` stays. */
function dropOldOwnerWords(now: Date, home: string): number {
  const file = managerFile("owner-words.jsonl", home);
  if (!fs.existsSync(file)) return 0;
  const cutoff = now.getTime() - OWNER_WORDS_AGE_DAYS * 86_400_000;
  return withFileLockSync(managerLockPath("owner-words.jsonl", home), () => {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return 0;
    }
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const kept = lines.filter((l) => {
      try {
        const t = Date.parse((JSON.parse(l) as { ts?: string }).ts ?? "");
        return !Number.isFinite(t) || t >= cutoff;
      } catch {
        return true;
      }
    });
    if (kept.length === lines.length) return 0;
    writeTextAtomic(file, kept.map((l) => `${l}\n`).join(""));
    return lines.length - kept.length;
  });
}

/** Lines that must survive verbatim: epic grants and wave decisions (the wave review's "already reviewed" set), existing roll-ups, and any entry of a still-unfinished pipeline. */
export function isRollupExempt(
  e: ManagerLogEntry,
  isUnfinished: (slug: string) => boolean,
): boolean {
  if (e.kind === "rollup") return true;
  if (e.kind === "grant" && e.scope?.startsWith("epic:")) return true;
  if (e.kind === "exec-decision" && e.exec?.reviewKind === "wave") return true;
  return e.slug !== undefined && isUnfinished(e.slug);
}

export function logOutcome(e: ManagerLogEntry): string {
  const x = e.exec;
  if (x?.actedOn !== undefined) return x.actedOn ? "acted-on" : "not-acted-on";
  return x?.ownerReply ?? x?.action ?? x?.decision ?? "none";
}

type Line = { raw: string; entry: ManagerLogEntry | null };

function parseLines(raw: string): Line[] {
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        const v: unknown = JSON.parse(l);
        const ok =
          typeof v === "object" &&
          v !== null &&
          typeof (v as ManagerLogEntry).ts === "string" &&
          typeof (v as ManagerLogEntry).kind === "string" &&
          typeof (v as ManagerLogEntry).repo === "string";
        return { raw: l, entry: ok ? (v as ManagerLogEntry) : null };
      } catch {
        return { raw: l, entry: null };
      }
    });
}

type Plan = { text: string; rolled: number; rollupLines: number };

/** The new file text for `raw`, or null when nothing is old enough to roll. */
function planRollup(
  raw: string,
  cutoffMs: number,
  isUnfinished: (slug: string) => boolean,
): Plan | null {
  const lines = parseLines(raw);
  const kept: string[] = [];
  const rollups = new Map<string, ManagerLogEntry>();
  const fresh = new Set<string>();
  let rolled = 0;
  for (const l of lines) {
    const e = l.entry;
    if (e?.kind === "rollup" && e.month) {
      rollups.set(`${e.month}\u0000${e.repo}`, e);
      continue;
    }
    const t = e ? Date.parse(e.ts) : NaN;
    if (
      !e ||
      !Number.isFinite(t) ||
      t >= cutoffMs ||
      isRollupExempt(e, isUnfinished)
    ) {
      kept.push(l.raw);
      continue;
    }
    const month = new Date(t).toISOString().slice(0, 7);
    const key = `${month}\u0000${e.repo}`;
    const roll =
      rollups.get(key) ??
      ({
        ts: `${month}-01T00:00:00.000Z`,
        kind: "rollup",
        repo: e.repo,
        month,
        counts: {},
      } satisfies ManagerLogEntry);
    const counts = (roll.counts ??= {});
    const byOutcome = (counts[e.kind] ??= {});
    const outcome = logOutcome(e);
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
    rollups.set(key, roll);
    fresh.add(key);
    rolled++;
  }
  if (rolled === 0) return null;
  const rollLines = [...rollups.values()]
    .sort(
      (a, b) =>
        (a.month ?? "").localeCompare(b.month ?? "") ||
        a.repo.localeCompare(b.repo),
    )
    .map((r) => JSON.stringify(r));
  return {
    text: [...rollLines, ...kept].map((l) => `${l}\n`).join(""),
    rolled,
    rollupLines: fresh.size,
  };
}

function readLog(home: string): string {
  try {
    return fs.readFileSync(logPath(home), "utf8");
  } catch {
    return "";
  }
}

export function pruneManagerHome(
  now: Date,
  deps: {
    home?: string;
    stateDir?: string;
    /** Test seam: runs between the unlocked roll-up and the lock. */
    beforeLock?: () => void;
    /** Test seam: runs between the unlocked notes read and the notes lock. */
    beforeNotesLock?: () => void;
  } = {},
): PruneResult {
  const home = deps.home ?? managerHome();
  const readSlug = (slug: string) => readState(slug, deps.stateDir);

  const notes = readNotes(home);
  const expired = notes.filter((n) => isNoteExpired(n, readSlug));
  const liveNotes = notes.filter((n) => !expired.includes(n));
  const notesDropped = expired.length;
  if (notesDropped > 0) {
    deps.beforeNotesLock?.();
    dropNotes(new Set(expired.map((n) => n.id)), home);
  }

  const { dropped: grantsDropped, logErrors: grantLogErrors } =
    dropDeadPipelineGrants(now, readSlug, home);

  const all = listStates(deps.stateDir);
  const unfinished = new Set(
    all.filter((s) => !FINISHED_PHASE_SET.has(s.phase)).map((s) => s.slug),
  );
  const isUnfinished = (slug: string) => unfinished.has(slug);
  const cutoffMs = now.getTime() - ROLLUP_AGE_DAYS * 86_400_000;

  const snapshot = readLog(home);
  const plan = planRollup(snapshot, cutoffMs, isUnfinished);
  let entriesRolled = 0;
  let monthsRolled = 0;
  if (plan) {
    deps.beforeLock?.();
    withFileLockSync(logLockPath(home), () => {
      const current = readLog(home);
      if (current === snapshot) {
        writeTextAtomic(logPath(home), plan.text);
        entriesRolled = plan.rolled;
        monthsRolled = plan.rollupLines;
        return;
      }
      // The log grew (or changed) since the snapshot: redo the cut on the
      // current text with the same precomputed cut-off and unfinished set.
      const redo = planRollup(current, cutoffMs, isUnfinished);
      if (redo) {
        writeTextAtomic(logPath(home), redo.text);
        entriesRolled = redo.rolled;
        monthsRolled = redo.rollupLines;
      }
    });
  }

  const openProposals = readProposals(home).length;
  const { path: statusPath } = writeManagerStatus(
    all,
    now,
    { openProposals, liveNotes: liveNotes.length },
    home,
  );
  const rulingsDropped = dropOldRulings(now, home);
  const ownerWordsDropped = dropOldOwnerWords(now, home);
  return {
    notesDropped,
    grantsDropped,
    grantLogErrors,
    entriesRolled,
    monthsRolled,
    openProposals,
    statusPath,
    rulingsDropped,
    ownerWordsDropped,
  };
}
