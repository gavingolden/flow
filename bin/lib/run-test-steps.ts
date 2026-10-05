/**
 * `/flow-pr-review` Step 8c's per-item loop as one call: fetch the PR body,
 * run every unchecked `command`-kind Test Step exactly as written (no
 * per-item vetting: refused for cross-repository PRs unless allowed), tick
 * passes and attach an evidence block to every run (via `rewriteBody`, the
 * `flow-inject-evidence` engine), repair the body with `flow-md-validate`,
 * and push it ONCE.
 *
 * Repair-before-push is this module's property now (the hand-written
 * `flow-md-validate --fix-pr-body` + `gh pr edit` recipe it replaces was
 * pinned by `bin/skill-md-lint.test.ts`'s BODY_EDIT_SITES; the ordering is
 * asserted in `bin/flow-run-test-steps.test.ts`). The PR body is read with
 * `gh pr view --json body,isCrossRepository` (or from a local `bodyFile` the
 * caller has unpushed edits in, so a re-entry never clobbers them) and parsed here — never `--jq`, which the eval
 * `gh` shim ignores.
 *
 * JUDGMENT STAYS OUT: classification of prose/browser/subjective items,
 * fixing failures, and prose promotion remain the supervisor's.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { rewriteBody } from "../flow-inject-evidence";
import { parseTestSteps, type StepKind } from "./test-steps-parse";
import { hasLocalImageRefs } from "./review-screenshots";

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
};

export type ExecFn = (
  argv: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => ExecResult | Promise<ExecResult>;

export type RunEnvelope = {
  /** Unchecked command-kind items considered. */
  total: number;
  /** ALL unchecked items in `## Test Steps` at start. */
  uncheckedTotal: number;
  ran: number;
  passed: number;
  failed: { index: number; command: string; exitCode: number; tail: string }[];
  pending: { index: number; command: string }[];
  notRunnable: { index: number; kind: StepKind; text: string }[];
  bodyPushed: boolean;
  pushSkippedReason: string | null;
};

const ITEM_TIMEOUT_SEC = 300;
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
const MARK = "\u0001";

/**
 * Each child runs in its own process group, and a timeout kills the whole
 * group — a bare SIGTERM to `bash` leaves `npm test`'s grandchildren running
 * (competing with the next item, outliving the helper).
 */
export function defaultExec(
  argv: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts?.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // group already gone
      }
    };
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup("SIGTERM");
          hardKill = setTimeout(() => killGroup("SIGKILL"), 2000);
        }, opts.timeoutMs)
      : undefined;
    const done = (r: ExecResult) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      resolve(r);
    };
    child.on("error", (e) =>
      done({ stdout, stderr: stderr + String(e), exitCode: 127 }),
    );
    child.on("close", (code) =>
      done({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
      }),
    );
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tail(output: string): string {
  const lines = output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  return lines.length > TAIL_CHARS ? lines.slice(-TAIL_CHARS) : lines;
}

