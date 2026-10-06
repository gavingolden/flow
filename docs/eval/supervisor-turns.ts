#!/usr/bin/env bun
// Re-runnable measurement of where the SUPERVISOR's turns go, per pipeline
// phase, from local Claude Code transcripts. Companion to token-spend-audit.ts
// (which says the supervisor is the dominant spend) — this says which phase
// and, inside review, which step cluster. Standalone: no bin/lib imports; it
// reuses priceTurn/resolveRepo/windowSince from the sibling audit so $ and
// repo attribution never diverge from it.
//   bun docs/eval/supervisor-turns.ts --since 2026-09-10
//   bun docs/eval/supervisor-turns.ts --self-test
// Flags: --home <dir> (default $HOME), --repos <csv> (default
// flow,pokemon,econ-data), --since <YYYY-MM-DD> (UTC, on first-line turn
// timestamp), --self-test.
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { priceTurn, resolveRepo, windowSince } from "./token-spend-audit";

export type Phase =
  | "pre"
  | "implement"
  | "ci-wait"
  | "review"
  | "gate"
  | "merge";
export type ReviewCluster =
  | "lens-collect"
  | "consolidator-collect"
  | "fix-applier-collect"
  | "test-steps-run"
  | "findings-post"
  | "prep-finalize"
  | "rest";
export type PhaseTurn = {
  phase: Phase;
  usd: number;
  contextTokens: number;
  tools: string[];
  bashCommands: string[];
};

const PHASES: Phase[] = [
  "pre",
  "implement",
  "ci-wait",
  "review",
  "gate",
  "merge",
];
const CLUSTERS: ReviewCluster[] = [
  "lens-collect",
  "consolidator-collect",
  "fix-applier-collect",
  "test-steps-run",
  "findings-post",
  "prep-finalize",
  "rest",
];
// Highest priority first: a turn that both polls for lenses and posts
// findings is findings work, so the cheaper-to-misread poll never wins.
const TURN_PRIORITY: ReviewCluster[] = [
  "test-steps-run",
  "findings-post",
  "prep-finalize",
  "consolidator-collect",
  "fix-applier-collect",
  "lens-collect",
];

// A helper binary invoked at a command position (start, after ; & | ( or a
// newline, past any VAR=val prefixes) — not merely mentioned in a heredoc.
const invokes = (name: string) =>
  `(?:^|[\\n;&|(])\\s*(?:[A-Za-z_]\\w*=(?:"[^"]*"|\\S*)\\s+)*${name}(?![\\w-])`;
const STATE_PHASE = new RegExp(
  `${invokes("flow-state-update")}[^\\n;&|]*?--phase[ =]+([a-z-]+)`,
  "g",
);
const GATE = new RegExp(invokes("flow-gate-decide"), "g");
const MERGE = new RegExp(invokes("flow-merge-guard"), "g");
const STATE_TO_PHASE: Record<string, Phase> = {
  implementing: "implement",
  reviewing: "review",
  "ci-wait": "ci-wait",
  merging: "merge",
};
type Step = (cur: Phase) => Phase;

const skillBase = (s: string) => s.replace(/^[a-z0-9-]+:/, "");

function commandSteps(cmd: string): Step[] {
  const hits: { idx: number; step: Step }[] = [];
  for (const m of cmd.matchAll(STATE_PHASE)) {
    const to = STATE_TO_PHASE[m[1]];
    if (to) hits.push({ idx: m.index!, step: () => to });
  }
  for (const m of cmd.matchAll(GATE))
    hits.push({ idx: m.index!, step: () => "gate" });
  for (const m of cmd.matchAll(MERGE))
    hits.push({ idx: m.index!, step: () => "merge" });
  return hits.sort((a, b) => a.idx - b.idx).map((h) => h.step);
}

function skillStep(skill: string): Step | null {
  const s = skillBase(skill);
  if (s === "flow-pr-review") return () => "review";
  if (s === "flow-new-feature" || s === "flow-coder")
    return (cur) => (cur === "pre" ? "implement" : cur);
  return null;
}

const ctxOf = (u: any) =>
  (u?.cache_read_input_tokens || 0) +
  (u?.cache_creation_input_tokens || 0) +
  (u?.input_tokens || 0);

type Raw = {
  model: string;
  usage: any;
  ts: string;
  tools: string[];
  cmds: string[];
  steps: Step[];
};

