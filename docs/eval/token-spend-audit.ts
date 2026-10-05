#!/usr/bin/env bun
// Re-runnable token-spend audit over local Claude Code transcripts, joined to
// flow's telemetry. Standalone on purpose: no bin/lib imports, so it runs on
// any checkout. Prints markdown tables to stdout.
//   bun docs/eval/token-spend-audit.ts --since 2026-08-31
//   bun docs/eval/token-spend-audit.ts --self-test
// Flags: --home <dir> (default $HOME), --repos <csv> (default
// flow,pokemon,econ-data), --since <YYYY-MM-DD> (UTC, filters BOTH sources on
// row timestamp, never file mtime), --self-test.
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join } from "path";

// $/MTok: input, 5m cache write (1.25x), 1h cache write (2x), cache read, output.
const PRICING_DATE = "2026-09-30"; // Last verified: 2026-09-30
type Price = [number, number, number, number, number];
const PRICES: Record<string, Price> = {
  "claude-opus-5": [5, 6.25, 10, 0.5, 25],
  "claude-opus-5-5": [4, 5, 8, 0.2, 20],
  "claude-sonnet-5": [2, 2.5, 4, 0.2, 10],
  "claude-sonnet-5-5": [2, 2.5, 4, 0.2, 10],
  "claude-fable-5": [10, 12.5, 20, 1, 50],
  "claude-fable-5-1": [10, 12.5, 20, 0.25, 50],
  "claude-haiku-4-5-20251001": [1, 1.25, 2, 0.1, 5],
};
const UNPARENTED = "unparented sub-agent tokens";
const TERMINAL_PHASES = new Set([
  "merged",
  "gated",
  "needs-human",
  "cancelled",
  "triaged-no-change",
]);

export type Usage = {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  turns: number;
  usd: number;
};
export type EventRow = {
  ts: string;
  event: string;
  slug: string | null;
  repo: string | null;
  session_id: string | null;
  attrs: any;
};
export type PipelineFacts = {
  slug: string | null;
  repo: string | null;
  phases: Record<string, number[]>; // ms spent in the phase named by `from`
  verifyOk: number;
  verifyFail: number;
  terminal: string | null;
  terminalReason: string | null;
  lastPhase: string | null;
};
type Stats = {
  parseErrors: number;
  missingUsage: number;
  unknownModels: Map<string, number>;
};
type Turn = { model: string; usage: any; ts: string; seg: string };
type Spawn = { prefix: string; type: string; toolUseId?: string };
type Meta = { agentType?: string; toolUseId?: string };

export const zero = (): Usage => ({
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
  turns: 0,
  usd: 0,
});
const newStats = (): Stats => ({
  parseErrors: 0,
  missingUsage: 0,
  unknownModels: new Map(),
});

function classes(u: any) {
  const cc = u?.cache_creation;
  const split =
    cc &&
    (cc.ephemeral_5m_input_tokens != null ||
      cc.ephemeral_1h_input_tokens != null);
  return {
    input: u?.input_tokens || 0,
    w5: split
      ? cc.ephemeral_5m_input_tokens || 0
      : u?.cache_creation_input_tokens || 0,
    w1: split ? cc.ephemeral_1h_input_tokens || 0 : 0,
    read: u?.cache_read_input_tokens || 0,
    output: u?.output_tokens || 0,
  };
}

export function priceTurn(usage: any, model: string): number {
  const p = PRICES[model];
  if (!p) return 0;
  const c = classes(usage);
  return (
    (c.input * p[0] +
      c.w5 * p[1] +
      c.w1 * p[2] +
      c.read * p[3] +
      c.output * p[4]) /
    1e6
  );
}

function addTurn(a: Usage, usage: any, model: string) {
  const c = classes(usage);
  a.input += c.input;
  a.cacheWrite5m += c.w5;
  a.cacheWrite1h += c.w1;
  a.cacheRead += c.read;
  a.output += c.output;
  a.turns++;
  a.usd += priceTurn(usage, model);
}

const skillName = (s: unknown) =>
  String(s).replace(/^flow-module-[a-z-]+:/, "");
const agentLabel = (s: string) => s.replace(/^flow-module-[a-z-]+:/, "");

