#!/usr/bin/env bun
// Measures each discovery sub-agent run's start-up payload. Standalone on
// purpose: fs/path/os only, no bin/lib imports, so it runs on any checkout.
//   bun docs/eval/discovery-payload.ts --since 2026-09-05 --sections <md>
//   bun docs/eval/discovery-payload.ts --stream-dir <flow-eval out dir>
// Flags: --home <dir> (default $HOME), --project-match <substring>,
// --since <YYYY-MM-DD>, --stream-dir <dir>, --instructions <path|basename>
// (repeatable; default discovery-instructions.md), --sections <path>.
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import {
  blocks,
  DEFAULT_INSTRUCTIONS,
  measureSpawn,
  METRICS,
  PRICING_DATE,
  referenceOpenRates,
  sectionSizes,
  SIBLING_REFS,
  summarize,
  textOf,
  type SpawnPayload,
} from "./discovery-payload-parse";

export {
  measureSpawn,
  referenceOpenRates,
  sectionSizes,
  summarize,
  type SpawnPayload,
} from "./discovery-payload-parse";

const parseLines = (file: string): unknown[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });

function walk(dir: string, hit: (p: string) => boolean, out: string[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, hit, out);
    else if (hit(p)) out.push(p);
  }
  return out;
}

function transcriptSpawns(a: Args): unknown[][] {
  const root = join(a.home, ".claude", "projects");
  if (!existsSync(root)) return [];
  const since = a.since ? Date.parse(`${a.since}T00:00:00Z`) : 0;
  const runs: unknown[][] = [];
  for (const proj of readdirSync(root)) {
    if (a.projectMatch && !proj.includes(a.projectMatch)) continue;
    const files = walk(join(root, proj), (p) =>
      /\/subagents\/agent-[^/]+\.jsonl$/.test(p),
    );
    for (const f of files) {
      const meta = f.replace(/\.jsonl$/, ".meta.json");
      if (!existsSync(meta)) continue;
      try {
        if (JSON.parse(readFileSync(meta, "utf8")).agentType !== AGENT)
          continue;
      } catch {
        continue;
      }
      if (statSync(f).mtimeMs < since) continue;
      runs.push(parseLines(f));
    }
  }
  return runs;
}

function streamSpawns(dir: string): unknown[][] {
  const runs: unknown[][] = [];
  const files = walk(dir, (p) =>
    /\/run-[^/]+\/stream\.jsonl$/.test(p.replace(/\\/g, "/")),
  );
  for (const f of files) {
    const rows = parseLines(f) as any[];
    const groups = new Map<string, any[]>();
    for (const r of rows)
      if (r?.parent_tool_use_id)
        (
          groups.get(r.parent_tool_use_id) ??
          groups.set(r.parent_tool_use_id, []).get(r.parent_tool_use_id)!
        ).push(r);
    const [id, group] =
      [...groups].sort((x, y) => y[1].length - x[1].length)[0] ?? [];
    if (!group) continue;
    if (!group.some((r) => r.type === "user" && textOf(r))) {
      const spawn = rows
        .flatMap(blocks)
        .find((b) => b?.type === "tool_use" && b.id === id);
      const prompt = String(spawn?.input?.prompt ?? "");
      group.unshift({ type: "user", message: { content: prompt } });
    }
    runs.push(group);
  }
  return runs;
}

const AGENT = "flow-module-core:flow-discovery";
type Args = {
  home: string;
  since?: string;
  projectMatch?: string;
  streamDir?: string;
  instructions: string[];
  sections?: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { home: homedir(), instructions: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === "--home") a.home = v;
    else if (argv[i] === "--since") a.since = v;
    else if (argv[i] === "--project-match") a.projectMatch = v;
    else if (argv[i] === "--stream-dir") a.streamDir = v;
    else if (argv[i] === "--instructions") a.instructions.push(v);
    else if (argv[i] === "--sections") a.sections = v;
    else continue;
    i++;
  }
  if (!a.instructions.length) a.instructions = DEFAULT_INSTRUCTIONS;
  return a;
}

const f = (n: number, d = 0) =>
  n.toLocaleString("en-US", { maximumFractionDigits: d });

const LABEL: Record<string, [string, number]> = {
  firstContext: ["First request context (tokens)", 0],
  firstWrite: ["First-turn write (tokens)", 0],
  taskTextChars: ["Task text (chars)", 0],
  instructionTokens: ["Instruction read (tokens, upper bound)", 0],
  instructionChunks: ["Instruction read chunks", 1],
  turnsAfterInstructions: ["Turns after instructions", 1],
  usd: ["USD per run", 2],
};

function table(title: string, spawns: SpawnPayload[]) {
  const s = summarize(spawns);
  console.log(`\n${title}\n`);
  console.log("| Metric | Median | p25 | p75 |\n|---|---|---|---|");
  for (const m of METRICS) {
    const [name, d] = LABEL[m];
    console.log(
      `| ${name} | ${f(s.median[m], d)} | ${f(s.p25[m], d)} | ${f(s.p75[m], d)} |`,
    );
  }
  return s;
}

function report(a: Args) {
  const runs = a.streamDir ? streamSpawns(a.streamDir) : transcriptSpawns(a);
  const spawns = runs
    .map((r) => measureSpawn(r, { instructionNames: a.instructions }))
    .filter((s): s is SpawnPayload => s !== null);
  const read = spawns.filter((x) => x.instructionChunks > 0);
  console.log(`# Discovery start-up payload\n`);
  console.log(`Runs: ${spawns.length}. Prices dated ${PRICING_DATE}.`);
  const s = table(`## All ${spawns.length} runs`, spawns);
  table(`## ${read.length} runs with an attributed instruction Read`, read);
  console.log("\n| Model | Runs | Mean USD per run |\n|---|---|---|");
  for (const [m, v] of Object.entries(s.usdPerRunByModel))
    console.log(
      `| ${m} | ${spawns.filter((x) => x.model === m).length} | ${f(v, 2)} |`,
    );
  const seen = new Set(spawns.flatMap((x) => x.referencesRead));
  const refs = [
    ...new Set([
      ...SIBLING_REFS,
      ...[...seen].filter((r) => /^discovery-/.test(r)),
    ]),
  ];
  console.log("\n| Reference | Opened | Runs | Rate |\n|---|---|---|---|");
  for (const [r, v] of Object.entries(referenceOpenRates(spawns, refs)))
    console.log(
      `| ${r} | ${v.opened} | ${v.total} | ${f((100 * v.opened) / (v.total || 1))}% |`,
    );
  if (a.sections) {
    const rows = sectionSizes(readFileSync(a.sections, "utf8"))
      .sort((x, y) => y.chars - x.chars)
      .slice(0, 25);
    console.log("\n| Section (top 25 by size) | Chars |\n|---|---|");
    for (const r of rows)
      console.log(`| ${r.heading.replace(/\|/g, "\\|")} | ${f(r.chars)} |`);
  }
}

if (import.meta.main) report(parseArgs(process.argv.slice(2)));
