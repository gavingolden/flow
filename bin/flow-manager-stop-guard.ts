#!/usr/bin/env bun
/**
 * Claude Code Stop hook for the global manager's settings. The manager hears
 * about pipelines only through its background `flow-manager-wait`; a turn that
 * ends with no live waiter leaves it deaf until the owner types. So when
 * `FLOW_MANAGER=1` and `waiter.json` does not name a live waiter that started
 * at or after this manager launched, the turn end is blocked (exit 2) with
 * "re-arm the waiter first".
 *
 * One block per turn: when Claude Code reports `stop_hook_active` the model was
 * already told, and a second block would loop forever on a waiter that cannot
 * start (the owner sees `status.md` go stale instead).
 */

import { readHookStdin } from "./lib/hook-stdin";
import { managerHome } from "./lib/manager-home";
import { readManagerRecord } from "./lib/manager-record";
import { readWaiter, waiterLive } from "./lib/manager-waiter";

export const REARM_MESSAGE =
  "re-arm the waiter first: run `flow-manager-wait --ensure`, and if it prints start-needed start `flow-manager-wait` with run_in_background, then end your turn.";

export function shouldBlock(
  input: { stop_hook_active?: boolean },
  env: NodeJS.ProcessEnv,
  deps: {
    home?: string;
    now?: () => number;
    kill?: (pid: number, signal: 0) => void;
  } = {},
): boolean {
  if (env.FLOW_MANAGER !== "1") return false;
  if (input.stop_hook_active === true) return false;
  const home = deps.home ?? managerHome();
  const record = readManagerRecord(home);
  if (!record) return false;
  const waiter = readWaiter(home);
  const live = waiterLive(waiter, (deps.now ?? Date.now)(), deps.kill);
  const started = Date.parse(waiter?.startedAt ?? "");
  return !(live && started >= Date.parse(record.startedAt));
}

export async function main(
  stdin: () => Promise<string>,
  env: NodeJS.ProcessEnv = process.env,
  deps: Parameters<typeof shouldBlock>[2] = {},
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<number> {
  let input: { stop_hook_active?: boolean } = {};
  try {
    input = JSON.parse(await stdin()) as typeof input;
  } catch {
    // an unreadable payload is treated as a first stop
  }
  if (!shouldBlock(input, env, deps)) return 0;
  err(`${REARM_MESSAGE}\n`);
  return 2;
}

if (import.meta.main) {
  main(() => readHookStdin()).then((code) => process.exit(code));
}
