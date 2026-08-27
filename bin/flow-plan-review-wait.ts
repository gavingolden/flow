#!/usr/bin/env bun
/**
 * Dumb, bounded, restartable waiter for the async cross-model plan review
 * (`flow-plan-review --start` / `--check`). Owns ZERO state and ZERO
 * decisions — it only polls for one file's existence. Mirrors
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
 * Usage:
 *   flow-plan-review-wait <result-path> [--max-sec <n=540>] [--interval <n=5>]
 *
 * Exit codes:
 *   0 — always (the result file appeared, or the wait timed out — both
 *       "done waiting"; the caller re-derives the real verdict by
 *       re-running `flow-plan-review --check` afterward, never from this
 *       process's exit code)
 *   2 — bad CLI args
 */

import { existsSync } from "node:fs";

const HELP =
  "usage: flow-plan-review-wait <result-path> [--max-sec <n=540>] [--interval <n=5>]";

export type WaitArgs = {
  resultPath: string;
  maxSec: number;
  intervalSec: number;
};

export function parseArgs(argv: string[]): WaitArgs | { error: string } {
  if (argv.length === 0) return { error: "result-path is required" };
  if (argv.includes("--help") || argv.includes("-h")) return { error: "help" };
  const [first, ...rest] = argv;
  if (first.startsWith("--")) {
    return { error: "result-path must be the first positional argument" };
  }
  const out: WaitArgs = { resultPath: first, maxSec: 540, intervalSec: 5 };
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
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return out;
}

export type Deps = {
  exists?: (p: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

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

  const startMs = now();
  const deadlineMs = startMs + parsed.maxSec * 1000;

  let signaled = false;
  const onSignal = (): void => {
    signaled = true;
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    while (!exists(parsed.resultPath)) {
      if (signaled) return 0;
      if (now() >= deadlineMs) return 0;
      await sleep(parsed.intervalSec * 1000);
    }
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }

  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
