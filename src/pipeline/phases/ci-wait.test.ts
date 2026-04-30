import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCiWaitPhase } from "./ci-wait.js";
import { readTask, writeTask, type Task } from "../../state/task-file.js";
import { TaskStatus } from "../../state/phases.js";
import { NoopLogger, type Logger } from "../../util/logger.js";
import type { JsonlSink } from "../../util/jsonl-sink.js";

interface FakeJsonl {
  event: ReturnType<typeof vi.fn>;
  pipeFrom: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  filePath: string;
}

function makeJsonl(): FakeJsonl & JsonlSink {
  return {
    filePath: "/tmp/fake-jsonl",
    event: vi.fn(),
    pipeFrom: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

interface SilentLogger extends Logger {
  warns: string[];
  errors: string[];
}

function makeLogger(): SilentLogger {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    ...NoopLogger,
    warn(msg: string) {
      warns.push(msg);
    },
    error(msg: string) {
      errors.push(msg);
    },
    warns,
    errors,
  };
}

// Build a shell script that emits the given stderr lines (one per element)
// and a single-line stdout payload from a sibling file. Writing the payload
// to a file sidesteps shell quoting/escape issues with embedded newlines.
async function writeFixtureScript(
  worktree: string,
  stderrLines: string[],
  stdoutPayload: string | null,
  exitCode: number,
): Promise<void> {
  const scriptsDir = path.join(worktree, "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  const stdoutFile = path.join(scriptsDir, "ci-wait.stdout.json");
  if (stdoutPayload != null) {
    await fs.writeFile(stdoutFile, stdoutPayload, "utf8");
  }
  const lines = ["#!/bin/sh"];
  for (const line of stderrLines) {
    // Embed each stderr line via a quoted heredoc so backslash escapes in
    // the JSON payload (e.g. `\n` inside string literals) survive verbatim.
    lines.push(`cat 1>&2 <<'__SE__'\n${line}\n__SE__`);
  }
  if (stdoutPayload != null) {
    lines.push(`cat '${stdoutFile}'`);
  }
  lines.push(`exit ${exitCode}`);
  const scriptPath = path.join(scriptsDir, "ci-wait.ts");
  await fs.writeFile(scriptPath, lines.join("\n") + "\n", "utf8");
  await fs.chmod(scriptPath, 0o755);
}

async function setupRepo(opts: {
  status: TaskStatus;
  pr: number | null;
  withWorktree?: boolean;
  fixture?: {
    stderrLines?: string[];
    stdoutPayload?: string | null;
    exitCode?: number;
  };
}): Promise<{ tmp: string; task: Task; worktree: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-ci-wait-"));
  const worktree = path.join(tmp, "worktree");
  if (opts.withWorktree !== false) {
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    if (opts.fixture) {
      await writeFixtureScript(
        worktree,
        opts.fixture.stderrLines ?? [],
        opts.fixture.stdoutPayload ?? null,
        opts.fixture.exitCode ?? 0,
      );
    }
  }

  const taskId = "2026-04-29-test-task";
  const taskDir = path.join(tmp, ".orchestrator", "tasks", taskId);
  await fs.mkdir(taskDir, { recursive: true });
  const taskPath = path.join(tmp, ".orchestrator", "tasks", `${taskId}.md`);

  const initial: Task = {
    path: taskPath,
    frontmatter: {
      id: taskId,
      status: opts.status,
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
      target_repo: tmp,
      worktree: opts.withWorktree === false ? null : worktree,
      branch: "agent/test",
      pr: opts.pr,
      manual_validation: null,
      merge_commit: null,
    },
    body: [
      "## User prompt",
      "",
      "test",
      "",
      "## Phase log",
      "",
      "## Phase outputs",
      "",
    ].join("\n"),
  };
  await writeTask(initial);
  const task = await readTask(taskPath);
  return { tmp, task, worktree };
}

describe("runCiWaitPhase", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  it("fails fast with pr-missing when task.frontmatter.pr is null (no script call)", async () => {
    const { tmp, task } = await setupRepo({
      status: "pr-open",
      pr: null,
      fixture: {
        stderrLines: ["should-not-run"],
        stdoutPayload: '{"outcome":"ok"}',
        exitCode: 99,
      },
    });
    tmpRoot = tmp;
    const logger = makeLogger();
    const jsonl = makeJsonl();

    const start = Date.now();
    const result = await runCiWaitPhase(task, logger, jsonl);
    const elapsed = Date.now() - start;

    expect(result).toEqual({ status: "needs-human", reason: "pr-missing" });
    expect(elapsed).toBeLessThan(1000);

    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("needs-human");
    // The script must not have been invoked — its stderr would have been
    // forwarded to the jsonl sink.
    expect(jsonl.event).not.toHaveBeenCalled();
  });

  it("fails with `failed` when worktree is missing on disk", async () => {
    const { tmp, task } = await setupRepo({
      status: "pr-open",
      pr: 184,
      withWorktree: false,
    });
    tmpRoot = tmp;
    const result = await runCiWaitPhase(task, makeLogger(), makeJsonl());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("worktree");
    }
  });

  it("fails with a deterministic diagnostic when scripts/ci-wait.ts is missing", async () => {
    // Mirrors verify-gate's preflight contract: a partial `flow install`
    // (or a directory at the symlink path) should produce a phase-level
    // "missing or not executable" error rather than a platform-dependent
    // execa spawn failure.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-ci-wait-"));
    tmpRoot = tmp;
    const worktree = path.join(tmp, "worktree");
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    // No ci-wait.ts in scripts/ on purpose.

    const taskId = "2026-04-29-test-task";
    const taskDir = path.join(tmp, ".orchestrator", "tasks", taskId);
    await fs.mkdir(taskDir, { recursive: true });
    const taskPath = path.join(tmp, ".orchestrator", "tasks", `${taskId}.md`);
    const initial: Task = {
      path: taskPath,
      frontmatter: {
        id: taskId,
        status: "pr-open",
        created: "2026-04-29T00:00:00.000Z",
        updated: "2026-04-29T00:00:00.000Z",
        target_repo: tmp,
        worktree,
        branch: "agent/test",
        pr: 184,
        manual_validation: null,
        merge_commit: null,
      },
      body: ["## Phase log", "", "## Phase outputs", ""].join("\n"),
    };
    await writeTask(initial);
    const task = await readTask(taskPath);

    const result = await runCiWaitPhase(task, makeLogger(), makeJsonl());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("missing or not executable");
      expect(result.reason).toContain("ci-wait.ts");
    }
    // Status should not have transitioned to `ci` — preflight fails before
    // the transition, leaving the next `flow run` free to retry from
    // `pr-open` once `flow install` has been run.
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("pr-open");
  });

  it("happy path: outcome ok → status flips pr-open → ci → reviewing, ci section written", async () => {
    const sectionMd = "| bot | state | submitted_at |\n|---|---|---|\n| Copilot | COMMENTED | 2026-04-29T22:35:00Z |";
    const stdoutPayload = JSON.stringify({
      outcome: "ok",
      polls: 3,
      durMs: 90000,
      section: sectionMd,
      missingBots: [],
      pendingChecks: [],
    });

    const { tmp, task } = await setupRepo({
      status: "pr-open",
      pr: 184,
      fixture: {
        stderrLines: [
          '{"event":"ci-wait.start","pr":184}',
          '{"event":"ci-wait.exit","outcome":"ok"}',
        ],
        stdoutPayload,
        exitCode: 0,
      },
    });
    tmpRoot = tmp;
    const jsonl = makeJsonl();
    const result = await runCiWaitPhase(task, makeLogger(), jsonl);

    expect(result).toEqual({ status: "ok" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("reviewing");
    expect(reread.body).toContain("### ci (latest:");
    expect(reread.body).toContain("| Copilot | COMMENTED | 2026-04-29T22:35:00Z |");
    // Both stderr events should have been forwarded.
    expect(jsonl.event).toHaveBeenCalledWith("ci-wait.start", { pr: 184 });
    expect(jsonl.event).toHaveBeenCalledWith("ci-wait.exit", { outcome: "ok" });
  });

  it("ci-hang: status flips to needs-human with note ci-hang, partial section written", async () => {
    const sectionMd = "**Checks still pending at hard cap:** lint\n\n| bot | state | submitted_at |\n|---|---|---|";
    const stdoutPayload = JSON.stringify({
      outcome: "ci-hang",
      pendingChecks: ["lint"],
      section: sectionMd,
      missingBots: [],
    });

    const { tmp, task } = await setupRepo({
      status: "pr-open",
      pr: 184,
      fixture: { stdoutPayload, exitCode: 1 },
    });
    tmpRoot = tmp;
    const result = await runCiWaitPhase(task, makeLogger(), makeJsonl());

    expect(result).toEqual({ status: "needs-human", reason: "ci-hang" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("needs-human");
    expect(reread.body).toContain("**Checks still pending at hard cap:** lint");
    // Phase log should record the transition with the ci-hang note.
    expect(reread.body).toContain("ci-hang");
  });

  it("config-invalid: status flips to needs-human with note config-invalid, no ci section written", async () => {
    const stdoutPayload = JSON.stringify({
      outcome: "config-invalid",
      reason: "cadenceMs must be positive",
    });

    const { tmp, task } = await setupRepo({
      status: "pr-open",
      pr: 184,
      fixture: { stdoutPayload, exitCode: 1 },
    });
    tmpRoot = tmp;
    const result = await runCiWaitPhase(task, makeLogger(), makeJsonl());

    expect(result).toEqual({ status: "needs-human", reason: "config-invalid" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("needs-human");
    expect(reread.body).not.toContain("### ci (latest:");
    expect(reread.body).toContain("config-invalid");
  });

  it("gh-permanent: status flips to needs-human with note gh-permanent, no ci section written", async () => {
    // Permanent gh CLI errors (e.g. "Unknown JSON field") must short-circuit
    // to needs-human instead of riding the loop to hard cap. Mirror of the
    // config-invalid branch — no review/check data, but distinct reason
    // so the user can debug the gh invocation.
    const stdoutPayload = JSON.stringify({
      outcome: "gh-permanent",
      reason: "gh pr checks: Unknown JSON field: \"conclusion\"",
    });

    const { tmp, task } = await setupRepo({
      status: "pr-open",
      pr: 184,
      fixture: { stdoutPayload, exitCode: 1 },
    });
    tmpRoot = tmp;
    const result = await runCiWaitPhase(task, makeLogger(), makeJsonl());

    expect(result).toEqual({ status: "needs-human", reason: "gh-permanent" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("needs-human");
    expect(reread.body).not.toContain("### ci (latest:");
    expect(reread.body).toContain("gh-permanent");
  });

  it("resume idempotency: running twice on a happy-path script writes one ### ci subsection", async () => {
    const sectionMd = "| bot | state | submitted_at |\n|---|---|---|\n| Copilot | COMMENTED | 2026-04-29T22:35:00Z |";
    const stdoutPayload = JSON.stringify({
      outcome: "ok",
      section: sectionMd,
      missingBots: [],
      pendingChecks: [],
    });

    const { tmp, task } = await setupRepo({
      status: "ci",
      pr: 184,
      fixture: { stdoutPayload, exitCode: 0 },
    });
    tmpRoot = tmp;

    await runCiWaitPhase(task, makeLogger(), makeJsonl());
    // Reset task status so the wrapper transitions through `ci` again on the
    // second run — exactly the resume-from-mid-flight crash scenario.
    const between = await readTask(task.path);
    between.frontmatter.status = "ci";
    await writeTask(between);

    const second = await readTask(task.path);
    const result = await runCiWaitPhase(second, makeLogger(), makeJsonl());

    expect(result.status).toBe("ok");
    const reread = await readTask(task.path);
    const matches = reread.body.match(/^### ci \(latest:/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(reread.frontmatter.status).toBe("reviewing");
  });

  it("forwards stderr JSON events to jsonl.event and routes non-JSON lines to logger.warn", async () => {
    const stdoutPayload = JSON.stringify({
      outcome: "ok",
      section: "section-md",
      missingBots: [],
      pendingChecks: [],
    });

    const { tmp, task } = await setupRepo({
      status: "pr-open",
      pr: 184,
      fixture: {
        stderrLines: [
          '{"event":"ci-wait.poll","polls":1,"elapsedMs":100}',
          "this-is-not-json-just-text",
        ],
        stdoutPayload,
        exitCode: 0,
      },
    });
    tmpRoot = tmp;
    const logger = makeLogger();
    const jsonl = makeJsonl();
    await runCiWaitPhase(task, logger, jsonl);

    expect(jsonl.event).toHaveBeenCalledWith("ci-wait.poll", { polls: 1, elapsedMs: 100 });
    const warnedAboutNonJson = logger.warns.some((w) => w.includes("this-is-not-json-just-text"));
    expect(warnedAboutNonJson).toBe(true);
  });

  it("preserves the script-emitted `ts` field when forwarding stderr events", async () => {
    // JsonlSink is payload-takes-precedence: when the wrapper passes a `ts`
    // field through, the recorded event reflects the script's poll-time
    // rather than the wrapper's read-time. This pins that contract so a
    // future "strip ts" regression is caught at unit-test time.
    const stdoutPayload = JSON.stringify({
      outcome: "ok",
      section: "section-md",
      missingBots: [],
      pendingChecks: [],
    });
    const { tmp, task } = await setupRepo({
      status: "pr-open",
      pr: 184,
      fixture: {
        stderrLines: [
          '{"ts":"2026-04-29T12:34:56.000Z","event":"ci-wait.poll","polls":1}',
        ],
        stdoutPayload,
        exitCode: 0,
      },
    });
    tmpRoot = tmp;
    const jsonl = makeJsonl();
    await runCiWaitPhase(task, makeLogger(), jsonl);
    expect(jsonl.event).toHaveBeenCalledWith("ci-wait.poll", {
      ts: "2026-04-29T12:34:56.000Z",
      polls: 1,
    });
  });

  it("returns failed when the script's stdout is unparseable", async () => {
    const { tmp, task } = await setupRepo({
      status: "pr-open",
      pr: 184,
      fixture: { stdoutPayload: "this is not json", exitCode: 0 },
    });
    tmpRoot = tmp;
    const result = await runCiWaitPhase(task, makeLogger(), makeJsonl());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("unparseable");
    }
  });
});
