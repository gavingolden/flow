#!/usr/bin/env bun
// Maintainer tool: the pre-registered scorer and harness helpers for the
// edit-applier batching / verify-timeout replay (docs/eval/applier-batching.md).
// Not on PATH, not shipped. `armVerdict` is the rule; the markdown records it.
//   bun docs/eval/applier-batching.ts report --results <dir|json>
//     [--production-json <file>] [--write-json <file>] [--check]
//   bun docs/eval/applier-batching.ts steer [--map <file>] [--projects <dir>]
//     [--since <YYYY-MM-DD>]
// The paid `run` lives in applier-replay.ts; this file spends nothing.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { attributeSpawn, firstUserText, kindOf } from "./applier-turns";
import {
  lastRuns,
  loadResults,
  parseWorktree,
  unwrapRead,
  type RunResult,
} from "./applier-replay";
import { resolveAgentType } from "./token-spend-audit";

export type MapRow = [
  spawnAt: string,
  repo: string,
  slug: string,
  model: string,
  turns: number,
  pr: number | null,
  relPath: string,
];

const MAP_REPOS = ["flow", "econ-data", "pokemon"];
const LIVE_INSTRUCTIONS = "skills/pipeline/flow-coder-instructions/SKILL.md";
const SENTINEL = /^.*flow-instructions-sentinel:.*$/m;
const ARTIFACT_KEYS = [
  "edits",
  "verify_status",
  "rejected_alternatives",
  "anti_patterns_found",
  "summary",
  "status",
];

export function slugFromWorktree(
  worktree: string,
  repo: string,
): string | null {
  const name = path.basename(worktree.replace(/\/+$/, ""));
  return name.startsWith(`${repo}-`) && name.length > repo.length + 1
    ? name.slice(repo.length + 1)
    : null;
}

type Result = { text: string; err: boolean };

function toolResults(records: unknown[]): Map<string, Result> {
  const out = new Map<string, Result>();
  for (const r of records as any[]) {
    if (r?.type !== "user" || !Array.isArray(r.message?.content)) continue;
    for (const b of r.message.content) {
      if (b?.type !== "tool_result") continue;
      const text = Array.isArray(b.content)
        ? b.content.map((x: any) => x?.text ?? "").join("\n")
        : String(b.content ?? "");
      out.set(b.tool_use_id, { text, err: !!b.is_error });
    }
  }
  return out;
}

export function treeDrift(
  records: unknown[],
  worktree: string,
  readAtBase: (rel: string) => string | null,
): string[] {
  const prefix = `${worktree}/`;
  const results = toolResults(records);
  const written = new Set<string>();
  const seen = new Set<string>();
  const drift = new Set<string>();
  for (const r of records as any[]) {
    if (r?.type !== "assistant") continue;
    for (const b of r.message?.content ?? []) {
      if (b?.type !== "tool_use") continue;
      const inp = b.input ?? {};
      if (["Write", "Edit", "MultiEdit"].includes(b.name)) {
        written.add(String(inp.file_path ?? ""));
        continue;
      }
      let file = "";
      if (
        b.name === "Read" &&
        inp.offset === undefined &&
        inp.limit === undefined
      ) {
        file = String(inp.file_path ?? "");
      } else if (b.name === "Bash") {
        const cmd = String(inp.command ?? "");
        const m = cmd.match(
          /^(?:cd\s+([^&;\s]+)\s*(?:&&|;)\s*)?cat\s+(\S+)\s*$/,
        );
        const cwd = m?.[1] ? path.resolve(worktree, m[1]) : worktree;
        if (m && !/[$~"'`]/.test(`${m[1] ?? ""}${m[2]}`)) {
          file = path.resolve(cwd, m[2]);
        }
        for (const m of cmd.matchAll(/>\s*(\/\S+)/g)) written.add(m[1]);
      }
      if (!file.startsWith(prefix) || file.startsWith(`${prefix}.flow-tmp/`)) {
        continue;
      }
      if (written.has(file) || seen.has(file)) continue;
      const res = results.get(b.id);
      if (!res || res.err || res.text.includes("<persisted-output>")) continue;
      if (/^\s*(File does not exist|cat: )/.test(res.text)) continue;
      seen.add(file);
      const rel = file.slice(prefix.length);
      const text = b.name === "Read" ? unwrapRead(res.text) : res.text;
      const base = readAtBase(rel);
      if (base === null || base.trimEnd() !== text.trimEnd()) drift.add(rel);
    }
  }
  return [...drift].sort();
}

export type MapDeps = {
  ghRepoOf: (repo: string, worktree: string) => string | null;
  prsFor: (
    ghRepo: string,
    slug: string,
  ) => { number: number; createdAt: string }[];
};

export function pickPr(
  prs: { number: number; createdAt: string }[],
  spawnAt: string,
): number | null {
  if (!prs.length) return null;
  const at = Date.parse(spawnAt);
  const after = prs
    .filter((p) => Date.parse(p.createdAt) >= at)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (after.length) return after[0].number;
  return [...prs].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )[0].number;
}

