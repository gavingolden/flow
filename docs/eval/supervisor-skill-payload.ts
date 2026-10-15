#!/usr/bin/env bun
// Measures how the flow-pipeline supervisor skill is loaded, compacted and
// re-read, from local Claude Code transcripts, plus the skill's static sizes.
//   bun docs/eval/supervisor-skill-payload.ts --since 2026-09-25 --format md
//   bun docs/eval/supervisor-skill-payload.ts --static [--skill-dir <dir>]
// Flags: --projects-root <dir> (default ~/.claude/projects), --repos <csv>
// (default flow,pokemon,econ-data), --since <YYYY-MM-DD> (UTC, on the
// session's first timestamp), --format md|json, --static, --skill-dir <dir>.
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { referenceOpenRates } from "./discovery-payload-parse";
import { isSupervisorSession } from "./supervisor-turns";
import {
  analyzeSession,
  phaseDocs,
  staticSizes,
  type SessionStats,
} from "./supervisor-skill-payload-parse";
import { resolveRepo } from "./token-spend-audit";

export { analyzeSession, phaseDocs, staticSizes };

const median = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[Math.floor((b.length - 1) / 2)] : 0;
};
const f = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function collect(root: string, repos: string[], since: number) {
  const out: SessionStats[] = [];
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    let files: string[];
    try {
      files = readdirSync(join(root, d)).filter((x) => x.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const lines = readFileSync(join(root, d, file), "utf8")
        .split("\n")
        .filter(Boolean);
      const cwd = lines
        .map((l) => /"cwd":"([^"]*)"/.exec(l)?.[1])
        .find(Boolean);
      const ts = lines
        .map((l) => /"timestamp":"([^"]*)"/.exec(l)?.[1])
        .find(Boolean);
      if (since && (!ts || Date.parse(ts) < since)) continue;
      if (!resolveRepo(cwd, repos) || !isSupervisorSession(lines)) continue;
      out.push(analyzeSession(lines));
    }
  }
  return out;
}

// Sessions that wrote each phase, and how many of them opened that phase's
// step doc at any point. A session-level proxy: it cannot see a doc read
// before a compaction and not re-read after it.
function stepDocCoverage(ss: SessionStats[], docs: Record<string, string>) {
  const out: Record<string, { doc: string; reached: number; opened: number }> =
    {};
  for (const s of ss)
    for (const p of s.phasesReached) {
      if (!docs[p]) continue;
      const c = (out[p] ??= { doc: docs[p], reached: 0, opened: 0 });
      c.reached++;
      if (s.docReads[docs[p]]) c.opened++;
    }
  return out;
}

export function summarizeSessions(
  ss: SessionStats[],
  docs: Record<string, string> = {},
) {
  const reads = referenceOpenRates(
    ss.map((s) => ({ referencesRead: Object.keys(s.docReads) })),
    [...new Set(ss.flatMap((s) => Object.keys(s.docReads)))],
  );
  const compacted = ss.filter((s) => s.compactions > 0);
  return {
    sessions: ss.length,
    skillLoads: ss.reduce((n, s) => n + s.skillLoads, 0),
    loadDeltaMedianTokens: median(ss.flatMap((s) => s.loadDeltaTokens)),
    turnsMedian: median(ss.map((s) => s.turns)),
    compactedSessions: compacted.length,
    reloadedAfterCompaction: compacted.filter((s) => s.reloadedAfterCompaction)
      .length,
    reattachChars: ss.flatMap((s) => s.reattachChars),
    docOpens: reads,
    docReads: ss.reduce<Record<string, number>>((acc, s) => {
      for (const [d, n] of Object.entries(s.docReads))
        acc[d] = (acc[d] ?? 0) + n;
      return acc;
    }, {}),
    stepDocCoverage: stepDocCoverage(ss, docs),
  };
}

export function renderSessions(sum: ReturnType<typeof summarizeSessions>) {
  const re = sum.reattachChars;
  const rows = [
    ["Supervisor sessions", f(sum.sessions)],
    ["Skill loads", f(sum.skillLoads)],
    [
      "Median context added by a skill load (tokens)",
      f(sum.loadDeltaMedianTokens),
    ],
    ["Median supervisor turns per session", f(sum.turnsMedian)],
    ["Sessions that compacted", f(sum.compactedSessions)],
    [
      "Compacted sessions that re-loaded or re-read the skill",
      f(sum.reloadedAfterCompaction),
    ],
    ["Re-attachments of the skill", f(re.length)],
    [
      "Re-attached length (chars, min / max)",
      re.length ? `${f(Math.min(...re))} / ${f(Math.max(...re))}` : "-",
    ],
  ];
  const doc = Object.entries(sum.docOpens).sort(
    (a, b) => b[1].opened - a[1].opened,
  );
  return [
    "| Measure | Value |\n|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    "\n| Doc Read | Reads | Sessions | Of |\n|---|---|---|---|",
    ...doc.map(
      ([d, v]) => `| ${d} | ${sum.docReads[d]} | ${v.opened} | ${v.total} |`,
    ),
    "\n| Phase reached | Step doc | Sessions | Opened the doc |\n|---|---|---|---|",
    ...Object.entries(sum.stepDocCoverage).map(
      ([p, c]) => `| ${p} | ${c.doc} | ${c.reached} | ${c.opened} |`,
    ),
  ].join("\n");
}

export function renderStatic(s: ReturnType<typeof staticSizes>) {
  const rows = Object.entries(s.residentAtStep);
  return [
    `Core (SKILL.md): ${f(s.coreChars)} chars`,
    "\n| Doc | Chars |\n|---|---|",
    ...Object.entries(s.docs).map(([d, n]) => `| ${d} | ${f(n)} |`),
    "\n| Resident text at entry to step | Chars |\n|---|---|",
    ...rows.map(([k, n]) => `| ${k} | ${f(n)} |`),
  ].join("\n");
}

function run(argv: string[]) {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const json = flag("--format") === "json";
  const dir =
    flag("--skill-dir") ??
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../skills/pipeline/flow-pipeline",
    );
  if (argv.includes("--static")) {
    const s = staticSizes(dir);
    console.log(json ? JSON.stringify(s, null, 2) : renderStatic(s));
    return;
  }
  const sinceStr = flag("--since");
  const since = sinceStr ? Date.parse(`${sinceStr}T00:00:00Z`) : 0;
  if (sinceStr && Number.isNaN(since))
    throw new Error(`bad --since: ${sinceStr}`);
  const root =
    flag("--projects-root") ?? join(homedir(), ".claude", "projects");
  const repos = (flag("--repos") ?? "flow,pokemon,econ-data")
    .split(",")
    .filter(Boolean);
  const sum = summarizeSessions(collect(root, repos, since), phaseDocs(dir));
  console.log(json ? JSON.stringify(sum, null, 2) : renderSessions(sum));
}

if (import.meta.main) run(process.argv.slice(2));
