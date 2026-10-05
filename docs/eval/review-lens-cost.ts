#!/usr/bin/env bun
/**
 * Per-lens review cost table from local Claude Code transcripts.
 *
 *   bun docs/eval/review-lens-cost.ts [--home <dir>] [--repos <csv>]
 *     [--since <YYYY-MM-DD>] [--model-prices <json-file>] [--json]
 *
 * Each review-lens subagent transcript (subagents/*.meta.json agentType
 * `flow-review-<lens>`) is one run. Claude Code writes one JSONL line per
 * content block of a message and only the last line carries its final
 * output_tokens, so usage is counted once per `message.id` (last occurrence
 * wins) while tool calls are counted across every line.
 * Cells are per-run means. Dollars use MODEL_PRICING, falling back to the
 * model family's priced entry; `--model-prices` overrides with a JSON map
 * { "<model>": { input, cacheCreation, cacheRead, output } } in $/MTok.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ALL_LENS_NAMES } from "../../bin/lib/agent-finding-schema";
import { MODEL_PRICING, type ModelPricing } from "../../bin/lib/cost-pricing";
import { lensFromMeta } from "../../bin/lib/review-telemetry";

export type RunStats = {
  turns: number;
  reads: number;
  greps: number;
  files: Set<string>;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  dollars: number;
};

type Prices = Record<string, ModelPricing>;

export function priceFor(model: string, prices: Prices): ModelPricing | null {
  if (prices[model]) return prices[model];
  for (const family of ["opus", "sonnet", "haiku"]) {
    if (!model.includes(family)) continue;
    const key = Object.keys(prices).find((k) => k.includes(family));
    if (key) return prices[key];
  }
  return null;
}

const n = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

export function statsFromJsonl(raw: string, prices: Prices): RunStats {
  const s: RunStats = {
    turns: 0,
    reads: 0,
    greps: 0,
    files: new Set(),
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    dollars: 0,
  };
  const messages = new Map<string, { usage: any; model: string }>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== "assistant" || !e.message) continue;
    const content = Array.isArray(e.message.content) ? e.message.content : [];
    for (const c of content) {
      if (c?.type !== "tool_use") continue;
      if (c.name === "Read") {
        s.reads++;
        if (typeof c.input?.file_path === "string")
          s.files.add(c.input.file_path);
      } else if (c.name === "Grep") s.greps++;
    }
    const id = e.message.id;
    const key = typeof id === "string" && id ? id : `\0line${messages.size}`;
    messages.set(key, {
      usage: e.message.usage ?? messages.get(key)?.usage ?? {},
      model: String(e.message.model ?? ""),
    });
  }
  for (const { usage: u, model } of messages.values()) {
    s.turns++;
    const cw = n(u.cache_creation_input_tokens);
    const cr = n(u.cache_read_input_tokens);
    const out = n(u.output_tokens);
    s.cacheWrite += cw;
    s.cacheRead += cr;
    s.output += out;
    const p = priceFor(model, prices);
    if (p) {
      s.dollars +=
        (n(u.input_tokens) * p.input +
          cw * p.cacheCreation +
          cr * p.cacheRead +
          out * p.output) /
        1_000_000;
    }
  }
  return s;
}

export type LensRow = {
  lens: string;
  n: number;
  turns: number;
  reads: number;
  greps: number;
  distinct_files: number;
  cache_write: number;
  cache_read: number;
  output: number;
  dollars: number;
};

export function aggregate(byLens: Map<string, RunStats[]>): LensRow[] {
  const rows: LensRow[] = [];
  for (const lens of ALL_LENS_NAMES) {
    const runs = byLens.get(lens) ?? [];
    if (runs.length === 0) continue;
    const mean = (f: (r: RunStats) => number) =>
      runs.reduce((a, r) => a + f(r), 0) / runs.length;
    rows.push({
      lens,
      n: runs.length,
      turns: mean((r) => r.turns),
      reads: mean((r) => r.reads),
      greps: mean((r) => r.greps),
      distinct_files: mean((r) => r.files.size),
      cache_write: mean((r) => r.cacheWrite),
      cache_read: mean((r) => r.cacheRead),
      output: mean((r) => r.output),
      dollars: mean((r) => r.dollars),
    });
  }
  return rows;
}

export function renderTable(rows: LensRow[]): string {
  const f = (x: number, d = 1) => x.toFixed(d);
  const lines = [
    "| Lens | Runs | Turns | Reads | Greps | Distinct files | Cache-write tok | Cache-read tok | Output tok | $ |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.lens} | ${r.n} | ${f(r.turns)} | ${f(r.reads)} | ${f(r.greps)} | ${f(r.distinct_files)} | ${f(r.cache_write, 0)} | ${f(r.cache_read, 0)} | ${f(r.output, 0)} | ${f(r.dollars, 2)} |`,
    );
  }
  return lines.join("\n");
}

function collect(
  home: string,
  repos: string[],
  since: number,
  prices: Prices,
): Map<string, RunStats[]> {
  const byLens = new Map<string, RunStats[]>();
  const root = path.join(home, ".claude", "projects");
  const known = new Set<string>(ALL_LENS_NAMES);
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return byLens;
  }
  for (const proj of projects) {
    if (repos.length > 0 && !repos.some((r) => proj.includes(r))) continue;
    const projDir = path.join(root, proj);
    let sessions: string[] = [];
    try {
      sessions = fs.readdirSync(projDir);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const sub = path.join(projDir, session, "subagents");
      let names: string[] = [];
      try {
        names = fs.readdirSync(sub);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".meta.json")) continue;
        try {
          const meta = JSON.parse(
            fs.readFileSync(path.join(sub, name), "utf8"),
          );
          const lens = lensFromMeta(meta);
          if (!lens || !known.has(lens)) continue;
          const jsonl = path.join(sub, name.replace(/\.meta\.json$/, ".jsonl"));
          if (fs.statSync(jsonl).mtimeMs < since) continue;
          const stats = statsFromJsonl(fs.readFileSync(jsonl, "utf8"), prices);
          byLens.set(lens, [...(byLens.get(lens) ?? []), stats]);
        } catch {
          continue;
        }
      }
    }
  }
  return byLens;
}

function main(argv: string[]): number {
  let home = os.homedir();
  let repos: string[] = [];
  let since = 0;
  let json = false;
  let prices: Prices = { ...MODEL_PRICING };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--home":
        home = v;
        i++;
        break;
      case "--repos":
        repos = v.split(",").filter(Boolean);
        i++;
        break;
      case "--since": {
        since = Date.parse(`${v}T00:00:00Z`);
        if (Number.isNaN(since)) {
          process.stderr.write(`invalid --since: ${v}\n`);
          return 2;
        }
        i++;
        break;
      }
      case "--model-prices":
        prices = { ...prices, ...JSON.parse(fs.readFileSync(v, "utf8")) };
        i++;
        break;
      case "--json":
        json = true;
        break;
      default:
        process.stderr.write(`unknown flag: ${argv[i]}\n`);
        return 2;
    }
  }
  const rows = aggregate(collect(home, repos, since, prices));
  process.stdout.write(
    json ? `${JSON.stringify(rows)}\n` : `${renderTable(rows)}\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
