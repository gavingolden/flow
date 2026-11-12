/**
 * `~/.flow/manager/status.md`: a regenerated snapshot of every unfinished
 * pipeline, owner-needed first and oldest first. `renderManagerStatus` is pure
 * text in, text out; `writeManagerStatus` is the one writer the waiter and
 * `flow-manager-prune` both call, so the shared list is never left filtered
 * once the manager is gone.
 */

import * as fs from "node:fs";
import { OWNER_NEEDED_PHASES, REASON_BY_PHASE } from "./epic-manage-board";
import {
  managerFile,
  managerHome,
  writeJsonAtomic,
  writeTextAtomic,
} from "./manager-home";
import { readManagerRecord } from "./manager-record";
import { readScope, repoNameForPath, stateInScope } from "./manager-scope";
import { FINISHED_PHASE_SET, type PipelineState } from "./state";

function waitingSince(s: PipelineState): number {
  const entry = [...(s.phaseLog ?? [])]
    .reverse()
    .find((e) => e.phase === s.phase);
  const t = Date.parse(entry?.at ?? s.updatedAt);
  return Number.isFinite(t) ? t : Date.parse(s.updatedAt) || 0;
}

/** Coarse on purpose: minutes under an hour, hours under two days, then days. */
function waitingLabel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export type StatusView = {
  /** List only the pipelines this accepts. */
  inScope?: (s: PipelineState) => boolean;
  /** Append a `## Not in scope` section for out-of-scope pipelines that need the owner. */
  notices?: boolean;
  /** The stable `#N` handle of a needs-you pipeline, when it has one. */
  handleFor?: (s: PipelineState) => number | undefined;
};

type StatusExtra = {
  openProposals: number;
  liveNotes: number;
  aliveAt?: string;
};

export function renderManagerStatus(
  states: PipelineState[],
  now: Date,
  extra: StatusExtra,
  view: StatusView = {},
): string {
  const visible = (s: PipelineState) => view.inScope?.(s) ?? true;
  const rows = states
    .filter((s) => !FINISHED_PHASE_SET.has(s.phase) && visible(s))
    .map((s) => ({
      s,
      since: waitingSince(s),
      needed: OWNER_NEEDED_PHASES.has(s.phase),
    }))
    .sort(
      (a, b) =>
        Number(b.needed) - Number(a.needed) ||
        a.since - b.since ||
        a.s.slug.localeCompare(b.s.slug),
    );

  const lines = [
    "# Manager status",
    "",
    `Generated ${now.toISOString()} · open proposals: ${extra.openProposals} · live notes: ${extra.liveNotes}${extra.aliveAt ? ` · manager alive ${extra.aliveAt}` : ""}`,
    "",
  ];
  if (rows.length === 0) {
    lines.push("No unfinished pipelines.");
  } else {
    lines.push(
      "| Pipeline | Repo | Epic | Phase | Owner action | Waiting |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const { s, since, needed } of rows) {
      const n = needed ? view.handleFor?.(s) : undefined;
      const action = needed
        ? `${n !== undefined ? `#${n} ` : ""}${cell(REASON_BY_PHASE[s.phase] ?? s.phase)}`
        : "-";
      lines.push(
        `| ${cell(s.slug)} | ${cell(repoNameForPath(s.repo))} | ${cell(s.epic?.slug ?? "-")} | ${cell(s.phase)} | ${action} | ${waitingLabel(now.getTime() - since)} |`,
      );
    }
  }
  if (view.notices && view.inScope) {
    const out = states
      .filter(
        (s) =>
          !visible(s) &&
          !FINISHED_PHASE_SET.has(s.phase) &&
          OWNER_NEEDED_PHASES.has(s.phase),
      )
      .sort((a, b) => a.slug.localeCompare(b.slug));
    if (out.length > 0) {
      lines.push("", "## Not in scope", "");
      for (const s of out) {
        lines.push(
          `- ${cell(s.slug)} (repo ${cell(repoNameForPath(s.repo))}) is ${cell(REASON_BY_PHASE[s.phase] ?? s.phase)} — answer in window ${cell(s.slug)}`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

type HandleFile = { version: 1; next: number; items: Record<string, number> };

function handlesPath(home: string): string {
  return managerFile("handles.json", home);
}

function readHandles(home: string): HandleFile {
  try {
    const v = JSON.parse(
      fs.readFileSync(handlesPath(home), "utf8"),
    ) as HandleFile;
    if (
      v?.version === 1 &&
      Number.isInteger(v.next) &&
      v.items &&
      typeof v.items === "object" &&
      Object.values(v.items).every((n) => Number.isInteger(n))
    ) {
      return v;
    }
  } catch {
    // missing or malformed: start over
  }
  return { version: 1, next: 1, items: {} };
}

/** One needs-you item is a pipeline sitting in one owner-needed phase; a new phase is a new item. */
const itemKey = (s: PipelineState) => `${s.slug}:${s.phase}`;

/** Gives every current needs-you item a `#N` and reuses the number of one that already has it. The counter only grows, so a number is not handed to a different item soon after. */
function assignHandles(
  states: PipelineState[],
  home: string,
): Map<string, number> {
  const cur = readHandles(home);
  const items: Record<string, number> = {};
  let next = cur.next;
  for (const s of states) {
    if (FINISHED_PHASE_SET.has(s.phase) || !OWNER_NEEDED_PHASES.has(s.phase)) {
      continue;
    }
    const k = itemKey(s);
    items[k] = cur.items[k] ?? next++;
  }
  const changed =
    next !== cur.next || JSON.stringify(items) !== JSON.stringify(cur.items);
  if (changed) writeJsonAtomic(handlesPath(home), { version: 1, next, items });
  return new Map(Object.entries(items));
}

/** Regenerates `status.md` (and `handles.json`). Filtered to the manager's scope only while a manager record exists and a scope file is readable; otherwise the full table. */
export function writeManagerStatus(
  states: PipelineState[],
  now: Date,
  extra: StatusExtra,
  home: string = managerHome(),
): { path: string; changed: boolean } {
  const scope = readScope(home);
  const record = scope ? readManagerRecord(home) : null;
  const handles = assignHandles(states, home);
  const view: StatusView = {
    handleFor: (s) => handles.get(itemKey(s)),
    ...(scope && record
      ? {
          inScope: (s: PipelineState) => stateInScope(s, scope),
          notices: record.notices,
        }
      : {}),
  };
  const text = renderManagerStatus(states, now, extra, view);
  const file = managerFile("status.md", home);
  const stamp = (t: string) => t.replace(/^Generated \S+/m, "Generated");
  let before = "";
  try {
    before = fs.readFileSync(file, "utf8");
  } catch {
    // first write
  }
  const changed = stamp(before) !== stamp(text);
  if (changed) writeTextAtomic(file, text);
  return { path: file, changed };
}