// One API request = one message.id, written as one line per content block.
// Only the LAST line carries the final output_tokens (earlier lines hold a
// streaming placeholder; input and cache fields never differ). Usage is
// buffered per id and flushed in first-seen order carrying the LAST line's
// usage, with ts/seg/inWindow from the FIRST line; every line is still
// scanned for tool calls.
export function walkFile(
  lines: string[],
  stats: Stats,
  onTurn: (t: Turn) => void,
  spawns: Spawn[] = [],
  inWindow: (ts: string) => boolean = () => true,
) {
  const turns = new Map<string, Turn & { counted: boolean }>();
  const missing = new Set<string>();
  let cur = "supervisor-base";
  for (const l of lines) {
    let j: any;
    try {
      j = JSON.parse(l);
    } catch {
      stats.parseErrors++;
      continue;
    }
    if (j?.type !== "assistant") continue;
    const m = j.message;
    const id = m?.id ?? j.uuid ?? l;
    if (!m?.usage) {
      if (!turns.has(id) && !missing.has(id) && inWindow(j.timestamp)) {
        missing.add(id);
        stats.missingUsage++;
      }
    } else if (m.model !== "<synthetic>") {
      const prior = turns.get(id);
      if (prior) prior.usage = m.usage;
      else
        turns.set(id, {
          model: m.model || "unknown",
          usage: m.usage,
          ts: j.timestamp,
          seg: cur,
          counted: inWindow(j.timestamp),
        });
    }
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type !== "tool_use") continue;
      if (b.name === "Skill" && b.input?.skill) cur = skillName(b.input.skill);
      if ((b.name === "Agent" || b.name === "Task") && b.input?.prompt) {
        const type = b.input.subagent_type ?? "general-purpose";
        spawns.push({
          prefix: String(b.input.prompt).slice(0, 120),
          type: agentLabel(String(type)),
          toolUseId: b.id,
        });
      }
    }
  }
  for (const { counted, ...t } of turns.values()) {
    if (!counted) continue;
    if (!PRICES[t.model])
      stats.unknownModels.set(
        t.model,
        (stats.unknownModels.get(t.model) || 0) + 1,
      );
    onTurn(t);
  }
}

export const windowSince = (since: number) => (ts: string) =>
  !since || Date.parse(ts) >= since;

export function attributeSession(
  lines: string[],
  since = 0,
): {
  segments: Record<string, Usage>;
  agentPrompts: Spawn[];
  stats: Stats;
} {
  const segments: Record<string, Usage> = {};
  const agentPrompts: Spawn[] = [];
  const stats = newStats();
  walkFile(
    lines,
    stats,
    (t) => addTurn((segments[t.seg] ||= zero()), t.usage, t.model),
    agentPrompts,
    windowSince(since),
  );
  return { segments, agentPrompts, stats };
}

export function resolveAgentType(
  meta: Meta | undefined,
  firstUserText: string,
  spawns: Spawn[],
  description = "",
): string {
  if (meta?.agentType) return agentLabel(meta.agentType);
  const byId = meta?.toolUseId
    ? spawns.find((s) => s.toolUseId === meta.toolUseId)
    : undefined;
  if (byId) return byId.type;
  if (firstUserText) {
    const hit = spawns.find((s) => firstUserText.startsWith(s.prefix));
    if (hit) return hit.type;
  }
  const re =
    /flow-review-(bug-detection|security|pattern-consistency|performance|supply-chain|test-coverage|intent-guess)|flow-(consolidator|fix-applier|discovery|scout|edit-applier|merge-resolver|backlog-verifier)/;
  const m = (description || firstUserText.slice(0, 600)).match(re);
  return m ? m[0] : UNPARENTED;
}

export function joinEvents(events: EventRow[]): Map<string, PipelineFacts> {
  const out = new Map<string, PipelineFacts>();
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const e of sorted) {
    if (!e.session_id) continue;
    let f = out.get(e.session_id);
    if (!f) {
      f = {
        slug: null,
        repo: null,
        phases: {},
        verifyOk: 0,
        verifyFail: 0,
        terminal: null,
        terminalReason: null,
        lastPhase: null,
      };
      out.set(e.session_id, f);
    }
    if (e.slug) f.slug = e.slug;
    if (e.repo) f.repo = e.repo;
    const a = e.attrs || {};
    if (e.event === "phase.transition") {
      if (a.from && typeof a.since_prev_ms === "number")
        (f.phases[a.from] ||= []).push(a.since_prev_ms);
      f.lastPhase = TERMINAL_PHASES.has(a.to) ? (a.from ?? a.to) : a.to;
    } else if (e.event === "verify.attempt") {
      if (a.ok) f.verifyOk++;
      else f.verifyFail++;
    } else if (e.event === "run.terminal") {
      f.terminal = a.status ?? null;
      f.terminalReason = a.reason ?? null;
    }
  }
  return out;
}

const SKIP_CWD = /scratchpad|flow-eval-fixture|^\/private\/(tmp|var)|^\/tmp/;
export function resolveRepo(cwd: string | undefined, repos: string[]) {
  if (!cwd || SKIP_CWD.test(cwd)) return null;
  const b = basename(cwd);
  for (const r of repos)
    if (b === r) return { repo: r, worktree: false };
    else if (b.startsWith(`${r}-`)) return { repo: r, worktree: true };
  return null;
}

