#!/usr/bin/env bun
/**
 * flow-manager-prune — rule-based housekeeping of ~/.flow/manager/.
 *
 *   flow-manager-prune
 *
 * Drops notes whose pipelines all finished, drops `pipeline:` grants whose
 * pipeline finished or is gone, rolls log entries older than 90 days into one
 * count line per month and repo (epic: grant lines, wave decisions and any line
 * of a still-unfinished pipeline stay verbatim), and rewrites status.md. Never
 * writes proposals.json. On a terminal it prints a plain-English summary;
 * otherwise (or with `--json`) one JSON line `{ notesDropped, grantsDropped,
 * entriesRolled, monthsRolled, openProposals, statusPath }`.
 */

import {
  pruneManagerHome,
  ROLLUP_AGE_DAYS,
  type PruneResult,
} from "./lib/manager-prune";

export function summarize(r: PruneResult): string {
  return [
    `Dropped ${r.notesDropped} finished note(s) and ${r.grantsDropped} grant(s) of finished pipelines.`,
    `Summarised ${r.entriesRolled} log line(s) older than ${ROLLUP_AGE_DAYS} days into ${r.monthsRolled} monthly count(s) (their per-line detail is gone).`,
    ...r.grantLogErrors.map(
      (e) => `warning: grant withdrawn but not logged (${e})`,
    ),
    `${r.openProposals} open proposal(s); status at ${r.statusPath}`,
  ].join("\n");
}

export function run(
  argv: string[],
  isTTY = process.stdout.isTTY === true,
): number {
  const json = argv.includes("--json");
  if (argv.some((a) => a !== "--json")) {
    console.error("usage: flow-manager-prune [--json]");
    return 2;
  }
  const result = pruneManagerHome(new Date());
  console.log(isTTY && !json ? summarize(result) : JSON.stringify(result));
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