// One API request = one message.id, written as one line per content block;
// only the LAST line carries the final usage (last line wins), while ts and
// the phase come from the FIRST. Every line is scanned for tool calls. The
// phase machine runs over ALL turns so a --since cut never shifts boundaries;
// a turn that carries a boundary action belongs to the phase it starts.
export function segmentSession(lines: string[], since: number): PhaseTurn[] {
  const byId = new Map<string, Raw>();
  for (const l of lines) {
    let j: any;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (j?.type !== "assistant") continue;
    const m = j.message;
    const id = m?.id ?? j.uuid ?? l;
    let raw = byId.get(id);
    if (!raw)
      byId.set(
        id,
        (raw = {
          model: m?.model ?? "unknown",
          usage: null,
          ts: j.timestamp,
          tools: [],
          cmds: [],
          steps: [],
        }),
      );
    if (m?.usage) raw.usage = m.usage;
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type !== "tool_use") continue;
      raw.tools.push(String(b.name));
      if (b.name === "Skill" && b.input?.skill) {
        const st = skillStep(String(b.input.skill));
        if (st) raw.steps.push(st);
      }
      if (typeof b.input?.command === "string") {
        raw.cmds.push(b.input.command);
        raw.steps.push(...commandSteps(b.input.command));
      }
    }
  }
  const inWindow = windowSince(since);
  const out: PhaseTurn[] = [];
  let phase: Phase = "pre";
  for (const r of byId.values()) {
    for (const st of r.steps) phase = st(phase);
    if (!r.usage || r.model === "<synthetic>" || !inWindow(r.ts)) continue;
    out.push({
      phase,
      usd: priceTurn(r.usage, r.model),
      contextTokens: ctxOf(r.usage),
      tools: r.tools,
      bashCommands: r.cmds,
    });
  }
  return out;
}

const has = (cmd: string, re: RegExp) => re.test(cmd);
// File-keyed rules come before the generic wait-loop rule, so a poll loop on
// consolidator-result.json is consolidator work, not lens work.
export function clusterCommand(cmd: string): ReviewCluster {
  if (has(cmd, new RegExp(invokes("flow-post-findings"))))
    return "findings-post";
  if (has(cmd, new RegExp(invokes("flow-review-(?:prep|finalize)"))))
    return "prep-finalize";
  if (
    has(cmd, new RegExp(invokes("flow-(?:inject-evidence|run-test-steps)"))) ||
    has(cmd, /\bevidence-[\w.-]*\.txt\b|\bexit-p?\d+\b/) ||
    has(cmd, /\bgh\s+pr\s+edit\b[^\n]*--body-file/)
  )
    return "test-steps-run";
  if (has(cmd, /consolidator-result\.json/)) return "consolidator-collect";
  if (has(cmd, /fix-applier-result\.json|flow-fix-applier-(?:schema|result)/))
    return "fix-applier-collect";
  if (
    has(cmd, /\buntil\b|\bsleep\b|\bfor\s+\w+\s+in\b|\btest\s+-s\b/) ||
    has(cmd, /flow-agent-finding-schema|agent-output-[\w*.-]*\.json/)
  )
    return "lens-collect";
  return "rest";
}

export function clusterTurn(t: PhaseTurn): ReviewCluster {
  const found = new Set(t.bashCommands.map(clusterCommand));
  return TURN_PRIORITY.find((c) => found.has(c)) ?? "rest";
}

const HELPER = new RegExp(invokes("(flow-[a-z0-9-]+)"));
const LEAD =
  /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*|[A-Za-z_]\w*=(?:"[^"]*"|\S*)\s*;?\s*)+/;
const helperOf = (t: PhaseTurn): string => {
  for (const c of t.bashCommands) {
    const m = c.match(HELPER);
    if (m) return m[1];
  }
  const first = t.bashCommands[0]?.replace(LEAD, "").trim().split(/\s+/)[0];
  return first || t.tools[0] || "(no tool)";
};

// A supervisor transcript is one that loaded the flow-pipeline skill; plain
// chat sessions in the same repos would otherwise pad the "pre" phase.
export function isSupervisorSession(lines: string[]): boolean {
  for (const l of lines) {
    if (!l.includes("flow-pipeline")) continue;
    try {
      const c = JSON.parse(l).message?.content;
      if (
        Array.isArray(c) &&
        c.some(
          (b) =>
            b?.type === "tool_use" &&
            b.name === "Skill" &&
            skillBase(String(b.input?.skill)) === "flow-pipeline",
        )
      )
        return true;
    } catch {
      continue;
    }
  }
  return false;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const quant = (a: number[], p: number) => {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * p))] : 0;
};
const stat = (a: number[]) =>
  `${quant(a, 0.5)} / ${a.length ? (sum(a) / a.length).toFixed(0) : 0}`;
const usd = (n: number) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
const pct = (n: number, d: number) =>
  d ? `${((n / d) * 100).toFixed(1)}%` : "-";
const k = (n: number) => `${Math.round(n / 1000)}K`;

