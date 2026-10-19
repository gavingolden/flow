#!/usr/bin/env bun
/**
 * Dumb, bounded, restartable waiter for the async cross-model plan review
 * (`flow-plan-review --start` / `--check`) and, as its second caller, the
 * long-delegate-call detach-and-wait recipe (survey, forced research, the
 * Gemini lens, the intent guess, discovery research): a caller launches a
 * helper with `flow-spawn --detach --stdout <file>` and re-runs this waiter
 * (`--complete-line --pid "$PID"`) until the file holds a complete line, the
 * helper is gone, or its own give-up time passes. Owns ZERO state and ZERO
 * decisions — it only polls for one file's existence (or completeness). Mirrors
 * `bin/flow-ci-wait.ts`'s shape (the decider/waiter split this module is
 * the second instance of), including the `--max-sec 540` default and its
 * rationale: every invocation must exit inside the Bash tool's ~600s
 * background-run ceiling, and the supervisor re-arms on the next wake.
 *
 * Deliberate divergence from `flow-ci-wait`: NO `--min-sec` floor.
 * `gh pr checks --watch` can exit instantly on a transient, so ci-wait
 * needs a floor to avoid a false-fast wake; here the result file's
 * appearance is definitive — flow-plan-review's own worker writes it
 * atomically (tmp-then-rename) only once the review is truly decided — so
 * a floor would only add latency after the review is already done. This
 * is a decision, not an omission.
 *
 * The decision matrix and the wall-clock anchors that make a suspended
 * wait immune to fabricating a false verdict live entirely in
 * `flow-plan-review.ts --check` / `~/.flow/state/<slug>.json`, not here.
 *
 * `--complete-line`: a `flow-spawn --detach --stdout <file>` file exists from
 * launch but stays empty until the helper prints its one-line result, so
 * existence alone returns instantly; this mode also requires a non-empty
 * file whose last byte is a newline (a half-written line keeps waiting).
 * `--pid <n>`: a helper that exits (or crashes) without printing ends the
 * wait at once (`process.kill(pid, 0)` throws ESRCH); the file is re-checked
 * once after the exit is seen, closing the race with the helper's final
 * atomic rename. A recycled pid can at worst hold the wait to `--max-sec`.
 *
 * Usage:
 *   flow-plan-review-wait <result-path> [--max-sec <n=540>] [--interval <n=5>]
 *                         [--complete-line] [--pid <n>]
 *
 * Output: one JSON line `{"outcome":"complete" | "process-exited-without-result"
 * | "timeout"}` so a caller can branch; the caller still re-derives the real
 * verdict from the watched file itself.
 *
 * Exit codes:
 *   0 — always (the result file appeared, the process exited, or the wait
 *       timed out — all "done waiting"; the caller re-derives the real
 *       verdict by re-running `flow-plan-review --check` (or reading the
 *       watched file) afterward, never from this process's exit code)
 *   2 — bad CLI args
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const HELP =
  "usage: flow-plan-review-wait <result-path> [--max-sec <n=540>] [--interval <n=5>] [--complete-line] [--pid <n>]";

export type WaitArgs = {
  resultPath: string;
  maxSec: number;
  intervalSec: number;
  completeLine: boolean;
  pid?: number;
};

export function parseArgs(argv: string[]): WaitArgs | { error: string } {
  if (argv.length === 0) return { error: "result-path is required" };
  if (argv.includes("--help") || argv.includes("-h")) return { error: "help" };
  const [first, ...rest] = argv;
  if (first.startsWith("--")) {
    return { error: "result-path must be the first positional argument" };
  }
  const out: WaitArgs = {
    resultPath: first,
    maxSec: 540,
    intervalSec: 5,
    completeLine: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    const parsePositiveInt = (name: string): number | { error: string } => {
      if (!value) return { error: `${name} requires a value` };
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
        return { error: `${name} must be a positive integer, got '${value}'` };
      }
      return n;
    };
    switch (flag) {
      case "--max-sec": {
        const n = parsePositiveInt("--max-sec");
        if (typeof n !== "number") return n;
        out.maxSec = n;
        i++;
        continue;
      }
      case "--interval": {
        const n = parsePositiveInt("--interval");
        if (typeof n !== "number") return n;
        out.intervalSec = n;
        i++;
        continue;
      }
      case "--pid": {
        const n = parsePositiveInt("--pid");
        if (typeof n !== "number") return n;
        out.pid = n;
        i++;
        continue;
      }
      case "--complete-line":
        out.completeLine = true;
        continue;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return out;
}

export type WaitOutcome =
  | "complete"
  | "process-exited-without-result"
  | "timeout";

export type Deps = {
  exists?: (p: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  statSize?: (p: string) => number;
  lastByte?: (p: string) => string;
  kill?: (pid: number, signal: 0) => void;
};

function defaultStatSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function defaultLastByte(p: string): string {
  let fd: number | undefined;
  try {
    const size = statSync(p).size;
    if (size === 0) return "";
    fd = openSync(p, "r");
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf.toString("latin1");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log(HELP);
      return 0;
    }
    console.error(`flow-plan-review-wait: ${parsed.error}`);
    console.error(HELP);
    return 2;
  }

  const exists = deps.exists ?? existsSync;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const statSize = deps.statSize ?? defaultStatSize;
  const lastByte = deps.lastByte ?? defaultLastByte;
  const kill = deps.kill ?? ((pid: number, sig: 0) => process.kill(pid, sig));

  const fileDone = (): boolean =>
    exists(parsed.resultPath) &&
    (!parsed.completeLine ||
      (statSize(parsed.resultPath) > 0 && lastByte(parsed.resultPath) === "\n"));

  const processGone = (): boolean => {
    if (parsed.pid === undefined) return false;
    try {
      kill(parsed.pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  };

  const startMs = now();
  const deadlineMs = startMs + parsed.maxSec * 1000;

  let signaled = false;
  const onSignal = (): void => {
    signaled = true;
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  let outcome: WaitOutcome | undefined;
  try {
    while (outcome === undefined) {
      if (fileDone()) {
        outcome = "complete";
      } else if (processGone()) {
        outcome = fileDone() ? "complete" : "process-exited-without-result";
      } else if (signaled) {
        return 0;
      } else if (now() >= deadlineMs) {
        outcome = "timeout";
      } else {
        await sleep(parsed.intervalSec * 1000);
      }
    }
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }

  console.log(JSON.stringify({ outcome }));
  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
