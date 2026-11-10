#!/usr/bin/env bun
/**
 * Re-measure the safeguards-stop / padding contingency table from local Claude
 * Code transcripts. See docs/eval/safeguards-stop-bisection-2026-11.md.
 *
 * Usage:
 *   bun scripts/safeguards-audit.ts --projects-dir <dir> [--since YYYY-MM-DD] [--json]
 *
 * Reads every *.jsonl (and agent *.meta.json) under <dir> recursively. Prints
 * counts only — never transcript contents or request IDs.
 *
 * Exit codes: 0 — result computed; 2 — bad args.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  auditTranscripts,
  type TranscriptFile,
} from "../bin/lib/safeguards-audit";

const USAGE =
  "usage: bun scripts/safeguards-audit.ts --projects-dir <dir> [--since YYYY-MM-DD] [--json]\n";

// Lazy: only one transcript is resident at a time. A transcript whose last
// write is before --since cannot have started after it, so it is never read.
function* collect(dir: string, since?: Date): Generator<TranscriptFile> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* collect(p, since);
    } else if (e.name.endsWith(".jsonl") || e.name.endsWith(".meta.json")) {
      const mtime = fs.statSync(p).mtime;
      if (since && e.name.endsWith(".jsonl") && mtime < since) continue;
      yield { name: e.name, text: fs.readFileSync(p, "utf8"), mtime };
    }
  }
}

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  let dir: string | undefined;
  let since: Date | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--projects-dir") dir = argv[++i];
    else if (argv[i] === "--since") {
      since = new Date(argv[++i] ?? "");
      if (Number.isNaN(since.getTime())) since = undefined;
      if (since === undefined) return fail("--since must be YYYY-MM-DD");
    } else if (argv[i] === "--json") json = true;
    else return fail(`unknown argument: ${argv[i]}`);
  }
  if (dir === undefined || !fs.existsSync(dir)) {
    return fail("--projects-dir <existing dir> is required");
  }
  const res = auditTranscripts(collect(dir, since), { since });
  if (json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return 0;
  }
  const rows = [
    "| window | runs | padded | stopped | stopped+padded | via read | via injection |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...res.windows.map(
      (w) =>
        `| ${w.window} | ${w.runs} | ${w.padded} | ${w.stopped} | ${w.stoppedPadded} | ${w.stoppedViaRead} | ${w.stoppedViaInjection} |`,
    ),
    "",
    "| agent type | runs | padded | stopped | stopped+padded |",
    "| --- | --- | --- | --- | --- |",
    ...res.agents.map(
      (a) =>
        `| ${a.agentType} | ${a.runs} | ${a.padded} | ${a.stopped} | ${a.stoppedPadded} |`,
    ),
  ];
  process.stdout.write(rows.join("\n") + "\n");
  return 0;
}

function fail(msg: string): number {
  process.stderr.write(`safeguards-audit: ${msg}\n${USAGE}`);
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