function table(head: string[], rows: string[][]): string {
  const w = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (r: string[]) =>
    `| ${r.map((c, i) => c.padEnd(w[i])).join(" | ")} |`;
  return [
    line(head),
    `| ${w.map((n) => "-".repeat(n)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}

const perSession = (sessions: PhaseTurn[][], pick: (t: PhaseTurn) => boolean) =>
  sessions.map((s) => s.filter(pick)).filter((s) => s.length);

export function render(sessions: PhaseTurn[][]): string {
  const all = sessions.flat();
  const total = sum(all.map((t) => t.usd));
  const out: string[] = [
    `Sessions: ${sessions.length}; supervisor turns: ${all.length}; supervisor spend (list price): ${usd(total)}`,
    "",
    "### Supervisor turns by phase",
    "",
  ];
  out.push(
    table(
      [
        "phase",
        "sessions",
        "turns",
        "$",
        "% of $",
        "median turns/session",
        "p75 turns/session",
        "median context",
      ],
      PHASES.map((p) => {
        const ss = perSession(sessions, (t) => t.phase === p);
        const ts = ss.flat();
        const counts = ss.map((s) => s.length);
        return [
          p,
          String(ss.length),
          String(ts.length),
          usd(sum(ts.map((t) => t.usd))),
          pct(sum(ts.map((t) => t.usd)), total),
          String(quant(counts, 0.5)),
          String(quant(counts, 0.75)),
          k(
            quant(
              ts.map((t) => t.contextTokens),
              0.5,
            ),
          ),
        ];
      }),
    ),
  );

  const rsess = perSession(sessions, (t) => t.phase === "review");
  const review = rsess.flat();
  const rUsd = sum(review.map((t) => t.usd));
  const count = (s: PhaseTurn[], names: string[]) =>
    s.reduce((n, t) => n + t.tools.filter((x) => names.includes(x)).length, 0);
  out.push(
    "",
    `### Review phase (${rsess.length} sessions, ${review.length} turns, ${usd(rUsd)})`,
    "",
    `Per review session (median / mean): ${stat(rsess.map((s) => count(s, ["Bash", "Monitor"])))} Bash/Monitor calls, ${stat(rsess.map((s) => count(s, ["Agent", "Task"])))} Agent calls, ${stat(rsess.map((s) => s.length))} turns.`,
    "",
    table(
      [
        "cluster",
        "turns",
        "$",
        "% of review $",
        "median turns/session",
        "median context",
      ],
      CLUSTERS.map((c) => {
        const ss = rsess
          .map((s) => s.filter((t) => clusterTurn(t) === c))
          .filter((s) => s.length);
        const ts = ss.flat();
        return [
          c,
          String(ts.length),
          usd(sum(ts.map((t) => t.usd))),
          pct(sum(ts.map((t) => t.usd)), rUsd),
          String(
            quant(
              ss.map((s) => s.length),
              0.5,
            ),
          ),
          k(
            quant(
              ts.map((t) => t.contextTokens),
              0.5,
            ),
          ),
        ];
      }),
    ),
  );

  const rest = review.filter((t) => clusterTurn(t) === "rest");
  const restBy = (names: string[]) =>
    rest.filter((t) => t.tools.some((x) => names.includes(x))).length;
  out.push(
    "",
    `Of the ${rest.length} rest turns: ${restBy(["Agent", "Task"])} spawn an agent, ${restBy(["Bash", "Monitor"])} run Bash, ${rest.filter((t) => !t.tools.length).length} are text-only.`,
  );

  const msess = perSession(sessions, (t) => t.phase === "merge");
  const merge = msess.flat();
  const mUsd = sum(merge.map((t) => t.usd));
  const byHelper = new Map<string, PhaseTurn[]>();
  for (const t of merge) {
    const h = helperOf(t);
    byHelper.set(h, [...(byHelper.get(h) ?? []), t]);
  }
  out.push(
    "",
    `### Merge tail (${msess.length} sessions, ${merge.length} turns, ${usd(mUsd)}), by first helper in the turn`,
    "",
    table(
      ["helper", "turns", "$", "% of merge $", "median context"],
      [...byHelper.entries()]
        .sort(
          (a, b) => sum(b[1].map((t) => t.usd)) - sum(a[1].map((t) => t.usd)),
        )
        .slice(0, 12)
        .map(([h, ts]) => [
          h,
          String(ts.length),
          usd(sum(ts.map((t) => t.usd))),
          pct(sum(ts.map((t) => t.usd)), mUsd),
          k(
            quant(
              ts.map((t) => t.contextTokens),
              0.5,
            ),
          ),
        ]),
    ),
  );
  return out.join("\n");
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
  const root = join(HOME, ".claude", "projects");
  const sessions: PhaseTurn[][] = [];
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    let files: string[];
    try {
      files = readdirSync(join(root, d)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const lines = readFileSync(join(root, d, f), "utf8")
        .split("\n")
        .filter(Boolean);
      let cwd: string | undefined;
      for (const l of lines) {
        if (!l.includes('"cwd"')) continue;
        try {
          cwd = JSON.parse(l).cwd;
        } catch {
          continue;
        }
        if (cwd) break;
      }
      if (!resolveRepo(cwd, repos) || !isSupervisorSession(lines)) continue;
      const turns = segmentSession(lines, since);
      if (turns.length) sessions.push(turns);
    }
  }
  console.log(
    `Run date: ${new Date().toISOString().slice(0, 10)}${sinceStr ? ` (--since ${sinceStr}, UTC)` : ""}; repos: ${repos.join(", ")}`,
  );
  console.log(render(sessions));
}

