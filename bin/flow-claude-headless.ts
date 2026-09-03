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
  run(process.argv.slice(2), defaultDeps()).then((code) => {
    process.exit(code);
  });
}
