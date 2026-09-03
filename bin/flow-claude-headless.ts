#!/usr/bin/env bun
/**
 * The one sanctioned raw `claude -p` spawn site (see
 * `skills/pipeline/flow-pipeline/references/headless-claude.md`). Thin CLI
 * over `bin/lib/claude-headless.ts` — this file supplies the real spawn
 * (`runClaude`) and PATH probe (`claudeOnPath`); the lib stays spawn-free
 * so it can be unit-tested with injected `Deps` under vitest, where
 * `Bun.spawn`/`Bun.spawnSync` is undefined.
 *
 * `node:child_process.spawn` with `detached: true` is required (not
 * `Bun.spawnSync`, flow-delegate's choice) so a timeout can
 * `process.kill(-pid, ...)` the whole process group, not just the direct
 * child — a `claude -p` session can itself spawn tool subprocesses.
 */

import { spawn } from "node:child_process";
import {
  openSync,
  closeSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { run, type Deps, type RunClaudeResult } from "./lib/claude-headless";

function claudeOnPath(): boolean {
  return Bun.which("claude") !== null;
}

const KILL_GRACE_MS = 2000;

// `detached: true` puts the child in its own process group so a timeout
// can kill the whole tree — but it also means the child survives if the
// wrapper itself is killed (Ctrl-C, a pipeline-level SIGTERM), left
// running with nobody to collect its result. Track the live child's pid
// so the wrapper's own signal handlers (registered once below) can
// forward the signal into the child's process group before the wrapper
// exits.
let currentChildPid: number | undefined;

function forwardSignal(signal: NodeJS.Signals): void {
  if (currentChildPid) {
    try {
      process.kill(-currentChildPid, signal);
    } catch {
      // process group already gone
    }
  }
  process.exit(signal === "SIGINT" ? 130 : 1);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => forwardSignal(signal));
}

function runClaude(
  argv: string[],
  env: Record<string, string>,
  outPath: string,
  timeoutSec: number,
): Promise<RunClaudeResult> {
  return new Promise((resolve) => {
    const outFd = openSync(outPath, "w");
    const child = spawn(argv[0], argv.slice(1), {
      env,
      detached: true,
      stdio: ["ignore", outFd, "pipe"],
    });
    currentChildPid = child.pid;

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // process group already gone
        }
      }
      killTimer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // already dead
          }
        }
      }, KILL_GRACE_MS);
    }, timeoutSec * 1000);

    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      currentChildPid = undefined;
      try {
        closeSync(outFd);
      } catch {
        // already closed
      }
      resolve({ exitCode: code ?? 1, stderr, timedOut });
    });

    child.on("error", (e) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      currentChildPid = undefined;
      try {
        closeSync(outFd);
      } catch {
        // already closed
      }
      resolve({ exitCode: 1, stderr: e.message, timedOut: false });
    });
  });
}

function defaultDeps(): Partial<Deps> {
  return {
    claudeOnPath,
    runClaude,
    readFile: (path: string) => readFileSync(path, "utf8"),
    fileExists: (path: string) => existsSync(path),
    mkdirp: (dir: string) => mkdirSync(dir, { recursive: true }),
  };
}

if (import.meta.main) {
  // `run()` (bin/lib/claude-headless.ts) already wraps every internal
  // throw so it always resolves with an envelope + exit code — this
  // `.catch` is defense-in-depth against a throw from `defaultDeps()`
  // construction itself or a `Deps` function outside `run()`'s own
  // try/catch, so this entry point can never leave a thrown error as an
  // unhandled rejection instead of the promised one JSON line.
  run(process.argv.slice(2), defaultDeps())
    .then((code) => {
      process.exit(code);
    })
    .catch((e) => {
      console.log(
        JSON.stringify({
          ran: false,
          task: "headless",
          skipReason: "claude-error",
          stderrTail: e instanceof Error ? e.message : String(e),
        }),
      );
      process.exit(0);
    });
}