const readLines = (p: string) => {
  try {
    return readFileSync(p, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const readJson = (p: string): any => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
};
const pct = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const fmtM = (n: number) => (n / 1e6).toFixed(2) + "M";
const fmtUsd = (n: number) => "$" + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
const fmtN = (n: number) => (Number.isNaN(n) ? "n/a" : n.toFixed(1));
const modelLabel = (m: string) => (PRICES[m] ? m : `${m} (unpriced)`);
const cell = (s: string) => s.replace(/\|/g, "\\|");

function table(heads: string[], rows: (string | number)[][]) {
  console.log(`| ${heads.join(" | ")} |`);
  console.log(`|${heads.map(() => "---").join("|")}|`);
  for (const r of rows)
    console.log(`| ${r.map((c) => cell(String(c))).join(" | ")} |`);
  console.log();
}

function usageTable(title: string, o: Record<string, Usage>, churn = false) {
  console.log(`## ${title}\n`);
  const entries = Object.entries(o).sort((a, b) => b[1].usd - a[1].usd);
  const total = entries.reduce((s, [, u]) => s + u.usd, 0);
  const heads = [
    "key",
    "turns",
    "input",
    "cache-write 5m",
    "cache-write 1h",
    "cache-read",
    "output",
    "$",
    "% of $",
  ];
  if (churn) heads.push("cache-churn");
  const row = (k: string, u: Usage) => {
    const r: (string | number)[] = [
      k,
      u.turns,
      fmtM(u.input),
      fmtM(u.cacheWrite5m),
      fmtM(u.cacheWrite1h),
      fmtM(u.cacheRead),
      fmtM(u.output),
      fmtUsd(u.usd),
      total ? ((100 * u.usd) / total).toFixed(1) + "%" : "0.0%",
    ];
    if (churn)
      r.push(
        u.cacheRead
          ? ((u.cacheWrite5m + u.cacheWrite1h) / u.cacheRead).toFixed(3)
          : "n/a",
      );
    return r;
  };
  const sum = zero();
  for (const [, u] of entries)
    for (const k of Object.keys(sum) as (keyof Usage)[]) sum[k] += u[k];
  table(heads, [...entries.map(([k, u]) => row(k, u)), row("**TOTAL**", sum)]);
}

function run(argv: string[]) {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const HOME = flag("--home") ?? process.env.HOME!;
  const repos = (flag("--repos") ?? "flow,pokemon,econ-data")
    .split(",")
    .filter(Boolean);
  const sinceStr = flag("--since");
  const since = sinceStr ? Date.parse(`${sinceStr}T00:00:00Z`) : 0;
  if (sinceStr && Number.isNaN(since))
    throw new Error(`bad --since: ${sinceStr}`);
  const inWindow = windowSince(since);

  const stats = newStats();
  const byProject: Record<string, Usage> = {};
  const byModel: Record<string, Usage> = {};
  const byAgent: Record<string, Usage> = {};
  const bySeg: Record<string, Usage> = {};
  const byAgentModel: Record<string, Usage> = {};
  const firstTurn: Record<string, number[]> = {};
  const sessions: { sid: string; repo: string; usage: Usage }[] = [];
  let worktreeSessions = 0;
  let minTs = Infinity,
    maxTs = -Infinity;
  let w5Usd = 0,
    w1Usd = 0,
    w1Premium = 0;
  let mainUsd = 0,
    subUsd = 0;
  const tok = zero();
  const G = (o: Record<string, Usage>, k: string) => (o[k] ||= zero());

  const root = join(HOME, ".claude", "projects");
  const dirs = existsSync(root) ? readdirSync(root) : [];
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(root, d)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const sid = f.replace(/\.jsonl$/, "");
      const lines = readLines(join(root, d, f));
      let cwd: string | undefined;
      for (const l of lines) {
        if (!l.includes('"cwd"')) continue;
        try {
          const j = JSON.parse(l);
          if (j.cwd) {
            cwd = j.cwd;
            break;
          }
        } catch {
          /* counted in walk */
        }
      }
      const res = resolveRepo(cwd, repos);
      if (!res) continue;
      const sess = zero();
      let counted = false;
      const note = (t: Turn, into: Usage[]) => {
        const ms = Date.parse(t.ts);
        if (ms < minTs) minTs = ms;
        if (ms > maxTs) maxTs = ms;
        counted = true;
        for (const u of into) addTurn(u, t.usage, t.model);
        addTurn(tok, t.usage, t.model);
        const pr = PRICES[t.model];
        if (pr) {
          const c = classes(t.usage);
          w5Usd += (c.w5 * pr[1]) / 1e6;
          w1Usd += (c.w1 * pr[2]) / 1e6;
          w1Premium += (c.w1 * (pr[2] - pr[1])) / 1e6;
        }
      };
      const spawns: Spawn[] = [];
      walkFile(
        lines,
        stats,
        (t) => {
          note(t, [
            G(byProject, res.repo),
            G(byModel, modelLabel(t.model)),
            G(bySeg, t.seg),
            sess,
          ]);
          mainUsd += priceTurn(t.usage, t.model);
        },
        spawns,
        inWindow,
      );
      const sadir = join(root, d, sid, "subagents");
      if (existsSync(sadir)) {
        for (const sf of readdirSync(sadir).filter((x) =>
          x.endsWith(".jsonl"),
        )) {
          const meta: Meta | undefined = readJson(
            join(sadir, sf.replace(/\.jsonl$/, ".meta.json")),
          );
          const sl = readLines(join(sadir, sf));
          let text = "";
          for (const l of sl.slice(0, 3)) {
            try {
              const j = JSON.parse(l);
              const c = j.message?.content;
              const t =
                typeof c === "string"
                  ? c
                  : Array.isArray(c)
                    ? c.map((b: any) => b.text || "").join("")
                    : "";
              if (j.type === "user" && t) {
                text = t;
                break;
              }
            } catch {
              /* counted below */
            }
          }
          const type = resolveAgentType(
            meta,
            text,
            spawns,
            meta && (meta as any).description,
          );
          let first = true;
          walkFile(
            sl,
            stats,
            (t) => {
              const isFirst = first;
              first = false;
              note(t, [
                G(byProject, res.repo),
                G(byModel, modelLabel(t.model)),
                G(byAgent, type),
                G(byAgentModel, `${type} @ ${modelLabel(t.model)}`),
                sess,
              ]);
              subUsd += priceTurn(t.usage, t.model);
              if (isFirst) {
                const c = classes(t.usage);
                (firstTurn[type] ||= []).push(c.w5 + c.w1);
              }
            },
            [],
            inWindow,
          );
        }
      }
      if (counted) {
        sessions.push({ sid, repo: res.repo, usage: sess });
        if (res.worktree) worktreeSessions++;
      }
    }
  }

  const events: EventRow[] = [];
  const evPath = join(HOME, ".flow", "telemetry", "events.jsonl");
  for (const l of readLines(evPath)) {
    try {
      const e = JSON.parse(l);
      if (e?.ts && inWindow(e.ts)) events.push(e);
    } catch {
      stats.parseErrors++;
    }
  }
  const facts = joinEvents(events);
  const repoOf = (p: string | null) =>
    p ? (resolveRepo(p, repos)?.repo ?? basename(p)) : null;
  const joined = sessions.filter((s) => facts.has(s.sid));
  const rate = sessions.length ? joined.length / sessions.length : 0;
  const runDate = new Date().toISOString().slice(0, 10);
  const stale = (Date.parse(runDate) - Date.parse(PRICING_DATE)) / 864e5 > 90;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  console.log("# Token-spend audit\n");
  console.log(
    `- Run date: ${runDate}${sinceStr ? ` (--since ${sinceStr}, UTC)` : ""}`,
  );
  console.log(
    `- Pricing table last verified: ${PRICING_DATE}${stale ? " - WARNING: more than 90 days old, re-verify before trusting dollars" : ""}`,
  );
  console.log(
    `- Sessions covered: ${sessions.length} (${sessions.length ? `${day(minTs)} to ${day(maxTs)}` : "none"}); repos: ${repos.join(", ")}`,
  );
  console.log(`- Sessions from worktree cwds: ${worktreeSessions}`);
  console.log(
    `- Telemetry join rate: ${joined.length}/${sessions.length} (${(rate * 100).toFixed(1)}%)`,
  );
  if (rate < 0.6)
    console.log(
      "- Caveat: join rate is below 60%; per-pipeline and outcome tables describe only the joined sessions and may not represent the whole window.",
    );
  console.log(
    `- Parse errors (whole files, not window-filtered): ${stats.parseErrors}`,
  );
  console.log(`- Assistant rows with no usage: ${stats.missingUsage}`);
  const unk = [...stats.unknownModels.entries()];
  console.log(
    `- Unknown models: ${unk.length ? unk.map(([m, n]) => `${m} (${n} turns, priced $0)`).join(", ") : "0"}`,
  );
  console.log(
    `- Spend (list price): supervisor ${fmtUsd(mainUsd)}, sub-agents ${fmtUsd(subUsd)}, total ${fmtUsd(mainUsd + subUsd)}`,
  );
  console.log(
    `- Cache writes: 5m ${fmtM(tok.cacheWrite5m)} tokens, 1h ${fmtM(tok.cacheWrite1h)} tokens (${tok.cacheWrite5m + tok.cacheWrite1h ? ((100 * tok.cacheWrite1h) / (tok.cacheWrite5m + tok.cacheWrite1h)).toFixed(1) : "0.0"}% are 1h)`,
  );
  console.log(
    `- Cache-write spend (list price): 5m ${fmtUsd(w5Usd)}, 1h ${fmtUsd(w1Usd)}; the 1h premium over the 5m rate is ${fmtUsd(w1Premium)}\n`,
  );

  usageTable("By project", byProject);
  usageTable("By model", byModel);
  usageTable("By sub-agent type", byAgent, true);
  usageTable("By in-process segment", bySeg, true);
  usageTable("Sub-agent type @ model", byAgentModel);

  const keyed = new Map<string, number>();
  const pipeRows: {
    key: string;
    usd: number;
    turns: number;
    med: number;
    ok: number;
    fail: number;
    outcome: string;
  }[] = [];
  for (const s of joined.sort((a, b) => a.sid.localeCompare(b.sid))) {
    const f = facts.get(s.sid)!;
    if (!f.slug) continue;
    const repo = repoOf(f.repo) ?? s.repo;
    const n = (keyed.get(repo) || 0) + 1;
    keyed.set(repo, n);
    const all = Object.values(f.phases)
      .flat()
      .map((x) => x / 6e4);
    pipeRows.push({
      key: repo === "flow" ? f.slug : `${repo}-${n}`,
      usd: s.usage.usd,
      turns: s.usage.turns,
      med: pct(all, 0.5),
      ok: f.verifyOk,
      fail: f.verifyFail,
      outcome: f.terminal
        ? f.terminal + (f.terminalReason ? `:${f.terminalReason}` : "")
        : "(no terminal)",
    });
  }
  console.log("## Per-pipeline\n");
  const pu = pipeRows.map((r) => r.usd);
  console.log(
    pu.length
      ? `Pipelines with spend joined: ${pu.length}; median ${fmtUsd(pct(pu, 0.5))}, p75 ${fmtUsd(pct(pu, 0.75))}, max ${fmtUsd(Math.max(...pu))}\n`
      : "Pipelines with spend joined: 0 (no per-pipeline statistics)\n",
  );
  table(
    ["pipeline", "$", "turns", "phase median min", "verify ok/fail", "outcome"],
    pipeRows
      .sort((a, b) => b.usd - a.usd)
      .map((r) => [
        r.key,
        fmtUsd(r.usd),
        r.turns,
        fmtN(r.med),
        `${r.ok}/${r.fail}`,
        r.outcome,
      ]),
  );

  const inRepos = (f: PipelineFacts) =>
    f.repo === null || repos.includes(repoOf(f.repo) ?? "");
  const slugged = [...facts.values()].filter(
    (f) => f.slug && f.terminal && inRepos(f),
  );
  const slugless = [...facts.values()].filter((f) => !f.slug && f.terminal);
  const dist = (fs: PipelineFacts[]) => {
    const c = new Map<string, number>();
    for (const f of fs) c.set(f.terminal!, (c.get(f.terminal!) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, n]);
  };
  console.log("## Outcome distribution\n");
  console.log(
    `Slugged runs (one terminal per session, the last): ${slugged.length}\n`,
  );
  table(["status", "runs"], dist(slugged));
  console.log(
    `Slug-less terminals (flow-eval harness children, never counted as pipelines): ${slugless.length}\n`,
  );
  table(["status", "runs"], dist(slugless));

  console.log("## Outcome by last phase\n");
  const ol = new Map<string, number>();
  for (const f of slugged) {
    const k = `${f.terminal} | ${f.terminalReason ?? "-"} | ${f.lastPhase ?? "(none)"}`;
    ol.set(k, (ol.get(k) || 0) + 1);
  }
  table(
    ["status", "reason", "phase the run ended in", "runs"],
    [...ol.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => [...k.split(" | "), n]),
  );

  console.log("## First-turn cache-write per sub-agent type\n");
  table(
    ["sub-agent type", "transcripts", "median tokens", "mean tokens"],
    Object.entries(firstTurn)
      .sort((a, b) => pct(b[1], 0.5) - pct(a[1], 0.5))
      .map(([k, xs]) => [
        k,
        xs.length,
        Math.round(pct(xs, 0.5)),
        Math.round(mean(xs)),
      ]),
  );

  console.log("## Phase minutes and verify pass rate\n");
  console.log(
    "since_prev_ms measures time spent in the PREVIOUS phase, so each row is keyed by the phase the run was leaving.\n",
  );
  const ph = new Map<string, number[]>();
  let vok = 0,
    vfail = 0;
  for (const f of facts.values()) {
    if (!f.slug || !inRepos(f)) continue;
    for (const [p, xs] of Object.entries(f.phases))
      ph.set(p, [...(ph.get(p) || []), ...xs.map((x) => x / 6e4)]);
    vok += f.verifyOk;
    vfail += f.verifyFail;
  }
  table(
    ["phase", "transitions", "median min", "p75 min"],
    [...ph.entries()]
      .sort((a, b) => pct(b[1], 0.5) - pct(a[1], 0.5))
      .map(([p, xs]) => [
        p,
        xs.length,
        fmtN(pct(xs, 0.5)),
        fmtN(pct(xs, 0.75)),
      ]),
  );
  console.log(
    `Verify attempts (slugged runs): ${vok} ok, ${vfail} failed (${vok + vfail ? ((100 * vok) / (vok + vfail)).toFixed(1) : "n/a"}% pass)\n`,
  );

  const lensRows: any[] = [];
  for (const l of readLines(
    join(HOME, ".flow", "telemetry", "review-lenses.jsonl"),
  )) {
    try {
      const r = JSON.parse(l);
      if (r?.ts && inWindow(r.ts)) lensRows.push(r);
    } catch {
      stats.parseErrors++;
    }
  }
  console.log("## Review lenses: spend per acted finding\n");
  const lensSummary = summarizeLenses(lensRows);
  const unpriced = lensSummary.reduce((n, r) => n + r.unpriced, 0);
  console.log(
    `Review runs in window: ${lensRows.length}. Only reviews recorded since PR #896 are costed here. Older reviews appear in the legacy rows column but are not added in, because they used a different, non-comparable token unit; their re-derived history is in PR #896. Until new reviews accumulate, tokens and dollars read n/a and fill in as they do.${unpriced ? ` ${unpriced} runs whose model name could not be priced are counted separately and left out of dollars.` : ""} Per-acted figures divide by the acted findings of the reviews that contributed. Dollars use this file's list prices, with cache writes at the 5-minute rate.\n`,
  );
  table(
    [
      "lens",
      "runs",
      "v3 token runs",
      "tokens",
      "dollars",
      "emitted",
      "survived",
      "acted",
      "tokens per acted",
      "dollars per acted",
      "legacy rows",
      "token sources (transcript/notification/none)",
    ],
    lensSummary.map((r) => [
      r.lens,
      r.runs,
      r.token_runs,
      r.tokens ? fmtM(r.tokens) : "n/a",
      r.dollars ? fmtUsd(r.dollars) : "n/a",
      r.emitted,
      r.survived,
      r.acted,
      r.acted_tok && r.tokens ? fmtM(r.tokens / r.acted_tok) : "n/a",
      r.acted_usd && r.dollars ? fmtUsd(r.dollars / r.acted_usd) : "n/a",
      r.legacy,
      `${r.src["subagent-transcript"] || 0}/${r.src["task-notification"] || 0}/${r.src["unavailable"] || 0}`,
    ]),
  );
}

