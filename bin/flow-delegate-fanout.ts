#!/usr/bin/env bun
/**
 * Run a manifest of `flow-delegate` calls concurrently (bounded pool) on the
 * user's Google AI Ultra quota, aggregating them into one structured JSON
 * result. Task-agnostic plumbing: it is the generic "run N flow-delegate
 * calls concurrently, aggregate one JSON" primitive that `flow-research`
 * (roadmap F1) consumes — not research-specific itself.
 *
 * It EXTENDS two existing flow patterns:
 * - flow-delegate's optional-tool graceful-skip envelope (per entry, the child
 *   reports `ran:false`/`skipReason` and we exit 0 on an all-skip run).
 * - flow-ci-wait's "background a long run, persist the verdict JSON to --out,
 *   stdout-result / stderr-progress" shape (a deep fan-out can exceed the
 *   harness foreground budget, so a resumed turn reads --out instead of
 *   re-running).
 *
 * Concurrency mechanism (load-bearing): the default runner async-`Bun.spawn`s
 * the `flow-delegate` BINARY per entry and `await`s up to K concurrently, so
 * the child `agy` subprocesses overlap at the OS level. It MUST NOT call
 * flow-delegate's exported `run()` for execution — that is synchronous
 * (`Bun.spawnSync`-backed), so a `Promise.all` over it would serialise and the
 * concurrency cap would be meaningless. The fanout treats flow-delegate as a
 * black-box binary: the child builds its own agy argv and pathing, so the only
 * reuse here is the `Args` type for consumers/tests to type against.
 *
 * Usage:
 *   flow-delegate-fanout --manifest <json-file>
 *                        [--concurrency <K>] [--max-calls <B>] [--out <path>]
 *                        [--default-entry-timeout <duration>]
 *
 *   Manifest is a JSON array of entries:
 *     { task, model, prompt | promptFile, timeout?, addDirs?, out? }
 *
 *   --default-entry-timeout is a fanout-level backstop: any entry that omits
 *   its own `timeout` is dispatched with this value, so a manifest that forgets
 *   a per-entry cap still gets one. A per-entry `timeout` always wins.
 *
 * stdout is always the single aggregate JSON envelope:
 *   { entries: [{ task, model, ran, artifactPath?, skipReason?, durationMs? }],
 *     anyRan, allSkipped, calls: { attempted, ran, skipped, budget } }
 *
 * Exit codes:
 *   0 — completed (every entry ran, skipped, or was budget-exhausted; an
 *       all-skip run is still 0 so the consumer branches on `allSkipped`).
 *   2 — usage error (missing/invalid manifest, unknown flag, non-positive
 *       --concurrency/--max-calls).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Args } from "./flow-delegate";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_CALLS = 40;
const DEFAULT_OUT = join(".flow-tmp", "research", "fanout-result.json");

export type ManifestEntry = {
  task: string;
  model?: string;
  prompt?: string;
  promptFile?: string;
  timeout?: string;
  addDirs?: string[];
  out?: string;
};

export type FanoutArgs = {
  manifest: string;
  concurrency: number;
  maxCalls: number;
  out: string;
  defaultEntryTimeout?: string;
};

export type EntryResult = {
  task: string;
  model: string | null;
  ran: boolean;
  artifactPath?: string;
  skipReason?: string;
  durationMs?: number;
};

export type FanoutResult = {
  entries: EntryResult[];
  anyRan: boolean;
  allSkipped: boolean;
  calls: { attempted: number; ran: number; skipped: number; budget: number };
};

// The one-line JSON envelope flow-delegate writes to stdout; the per-entry
// record is a projection of this. Skip envelopes omit artifactPath/durationMs.
export type DelegateEnvelope = {
  ran: boolean;
  task: string;
  model?: string | null;
  artifactPath?: string;
  skipReason?: string;
  exitCode?: number;
  durationMs?: number;
};

export type FanoutDeps = {
  // Dispatches one delegate call for a prepared entry and resolves the child's
  // parsed stdout envelope. MUST be async so the bounded pool is real — a
  // synchronous seam would serialise and observe a max in-flight depth of 1
  // regardless of the pool size (the exact trap the default runner avoids by
  // async-spawning the binary).
  runDelegate: (
    entry: ManifestEntry,
    outPath: string,
  ) => Promise<DelegateEnvelope>;
  readFile: (path: string) => string;
  fileExists: (path: string) => boolean;
  mkdirp: (dir: string) => void;
  writeFile: (path: string, data: string) => void;
  writeOut: (line: string) => void;
  progress: (line: string) => void;
  cwd: () => string;
};

export function parseFanoutArgs(
  argv: string[],
): FanoutArgs | { error: string } {
  const out: Partial<FanoutArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--manifest":
        out.manifest = value;
        break;
      case "--concurrency":
        out.concurrency = Number(value);
        break;
      case "--max-calls":
        out.maxCalls = Number(value);
        break;
      case "--out":
        out.out = value;
        break;
      case "--default-entry-timeout":
        out.defaultEntryTimeout = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (out.manifest === undefined) {
    return { error: "--manifest is required" };
  }
  const concurrency = out.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return { error: "--concurrency must be a positive integer" };
  }
  const maxCalls = out.maxCalls ?? DEFAULT_MAX_CALLS;
  if (!Number.isInteger(maxCalls) || maxCalls < 1) {
    return { error: "--max-calls must be a positive integer" };
  }
  return {
    manifest: out.manifest,
    concurrency,
    maxCalls,
    out: out.out ?? DEFAULT_OUT,
    defaultEntryTimeout: out.defaultEntryTimeout,
  };
}

// Each entry's artifact lands under
// <dir-of-aggregate-out>/artifacts/<index>-<task>.md. The 0-based manifest
// index prefix is load-bearing: the `task` sanitizer is lossy (it collapses
// every run of non-`[A-Za-z0-9._-]` chars to a single `-`), so distinct tasks
// differing only in punctuation/whitespace ("climate impact" / "climate/impact"
// / "climate:impact") would otherwise sanitize to the SAME filename and, since
// runPool dispatches them concurrently with the same `--out`, silently
// overwrite each other. The index makes the default path collision-free; a
// manifest entry's own `out` still overrides (and is NOT index-prefixed).
export function entryOutPath(
  entry: ManifestEntry,
  aggregateOut: string,
  index: number,
): string {
  if (entry.out) return entry.out;
  const safeTask = entry.task.replace(/[^A-Za-z0-9._-]+/g, "-");
  return join(dirname(aggregateOut), "artifacts", `${index}-${safeTask}.md`);
}

// Translate a manifest entry into the flow-delegate argv (the binary the
// default runner spawns). The resulting argv is for `flow-delegate`, NOT for
// `agy` directly — the child binary derives the agy argv itself.
export function entryToDelegateArgv(
  entry: ManifestEntry,
  outPath: string,
): string[] {
  const argv: string[] = ["--task", entry.task, "--out", outPath];
  if (entry.model) argv.push("--model", entry.model);
  if (entry.prompt !== undefined) argv.push("--prompt", entry.prompt);
  if (entry.promptFile !== undefined)
    argv.push("--prompt-file", entry.promptFile);
  if (entry.timeout) argv.push("--timeout", entry.timeout);
  for (const dir of entry.addDirs ?? []) argv.push("--add-dir", dir);
  return argv;
}

function parseManifest(raw: string): ManifestEntry[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `manifest is not valid JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { error: "manifest must be a JSON array of entries" };
  }
  for (const [i, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { error: `manifest entry ${i} is not an object` };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.task !== "string" || e.task.length === 0) {
      return { error: `manifest entry ${i} is missing a string "task"` };
    }
    if ((e.prompt === undefined) === (e.promptFile === undefined)) {
      return {
        error: `manifest entry ${i} ("${e.task}") needs exactly one of "prompt" or "promptFile"`,
      };
    }
  }
  return parsed as ManifestEntry[];
}

// Mirrors bin/flow-ci-wait.ts:1751 emitResult: the SAME serialized string goes
// to BOTH stdout and the --out file; the file write is mkdir-recursive then
// wrapped in try/catch so a failure writes a one-line stderr notice and is
// SWALLOWED — it never changes the exit code or suppresses the stdout result.
function emitResult(
  deps: FanoutDeps,
  result: FanoutResult,
  outPath: string,
): void {
  const serialized = JSON.stringify(result) + "\n";
  deps.writeOut(serialized);
  try {
    deps.mkdirp(dirname(outPath));
    deps.writeFile(outPath, serialized);
  } catch (err) {
    deps.progress(
      `flow-delegate-fanout: failed to persist result to ${outPath}: ${(err as Error).message}\n`,
    );
  }
}

// Bounded-pool executor: at most `concurrency` runDelegate calls in flight at
// once, draining the queue as each resolves. Budget is enforced at the call
// site (only dispatched entries reach here).
async function runPool(
  deps: FanoutDeps,
  jobs: Array<{ entry: ManifestEntry; outPath: string }>,
  concurrency: number,
): Promise<EntryResult[]> {
  const results: EntryResult[] = new Array(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++;
      const { entry, outPath } = jobs[index]!;
      const start = Date.now();
      let record: EntryResult;
      try {
        const envelope = await deps.runDelegate(entry, outPath);
        // Measure wall-clock in the pool (covers skips too) rather than
        // passing the envelope's durationMs through — skip envelopes have none.
        const durationMs = Date.now() - start;
        record = {
          task: entry.task,
          model: entry.model ?? null,
          ran: envelope.ran === true,
          durationMs,
        };
        if (envelope.artifactPath) record.artifactPath = envelope.artifactPath;
        if (envelope.skipReason) record.skipReason = envelope.skipReason;
      } catch (err) {
        // A thrown dispatch is a graceful skip for this entry, mirroring
        // flow-delegate's spawn-throw → agy-error contract.
        record = {
          task: entry.task,
          model: entry.model ?? null,
          ran: false,
          skipReason: "agy-error",
          durationMs: Date.now() - start,
        };
        deps.progress(
          `flow-delegate-fanout: entry "${entry.task}" dispatch failed: ${(err as Error).message}\n`,
        );
      }
      results[index] = record;
      deps.progress(
        `flow-delegate-fanout: ${record.ran ? "ran" : `skip(${record.skipReason})`} ${entry.task}\n`,
      );
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, jobs.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export async function run(
  argv: string[],
  depsOverride?: Partial<FanoutDeps>,
): Promise<number> {
  const deps = resolveDeps(depsOverride);
  const parsed = parseFanoutArgs(argv);
  if ("error" in parsed) {
    deps.progress(`flow-delegate-fanout: ${parsed.error}\n`);
    deps.progress(
      "usage: flow-delegate-fanout --manifest <json-file> [--concurrency <K>] [--max-calls <B>] [--out <path>] [--default-entry-timeout <duration>]\n",
    );
    return 2;
  }

  const manifestPath = resolve(deps.cwd(), parsed.manifest);
  if (!deps.fileExists(manifestPath)) {
    deps.progress(
      `flow-delegate-fanout: manifest not found: ${parsed.manifest}\n`,
    );
    return 2;
  }
  let raw: string;
  try {
    raw = deps.readFile(manifestPath);
  } catch (err) {
    deps.progress(
      `flow-delegate-fanout: cannot read manifest ${parsed.manifest}: ${(err as Error).message}\n`,
    );
    return 2;
  }
  const entries = parseManifest(raw);
  if ("error" in entries) {
    deps.progress(`flow-delegate-fanout: ${entries.error}\n`);
    return 2;
  }

  const outPath = resolve(deps.cwd(), parsed.out);

  // Budget counts DISPATCH ATTEMPTS: a skip still consumes one unit. Entries
  // past the budget are never dispatched and recorded budget-exhausted.
  const dispatched = entries.slice(0, parsed.maxCalls);
  const overBudget = entries.slice(parsed.maxCalls);

  // A per-entry `timeout` always wins; the fanout-level --default-entry-timeout
  // is the backstop for an entry that omits one. entryToDelegateArgv is left
  // unchanged — it just sees an entry whose timeout may have been filled in.
  const jobs = dispatched.map((entry, index) => {
    const timeout = entry.timeout ?? parsed.defaultEntryTimeout;
    const effective = timeout ? { ...entry, timeout } : entry;
    return {
      entry: effective,
      outPath: entryOutPath(effective, outPath, index),
    };
  });
  const dispatchedResults = await runPool(deps, jobs, parsed.concurrency);

  const budgetResults: EntryResult[] = overBudget.map((entry) => ({
    task: entry.task,
    model: entry.model ?? null,
    ran: false,
    skipReason: "budget-exhausted",
  }));

  const allResults = [...dispatchedResults, ...budgetResults];
  const ran = dispatchedResults.filter((r) => r.ran).length;
  const result: FanoutResult = {
    entries: allResults,
    anyRan: ran > 0,
    allSkipped: ran === 0,
    calls: {
      attempted: dispatched.length,
      ran,
      skipped: allResults.length - ran,
      budget: parsed.maxCalls,
    },
  };

  emitResult(deps, result, outPath);
  return 0;
}

// Default runner: async-spawn the flow-delegate BINARY and parse its one-line
// stdout envelope. Resolves the bare `flow-delegate` on PATH when installed,
// else the sibling source via `bun run`, so it works pre- and post-install.
function defaultRunDelegate(
  entry: ManifestEntry,
  outPath: string,
): Promise<DelegateEnvelope> {
  const delegateArgv = entryToDelegateArgv(entry, outPath);
  // We do NOT call flow-delegate's exported run(): it is synchronous, so a
  // Promise.all over it would serialise and defeat the bounded pool. The child
  // binary owns the agy argv build and artifact pathing; we only pass it the
  // flow-delegate argv and spawn it async.
  const onPath =
    Bun.spawnSync(["which", "flow-delegate"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0;
  const spawnArgv = onPath
    ? ["flow-delegate", ...delegateArgv]
    : [
        "bun",
        "run",
        join(import.meta.dir, "flow-delegate.ts"),
        ...delegateArgv,
      ];
  const proc = Bun.spawn(spawnArgv, {
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
      // A child that produced no parsable envelope is treated as a graceful
      // skip rather than a hard failure, consistent with flow-delegate's
      // never-throw contract.
      return { ran: false, task: entry.task, skipReason: "agy-error" };
    }
  });
}

function resolveDeps(o?: Partial<FanoutDeps>): FanoutDeps {
  return {
    runDelegate: o?.runDelegate ?? defaultRunDelegate,
    readFile: o?.readFile ?? ((p) => readFileSync(p, "utf8")),
    fileExists: o?.fileExists ?? ((p) => existsSync(p)),
    mkdirp: o?.mkdirp ?? ((d) => void mkdirSync(d, { recursive: true })),
    writeFile: o?.writeFile ?? ((p, data) => writeFileSync(p, data)),
    writeOut: o?.writeOut ?? ((line) => process.stdout.write(line)),
    progress: o?.progress ?? ((line) => process.stderr.write(line)),
    cwd: o?.cwd ?? (() => process.cwd()),
  };
}

// Re-export Args so consumers/tests can type-check against flow-delegate's
// shape without a second import.
export type { Args };

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
