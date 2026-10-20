#!/usr/bin/env bun
/**
 * PATH helper for the advisory PM-readability judge
 * (`skills/pipeline/flow-pipeline/SKILL.md` Step 5's PR-body site). Thin
 * CLI over `bin/lib/explain-judge.ts` — this file supplies the real
 * `flow-claude-headless` spawn (`runHeadless`) and the real config/brief/
 * telemetry seams; the lib stays spawn-free so it can be unit-tested with
 * injected `Deps` under vitest.
 *
 * `flow-claude-headless` — the one sanctioned raw `claude -p` spawn site —
 * is spawned here by BARE PATH NAME via `Bun.spawnSync`, the exact same
 * bare-name-spawn discipline as `bin/flow-deliberate.ts:476`, which spawns
 * `flow-claude-headless` the same way (siblings `bin/flow-gemini-lens.ts:757`
 * and `bin/flow-blind-survey.ts:549` spawn `flow-delegate`, and
 * `bin/flow-plan-review.ts:1472` spawns `flow-delegate` too — all four
 * establish the bare-PATH-name convention this file follows, even though
 * `flow-deliberate.ts:476` is the one spawning the same binary). This file
 * itself never imports `node:child_process` and is not a second raw
 * `claude -p` site.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run, type Deps } from "./lib/explain-judge";
import { resolveProductBrief } from "./flow-product-brief";
import { recordEvent, type RecordEventOpts } from "./lib/telemetry";

function defaultReadConfig(): string | null {
  try {
    return fs.readFileSync(
      path.join(os.homedir(), ".flow", "config.json"),
      "utf8",
    );
  } catch {
    return null;
  }
}

function defaultMkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-explain-judge-"));
}

function defaultRemoveDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function defaultRunHeadless(
  argv: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  // A fresh, empty temp cwd: the child loads no CLAUDE.md and cannot see
  // the repo. No detached process group is needed — flow-claude-headless
  // owns its own timeout.
  const r = Bun.spawnSync(["flow-claude-headless", ...argv], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = r.stdout ? new TextDecoder().decode(r.stdout) : "";
  return Promise.resolve({ exitCode: r.exitCode ?? 1, stdout });
}

// `recordOpts` is a test-only seam (an injected `logPath`, mirroring
// `RecordEventOpts`) — every real caller invokes `defaultDeps()` with no
// arguments, so `defaultDeps(): Partial<Deps>` still holds for them.
export function defaultDeps(recordOpts: RecordEventOpts = {}): Partial<Deps> {
  return {
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    fileExists: (p) => fs.existsSync(p),
    readConfig: defaultReadConfig,
    resolveBrief: () => resolveProductBrief(),
    runHeadless: defaultRunHeadless,
    mkdtemp: defaultMkdtemp,
    removeDir: defaultRemoveDir,
    env: process.env,
    writeOut: (line) => console.log(line),
    record: (attrs) => recordEvent("explain.judge", attrs, recordOpts),
  };
}

if (import.meta.main) {
  // `run()` (bin/lib/explain-judge.ts) already wraps every internal throw
  // so it always resolves with an envelope + exit code — this `.catch` is
  // defense-in-depth against a throw from `defaultDeps()` construction
  // itself, so this entry point can never leave a thrown error as an
  // unhandled rejection instead of the promised one JSON line.
  run(process.argv.slice(2), defaultDeps())
    .then((code) => {
      process.exit(code);
    })
    .catch((e) => {
      console.log(
        JSON.stringify({
          ran: false,
          site: "unknown",
          skipReason: "claude-error",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      process.exit(0);
    });
}