export function summarizeLenses(rows: any[]) {
  const by = new Map<string, any>();
  for (const r of rows) {
    const current = (r.version ?? 0) >= 3;
    for (const [lens, v] of Object.entries<any>(r.lenses || {})) {
      const a = by.get(lens) ?? {
        lens,
        runs: 0,
        tokens: 0,
        dollars: 0,
        token_runs: 0,
        emitted: 0,
        survived: 0,
        acted: 0,
        acted_tok: 0,
        acted_usd: 0,
        unpriced: 0,
        src: {},
        legacy: 0,
      };
      by.set(lens, a);
      if (v.ran) a.runs++;
      if (v.ran && !current) a.legacy++;
      a.emitted += v.findings_emitted || 0;
      a.survived += v.findings_survived || 0;
      a.acted += v.findings_acted || 0;
      a.src[v.tokens_source] = (a.src[v.tokens_source] || 0) + 1;
      if (!current || !v.ran || !v.tokens) continue;
      const acted = v.findings_acted || 0;
      a.tokens += v.tokens.total || 0;
      a.token_runs++;
      a.acted_tok += acted;
      if (PRICES[v.model]) {
        a.dollars += priceTurn(
          {
            input_tokens: v.tokens.input,
            cache_creation_input_tokens: v.tokens.cache_creation,
            cache_read_input_tokens: v.tokens.cache_read,
            output_tokens: v.tokens.output,
          },
          v.model,
        );
        a.acted_usd += acted;
      } else a.unpriced++;
    }
  }
  return [...by.values()].sort(
    (a, b) => b.dollars - a.dollars || b.tokens - a.tokens,
  );
}

