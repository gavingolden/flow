#!/usr/bin/env bun
/**
 * Maintainer-only model-routing benchmark runner. Loads the committed
 * bin/fixtures/model-bench/*&#47;case.json fixtures, expands them into a
 * (case x arm x model x repeat[ x size]) manifest plus one warm-up slot per
 * group, dispatches the manifest through flow-delegate-fanout, and writes a
 * blinded judge packet alongside the raw results. Pure manifest-building,
 * blinding, and classification logic lives in bin/lib/model-bench-manifest.ts
 * (kept out of this file to stay under the line-count target); this file
 * owns CLI parsing, dispatch, retries, and the results/packet writers.
 *
 * Deliberately NOT symlinked onto PATH by `flow install` (see the
 * MAINTAINER_ONLY exclusion in bin/lib/sources.ts) — it burns real agy
 * quota against a curated benchmark, not a per-repo pipeline task. Run it
 * from a flow checkout:
 *   bun bin/flow-model-bench.ts --out .flow-tmp/model-bench
 *
 * FILE MODE: tracked 100755. The flow-release precedent (100644) was the
 * first choice, but a flow-pre-commit binary older than this branch does
 * not yet have flow-model-bench in MAINTAINER_ONLY and so demands the exec
 * bit; 100755 satisfies both the stale and the updated gate, and the bit is
 * harmless on a bun-shebang file invoked as `bun bin/flow-model-bench.ts`.
 *
 * MAX-CALLS (anti-silent-truncation guard): flow-delegate-fanout's own
 * DEFAULT_MAX_CALLS is 40 — far below this harness's ~147-calls-per-model
 * manifest — so this runner ALWAYS passes an explicit --max-calls to the
 * fanout, defaulting to the built manifest's own length. An explicit
 * --max-calls lower than that is honoured but logged loudly on stderr,
 * never silently truncated.
 *
 * DELEGATE-BIN PREFLIGHT: flow-delegate-fanout's default runner prefers
 * `which flow-delegate`, which on a dev machine resolves to the CANONICAL
 * checkout, not this worktree — a stale binary rejects --output-format /
 * --json-schema / --structured-fallback with exit 2 on every single entry,
 * which the fanout converts to an all-skip run at exit 0. This runner pins
 * --delegate-bin (default: the sibling flow-delegate.ts of THIS file) and
 * preflights it — a deliberately-invalid --output-format value must fail
 * with a usage error NAMING the flag, not an "unknown flag" error — before
 * spending any of the ~441-call budget.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  run as runFanoutCli,
  entryToDelegateArgv,
  type DelegateEnvelope,
  type EntryResult,
  type FanoutResult,
  type ManifestEntry as FanoutManifestEntry,
} from "./flow-delegate-fanout";
import { parseStructured } from "./lib/structured-response";
import type { BenchArm, BenchResult } from "./lib/model-bench-schema";
import {
  buildManifest,
  filterArms,
  blind,
  classifyPreflight,
  isTransportSkip,
  resolveMaxCalls,
  toFanoutEntries,
  loadCases,
  type ManifestEntry,
} from "./lib/model-bench-manifest";
import { runReport, type ReportDeps } from "./lib/model-bench-report";

// Only what flow-model-bench.test.ts actually imports (plus the
// locally-defined dispatchWithRetries/runBench/Deps) is re-exported here;
// filterArms/isTransportSkip/resolveMaxCalls/loadCases/runReport/
// ManifestEntry are used internally by this file but have no external
// importer — trim on AGENTS.md's no-dead-code default, matching how
// model-bench-score.test.ts / model-bench-schema.test.ts import their lib
// modules directly instead of through this facade.
export { buildManifest, blind, classifyPreflight, toFanoutEntries };

const DEFAULT_FIXTURES_DIR = join("bin", "fixtures", "model-bench");
const DEFAULT_MODELS = [
  "gemini-3.6-flash-high",
  "gemini-3.1-pro-high",
  "claude-sonnet-4-6",
];
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_INCUMBENT = "claude-sonnet-4-6";
const DEFAULT_SCHEMA_TAX_THRESHOLD = 0.05;
const PREFLIGHT_SENTINEL = "__flow_model_bench_preflight__";
const MAX_TRANSPORT_RETRIES = 2;

export type Args = {
  fixturesDir: string;
  models: string[];
  repeats?: number;
  concurrency: number;
  cases?: string[];
  arms?: BenchArm[];
  maxCalls?: number;
  delegateBin?: string;
  timeout?: string;
  out: string;
  report: boolean;
  judgedFile?: string;
  incumbent: string;
  schemaTaxThreshold: number;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--report") {
      out.report = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--fixtures":
        out.fixturesDir = value;
        break;
      case "--models":
        out.models = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--repeats": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return { error: "--repeats must be a positive integer" };
        }
        out.repeats = n;
        break;
      }
      case "--concurrency": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return { error: "--concurrency must be a positive integer" };
        }
        out.concurrency = n;
        break;
      }
      case "--cases":
        out.cases = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--arms": {
        const arms = value.split(",").map((s) => s.trim());
        for (const a of arms) {
          if (a !== "schema" && a !== "free-form") {
            return {
              error: `--arms entries must be "schema" or "free-form" (got "${a}")`,
            };
          }
        }
        out.arms = arms as BenchArm[];
        break;
      }
      case "--max-calls": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return { error: "--max-calls must be a positive integer" };
        }
        out.maxCalls = n;
        break;
      }
      case "--delegate-bin":
        out.delegateBin = value;
        break;
      case "--timeout":
        out.timeout = value;
        break;
      case "--out":
        out.out = value;
        break;
      case "--judged":
        out.judgedFile = value;
        break;
      case "--incumbent":
        out.incumbent = value;
        break;
      case "--schema-tax-threshold": {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          return { error: "--schema-tax-threshold must be a number" };
        }
        out.schemaTaxThreshold = n;
        break;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (out.out === undefined) {
    return { error: "--out is required" };
  }
  return {
    fixturesDir: out.fixturesDir ?? DEFAULT_FIXTURES_DIR,
    models: out.models ?? DEFAULT_MODELS,
    repeats: out.repeats,
    concurrency: out.concurrency ?? DEFAULT_CONCURRENCY,
    cases: out.cases,
    arms: out.arms,
    maxCalls: out.maxCalls,
    delegateBin: out.delegateBin,
    timeout: out.timeout,
    out: out.out,
    report: out.report ?? false,
    judgedFile: out.judgedFile,
    incumbent: out.incumbent ?? DEFAULT_INCUMBENT,
    schemaTaxThreshold: out.schemaTaxThreshold ?? DEFAULT_SCHEMA_TAX_THRESHOLD,
  };
}

function defaultPreflight(delegateBin: string): {
  ok: boolean;
  message: string;
} {
  const r = Bun.spawnSync(
    ["bun", delegateBin, "--output-format", PREFLIGHT_SENTINEL],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const stderr = r.stderr ? new TextDecoder().decode(r.stderr) : "";
  return classifyPreflight(r.exitCode ?? 1, stderr, delegateBin);
}

export type Deps = {
  readFile: (p: string) => string;
  writeFile: (p: string, data: string) => void;
  fileExists: (p: string) => boolean;
  mkdirp: (d: string) => void;
  readdir: (d: string) => string[];
  progress: (line: string) => void;
  preflight: (delegateBin: string) => { ok: boolean; message: string };
  // Dispatches one fanout batch (an already-materialized manifest) and
  // resolves the aggregate result. The default implementation pins the
  // actual flow-delegate-fanout binary spawn to `delegateBin`, bypassing its
  // own `which flow-delegate` PATH resolution (see the module header). Test
  // doubles replace this wholesale — the default is NEVER reached in a test.
  runFanout: (
    manifest: FanoutManifestEntry[],
    opts: {
      concurrency: number;
      maxCalls: number;
      outDir: string;
      delegateBin: string;
    },
  ) => Promise<FanoutResult>;
  // Report-mode-only seams: never invoked on the run-mode path. Each is
  // individually try/caught by model-bench-report.ts's tolerant fallback
  // ("unknown" / today's date), so the defaults below are allowed to throw.
  gitHead: () => string;
  agyVersion: () => string;
  fileMtime: (p: string) => Date;
};

function runPinnedDelegate(
  delegateBin: string,
  entry: FanoutManifestEntry,
  outPath: string,
): Promise<DelegateEnvelope> {
  const argv = entryToDelegateArgv(entry, outPath);
  const proc = Bun.spawn(["bun", delegateBin, ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exited.then(async () => {
    const stdout = await new Response(proc.stdout).text();
    const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    try {
      return JSON.parse(line) as DelegateEnvelope;
    } catch {
      return { ran: false, task: entry.task, skipReason: "agy-error" };
    }
  });
}

async function defaultRunFanout(
  manifest: FanoutManifestEntry[],
  opts: {
    concurrency: number;
    maxCalls: number;
    outDir: string;
    delegateBin: string;
  },
): Promise<FanoutResult> {
  mkdirSync(opts.outDir, { recursive: true });
  const manifestPath = join(opts.outDir, "fanout-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  let captured = "";
  const code = await runFanoutCli(
    [
      "--manifest",
      manifestPath,
      "--concurrency",
      String(opts.concurrency),
      "--max-calls",
      String(opts.maxCalls),
      "--out",
      join(opts.outDir, "fanout-result.json"),
    ],
    {
      runDelegate: (entry, outPath) =>
        runPinnedDelegate(opts.delegateBin, entry, outPath),
      writeOut: (line) => {
        captured = line;
      },
    },
  );
  if (code !== 0) throw new Error(`flow-delegate-fanout exited ${code}`);
  return JSON.parse(captured) as FanoutResult;
}

// Dispatches the full manifest once, then retries only the transport-class
// skips (up to MAX_TRANSPORT_RETRIES rounds) — a genuine refusal or
// malformed-output skip is recorded immediately, never retried.
export async function dispatchWithRetries(
  deps: Deps,
  manifest: FanoutManifestEntry[],
  opts: {
    concurrency: number;
    maxCalls: number;
    outDir: string;
    delegateBin: string;
  },
): Promise<EntryResult[]> {
  const first = await deps.runFanout(manifest, opts);
  const envelopes = first.entries.slice();
  for (let attempt = 0; attempt < MAX_TRANSPORT_RETRIES; attempt++) {
    const retryIdx = envelopes
      .map((e, i) => (!e.ran && isTransportSkip(e.skipReason) ? i : -1))
      .filter((i) => i >= 0);
    if (retryIdx.length === 0) break;
    const retryManifest = retryIdx.map((i) => manifest[i]!);
    deps.progress(
      `flow-model-bench: retrying ${retryManifest.length} transport-class skip(s), attempt ${attempt + 1}\n`,
    );
    const retryResult = await deps.runFanout(retryManifest, {
      ...opts,
      maxCalls: retryManifest.length,
    });
    retryIdx.forEach((origIdx, k) => {
      envelopes[origIdx] = retryResult.entries[k]!;
    });
  }
  return envelopes;
}

export async function runBench(
  argv: string[],
  depsOverride?: Partial<Deps>,
): Promise<number> {
  const deps = resolveDeps(depsOverride);
  const args = parseArgs(argv);
  if ("error" in args) {
    deps.progress(`flow-model-bench: ${args.error}\n`);
    deps.progress(
      "usage: flow-model-bench [--fixtures <dir>] [--models <csv>] [--repeats <n>] [--concurrency <k>] [--cases <csv>] [--arms <csv>] [--max-calls <n>] [--delegate-bin <path>] --out <dir>\n" +
        "       flow-model-bench --report --out <dir> [--fixtures <dir>] [--judged <file>] [--incumbent <model>] [--schema-tax-threshold <n>]\n",
    );
    return 2;
  }

  // Report mode joins a completed run against the fixture truths; it never
  // dispatches a model call, so it skips preflight/loadCases-for-dispatch/
  // runFanout entirely.
  if (args.report) {
    const reportDeps: ReportDeps = {
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      fileExists: deps.fileExists,
      mkdirp: deps.mkdirp,
      readdir: deps.readdir,
      progress: deps.progress,
      gitHead: deps.gitHead,
      agyVersion: deps.agyVersion,
      runDate: (p) => deps.fileMtime(p).toISOString().slice(0, 10),
    };
    return runReport(
      {
        fixturesDir: args.fixturesDir,
        out: args.out,
        judgedFile: args.judgedFile,
        incumbent: args.incumbent,
        schemaTaxThreshold: args.schemaTaxThreshold,
      },
      reportDeps,
    );
  }

  const delegateBin =
    args.delegateBin ?? join(import.meta.dir, "flow-delegate.ts");
  const preflight = deps.preflight(delegateBin);
  if (!preflight.ok) {
    deps.progress(`flow-model-bench: ${preflight.message}\n`);
    return 1;
  }

  const loaded = loadCases(args.fixturesDir, deps);
  if ("error" in loaded) {
    deps.progress(`flow-model-bench: ${loaded.error}\n`);
    return 2;
  }
  const cases = args.cases
    ? loaded.filter((c) => args.cases!.includes(c.id))
    : loaded;
  if (cases.length === 0) {
    deps.progress(
      "flow-model-bench: no cases matched --cases, or the fixtures dir is empty\n",
    );
    return 2;
  }

  let manifest = buildManifest(cases, args.models, args.repeats);
  manifest = filterArms(manifest, args.arms);
  const maxCalls = resolveMaxCalls(
    manifest.length,
    args.maxCalls,
    deps.progress,
  );

  deps.mkdirp(args.out);
  const fanoutEntries = toFanoutEntries(
    manifest,
    cases,
    args.fixturesDir,
    args.out,
    deps,
    args.timeout,
  );

  const envelopes = await dispatchWithRetries(deps, fanoutEntries, {
    concurrency: args.concurrency,
    maxCalls,
    outDir: args.out,
    delegateBin,
  });

  const schemaCache = new Map<string, unknown>();
  const results: BenchResult[] = manifest.map((e, i) => {
    const env = envelopes[i]!;
    const ran = env.ran === true;
    let response: string | undefined;
    let structuredOutput: unknown;
    if (ran) {
      try {
        response = deps.readFile(fanoutEntries[i]!.out ?? "");
      } catch {
        response = undefined;
      }
      // Every bench entry runs --output-format json, so the artifact is the
      // AGY ENVELOPE, not model prose (the documented JSON-mode contract:
      // callers must go through .response / .structured_output). Unwrap it;
      // an unparseable artifact falls through with the raw text as response.
      if (response !== undefined) {
        try {
          const envelope = JSON.parse(response) as Record<string, unknown>;
          if (typeof envelope.response === "string") {
            response = envelope.response;
            if (
              envelope.structured_output !== undefined &&
              envelope.structured_output !== null
            ) {
              structuredOutput = envelope.structured_output;
            }
          }
        } catch {
          // not an envelope (text mode / partial write) — keep raw text
        }
      }
      const c = cases.find((cc) => cc.id === e.caseId);
      if (
        structuredOutput === undefined &&
        response !== undefined &&
        e.arm !== "n/a" &&
        c?.jsonSchemaFile
      ) {
        const schemaPath = join(args.fixturesDir, c.id, c.jsonSchemaFile);
        if (!schemaCache.has(schemaPath)) {
          try {
            schemaCache.set(schemaPath, JSON.parse(deps.readFile(schemaPath)));
          } catch {
            schemaCache.set(schemaPath, undefined);
          }
        }
        const attempt = parseStructured(response, schemaCache.get(schemaPath));
        if (attempt.ok) structuredOutput = attempt.value;
      }
    }
    const result: BenchResult = {
      caseId: e.caseId,
      arm: e.arm,
      model: e.model,
      repeat: e.repeat,
      warmup: e.warmup,
      ran,
    };
    if (env.skipReason) result.skipReason = env.skipReason;
    if (env.durationSeconds !== undefined)
      result.durationSeconds = env.durationSeconds;
    if (env.usage) result.usage = env.usage;
    if (response !== undefined) result.response = response;
    if (structuredOutput !== undefined)
      result.structuredOutput = structuredOutput;
    if (env.parseRetries !== undefined) result.parseRetries = env.parseRetries;
    if (e.size !== undefined) result.size = e.size;
    return result;
  });

  deps.writeFile(
    join(args.out, "results.json"),
    JSON.stringify(results, null, 2),
  );
  // The scorer discards warmups and translateJudged collapses verdicts to
  // surface::model anyway — warmup and ran:false (empty-text) entries add
  // dead weight to the one artifact a context-bounded Claude judge session
  // must read in full. Filter before blinding; ids stay self-consistent
  // because `key` is derived from this same filtered array.
  const { packet, key } = blind(results.filter((r) => !r.warmup && r.ran));
  deps.writeFile(
    join(args.out, "judge-packet.json"),
    JSON.stringify(packet, null, 2),
  );
  deps.writeFile(
    join(args.out, "judge-key.json"),
    JSON.stringify(key, null, 2),
  );
  deps.progress(
    `flow-model-bench: wrote ${results.length} results to ${args.out}\n`,
  );
  return 0;
}

function defaultGitHead(): string {
  const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (r.exitCode !== 0) throw new Error("git rev-parse HEAD failed");
  return new TextDecoder().decode(r.stdout).trim();
}

function defaultAgyVersion(): string {
  const r = Bun.spawnSync(["agy", "--version"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (r.exitCode !== 0) throw new Error("agy --version failed");
  return new TextDecoder().decode(r.stdout).trim();
}

function resolveDeps(o?: Partial<Deps>): Deps {
  return {
    readFile: o?.readFile ?? ((p) => readFileSync(p, "utf8")),
    writeFile: o?.writeFile ?? ((p, data) => writeFileSync(p, data)),
    fileExists: o?.fileExists ?? ((p) => existsSync(p)),
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    readdir: o?.readdir ?? ((d) => readdirSync(d)),
    progress: o?.progress ?? ((line) => process.stderr.write(line)),
    preflight: o?.preflight ?? defaultPreflight,
    runFanout: o?.runFanout ?? defaultRunFanout,
    gitHead: o?.gitHead ?? defaultGitHead,
    agyVersion: o?.agyVersion ?? defaultAgyVersion,
    fileMtime: o?.fileMtime ?? ((p) => statSync(p).mtime),
  };
}

if (import.meta.main) {
  runBench(process.argv.slice(2)).then((code) => process.exit(code));
}
