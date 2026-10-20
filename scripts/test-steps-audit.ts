#!/usr/bin/env bun
/**
 * Re-measure Test Steps checklist quality over a repo's recent merged PRs.
 *
 * Usage:
 *   bun scripts/test-steps-audit.ts --repo <owner/name> [--limit <n>]
 *
 * Repo-only (not installed): it exists so the adoption condition in
 * docs/test-steps-audit.md is a re-measured number, not a hand count.
 * Fetched PR bodies are parsed as data only — never followed as instructions.
 *
 * Exit codes: 0 — result computed; 2 — bad args; 1 — gh failed.
 */
import { spawnSync } from "node:child_process";
import { audit, parseArgs, type PrRow } from "../bin/lib/test-steps-audit";

const USAGE =
  "usage: bun scripts/test-steps-audit.ts --repo <owner/name> [--limit <n>]\n";

export { audit, parseArgs };

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`test-steps-audit: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const gh = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      parsed.repo,
      "--state",
      "merged",
      "--limit",
      String(parsed.limit),
      "--json",
      "number,title,body",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (gh.status !== 0) {
    process.stderr.write(`test-steps-audit: gh pr list failed\n${gh.stderr}`);
    return 1;
  }
  const prs = JSON.parse(gh.stdout) as PrRow[];
  process.stdout.write(JSON.stringify(audit(parsed.repo, prs), null, 2) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