export function selfTest(): string[] {
  const fails: string[] = [];
  const eq = (name: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      fails.push(`${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
  };
  const close = (name: string, a: number, b: number) => {
    if (Math.abs(a - b) > 1e-9) fails.push(`${name}: got ${a} want ${b}`);
  };
  const asst = (
    id: string,
    model: string,
    usage: any,
    content: any[] = [],
    ts = "2026-09-10T00:00:00Z",
  ) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: { id, model, usage, content },
    });
  const split = {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 600,
    cache_creation: {
      ephemeral_5m_input_tokens: 100,
      ephemeral_1h_input_tokens: 500,
    },
  };
  close(
    "priceTurn split",
    priceTurn(split, "claude-opus-5"),
    (10 * 5 + 100 * 6.25 + 500 * 10 + 1000 * 0.5 + 20 * 25) / 1e6,
  );
  close(
    "priceTurn fallback",
    priceTurn({ cache_creation_input_tokens: 400 }, "claude-opus-5"),
    (400 * 6.25) / 1e6,
  );
  close("priceTurn unknown", priceTurn(split, "claude-mystery-9"), 0);

  const lines = [
    "{not json",
    asst("m1", "claude-opus-5", split, [
      {
        type: "tool_use",
        id: "tu1",
        name: "Skill",
        input: { skill: "flow-module-core:flow-coder" },
      },
    ]),
    asst("m1", "claude-opus-5", split, [
      { type: "text", text: "dup row of m1" },
    ]),
    JSON.stringify({
      type: "assistant",
      message: { id: "m2", model: "claude-opus-5", content: [] },
    }),
    asst("m3", "claude-mystery-9", split, [
      {
        type: "tool_use",
        id: "tu2",
        name: "Agent",
        input: {
          prompt: "Do the thing for the parent",
          subagent_type: "flow-module-core:flow-edit-applier",
        },
      },
    ]),
    asst("m4", "claude-sonnet-5", { input_tokens: 1, output_tokens: 1 }),
  ];
  const r = attributeSession(lines);
  eq("parseErrors", r.stats.parseErrors, 1);
  eq("missingUsage", r.stats.missingUsage, 1);
  eq("unknown model", [...r.stats.unknownModels.keys()], ["claude-mystery-9"]);
  eq("dedup turns", r.segments["supervisor-base"]?.turns, 1);
  eq("skill segment turns", r.segments["flow-coder"]?.turns, 2);
  eq(
    "segment split",
    [
      r.segments["supervisor-base"].cacheWrite1h,
      r.segments["supervisor-base"].cacheWrite5m,
    ],
    [500, 100],
  );
  eq(
    "agent prompts",
    r.agentPrompts.map((a) => [a.type, a.toolUseId, a.prefix]),
    [["flow-edit-applier", "tu2", "Do the thing for the parent"]],
  );
  const windowed = attributeSession(
    [
      asst("w1", "claude-opus-5", split, [], "2026-09-01T00:00:00Z"),
      asst("w2", "claude-mystery-9", split, [], "2026-09-01T00:00:00Z"),
      asst("w3", "claude-opus-5", split, [], "2026-09-20T00:00:00Z"),
    ],
    Date.parse("2026-09-10T00:00:00Z"),
  );
  eq("since drops old turns", windowed.segments["supervisor-base"]?.turns, 1);
  eq("since drops old unknown models", windowed.stats.unknownModels.size, 0);

  const spawns: Spawn[] = [
    {
      prefix: "Do the thing for the parent",
      type: "flow-edit-applier",
      toolUseId: "tu2",
    },
  ];
  eq(
    "type from meta.agentType",
    resolveAgentType(
      { agentType: "flow-module-core:flow-fix-applier" },
      "",
      spawns,
    ),
    "flow-fix-applier",
  );
  eq(
    "type from meta.toolUseId",
    resolveAgentType({ toolUseId: "tu2" }, "", spawns),
    "flow-edit-applier",
  );
  eq(
    "type from prompt prefix (no meta)",
    resolveAgentType(undefined, "Do the thing for the parent, please", spawns),
    "flow-edit-applier",
  );
  eq(
    "type from regex",
    resolveAgentType(undefined, "You are flow-review-security agent", []),
    "flow-review-security",
  );
  eq("unparented", resolveAgentType(undefined, "hello", []), UNPARENTED);

  const ev = (
    ts: string,
    event: string,
    slug: string | null,
    sid: string,
    attrs: any,
  ): EventRow => ({ ts, event, slug, repo: "/x/flow", session_id: sid, attrs });
  const f = joinEvents([
    ev("2026-09-10T00:03:00Z", "run.terminal", "s1", "A", {
      status: "merged",
      reason: null,
    }),
    ev("2026-09-10T00:01:00Z", "phase.transition", "s1", "A", {
      from: "implementing",
      to: "verifying",
      since_prev_ms: 60000,
    }),
    ev("2026-09-10T00:02:00Z", "verify.attempt", "s1", "A", { ok: false }),
    ev("2026-09-10T00:02:30Z", "phase.transition", "s1", "A", {
      from: "verifying",
      to: "merged",
      since_prev_ms: 30000,
    }),
    ev("2026-09-10T00:02:40Z", "run.terminal", "s1", "A", {
      status: "gated",
      reason: "x",
    }),
    ev("2026-09-10T00:04:00Z", "run.terminal", null, "B", {
      status: "merged",
      reason: null,
    }),
  ]);
  eq(
    "last terminal wins",
    [f.get("A")!.terminal, f.get("A")!.terminalReason],
    ["merged", null],
  );
  eq("lastPhase skips terminal to", f.get("A")!.lastPhase, "verifying");
  eq("verify fail", [f.get("A")!.verifyOk, f.get("A")!.verifyFail], [0, 1]);
  eq("phases keyed by from", f.get("A")!.phases, {
    implementing: [60000],
    verifying: [30000],
  });
  eq(
    "slug-less terminal",
    [f.get("B")!.slug, f.get("B")!.terminal],
    [null, "merged"],
  );
  const v3 = (model: string, tokens: any, acted: number, ran = true) => ({
    ran,
    model,
    tokens,
    tokens_source: tokens ? "subagent-transcript" : "unavailable",
    findings_acted: acted,
  });
  const ls = summarizeLenses([
    {
      version: 3,
      lenses: {
        a: v3(
          "claude-opus-5",
          {
            total: 1_000_000 + 2_000_000 + 1_000_000 + 100_000,
            input: 1_000_000,
            cache_creation: 2_000_000,
            cache_read: 1_000_000,
            output: 100_000,
          },
          2,
        ),
      },
    },
    {
      version: 3,
      lenses: {
        a: v3("claude-mystery-9", { total: 50, input: 50 }, 1),
      },
    },
    { version: 3, lenses: { a: v3("claude-opus-5", null, 0, false) } },
    {
      version: 3,
      lenses: {
        a: v3("claude-opus-5", { total: 999_999, input: 999_999 }, 0, false),
      },
    },
    {
      version: 2,
      lenses: {
        a: {
          ran: true,
          tokens: { total: 7000 },
          tokens_source: "subagent-transcript",
          findings_acted: 5,
        },
      },
    },
    {
      version: 1,
      lenses: {
        a: {
          ran: true,
          tokens: { total: 900 },
          tokens_source: "task-notification",
          findings_acted: 1,
        },
      },
    },
    {
      lenses: {
        a: {
          ran: true,
          tokens: { total: 100 },
          tokens_source: "task-notification",
          findings_acted: 2,
        },
      },
    },
  ]);
  eq(
    "lens summary: v3 only in tokens, older rows legacy",
    [
      ls[0].runs,
      ls[0].tokens,
      ls[0].token_runs,
      ls[0].acted,
      ls[0].legacy,
      ls[0].unpriced,
      ls[0].acted_tok,
      ls[0].acted_usd,
    ],
    [5, 4_100_050, 2, 11, 3, 1, 3, 2],
  );
  // opus-5: 1M*5 + 2M*6.25 (5m rate) + 1M*0.5 + 0.1M*25 = 5+12.5+0.5+2.5
  close("lens summary dollars", ls[0].dollars, 20.5);
  eq(
    "lens summary src",
    [ls[0].src["subagent-transcript"], ls[0].src.unavailable],
    [4, 1],
  );
  const stream = (outputs: number[]) =>
    outputs.map((o) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-10T00:00:00Z",
        message: {
          id: "r1",
          model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: o },
          content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }],
        },
      }),
    );
  const turns: Turn[] = [];
  walkFile(stream([3, 333]), newStats(), (t) => turns.push(t));
  eq(
    "walkFile last line wins, one turn per id",
    turns.map((t) => [t.usage.output_tokens, t.ts, t.seg]),
    [[333, "2026-09-10T00:00:00Z", "supervisor-base"]],
  );
  eq("resolveRepo worktree", resolveRepo("/u/code/me/flow-foo", ["flow"]), {
    repo: "flow",
    worktree: true,
  });
  eq("resolveRepo skip", resolveRepo("/private/tmp/x/flow", ["flow"]), null);

  return fails;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    const fails = selfTest();
    if (fails.length) {
      console.error(`self-test FAILED (${fails.length}):\n${fails.join("\n")}`);
      process.exit(1);
    }
    console.log("self-test ok");
  } else run(argv);
}
