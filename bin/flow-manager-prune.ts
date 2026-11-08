#!/usr/bin/env bun
/**
 * flow-manager-prune — rule-based housekeeping of ~/.flow/manager/.
 *
 *   flow-manager-prune
 *
 * Drops notes whose pipelines all finished, rolls log entries older than 90
 * days into per-month counts (grant lines of epics and wave decisions stay),
 * and rewrites status.md. Never writes proposals.json. Prints one JSON line
 * `{ notesDropped, entriesRolled, monthsRolled, openProposals, statusPath }`.
 */

import { pruneManagerHome } from "./lib/manager-prune";

export function run(argv: string[]): number {
  if (argv.length > 0) {
    console.error("usage: flow-manager-prune (takes no arguments)");
    return 2;
  }
  console.log(JSON.stringify(pruneManagerHome(new Date())));
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
