/**
 * Merge-time seeding: after-merge checks and failed/not-run local follow-ups
 * live in the worktree (deleted at merge), so `flow-untracked seed-merge`
 * copies them into the state ledger as `manual` items. Records only — never
 * files anything — and never seeds plan candidates (those were settled at
 * plan review).
 *
 * Dedup is against EVERY existing item (dropped, filed, done, launched too):
 * the shared `addItemDedup` skips dropped matches, which would resurrect a
 * dropped check on every resume re-render.
 */
import { ALLOWLIST } from "../flow-followups";
import { stripBullet } from "./gate-summary-rows";
import {
  readState,
  writeState,
  type PipelineState,
  type UntrackedItem,
} from "./state";

export type MergeSeed = {
  title: string;
  kind: "manual";
  source: "after-merge" | "followup";
};

export const AFTER_MERGE_PREFIX = "after merge: ";
const FAILED_PREFIX = "failed follow-up: ";
// formatVerdict indents the header 2 spaces and its tail lines 12: cap the
// leading whitespace so a tail line that itself starts "FAIL …" is ignored.
const FAIL_LINE = /^ {0,3}FAIL\s+(.+?)\s+\(exit -?\d+\)\s*$/;

export function mergeSeedEntries(inputs: {
  afterMerge: string[];
  followupEntries: Array<{ command: string; reason: string; auto?: boolean }>;
  followupsBlock: string;
}): MergeSeed[] {
  const out: MergeSeed[] = [];
  const seen = new Set<string>();
  const push = (title: string, source: MergeSeed["source"]): void => {
    const key = `${source}\u0000${title}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ title, kind: "manual", source });
  };
  for (const raw of inputs.afterMerge) {
    const text = stripBullet(raw.trim())
      .replace(/^after merge:\s*/i, "")
      .trim();
    if (text) push(`${AFTER_MERGE_PREFIX}${text}`, "after-merge");
  }
  for (const e of inputs.followupEntries) {
    if (e.auto === true && ALLOWLIST.has(e.command)) continue;
    push(`${FAILED_PREFIX}${e.command} — ${e.reason}`, "followup");
  }
  for (const line of inputs.followupsBlock.split("\n")) {
    const m = FAIL_LINE.exec(line);
    if (m) push(`${FAILED_PREFIX}${m[1]}`, "followup");
  }
  return out;
}

/** Appends seeds the ledger has never held; returns the new ids. */
export function applyMergeSeeds(
  state: PipelineState,
  seeds: MergeSeed[],
  now: () => string = () => new Date().toISOString(),
): { state: PipelineState; added: number[] } {
  const items: UntrackedItem[] = [...(state.untracked ?? [])];
  let next = items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const added: number[] = [];
  for (const s of seeds) {
    if (items.some((i) => i.title === s.title && i.source === s.source)) {
      continue;
    }
    items.push({
      id: next,
      title: s.title,
      source: s.source,
      at: now(),
      kind: s.kind,
    });
    added.push(next++);
  }
  return { state: { ...state, untracked: items }, added };
}

/**
 * Records un-numbered slot items a finished-window message listed. Dedup is by
 * normalised title against EVERY existing item (so a re-run, or an idea
 * already recorded another way, adds nothing). Records only — never files.
 */
export function appendRecorded(
  state: PipelineState,
  items: Array<{ title: string; kind: "work" | "manual" }>,
  now: () => string = () => new Date().toISOString(),
): { state: PipelineState; added: number[] } {
  const all: UntrackedItem[] = [...(state.untracked ?? [])];
  const norm = (t: string): string =>
    t.trim().replace(/\s+/g, " ").toLowerCase();
  const seen = new Set(all.map((i) => norm(i.title)));
  let next = all.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const added: number[] = [];
  for (const it of items) {
    if (seen.has(norm(it.title))) continue;
    seen.add(norm(it.title));
    all.push({
      id: next,
      title: it.title,
      source: "turn-end",
      at: now(),
      ...(it.kind === "manual" ? { kind: "manual" as const } : {}),
    });
    added.push(next++);
  }
  return { state: { ...state, untracked: all }, added };
}

/** The hook's persisted form of `appendRecorded`: read, append, write only when something was added. */
export function recordTurnEndItems(
  slug: string,
  items: Array<{ title: string; kind: "work" | "manual" }>,
  io: {
    read: typeof readState;
    write: typeof writeState;
  } = { read: readState, write: writeState },
): PipelineState {
  const st = io.read(slug);
  if (!st) throw new Error(`no state for ${slug}`);
  const r = appendRecorded(st, items);
  if (r.added.length > 0) io.write(r.state);
  return r.state;
}
