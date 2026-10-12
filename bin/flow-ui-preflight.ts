#!/usr/bin/env bun
/**
 * Readiness preflight for the browser-driven UI checks: probes every
 * `dependsOn` service declared in `.flow/ui-validation.json` with a
 * load-aware backoff, runs a dependency's `start` command once after the
 * first failed probe, and records the verdict plus the load it saw in
 * `<worktree>/.flow-tmp/ui-preflight.json` (also printed to stdout).
 * Its envelope is the ONLY readiness verdict for Step 8c.iii / the verify
 * smoke pass: an ad-hoc probe (curl, port check) never vetoes a drive.
 *
 *   flow-ui-preflight [--manifest <path>] [--budget-sec <n=300>]
 *                     [--worktree <dir=cwd>]
 *
 * A probe is ready on any HTTP status < 500. Load factor =
 * clamp(loadavg1 / cpus, 1, 3); probe timeout (5 s), every wait and the
 * budget scale by it, the budget capped at 540 s so one Bash call (timeout
 * 600000) covers it. `start` runs as a plain foreground `sh -c` — NOT via
 * flow-spawn, whose registry rows `flow-browser-teardown --reap` signals at
 * terminal states; a service flow starts is left running (`startedByFlow`).
 * `start` must therefore RETURN once the service is up.
 *
 * Exit codes: 0 — envelope emitted (any verdict); 2 — bad args / manifest.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  validateUiValidationManifest,
  type UiValidationManifest,
} from "./lib/ui-validation-schema";

const WAITS_SEC = [5, 15, 30, 60, 90];
const PROBE_TIMEOUT_SEC = 5;
const MAX_BUDGET_SEC = 540;
const START_CAP_MS = 180_000;
const DEFAULT_MANIFEST = ".flow/ui-validation.json";

export type DependencyResult = {
  name: string;
  url: string;
  ready: boolean;
  attempts: number;
  lastStatus: number | string | null;
  startAttempted: boolean;
  startExitCode?: number;
  startedByFlow: boolean;
};

export type PreflightEnvelope = {
  ready: boolean;
  skipped_reason?: "dependency-unready";
  headSha: string | null;
  load: { loadavg: number[]; cpus: number };
  dependencies: DependencyResult[];
  startedAt: string;
  finishedAt: string;
};

export type ExecResult = { code: number; stdout: string };

export type PreflightDeps = {
  fetch: (url: string, timeoutMs: number) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  loadavg: () => number[];
  cpus: () => number;
  now: () => number;
  exec: (
    argv: string[],
    opts: { cwd: string; timeoutMs: number; captureStdout?: boolean },
  ) => Promise<ExecResult>;
  readFile: (p: string) => string | null;
  writeFile: (p: string, content: string) => void;
};

export function loadFactor(loadavg1: number, cpus: number): number {
  if (!Number.isFinite(loadavg1) || !(cpus > 0)) return 1;
  return Math.min(3, Math.max(1, loadavg1 / cpus));
}

export function computeSchedule(factor: number, budgetSec: number) {
  return {
    waitsMs: WAITS_SEC.map((s) => s * factor * 1000),
    probeTimeoutMs: PROBE_TIMEOUT_SEC * factor * 1000,
    budgetMs: Math.min(budgetSec * factor, MAX_BUDGET_SEC) * 1000,
  };
}

async function defaultExec(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; captureStdout?: boolean },
): Promise<ExecResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: opts.captureStdout ? "pipe" : "ignore",
    stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  try {
    const stdout = opts.captureStdout
      ? await new Response(proc.stdout as ReadableStream).text()
      : "";
    const code = await proc.exited;
    return { code: timedOut ? 124 : code, stdout };
  } finally {
    clearTimeout(timer);
  }
}

export function defaultDeps(): PreflightDeps {
  return {
    fetch: async (url, timeoutMs) => {
      const res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      void res.body?.cancel();
      return res.status;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    loadavg: () => os.loadavg(),
    cpus: () => os.availableParallelism(),
    now: () => Date.now(),
    exec: defaultExec,
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: (p, content) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
  };
}

async function headSha(worktree: string, deps: PreflightDeps) {
  try {
    const r = await deps.exec(["git", "rev-parse", "HEAD"], {
      cwd: worktree,
      timeoutMs: 10_000,
      captureStdout: true,
    });
    const sha = r.stdout.trim();
    return r.code === 0 && sha ? sha : null;
  } catch {
    return null;
  }
}

export async function runPreflight(
  manifest: UiValidationManifest | null,
  opts: { budgetSec: number; worktree: string },
  deps: PreflightDeps,
): Promise<PreflightEnvelope> {
  const startedMs = deps.now();
  const loadavg = deps.loadavg().slice(0, 3);
  while (loadavg.length < 3) loadavg.push(0);
  const cpus = deps.cpus();
  const sched = computeSchedule(loadFactor(loadavg[0], cpus), opts.budgetSec);
  const deadline = startedMs + sched.budgetMs;
  const dependencies: DependencyResult[] = [];

  for (const dep of manifest?.dependsOn ?? []) {
    const r: DependencyResult = {
      name: dep.name,
      url: dep.url,
      ready: false,
      attempts: 0,
      lastStatus: null,
      startAttempted: false,
      startedByFlow: false,
    };
    dependencies.push(r);
    for (;;) {
      r.attempts++;
      try {
        r.lastStatus = await deps.fetch(dep.url, sched.probeTimeoutMs);
        r.ready = r.lastStatus < 500;
      } catch (e) {
        r.lastStatus = e instanceof Error ? e.message : String(e);
      }
      if (r.ready || r.attempts >= WAITS_SEC.length) break;
      let remaining = deadline - deps.now();
      if (remaining <= 0) break;
      if (dep.start && !r.startAttempted) {
        r.startAttempted = true;
        const res = await deps.exec(["sh", "-c", dep.start], {
          cwd: opts.worktree,
          timeoutMs: Math.min(remaining, START_CAP_MS),
        });
        r.startExitCode = res.code;
        r.startedByFlow = res.code === 0;
        continue; // start returns once the service is up: re-probe at once
      }
      remaining = deadline - deps.now();
      if (remaining <= 0) break;
      await deps.sleep(Math.min(sched.waitsMs[r.attempts - 1], remaining));
    }
  }

  const ready = dependencies.every((d) => d.ready);
  return {
    ready,
    ...(ready ? {} : { skipped_reason: "dependency-unready" as const }),
    headSha: await headSha(opts.worktree, deps),
    load: { loadavg, cpus },
    dependencies,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(deps.now()).toISOString(),
  };
}

type Args = { manifest?: string; budgetSec: number; worktree: string };

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Args = { budgetSec: 300, worktree: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      flag !== "--manifest" &&
      flag !== "--budget-sec" &&
      flag !== "--worktree"
    ) {
      return { error: `unknown flag: ${flag}` };
    }
    if (!value || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    i++;
    if (flag === "--manifest") out.manifest = value;
    else if (flag === "--worktree") out.worktree = path.resolve(value);
    else {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `invalid --budget-sec value: ${value}` };
      }
      out.budgetSec = n;
    }
  }
  return out;
}

const USAGE =
  "usage: flow-ui-preflight [--manifest <path>] [--budget-sec <n=300>] [--worktree <dir>]\n";

export async function run(
  argv: string[],
  overrides: Partial<PreflightDeps> = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const args = parseArgs(argv);
  if ("error" in args) {
    process.stderr.write(`${args.error}\n${USAGE}`);
    return 2;
  }
  const deps = { ...defaultDeps(), ...overrides };
  const manifestPath = path.resolve(
    args.worktree,
    args.manifest ?? DEFAULT_MANIFEST,
  );
  const raw = deps.readFile(manifestPath);
  let manifest: UiValidationManifest | null = null;
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(
        `invalid manifest ${manifestPath}: JSON parse failed: ${e instanceof Error ? e.message : e}\n`,
      );
      return 2;
    }
    const v = validateUiValidationManifest(parsed);
    if (!v.ok) {
      process.stderr.write(`invalid manifest ${manifestPath}: ${v.reason}\n`);
      return 2;
    }
    manifest = v.value;
  }
  const envelope = await runPreflight(manifest, args, deps);
  const json = JSON.stringify(envelope, null, 2) + "\n";
  deps.writeFile(
    path.join(args.worktree, ".flow-tmp", "ui-preflight.json"),
    json,
  );
  process.stdout.write(json);
  return 0;
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