export const defaultMapDeps: MapDeps = {
  ghRepoOf: (repo, worktree) => {
    const clone = path.join(path.dirname(worktree), repo);
    const r = spawnSync("git", ["-C", clone, "remote", "get-url", "origin"], {
      encoding: "utf8",
    });
    return r.status === 0 ? ghRepoFromUrl(r.stdout.trim()) : null;
  },
  prsFor: (ghRepo, slug) => {
    const r = spawnSync(
      "gh",
      [
        "pr",
        "list",
        "-R",
        ghRepo,
        "--head",
        slug,
        "--state",
        "all",
        "--json",
        "number,createdAt",
      ],
      { encoding: "utf8" },
    );
    try {
      return r.status === 0 ? JSON.parse(r.stdout) : [];
    } catch {
      return [];
    }
  },
};

export const ghRepoFromUrl = (url: string): string | null =>
  url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1] ?? null;

// A live transcript can end on a truncated line; skip it rather than abort.
export function parseJsonl(text: string): unknown[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

export function buildMap(
  o: { projects: string; since: number },
  deps: MapDeps = defaultMapDeps,
): MapRow[] {
  const rows: MapRow[] = [];
  const prCache = new Map<string, ReturnType<MapDeps["prsFor"]>>();
  if (!fs.existsSync(o.projects)) return rows;
  const dirs = (d: string) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  for (const proj of dirs(o.projects))
    for (const sid of dirs(path.join(o.projects, proj))) {
      const sa = path.join(o.projects, proj, sid, "subagents");
      for (const f of dirs(sa).filter((x) => x.endsWith(".jsonl"))) {
        const rel = path.join(proj, sid, "subagents", f);
        const recs = parseJsonl(
          fs.readFileSync(path.join(o.projects, rel), "utf8"),
        );
        const text = firstUserText(recs);
        let meta: any;
        try {
          meta = JSON.parse(
            fs.readFileSync(
              path.join(sa, f.replace(/\.jsonl$/, ".meta.json")),
              "utf8",
            ),
          );
        } catch {}
        const label = resolveAgentType(meta, text, [], meta?.description);
        if (kindOf(label, text) !== "edit-applier") continue;
        const spawnAt = (recs as { timestamp?: string }[]).find(
          (r) => r?.timestamp,
        )?.timestamp;
        const worktree = parseWorktree(text);
        if (!spawnAt || !worktree || Date.parse(spawnAt) < o.since) continue;
        const repo = MAP_REPOS.find((r) => slugFromWorktree(worktree, r));
        if (!repo) continue;
        const slug = slugFromWorktree(worktree, repo)!;
        const ghRepo = deps.ghRepoOf(repo, worktree);
        let pr: number | null = null;
        if (ghRepo) {
          const key = `${ghRepo}#${slug}`;
          if (!prCache.has(key)) prCache.set(key, deps.prsFor(ghRepo, slug));
          pr = pickPr(prCache.get(key)!, spawnAt);
        }
        const s = attributeSpawn(recs);
        rows.push([spawnAt, repo, slug, s.model, s.turns, pr, rel]);
      }
    }
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}

// The relaxed Bash-first auto-mode reminder, as delivered to Sonnet 5.5
// edit-appliers (32 of 34 recorded runs; the other 2 got the strict wording).
export const AUTO_MODE_STEER = `<system-reminder>
While auto mode is active:

You can do much of your work through the Bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated Read, Edit, or Write tools. The choice is yours: prefer Edit or Write when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.
</system-reminder>`;

export function preloadedPrompt(
  instructions: string,
  prompt: string,
  steer: string,
): string {
  // A leading "---" (skill frontmatter) is parsed as a CLI option by `claude`.
  return `Preloaded skill instructions:\n\n${instructions.trimEnd()}\n\n---\n\n${prompt}\n\n${steer}\n`;
}

export function withArmToken(instructions: string, token: string): string {
  const m = instructions.match(SENTINEL);
  if (!m || m.index === undefined) {
    throw new Error("instructions carry no flow-instructions-sentinel line");
  }
  const at = m.index + m[0].length;
  return `${instructions.slice(0, at)}\n<!-- replay-arm-token: ${token} -->${instructions.slice(at)}`;
}

export function tokenWasRead(events: unknown[], token: string): boolean {
  return [...toolResults(events).values()].some((r) => r.text.includes(token));
}

export function checkArtifact(
  text: string | null,
  editSetFiles: string[],
  changed: string[],
): boolean {
  if (text === null) return false;
  let a: any;
  try {
    a = JSON.parse(text);
  } catch {
    return false;
  }
  if (!a || typeof a !== "object" || !Array.isArray(a.edits)) return false;
  if (!ARTIFACT_KEYS.every((k) => k in a)) return false;
  const norm = (f: unknown) => String(f).replace(/^\.\//, "");
  const listed = new Set(a.edits.map((e: any) => norm(e?.file)));
  if (!editSetFiles.every((f) => listed.has(norm(f)))) return false;
  const diff = new Set(changed.map(norm));
  return a.edits.every(
    (e: any) => e?.applied !== true || diff.has(norm(e.file)),
  );
}

export const ARMS = {
  batching: {
    file: "docs/eval/applier-batching/arms/batching.md",
    marker: "One message, many calls",
    scope: "all",
    maxTurnRatio: 0.9,
    minBeforePasses: 3,
  },
  "verify-timeout": {
    file: "docs/eval/applier-batching/arms/verify-timeout.md",
    marker: "Run it in the foreground",
    scope: "econ-data",
    maxTurnRatio: 1.0,
    minBeforePasses: 2,
  },
} as const;

export const FIDELITY = { bashShareBand: 0.1, shellOpsBand: 0.25 } as const;

export type Production = { bashShare: number; shellOpsPerTurn: number };
export type ArmVerdict = {
  verdict: "ship" | "no-change" | "inconclusive";
  reasons: string[];
  turns: { before: number; after: number };
  shellOpsPerTurn: { production: number; before: number; after: number };
};

const sumOf = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const n = (x: number | undefined) => x ?? 0;
const perTurn = (rs: RunResult[]) =>
  sumOf(rs.map((r) => r.turns))
    ? sumOf(rs.map((r) => n(r.shellOps))) / sumOf(rs.map((r) => r.turns))
    : 0;
const waits = (r: RunResult) =>
  r.parkedVerifies + n(r.backgroundedVerifies) + n(r.pollCalls);

export function armVerdict(
  arm: keyof typeof ARMS,
  runs: RunResult[],
  production: Production,
): ArmVerdict {
  const spec = ARMS[arm];
  const inScope = (r: RunResult) =>
    spec.scope === "all" || r.case.startsWith("econ-data-");
  const scored = lastRuns(runs.filter((r) => !r.rateLimited)).filter(
    (r) => inScope(r) && (r.arm === "before" || r.arm === arm),
  );
  const before = scored.filter((r) => r.arm === "before");
  const after = scored.filter((r) => r.arm === arm);
  const out = (
    verdict: ArmVerdict["verdict"],
    reasons: string[],
    pb = before,
    pa = after,
  ): ArmVerdict => ({
    verdict,
    reasons,
    turns: {
      before: sumOf(pb.map((r) => r.turns)),
      after: sumOf(pa.map((r) => r.turns)),
    },
    shellOpsPerTurn: {
      production: production.shellOpsPerTurn,
      before: perTurn(pb),
      after: perTurn(pa),
    },
  });
  if (!scored.length) return out("inconclusive", ["no scored runs in scope"]);

  const invalid = scored
    .filter((r) => r.steerInjected !== true || r.instructionsRead !== true)
    .map(
      (r) =>
        `validity ${r.case}/${r.arm}: steerInjected=${r.steerInjected} instructionsRead=${r.instructionsRead}`,
    );
  if (invalid.length) return out("inconclusive", invalid);

  const gates: string[] = [];
  const calls = sumOf(before.map((r) => n(r.toolCalls)));
  const share = calls ? sumOf(before.map((r) => n(r.bashCalls))) / calls : 0;
  if (Math.abs(share - production.bashShare) > FIDELITY.bashShareBand) {
    gates.push(
      `g1 before Bash share ${share.toFixed(3)} vs production ${production.bashShare} (band ${FIDELITY.bashShareBand})`,
    );
  }
  const ops = perTurn(before);
  if (
    Math.abs(ops - production.shellOpsPerTurn) >
    FIDELITY.shellOpsBand * production.shellOpsPerTurn
  ) {
    gates.push(
      `g2 before shell ops per turn ${ops.toFixed(2)} vs production ${production.shellOpsPerTurn} (band ${FIDELITY.shellOpsBand * 100}%)`,
    );
  }
  const passes = before.filter((r) => r.finalVerify === true).length;
  if (passes < spec.minBeforePasses) {
    gates.push(
      `g3 before-arm final-verify passes ${passes} < ${spec.minBeforePasses}`,
    );
  }
  if (
    arm === "verify-timeout" &&
    sumOf(before.map((r) => r.parkedVerifies + n(r.backgroundedVerifies))) < 1
  ) {
    gates.push("g4 no parked or backgrounded verify in the before arm");
  }
  if (gates.length) return out("inconclusive", gates);

  const ids = [...new Set(scored.map((r) => r.case))].sort();
  const pairs: { id: string; b: RunResult; a: RunResult }[] = [];
  const reasons: string[] = [];
  for (const id of ids) {
    const b = before.find((r) => r.case === id);
    const a = after.find((r) => r.case === id);
    if (!b || !a) {
      reasons.push(`(a) ${id}: missing the ${b ? arm : "before"} arm`);
    } else pairs.push({ id, b, a });
  }
  const pb = pairs.map((p) => p.b);
  const pa = pairs.map((p) => p.a);
  for (const { id, b, a } of pairs) {
    for (const r of [b, a])
      if (r.error) reasons.push(`(a) ${id}/${r.arm}: run failed (${r.error})`);
    if (
      a.finalVerify === null ||
      b.finalVerify === null ||
      (b.finalVerify && !a.finalVerify)
    ) {
      reasons.push(
        `(a) ${id}: final verify before=${b.finalVerify} after=${a.finalVerify}`,
      );
    }
    if (!(b.tests > 0 && a.tests > 0)) {
      reasons.push(`(b) ${id}: tests before=${b.tests} after=${a.tests}`);
    }
    if (b.artifactValid && !a.artifactValid) {
      reasons.push(`(e) ${id}: after-arm artifact invalid`);
    }
  }
  const bt = sumOf(pb.map((r) => r.tests));
  const at = sumOf(pa.map((r) => r.tests));
  if (at < bt) reasons.push(`(b) summed tests before=${bt} after=${at}`);
  const bTurns = sumOf(pb.map((r) => r.turns));
  const aTurns = sumOf(pa.map((r) => r.turns));
  const bCost = sumOf(pb.map((r) => r.costUsd));
  const aCost = sumOf(pa.map((r) => r.costUsd));
  if (aTurns > spec.maxTurnRatio * bTurns) {
    reasons.push(
      `(c) turns before=${bTurns} after=${aTurns} (limit ${(spec.maxTurnRatio * bTurns).toFixed(1)})`,
    );
  }
  if (aCost > bCost) {
    reasons.push(
      `(c) cost before=$${bCost.toFixed(2)} after=$${aCost.toFixed(2)}`,
    );
  }
  if (arm === "batching" && !(perTurn(pa) > perTurn(pb))) {
    reasons.push(
      `(d) shell ops per turn before=${perTurn(pb).toFixed(2)} after=${perTurn(pa).toFixed(2)}`,
    );
  }
  if (arm === "verify-timeout") {
    const bw = sumOf(pb.map(waits));
    const aw = sumOf(pa.map(waits));
    if (!(aw < bw)) reasons.push(`(f) waits before=${bw} after=${aw}`);
  }
  return out(reasons.length ? "no-change" : "ship", reasons, pb, pa);
}

export const LABEL = {
  ship: "worth it",
  "no-change": "not worth it",
  inconclusive: "unmeasured",
} as const;

export type Verdicts = Record<keyof typeof ARMS, ArmVerdict>;
const armNames = Object.keys(ARMS) as (keyof typeof ARMS)[];

export const verdictsFor = (runs: RunResult[], p: Production): Verdicts =>
  Object.fromEntries(
    armNames.map((a) => [a, armVerdict(a, runs, p)]),
  ) as Verdicts;

export function checkShipped(verdicts: Verdicts, skill: string): string[] {
  const bad: string[] = [];
  for (const a of armNames) {
    const has = skill.includes(ARMS[a].marker);
    const ships = verdicts[a].verdict === "ship";
    if (ships && !has)
      bad.push(`${a} ships but its marker is not in the live skill`);
    if (!ships && has)
      bad.push(`${a} does not ship but its marker is in the live skill`);
  }
  return bad;
}

type Report = {
  arms: typeof ARMS;
  fidelity: typeof FIDELITY;
  production: Production;
  cases: string[];
  runs: RunResult[];
  verdicts: Verdicts;
};

function loadReportInput(
  p: string,
  productionJson: string | undefined,
): { runs: RunResult[]; production: Production; stored?: Verdicts } {
  const raw = fs.statSync(p).isDirectory()
    ? loadResults(p)
    : JSON.parse(fs.readFileSync(p, "utf8"));
  const prod = productionJson
    ? JSON.parse(fs.readFileSync(productionJson, "utf8"))
    : raw.production;
  if (!prod) throw new Error("--production-json <file> is required");
  const production: Production = {
    bashShare: Number(prod.bashShare),
    shellOpsPerTurn: Number(prod.shellOpsPerTurn),
  };
  if (
    !Number.isFinite(production.bashShare) ||
    !Number.isFinite(production.shellOpsPerTurn)
  ) {
    throw new Error("production needs numeric bashShare and shellOpsPerTurn");
  }
  return Array.isArray(raw)
    ? { runs: raw, production }
    : { runs: raw.runs, production, stored: raw.verdicts };
}

export function renderVerdicts(v: Verdicts): string {
  return armNames
    .flatMap((a) => [
      `**${a}:** ${v[a].verdict} (${LABEL[v[a].verdict]}); turns before=${v[a].turns.before} after=${v[a].turns.after}`,
      ...v[a].reasons.map((r) => `- ${r}`),
    ])
    .join("\n");
}

function report(flag: (n: string) => string | undefined) {
  const input = loadReportInput(
    path.resolve(flag("--results") ?? ""),
    flag("--production-json"),
  );
  const verdicts = verdictsFor(input.runs, input.production);
  const doc: Report = {
    arms: ARMS,
    fidelity: FIDELITY,
    production: input.production,
    cases: [...new Set(input.runs.map((r) => r.case))].sort(),
    runs: input.runs,
    verdicts,
  };
  const write = flag("--write-json");
  if (write) fs.writeFileSync(write, JSON.stringify(doc, null, 2) + "\n");
  console.log(renderVerdicts(verdicts));
  if (!process.argv.includes("--check")) return;
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const bad = checkShipped(
    verdicts,
    fs.readFileSync(path.join(root, LIVE_INSTRUCTIONS), "utf8"),
  );
  if (
    input.stored &&
    JSON.stringify(input.stored) !== JSON.stringify(verdicts)
  ) {
    bad.push("stored verdicts differ from the recomputed ones");
  }
  for (const b of bad) console.error(`check failed: ${b}`);
  if (bad.length) process.exit(1);
}

// Transcripts record only the steer flag, never the rendered text. The count
// uses attributeSpawn, the same rule applier-turns.ts's "auto-mode reminder"
// line uses, so the two figures differ only by the spawn window.
function steer(flag: (n: string) => string | undefined) {
  const projects =
    flag("--projects") ?? path.join(os.homedir(), ".claude/projects");
  const since = flag("--since") ?? "";
  const rows: MapRow[] = JSON.parse(
    fs.readFileSync(
      flag("--map") ?? ".flow-tmp/edit-applier-pr-map.json",
      "utf8",
    ),
  );
  const seen = new Map<string, number>();
  const picked = rows.filter(
    (r) => r[3].includes("sonnet-5-5") && r[0] >= since,
  );
  for (const row of picked) {
    const recs = parseJsonl(
      fs.readFileSync(path.join(projects, row[6]), "utf8"),
    );
    const s = attributeSpawn(recs).autoModeSteer;
    seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  const at = picked.map((r) => r[0]).sort();
  console.log(
    `window: ${at[0] ?? "none"} .. ${at[at.length - 1] ?? "none"} (${picked.length} Sonnet 5.5 spawns)`,
  );
  for (const [s, n] of seen) console.log(`${s}: ${n} Sonnet 5.5 spawn(s)`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (x: string) =>
    argv.includes(x) ? argv[argv.indexOf(x) + 1] : undefined;
  try {
    if (argv[0] === "report") report(flag);
    else if (argv[0] === "steer") steer(flag);
    else
      throw new Error("usage: applier-batching.ts report|steer (see header)");
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