export function selfTest(): string[] {
  const fails: string[] = [];
  const eq = (name: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want))
      fails.push(
        `${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
      );
  };
  const u = { input_tokens: 1, cache_read_input_tokens: 100, output_tokens: 5 };
  const line = (id: string, block: object, ts: string, usage = u) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: {
        id,
        model: "claude-opus-5",
        usage,
        content: [block],
      },
    });
  const bash = (command: string) => ({
    type: "tool_use",
    name: "Bash",
    input: { command },
  });
  const skill = (s: string) => ({
    type: "tool_use",
    name: "Skill",
    input: { skill: s },
  });
  const T = "2026-10-01T00:00:00Z";
  const seq: [string, object][] = [
    ["a", bash("ls")],
    ["b", skill("flow-module-core:flow-coder")],
    ["c", bash("flow-state-update --phase reviewing")],
    ["d", bash("sleep 5")],
    ["e", bash("flow-state-update --phase ci-wait")],
    ["f", bash("RESULT=$(flow-gate-decide 12)")],
    ["g", bash("cd /w; flow-merge-guard 12")],
  ];
  const turns = segmentSession(
    seq.map(([id, b]) => line(id, b, T)),
    0,
  );
  eq(
    "phases",
    turns.map((t) => t.phase),
    ["pre", "implement", "review", "review", "ci-wait", "gate", "merge"],
  );
  const dup = [
    line("x", { type: "text", text: "hi" }, T, { ...u, output_tokens: 1 }),
    line("x", bash("flow-gate-decide 1"), T, { ...u, output_tokens: 9 }),
  ];
  const dupTurns = segmentSession(dup, 0);
  eq("dedup count", dupTurns.length, 1);
  eq(
    "dedup last usage wins",
    dupTurns[0].usd,
    segmentSession([dup[1]], 0)[0].usd,
  );
  eq(
    "since filters turns, not phases",
    segmentSession(
      [
        line("p", bash("flow-gate-decide 1"), "2026-09-01T00:00:00Z"),
        line("q", bash("ls"), T),
      ],
      Date.parse("2026-10-01T00:00:00Z"),
    ).map((t) => t.phase),
    ["gate"],
  );
  const cases: [string, ReviewCluster][] = [
    [
      "until test -s $T/agent-output-security.json; do sleep 5; done",
      "lens-collect",
    ],
    [
      "flow-agent-finding-schema --validate $T/agent-output-x.json",
      "lens-collect",
    ],
    [
      "until jq -e . consolidator-result.json; do sleep 5; done",
      "consolidator-collect",
    ],
    [
      "flow-fix-applier-schema --validate fix-applier-result.json",
      "fix-applier-collect",
    ],
    ["flow-inject-evidence --body-file b.md --item x", "test-steps-run"],
    ["bash -c 'true' > evidence-1.txt 2>&1", "test-steps-run"],
    ["gh pr edit 5 --body-file body.md", "test-steps-run"],
    ["flow-run-test-steps --pr 5 --worktree /w", "test-steps-run"],
    ["echo $? > .flow-tmp/exit-p3", "test-steps-run"],
    ["flow-post-findings --pr 5 --findings f.json", "findings-post"],
    ["flow-review-finalize --pr 5", "prep-finalize"],
    ["git status", "rest"],
  ];
  for (const [c, want] of cases) eq(`cluster ${c}`, clusterCommand(c), want);
  eq(
    "heredoc mention is not an invocation",
    segmentSession(
      [line("m", bash("cat <<'EOF'\nsee `flow-gate-decide` docs\nEOF"), T)],
      0,
    )[0].phase,
    "pre",
  );
  eq(
    "supervisor session needs a flow-pipeline Skill load",
    [
      isSupervisorSession([line("s", skill("flow-pipeline"), T)]),
      isSupervisorSession([line("s", bash("echo flow-pipeline"), T)]),
    ],
    [true, false],
  );
  eq(
    "merge helper skips path-embedded flow- names",
    segmentSession(
      [line("h", bash("cd /w/flow-tmp; flow-merge-guard 1"), T)],
      0,
    )[0].bashCommands.map(
      (c) => c.match(new RegExp(invokes("(flow-[a-z0-9-]+)")))?.[1],
    ),
    ["flow-merge-guard"],
  );
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
