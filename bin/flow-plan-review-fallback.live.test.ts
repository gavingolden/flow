/**
 * Live smoke of the plan review's reviewer-2 Claude Code fallback: a real
 * `flow-claude-headless` reviewer must finish all seven lenses inside the
 * 25-turn / $3 caps (about $3 at most).
 *
 * Skipped unless FLOW_LIVE_PLAN_REVIEW_FALLBACK=1, so `npm run test` never
 * spends. The run reads only a temp worktree holding a small fixture plan.
 *
 *   FLOW_LIVE_PLAN_REVIEW_FALLBACK=1 npx vitest run bin/flow-plan-review-fallback.live.test.ts
 *
 * Runs under Node, not `bunx --bun`: Bun's os.homedir() ignores the suite's
 * sandboxed HOME, which trips the HOME-sandbox guard in vitest.setup.ts. The
 * child gets the real home (FLOW_TEST_REAL_HOME) so `claude` finds its login.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseHeadlessStdout,
  readHeadlessResult,
} from "./lib/headless-envelope";
import { classifyEngagement } from "./lib/plan-review-engagement";
import {
  buildFallbackArgv,
  buildFallbackPrompt,
} from "./lib/plan-review-fallback";
import { buildBatteryPrompt, extractGoalLine } from "./lib/plan-review-prompt";

const LIVE = process.env.FLOW_LIVE_PLAN_REVIEW_FALLBACK === "1";

const PLAN = [
  "# PRD: add a retry to the sync job",
  "",
  "**Goal:** a failed nightly sync retries once before paging the owner.",
  "",
  "## Decision analysis",
  "",
  "**Decision A — retry in the job or in the scheduler?** Verdict: in the job, because the job owns the idempotency key.",
  "",
  "## Cut list",
  "",
  "- No exponential backoff; one retry only.",
].join("\n");

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-fallback-live-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "sync.ts"),
    "export function runSync(): void {\n  // nightly sync entry point\n}\n",
  );
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!LIVE)(
  "plan-review reviewer-2 fallback live (FLOW_LIVE_PLAN_REVIEW_FALLBACK=1)",
  () => {
    it(
      "finishes the seven lenses in one final message under the caps",
      () => {
        const promptPath = path.join(root, "prompt.r2-claude");
        const out = path.join(root, "r2-claude.json");
        fs.writeFileSync(
          promptPath,
          buildFallbackPrompt(
            buildBatteryPrompt({
              planText: PLAN,
              goalLine: extractGoalLine(PLAN),
              sameFamilyAsAuthor: true,
              worktreePath: root,
              productBrief: null,
            }),
          ),
        );

        const r = spawnSync(
          "flow-claude-headless",
          buildFallbackArgv({
            promptPath,
            out,
            task: "plan-review-r2-claude",
            timeoutSec: 900,
          }),
          {
            cwd: root,
            env: {
              ...process.env,
              HOME: process.env.FLOW_TEST_REAL_HOME ?? process.env.HOME,
            },
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
          },
        );
        const env = parseHeadlessStdout(r.stdout ?? "");
        expect(env.ran, JSON.stringify(env)).toBe(true);

        const prose = readHeadlessResult(env, out, (p) =>
          fs.readFileSync(p, "utf8"),
        );
        expect(prose).not.toBeNull();
        const eng = classifyEngagement(prose ?? "");
        expect(eng.engaged, JSON.stringify(eng)).toBe(true);
      },
      16 * 60 * 1000,
    );
  },
);