function firstCommand(text: string): string {
  return /`([^`]+)`/.exec(text)?.[1] ?? "";
}

/**
 * Tick/annotate the item at 1-based `index`. `ParsedStep.text` is
 * comment-stripped, so the regex is built from the ESCAPED RAW body line;
 * earlier identical lines are masked so a duplicate is never hit twice.
 */
function applyResult(
  body: string,
  index: number,
  bodyFile: string,
  output: string,
  exitCode: number,
): string {
  const step = parseTestSteps(body).steps[index - 1];
  if (!step || step.line <= 0) {
    throw new Error(`test step ${index} not locatable in the PR body`);
  }
  const lines = body.split("\n");
  const raw = lines[step.line - 1];
  for (let j = 0; j < step.line - 1; j++) {
    if (lines[j] === raw) lines[j] = MARK + lines[j];
  }
  const res = rewriteBody(
    lines.join("\n"),
    { bodyFile, item: `^${escapeRegExp(raw)}$`, exitCode },
    output,
  );
  if (!res.ok) throw new Error(res.error);
  return res.body
    .split("\n")
    .map((l) => (l.startsWith(MARK) ? l.slice(MARK.length) : l))
    .join("\n");
}

export async function runTestSteps(opts: {
  pr: number;
  worktree: string;
  only?: number[];
  budgetSec: number;
  /** Start from this local body (the one the supervisor read and may have
   * edited) when it exists; GitHub's body is the fallback. */
  bodyFile?: string;
  allowCrossRepo?: boolean;
  exec: ExecFn;
  now?: () => number;
}): Promise<RunEnvelope> {
  const { exec } = opts;
  const now = opts.now ?? Date.now;
  const dir = path.join(opts.worktree, ".flow-tmp");
  const bodyFile = path.join(dir, "body.md");
  fs.mkdirSync(dir, { recursive: true });

  const view = await exec(
    ["gh", "pr", "view", String(opts.pr), "--json", "body,isCrossRepository"],
    { cwd: opts.worktree },
  );
  if (view.exitCode !== 0) {
    throw new Error(`gh pr view failed: ${view.stderr.trim()}`);
  }
  let original: string;
  let crossRepo: boolean;
  try {
    const parsed = JSON.parse(view.stdout) as {
      body?: unknown;
      isCrossRepository?: unknown;
    };
    if (typeof parsed.body !== "string") throw new Error("no string `body`");
    original = parsed.body;
    crossRepo = parsed.isCrossRepository === true;
  } catch (e) {
    throw new Error(
      `gh pr view returned unparseable JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (opts.bodyFile && fs.existsSync(opts.bodyFile)) {
    original = fs.readFileSync(opts.bodyFile, "utf8");
  }
  fs.writeFileSync(bodyFile, original);

  const steps = parseTestSteps(original).steps.map((s, i) => ({
    ...s,
    index: i + 1,
  }));
  const unchecked = steps.filter((s) => !s.checked);
  const only = opts.only ? new Set(opts.only) : null;
  const candidates = unchecked.filter(
    (s) => s.kind === "command" && (!only || only.has(s.index)),
  );
  const envelope: RunEnvelope = {
    total: candidates.length,
    uncheckedTotal: unchecked.length,
    ran: 0,
    passed: 0,
    failed: [],
    pending: [],
    notRunnable: unchecked
      .filter((s) => s.kind !== "command")
      .map((s) => ({ index: s.index, kind: s.kind, text: s.text })),
    bodyPushed: false,
    pushSkippedReason: null,
  };

  if (crossRepo && !opts.allowCrossRepo) {
    for (const s of candidates) {
      envelope.pending.push({ index: s.index, command: firstCommand(s.text) });
    }
    envelope.pushSkippedReason = "cross-repository-pr";
    return envelope;
  }

  const start = now();
  const single = candidates.length === 1;
  let body = original;
  for (const step of candidates) {
    const command = firstCommand(step.text);
    const remainingSec = opts.budgetSec - (now() - start) / 1000;
    if (remainingSec <= 0) {
      envelope.pending.push({ index: step.index, command });
      continue;
    }
    const itemSec = single
      ? remainingSec
      : Math.min(ITEM_TIMEOUT_SEC, remainingSec);
    const run = await exec(["bash", "-c", command], {
      cwd: opts.worktree,
      timeoutMs: itemSec * 1000,
    });
    // Cut by the shared budget, not the item's own cap: not a test failure.
    if (run.timedOut && !single && itemSec < ITEM_TIMEOUT_SEC) {
      envelope.pending.push({ index: step.index, command });
      continue;
    }
    const output = run.stdout + run.stderr;
    fs.writeFileSync(path.join(dir, `evidence-${step.index}.txt`), output);
    fs.writeFileSync(path.join(dir, `exit-${step.index}`), `${run.exitCode}\n`);
    body = applyResult(body, step.index, bodyFile, output, run.exitCode);
    envelope.ran++;
    if (run.exitCode === 0) envelope.passed++;
    else {
      envelope.failed.push({
        index: step.index,
        command,
        exitCode: run.exitCode,
        tail: tail(output),
      });
    }
  }

  if (envelope.ran === 0) {
    envelope.pushSkippedReason = "no-items-ran";
    return envelope;
  }

  fs.writeFileSync(bodyFile, body);
  // `--fix-pr-body` always exits 0 (repair); `--check-pr-body` is the gate.
  await exec(["flow-md-validate", "--fix-pr-body", bodyFile], {
    cwd: opts.worktree,
  });
  const check = await exec(["flow-md-validate", "--check-pr-body", bodyFile], {
    cwd: opts.worktree,
  });
  if (check.exitCode !== 0) {
    fs.writeFileSync(bodyFile, original);
    envelope.pushSkippedReason = "md-validate-failed";
    return envelope;
  }
  if (hasLocalImageRefs(fs.readFileSync(bodyFile, "utf8"))) {
    envelope.pushSkippedReason = "local-image-refs-deferred-to-finalize";
    return envelope;
  }
  const edit = await exec(
    ["gh", "pr", "edit", String(opts.pr), "--body-file", bodyFile],
    { cwd: opts.worktree },
  );
  if (edit.exitCode !== 0) {
    throw new Error(`gh pr edit failed: ${edit.stderr.trim()}`);
  }
  envelope.bodyPushed = true;
  return envelope;
}
