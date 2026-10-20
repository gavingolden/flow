#!/usr/bin/env bun
/**
 * Stage 0 latency probe (maintainer-only, hand-run; see README.md). Re-runs
 * production Argon calls under production conditions — each prompt comes from
 * the step's own production builder, with the step's read-access / web-search
 * posture — one at a time through `flow-delegate-fanout` with a 20-minute cap,
 * and records answer time so each step's limit is sized from data.
 *
 *   bun docs/eval/argon-latency-probe/run.ts --worktree <dir> --out <dir>
 *     [--models <csv>] [--timeout 20m] [--repeats <surface=n,...>]
 *     [--surfaces <csv>] [--capped-gather]
 *
 * Exit codes: 0 done, 2 bad args, 3 stopped at the first quota refusal (the
 * records so far are kept in <out>/records.json).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  entryToDelegateArgv,
  run as runFanoutCli,
  type DelegateEnvelope,
  type FanoutResult,
  type ManifestEntry as FanoutManifestEntry,
} from "../../../bin/flow-delegate-fanout";
import {
  buildProbeManifest,
  DEFAULT_MODELS,
  DEFAULT_REPEATS,
  DEFAULT_TIMEOUT,
  PROBE_SURFACES,
  type Io,
} from "./manifest";
import {
  answerBytes,
  sizeLimits,
  toProbeRecord,
  type ProbeRecord,
  type ProbeSurface,
} from "./sizing";

export * from "./manifest";
export * from "./sizing";

const HERE = dirname(fileURLToPath(import.meta.url));

type Args = {
  worktree: string;
  out: string;
  models: string[];
  timeout: string;
  repeats: Record<ProbeSurface, number>;
  surfaces: ProbeSurface[];
  cappedGather: boolean;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const a: Args = {
    worktree: "",
    out: "",
    models: DEFAULT_MODELS,
    timeout: DEFAULT_TIMEOUT,
    repeats: { ...DEFAULT_REPEATS },
    surfaces: PROBE_SURFACES,
    cappedGather: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--capped-gather") {
      a.cappedGather = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) return { error: `${flag} requires a value` };
    if (flag === "--worktree") a.worktree = resolve(v);
    else if (flag === "--out") a.out = resolve(v);
    else if (flag === "--models") a.models = v.split(",").filter(Boolean);
    else if (flag === "--timeout") a.timeout = v;
    else if (flag === "--surfaces") {
      const s = v.split(",").filter(Boolean);
      const bad = s.find((x) => !PROBE_SURFACES.includes(x as ProbeSurface));
      if (bad) return { error: `unknown surface: ${bad}` };
      a.surfaces = s as ProbeSurface[];
    } else if (flag === "--repeats") {
      for (const pair of v.split(",").filter(Boolean)) {
        const [k, n] = pair.split("=");
        const count = Number(n);
        if (
          !PROBE_SURFACES.includes(k as ProbeSurface) ||
          !Number.isInteger(count) ||
          count < 0
        ) {
          return { error: `bad --repeats entry: ${pair}` };
        }
        a.repeats[k as ProbeSurface] = count;
      }
    } else return { error: `unknown flag: ${flag}` };
  }
  if (!a.worktree || !a.out)
    return { error: "--worktree and --out are required" };
  for (const s of PROBE_SURFACES) if (!a.surfaces.includes(s)) a.repeats[s] = 0;
  return a;
}

export function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, data);
  renameSync(`${path}.tmp`, path);
}

export function recordsDocument(
  records: ProbeRecord[],
  measuredAt: string,
): string {
  return (
    JSON.stringify(
      { measuredAt, records, limits: sizeLimits(records) },
      null,
      2,
    ) + "\n"
  );
}

// Records from an earlier run in the same out dir, for surfaces this run does
// not re-measure. A missing or unreadable file is an empty history.
export function readPriorRecords(path: string): ProbeRecord[] {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      records?: unknown;
    };
    return Array.isArray(doc.records) ? (doc.records as ProbeRecord[]) : [];
  } catch {
    return [];
  }
}

export type Dispatch = (
  entry: FanoutManifestEntry,
) => Promise<FanoutResult["entries"][number]>;

function runPinnedDelegate(
  entry: FanoutManifestEntry,
  outPath: string,
): Promise<DelegateEnvelope> {
  const delegateBin = resolve(HERE, "../../../bin/flow-delegate.ts");
  const proc = Bun.spawn(
    ["bun", delegateBin, ...entryToDelegateArgv(entry, outPath)],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  // Drain stdout while the child runs: reading it only after exit would
  // deadlock a child that fills the pipe buffer.
  return Promise.all([new Response(proc.stdout).text(), proc.exited]).then(
    ([stdout]) => {
      const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
      try {
        return JSON.parse(line) as DelegateEnvelope;
      } catch {
        return { ran: false, task: entry.task, skipReason: "agy-error" };
      }
    },
  );
}

// One entry per fanout call, concurrency 1: serial by construction, so a quota
// refusal stops the run before a second call is spent.
export function fanoutDispatch(outDir: string): Dispatch {
  return async (entry) => {
    const manifestPath = join(outDir, "manifests", `${entry.task}.json`);
    writeAtomic(manifestPath, JSON.stringify([entry]));
    let captured = "";
    await runFanoutCli(
      [
        "--manifest",
        manifestPath,
        "--concurrency",
        "1",
        "--max-calls",
        "1",
        "--out",
        join(outDir, "results", `${entry.task}.json`),
      ],
      {
        runDelegate: (e, out) => runPinnedDelegate(e, out),
        writeOut: (line) => {
          captured = line;
        },
        progress: () => {},
      },
    );
    return (JSON.parse(captured) as FanoutResult).entries[0]!;
  };
}

export async function runProbe(
  args: Args,
  deps: {
    dispatch?: Dispatch;
    now?: () => Date;
    progress?: (l: string) => void;
    io?: Io;
    writeRecords?: (path: string, data: string) => void;
    readPrior?: (path: string) => ProbeRecord[];
    writeOut?: (line: string) => void;
  } = {},
): Promise<number> {
  const dispatch = deps.dispatch ?? fanoutDispatch(args.out);
  const now = deps.now ?? (() => new Date());
  const progress = deps.progress ?? ((l) => process.stderr.write(l));
  const writeRecords = deps.writeRecords ?? writeAtomic;
  const writeOut = deps.writeOut ?? ((l) => console.log(l));
  // One stdout line when the run ends, so a detached run's stdout file is the
  // complete-line signal for flow-plan-review-wait.
  const finish = (code: number): number => {
    writeOut(
      JSON.stringify({
        code,
        recorded: records.length - kept,
        planned: manifest.length,
      }),
    );
    return code;
  };
  const manifest = buildProbeManifest({
    models: args.models,
    repeats: args.repeats,
    worktree: args.worktree,
    inputsDir: join(HERE, "inputs"),
    timeout: args.timeout,
    outDir: args.out,
    cappedGather: args.cappedGather,
    io: deps.io,
  });
  const recordsPath = join(args.out, "records.json");
  // A re-run of some surfaces merges into the earlier records instead of
  // replacing them; a surface measured again replaces its own earlier records.
  const remeasured = new Set(manifest.map((e) => e.task.split("__r")[0]));
  const records: ProbeRecord[] = (deps.readPrior ?? readPriorRecords)(
    recordsPath,
  ).filter((r) => !remeasured.has(r.surface));
  const kept = records.length;
  for (const entry of manifest) {
    progress(
      `argon-latency-probe: ${entry.task} (${records.length - kept + 1}/${manifest.length})\n`,
    );
    const result = await dispatch(entry);
    // A refused call carries no latency signal and would drag the median down;
    // stop before spending another call.
    if (result.failureClass === "quota-exhausted") {
      writeRecords(recordsPath, recordsDocument(records, now().toISOString()));
      progress(
        `argon-latency-probe: quota refusal at ${entry.task}; ${manifest.length - (records.length - kept)} calls not run. Wait for the reset and re-run for the rest.\n`,
      );
      return finish(3);
    }
    const bytes =
      result.ran &&
      result.artifactPath &&
      existsSync(result.artifactPath) &&
      statSync(result.artifactPath).size > 0
        ? answerBytes(readFileSync(result.artifactPath, "utf8"))
        : 0;
    records.push(toProbeRecord(entry, result, bytes));
    writeRecords(recordsPath, recordsDocument(records, now().toISOString()));
  }
  return finish(0);
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`argon-latency-probe: ${parsed.error}`);
    process.exit(2);
  }
  runProbe(parsed).then((code) => process.exit(code));
}
