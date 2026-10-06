#!/usr/bin/env bun
// Maintainer tool: attribute flow-edit-applier / flow-fix-applier turns to a
// cause from local Claude Code sub-agent transcripts. Not on PATH, not
// shipped by `flow install`. Turn identity comes from token-spend-audit.ts
// (one unique assistant message.id with usage, last-line usage), so the
// totals agree with the audit's.
//   bun docs/eval/applier-turns.ts --since 2026-09-05
// Flags: --since <YYYY-MM-DD> (UTC, required), --model <id> (exact model of
// the spawn's first assistant turn), --repo <flow|econ-data|pokemon>,
// --home <dir> (default $HOME).
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  priceTurn,
  resolveAgentType,
  resolveRepo,
  walkFile,
  windowSince,
} from "./token-spend-audit";

const REPOS = ["flow", "econ-data", "pokemon"];
const ARTIFACT_RE = /(coder-result|fix-applier-result)\.json/;
const PARKED = "moved to the background";
const PRETTIER_ROUND = "lint-only (prettier)";
const VERIFY_TIMEOUT_MS = 600000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Remove text that only mentions the helper (which/pgrep/grep/cat, quoted
// strings, heredoc bodies) so it never reads as a verify run.
const MENTION_ONLY =
  /(which|command -v)\s+[^|;&\n]*|(pgrep -f|pkill -f|grep[^|;&\n]*|ps aux[^|;&\n]*|cat|head|tail|ls|wc|nl|less|bat|sed[^|;&\n]*)\s+["']?[^\s|;&]*flow-pre-commit\S*/g;
const QUOTED_MENTION = /(["'])[^"'\n]*flow-pre-commit[^"'\n]*\1/g;
const QUOTED_NPM_VERIFY = /(["'`])[^"'`\n]*npm run verify[^"'`\n]*\1/g;
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g;
const PRE_COMMIT_CALL =
  /flow-pre-commit(\.ts)?(?=\s+(--json|--pr|--scope)|\s*(2>|>|\||;|&&|\n|$))/;

function verifyKind(cmd: string): "flow-pre-commit" | "npm-verify" | null {
  if (/flow-pre-commit --help/.test(cmd)) return null;
  const noHeredoc = cmd.replace(HEREDOC, "");
  if (
    PRE_COMMIT_CALL.test(
      noHeredoc.replace(QUOTED_MENTION, '""').replace(MENTION_ONLY, ""),
    )
  ) {
    return "flow-pre-commit";
  }
  return /npm run verify\b/.test(noHeredoc.replace(QUOTED_NPM_VERIFY, '""'))
    ? "npm-verify"
    : null;
}

export const isVerifyInvocation = (cmd: string): boolean =>
  verifyKind(cmd) !== null;

export function classifyBash(cmd: string): string {
  const c = cmd.replace(/\s+/g, " ");
  const kind = verifyKind(cmd);
  if (kind) return `verify:${kind}`;
  if (/flow-pre-commit/.test(c)) {
    return /sleep|until|while|pgrep|tasks\/\w+\.output/.test(c)
      ? "verify:wait-poll"
      : "bash-other";
  }
  if (
    ARTIFACT_RE.test(c) &&
    /(cat\s*>|>\s*\S*result\.json|tee |jq |python|node -e|bun -e)/.test(c)
  ) {
    return "artifact";
  }
  if (/tasks\/\w+\.output|^\s*sleep \d|until \[|while ! /.test(c)) {
    return "verify:wait-poll";
  }
  if (
    /(vitest|npm run test|npm test|bun test|bun scripts\/test|go test|pytest|playwright test)/.test(
      c,
    )
  ) {
    return /(\.test\.|\.spec\.|_test\.go| -run | -t |--testNamePattern|\.\/[\w/-]+\/?(\s|$)| src\/| bin\/| apps\/| backend\/| tests?\/)/.test(
      c,
    )
      ? "test:targeted"
      : "test:full";
  }
  if (
    /(tsc\b|typecheck|svelte-check|npm run check\b|npm run lint|eslint|prettier|npm run format|go vet|gofmt|actionlint)/.test(
      c,
    )
  ) {
    return "typecheck-lint-format";
  }
  if (/\bgit (commit|push|add)\b|\bgh (pr|api|issue)\b/.test(c)) {
    return "git-gh-write";
  }
  if (
    /\bgit (diff|status|log|show|rev-parse|branch|stash|restore|checkout|merge-base|fetch)\b/.test(
      c,
    )
  ) {
    return "git-inspect";
  }
  const lead = c.trim().replace(/^cd [^&;]+(&&|;) ?/, "");
  if (/^(cat|sed -n|head|tail|nl|wc|awk|less|jq)\b/.test(lead)) {
    return "bash-read";
  }
  if (/^(grep|rg|find|ls|fd|tree|ugrep)\b/.test(lead)) return "bash-search";
  if (
    /^(mkdir|cp|mv|rm|touch|chmod|sed -i|perl -pi|python3?|node|bun)\b/.test(
      lead,
    )
  ) {
    return "bash-mutate-or-script";
  }
  return "bash-other";
}

const LOOKUP_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);
const LEADING_CD = /^\s*cd\s+[^&;\n]+(&&|;)\s*/;
const FILE_REDIRECT = /(?<![\d&>])>{1,2}(?!&)\s*(?!\/dev\/null)[^\s|;&]+/g;

export function shellSegments(cmd: string): string[] {
  return cmd
    .replace(HEREDOC, "")
    .replace(LEADING_CD, "")
    .split(/&&|\|\||;|\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function isLookupSegment(seg: string): boolean {
  const s = seg.trim();
  if (/(?<![\d&>])>(?!&)\s*(?!\/dev\/null)\S/.test(s)) return false;
  if (/^find\b/.test(s)) return !/\s-(delete|exec|execdir|ok)\b/.test(s);
  return /^(cat|sed\s+-n|grep|rg|head|tail|ls|wc|git\s+(diff|log|show|status))\b/.test(
    s,
  );
}

export function editScript(
  cmd: string,
): { guarded: boolean; chained: boolean } | null {
  if (ARTIFACT_RE.test(cmd)) return null;
  const m = cmd.match(
    /\bpython3?\b[^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/,
  );
  if (!m) return null;
  const body = m[2];
  if (!/\.write(_text)?\(|\bopen\([^)]*['"][wa]b?['"]/.test(body)) {
    return null;
  }
  return {
    guarded: /\bassert\b| in |\.count\(/.test(body),
    chained: shellSegments(cmd).length > 1,
  };
}

function writesFile(cmd: string): boolean {
  if (ARTIFACT_RE.test(cmd) || verifyKind(cmd)) return false;
  if (editScript(cmd)) return true;
  const c = cmd.replace(HEREDOC, "");
  if (/\b(sed|perl)\s+-\w*i\b|\btee\b/.test(c)) return true;
  return [...c.matchAll(FILE_REDIRECT)].some((x) => !/\.flow-tmp\//.test(x[0]));
}

export type VerifyDetail = {
  ok: boolean | null;
  failed: string[];
  prettier: boolean;
};

export function verifyDetail(resultText: string, cmd: string): VerifyDetail {
  const t = resultText.replace(/\\"/g, '"').replace(/\\n/g, "\n");
  if (t.includes(PARKED)) return { ok: null, failed: [], prettier: false };
  const prettier = /Code style issues|\[warn\] /.test(t);
  // Last match: the top-level key follows `results`, whose failure excerpts
  // can carry a quoted `"allPassed": true` of their own.
  const m = [...t.matchAll(/"allPassed":\s*(true|false)/g)].at(-1);
  const failed = [
    ...t.matchAll(
      /"name":\s*"([^"]+)",\s*"scope":\s*"[^"]*",\s*"passed":\s*false/g,
    ),
  ].map((x) => x[1]);
  if (m) return { ok: m[1] === "true", failed, prettier };
  // Human-readable output (`flow-pre-commit --pr N` without --json).
  const humanFailed = [...t.matchAll(/^\s*FAIL\s+(.+?) \(/gm)].map((x) => x[1]);
  if (/\bAll \d+ checks passed\b/.test(t)) {
    return { ok: true, failed: [], prettier };
  }
  if (/\b\d+\/\d+ checks passed\b/.test(t)) {
    return { ok: false, failed: humanFailed, prettier };
  }
  if (cmd.includes("allPassed")) {
    const bare = t.match(/^\s*(true|false)\s*$/m);
    if (bare) return { ok: bare[1] === "true", failed: [], prettier };
  }
  const code = t.match(/(?:DONE_|exit[:=]\s*|EXIT[:=]\s*|rc=)(\d+)/);
  if (code) return { ok: code[1] === "0", failed: [], prettier };
  return { ok: null, failed: [], prettier };
}

export const verifyOutcome = (
  resultText: string,
  cmd: string,
): boolean | null => verifyDetail(resultText, cmd).ok;

export function failureClass(
  failedCheckNames: string[],
  prettierWarn: boolean,
): string {
  const names = new Set(failedCheckNames);
  const lintish = [...names].filter((n) => /lint|format|prettier/.test(n));
  if (names.size && lintish.length === names.size) {
    return prettierWarn ? PRETTIER_ROUND : "lint-only (eslint/other)";
  }
  const any = (re: RegExp) => failedCheckNames.some((n) => re.test(n));
  if (any(/\btest\b|go test|vitest/)) return "tests";
  if (any(/typecheck|check|tsc/)) return "typecheck";
  if (!names.size) return "unparsed-fail";
  return "other: " + [...names].sort().join(",").slice(0, 60);
}

export type Round = { cls: string; turns: number; next: string };
export type SpawnStats = {
  turns: number;
  catTurns: Record<string, number>;
  shares: Record<string, number>;
  fullVerifies: number;
  verifyCalls: number;
  verifyCallsWithTimeout: number;
  parkedVerifies: number;
  backgroundedVerifies: number;
  pollCalls: number;
  prettierRounds: number;
  refusedEdits: number;
  finalVerify: boolean | null;
  rounds: Round[];
  model: string;
  toolCalls: number;
  bashCalls: number;
  shellOps: number;
  chainedBash: number;
  multiCallTurns: number;
  lookupTurns: number;
  lookupAfterLookup: number;
  editScripts: number;
  editScriptsGuarded: number;
  editScriptsChained: number;
  editScriptTracebacks: number;
  noEditReruns: number;
  fixRounds: number;
  autoModeSteer: "relaxed" | "strict" | "none";
};

type Block = Record<string, any>;
const asRec = (x: unknown): Record<string, any> | null =>
  x && typeof x === "object" ? (x as Record<string, any>) : null;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: Block) => (typeof b?.text === "string" ? b.text : ""))
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

// Accepts transcript JSONL records and `--output-format stream-json` events:
// both carry {type:'assistant'|'user', message:{...}}; system/result events
// and anything else are ignored.
export function attributeSpawn(records: unknown[]): SpawnStats {
  const order: string[] = [];
  const tools = new Map<string, Block[]>();
  const hasUsage = new Set<string>();
  const results = new Map<string, { text: string; err: boolean }>();
  let model = "";
  let steer: SpawnStats["autoModeSteer"] = "none";
  for (const raw of records) {
    const r = asRec(raw);
    if (r?.type === "attachment" && r.attachment?.type === "auto_mode") {
      const v = r.attachment.bashFirstSteer;
      if ((v === "relaxed" || v === "strict") && steer === "none") steer = v;
    }
    const msg = asRec(r?.message);
    if (!r || !msg) continue;
    if (r.type === "user" && Array.isArray(msg.content)) {
      for (const b of msg.content as Block[]) {
        if (b?.type !== "tool_result") continue;
        const text = resultText(b.content);
        results.set(b.tool_use_id, {
          text,
          err: !!b.is_error || text.includes("<tool_use_error>"),
        });
      }
    } else if (r.type === "assistant") {
      const id = msg.id;
      if (!id || msg.model === "<synthetic>") continue;
      if (!tools.has(id)) {
        order.push(id);
        tools.set(id, []);
      }
      if (msg.usage) hasUsage.add(id);
      if (!model && msg.model) model = msg.model;
      for (const b of Array.isArray(msg.content)
        ? (msg.content as Block[])
        : [])
        if (b?.type === "tool_use") tools.get(id)!.push(b);
    }
  }
  const ids = order.filter((id) => hasUsage.has(id));
  const s: SpawnStats = {
    turns: ids.length,
    catTurns: {},
    shares: {},
    fullVerifies: 0,
    verifyCalls: 0,
    verifyCallsWithTimeout: 0,
    parkedVerifies: 0,
    backgroundedVerifies: 0,
    pollCalls: 0,
    prettierRounds: 0,
    refusedEdits: 0,
    finalVerify: null,
    rounds: [],
    model,
    toolCalls: 0,
    bashCalls: 0,
    shellOps: 0,
    chainedBash: 0,
    multiCallTurns: 0,
    lookupTurns: 0,
    lookupAfterLookup: 0,
    editScripts: 0,
    editScriptsGuarded: 0,
    editScriptsChained: 0,
    editScriptTracebacks: 0,
    noEditReruns: 0,
    fixRounds: 0,
    autoModeSteer: steer,
  };
  const add = (k: string, w: number) =>
    (s.catTurns[k] = (s.catTurns[k] ?? 0) + w);
  const readSeen = new Set<string>();
  const editedSinceRead = new Set<string>();
  let prevErr = false;
  let pending = false;
  let open: { cls: string; start: number } | null = null;
  let prevLookup = false;
  let sawVerify = false;
  let editedSinceVerify = false;
  const closeRound = (i: number, next: string) => {
    if (!open) return;
    s.rounds.push({ cls: open.cls, turns: i - open.start, next });
    if (open.cls === PRETTIER_ROUND) s.prettierRounds++;
    open = null;
  };
  ids.forEach((id, i) => {
    const calls = tools.get(id)!;
    if (!calls.length) {
      prevLookup = false;
      return add("text-only", 1);
    }
    const w = 1 / calls.length;
    let turnErr = false;
    let turnLookup = true;
    s.toolCalls += calls.length;
    if (calls.length > 1) s.multiCallTurns++;
    for (const b of calls) {
      const res = results.get(b.id);
      const err = !!res?.err;
      const inp = b.input ?? {};
      if (err) turnErr = true;
      let cat: string = b.name;
      if (b.name === "Read") {
        const p = String(inp.file_path ?? "");
        if (ARTIFACT_RE.test(p)) cat = "artifact";
        else if (!readSeen.has(p)) cat = "read:first";
        else if (editedSinceRead.has(p)) cat = "read:after-own-edit";
        else cat = "read:re-read-unchanged";
        if (prevErr) cat = "read:after-tool-error";
        readSeen.add(p);
        editedSinceRead.delete(p);
      } else if (EDIT_TOOLS.has(b.name)) {
        const p = String(inp.file_path ?? inp.notebook_path ?? "");
        cat = ARTIFACT_RE.test(p) ? "artifact" : "edit";
        if (cat === "edit") editedSinceRead.add(p);
        if (cat === "edit" && !err) editedSinceVerify = true;
        if (err && res!.text.includes("has not been read yet")) {
          s.refusedEdits++;
          cat = "edit:refused";
        } else if (err && cat === "edit") cat = "edit:failed";
      } else if (b.name === "Grep" || b.name === "Glob") cat = "search";
      else if (b.name === "Bash") {
        const cmd = String(inp.command ?? "");
        const text = res?.text ?? "";
        cat = classifyBash(cmd);
        const segs = shellSegments(cmd);
        s.bashCalls++;
        s.shellOps += segs.length;
        if (segs.length > 1) s.chainedBash++;
        if (!segs.length || !segs.every(isLookupSegment)) turnLookup = false;
        const script = editScript(cmd);
        if (script) {
          s.editScripts++;
          if (script.guarded) s.editScriptsGuarded++;
          if (script.chained) s.editScriptsChained++;
          if (text.includes("Traceback (most recent call last)")) {
            s.editScriptTracebacks++;
          }
        }
        if (!err && writesFile(cmd)) editedSinceVerify = true;
        if (verifyKind(cmd) === "flow-pre-commit") {
          if (sawVerify) {
            if (editedSinceVerify) s.fixRounds++;
            else s.noEditReruns++;
          }
          sawVerify = true;
          editedSinceVerify = false;
        }
        if (cat === "verify:wait-poll") s.pollCalls++;
        if (pending && !isVerifyInvocation(cmd)) {
          const d = verifyDetail(text, cmd);
          if (
            d.ok !== null &&
            /allPassed|DONE_|exit[:=]|rc=/.test(text + cmd)
          ) {
            s.finalVerify = d.ok;
            pending = false;
            if (d.ok === false) {
              open = { cls: failureClass(d.failed, d.prettier), start: i };
            }
          }
        }
        if (isVerifyInvocation(cmd)) {
          s.verifyCalls++;
          s.fullVerifies++;
          if (Number(inp.timeout) >= VERIFY_TIMEOUT_MS) {
            s.verifyCallsWithTimeout++;
          }
          const d = verifyDetail(text, cmd);
          if (text.includes(PARKED)) s.parkedVerifies++;
          if (inp.run_in_background === true) s.backgroundedVerifies++;
          closeRound(
            i,
            d.ok === true ? "pass" : d.ok === false ? "fail" : "unknown",
          );
          if (d.ok === false)
            open = { cls: failureClass(d.failed, d.prettier), start: i };
          s.finalVerify = d.ok;
          pending = d.ok === null;
        }
      } else if (b.name === "SubagentHandback") cat = "handback";
      else if (b.name === "Skill") {
        cat = "skill:" + String(inp.skill ?? "").replace(/^.*:/, "");
      } else if (b.name === "ToolSearch") cat = "toolsearch";
      else if (/^mcp__/.test(b.name)) cat = "mcp";
      if (!LOOKUP_TOOLS.has(b.name)) turnLookup = false;
      add(
        err && !/^(edit|verify|test)/.test(cat) ? `tool-error:${cat}` : cat,
        w,
      );
    }
    if (turnLookup) {
      s.lookupTurns++;
      if (prevLookup) s.lookupAfterLookup++;
    }
    prevLookup = turnLookup;
    prevErr = turnErr;
  });
  closeRound(s.turns, "no further verify");
  for (const [k, v] of Object.entries(s.catTurns)) {
    s.shares[k] = s.turns ? v / s.turns : 0;
  }
  return s;
}

type Row = {
  kind: string;
  repo: string;
  model: string;
  usd: number;
  walkTurns: number;
  stats: SpawnStats;
};

const readLines = (p: string): string[] => {
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
const parse = (lines: string[]): any[] =>
  lines.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

export function firstUserText(recs: any[]): string {
  const u = recs.find((r) => r?.type === "user");
  const c = u?.message?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.map((b: Block) => b?.text ?? "").join("") : "";
}

function kindOf(label: string, text: string): string {
  if (/flow-edit-applier$/.test(label)) return "edit-applier";
  if (/flow-fix-applier$/.test(label)) return "fix-applier";
  if (/flow-/.test(label)) return "";
  if (/Independent Edit-Applier Subagent/.test(text)) return "edit-applier";
  if (/Independent Fix-Applier/i.test(text)) return "fix-applier";
  return "";
}

export function collect(o: {
  home: string;
  since: number;
  model?: string;
  repo?: string;
}): Row[] {
  const rows: Row[] = [];
  const root = join(o.home, ".claude", "projects");
  if (!existsSync(root)) return rows;
  const inWindow = windowSince(o.since);
  for (const d of readdirSync(root)) {
    let sessions: string[] = [];
    try {
      sessions = readdirSync(join(root, d));
    } catch {
      continue;
    }
    for (const sid of sessions) {
      const sa = join(root, d, sid, "subagents");
      if (!existsSync(sa)) continue;
      for (const f of readdirSync(sa).filter((x) => x.endsWith(".jsonl"))) {
        const lines = readLines(join(sa, f));
        const recs = parse(lines);
        const text = firstUserText(recs);
        const meta = readJson(join(sa, f.replace(/\.jsonl$/, ".meta.json")));
        const label = resolveAgentType(meta, text, [], meta?.description);
        const kind = kindOf(label, text);
        if (!kind) continue;
        const res = resolveRepo(recs.find((r) => r?.cwd)?.cwd, REPOS);
        const ts = recs.find((r) => r?.timestamp)?.timestamp;
        if (!res || !ts || !inWindow(ts)) continue;
        if (o.repo && res.repo !== o.repo) continue;
        const stats = attributeSpawn(recs);
        if (o.model && stats.model !== o.model) continue;
        let usd = 0;
        let walkTurns = 0;
        walkFile(
          lines,
          { parseErrors: 0, missingUsage: 0, unknownModels: new Map() },
          (t) => {
            walkTurns++;
            usd += priceTurn(t.usage, t.model);
          },
        );
        rows.push({
          kind,
          repo: res.repo,
          model: stats.model,
          usd,
          walkTurns,
          stats,
        });
      }
    }
  }
  return rows;
}

const pct = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const f1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US");
const KINDS = ["edit-applier", "fix-applier"];
const table = (heads: string[], rows: (string | number)[][]) =>
  [
    `| ${heads.join(" | ")} |`,
    `|${heads.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

const ratio = (n: number, d: number) => (d ? n / d : 0);
const share = (n: number, d: number) => `${f1(100 * ratio(n, d))}%`;

function habitLines(kind: string, rs: Row[]): string[] {
  const out = [`\n### ${kind}\n`];
  if (!rs.length) return [...out, "No spawns in the window."];
  const t = (fn: (s: SpawnStats) => number) => sum(rs.map((r) => fn(r.stats)));
  const turns = t((s) => s.turns);
  const calls = t((s) => s.toolCalls);
  const bash = t((s) => s.bashCalls);
  const lookups = t((s) => s.lookupTurns);
  const after = t((s) => s.lookupAfterLookup);
  const rounds = rs.map((r) => r.stats.fixRounds);
  const steer = (v: string) =>
    rs.filter((r) => r.stats.autoModeSteer === v).length;
  out.push(
    `- Tool calls per turn: ${f1(ratio(calls, turns))} (${t((s) => s.multiCallTurns)} multi-call turns); Bash share ${share(bash, calls)}; shell operations per turn ${f1(
      ratio(
        t((s) => s.shellOps),
        turns,
      ),
    )} (${t((s) => s.chainedBash)} of ${bash} Bash calls chained)`,
    `- Lookup-only turns: ${lookups} (${share(lookups, turns)}); directly after another: ${after} (${share(after, turns)})`,
    `- Shell edit scripts: ${t((s) => s.editScripts)}; with a match guard ${t((s) => s.editScriptsGuarded)}; chained with a check ${t((s) => s.editScriptsChained)}; failed with a traceback ${t((s) => s.editScriptTracebacks)}`,
    `- Verify calls ${t((s) => s.verifyCalls)}; no-edit re-runs ${t((s) => s.noEditReruns)}; edit-separated fix rounds per spawn: p50 ${pct(rounds, 0.5)}, max ${Math.max(...rounds)}; spawns over 5 rounds: ${rounds.filter((n) => n > 5).length}`,
    `- Auto-mode Bash-first reminder: relaxed ${steer("relaxed")}, strict ${steer("strict")}, none ${steer("none")} spawns`,
  );
  return out;
}

export function render(rows: Row[], since: string, runDate: string): string {
  const out = [`# Applier turn attribution (since ${since}, run ${runDate})`];
  const by = (k: string) => rows.filter((r) => r.kind === k);
  for (const kind of KINDS) {
    const rs = by(kind);
    out.push(`\n## Where ${kind} turns go\n`);
    if (!rs.length) {
      out.push("No spawns in the window.");
      continue;
    }
    const T = sum(rs.map((r) => r.stats.turns));
    const U = sum(rs.map((r) => r.usd));
    const t = rs.map((r) => r.stats.turns);
    out.push(
      `${rs.length} spawns, ${T.toLocaleString("en-US")} turns, $${U.toFixed(2)} list price. Turns per spawn: p50 ${pct(t, 0.5)}, p90 ${pct(t, 0.9)}, max ${Math.max(...t)}.\n`,
    );
    const cats: Record<string, number> = {};
    for (const r of rs)
      for (const [k, v] of Object.entries(r.stats.catTurns))
        cats[k] = (cats[k] ?? 0) + v;
    out.push(
      table(
        ["Category", "Turns", "Share"],
        Object.entries(cats)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, f1(v), `${((100 * v) / T).toFixed(1)}%`]),
      ),
    );
  }
  const fin = (rs: Row[], v: boolean | null) =>
    rs.filter((r) => r.stats.finalVerify === v).length;
  out.push("\n## Verify rounds");
  for (const kind of KINDS) {
    const rs = by(kind);
    out.push(`\n### ${kind}\n`);
    if (!rs.length) {
      out.push("No spawns in the window.");
      continue;
    }
    const fv = rs.map((r) => r.stats.fullVerifies);
    out.push(
      `Full verify runs per spawn: total ${sum(fv)}, p50 ${pct(fv, 0.5)}, p90 ${pct(fv, 0.9)}, max ${Math.max(...fv)}. Last verify outcome: pass ${fin(rs, true)}, fail ${fin(rs, false)}, unparsed ${fin(rs, null)} of ${rs.length} spawns.\n`,
    );
    const rounds = rs.flatMap((r) => r.stats.rounds);
    const classes = [...new Set(rounds.map((r) => r.cls))];
    out.push(
      table(
        [
          "Failed-verify class",
          "Rounds",
          "Turns until next verify",
          "Next verify",
        ],
        classes
          .map((cls) => ({ cls, rs: rounds.filter((r) => r.cls === cls) }))
          .sort((a, b) => b.rs.length - a.rs.length)
          .map(({ cls, rs: x }) => {
            const next: Record<string, number> = {};
            for (const r of x) next[r.next] = (next[r.next] ?? 0) + 1;
            return [
              cls,
              x.length,
              sum(x.map((r) => r.turns)),
              Object.entries(next)
                .map(([k, v]) => `${k} ${v}`)
                .join(", "),
            ];
          }),
      ),
    );
  }
  out.push("\n## Mechanical waste\n");
  const cell = (fn: (rs: Row[]) => string) => KINDS.map((k) => fn(by(k)));
  const spawnsWith = (rs: Row[], fn: (r: Row) => number) =>
    rs.filter((r) => fn(r) > 0).length;
  const roundTurns = (rs: Row[]) =>
    sum(
      rs.flatMap((r) =>
        r.stats.rounds
          .filter((x) => x.cls === PRETTIER_ROUND)
          .map((x) => x.turns),
      ),
    );
  out.push(
    table(
      ["Event", ...KINDS],
      [
        [
          "Verify parked in background (at the call's timeout)",
          ...cell(
            (rs) =>
              `${sum(rs.map((r) => r.stats.parkedVerifies))} runs in ${spawnsWith(rs, (r) => r.stats.parkedVerifies)} spawns`,
          ),
        ],
        [
          "Verify started with run_in_background (agent's own workaround)",
          ...cell(
            (rs) =>
              `${sum(rs.map((r) => r.stats.backgroundedVerifies))} runs in ${spawnsWith(rs, (r) => r.stats.backgroundedVerifies)} spawns`,
          ),
        ],
        [
          "Polling calls (sleep loops, output reads)",
          ...cell((rs) => String(sum(rs.map((r) => r.stats.pollCalls)))),
        ],
        [
          "Prettier-only lint failure, extra verify round",
          ...cell(
            (rs) =>
              `${sum(rs.map((r) => r.stats.prettierRounds))} rounds, ${roundTurns(rs)} turns to next verify`,
          ),
        ],
        [
          "Edit refused: file not opened with Read",
          ...cell(
            (rs) =>
              `${sum(rs.map((r) => r.stats.refusedEdits))} errors in ${spawnsWith(rs, (r) => r.stats.refusedEdits)} spawns`,
          ),
        ],
        [
          "Verify calls with timeout >= 600000 / all verify calls",
          ...cell(
            (rs) =>
              `${sum(rs.map((r) => r.stats.verifyCallsWithTimeout))} / ${sum(rs.map((r) => r.stats.verifyCalls))}`,
          ),
        ],
      ],
    ),
  );
  out.push("\n## Tool-use habit");
  for (const kind of KINDS) out.push(...habitLines(kind, by(kind)));
  const bad = rows.filter((r) => r.walkTurns !== r.stats.turns).length;
  out.push(
    `\nTurn-identity check against token-spend-audit walkFile: ${bad} of ${rows.length} spawns differ.`,
  );
  return out.join("\n");
}

export function isCalendarDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) =>
    argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined;
  const since = flag("--since");
  if (!since || !isCalendarDate(since)) {
    console.error(
      "usage: bun docs/eval/applier-turns.ts --since <YYYY-MM-DD> [--model <id>] [--repo <flow|econ-data|pokemon>] [--home <dir>]",
    );
    process.exit(2);
  }
  const rows = collect({
    home: flag("--home") ?? process.env.HOME ?? "",
    since: Date.parse(`${since}T00:00:00Z`),
    model: flag("--model"),
    repo: flag("--repo"),
  });
  console.log(render(rows, since, new Date().toISOString().slice(0, 10)));
}
