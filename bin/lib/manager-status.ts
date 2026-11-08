/**
 * `~/.flow/manager/status.md`: a regenerated snapshot of every unfinished
 * pipeline, owner-needed first and oldest first. Pure text in, text out; the
 * caller supplies the clock and the loaded states.
 */

import { OWNER_NEEDED_PHASES, REASON_BY_PHASE } from "./epic-manage-board";
import { repoNameForPath } from "./manager-scope";
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

export function renderManagerStatus(
  states: PipelineState[],
  now: Date,
  extra: { openProposals: number; liveNotes: number },
): string {
  const rows = states
    .filter((s) => !FINISHED_PHASE_SET.has(s.phase))
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
    `Generated ${now.toISOString()} · open proposals: ${extra.openProposals} · live notes: ${extra.liveNotes}`,
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
      lines.push(
        `| ${cell(s.slug)} | ${cell(repoNameForPath(s.repo))} | ${cell(s.epic?.slug ?? "-")} | ${cell(s.phase)} | ${needed ? cell(REASON_BY_PHASE[s.phase] ?? s.phase) : "-"} | ${waitingLabel(now.getTime() - since)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
