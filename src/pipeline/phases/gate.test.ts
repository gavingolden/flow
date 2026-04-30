import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { runGatePhase } from "./gate.js";
import {
  __setNotifierForTests,
  readTask,
  writeTask,
  type Task,
} from "../../state/task-file.js";
import { NoopNotifier, type Notifier, type NotifyArgs } from "../../util/notify.js";
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

interface SetupOpts {
  status: TaskStatus;
  pr: number | null;
  worktreeOnDisk?: boolean;
  worktreeNullInFrontmatter?: boolean;
  manualValidation?: boolean | null;
  mergeCommit?: string | null;
}

async function setup(opts: SetupOpts): Promise<{
  tmp: string;
  task: Task;
  worktreePath: string | null;
}> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gate-"));
  let worktreePath: string | null = null;
  if (opts.worktreeNullInFrontmatter) {
    worktreePath = null;
  } else {
    worktreePath = path.join(tmp, "worktree");
    if (opts.worktreeOnDisk !== false) {
      await fs.mkdir(worktreePath, { recursive: true });
    }
  }

  const taskId = "2026-04-30-test-task";
  const tasksDir = path.join(tmp, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });
  const taskPath = path.join(tasksDir, `${taskId}.md`);

  const initial: Task = {
    path: taskPath,
    frontmatter: {
      id: taskId,
      status: opts.status,
      created: "2026-04-30T00:00:00.000Z",
      updated: "2026-04-30T00:00:00.000Z",
      target_repo: tmp,
      worktree: worktreePath,
      branch: "agent/test",
      pr: opts.pr,
      manual_validation: opts.manualValidation ?? null,
      merge_commit: opts.mergeCommit ?? null,
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
  return { tmp, task, worktreePath };
}

interface PrViewResponse {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function mockGhPrView(response: PrViewResponse): void {
  vi.mocked(execa).mockImplementation((async (cmd: string, args: string[]) => {
    if (cmd !== "gh" || args[0] !== "pr" || args[1] !== "view") {
      throw new Error(`unexpected execa: ${cmd} ${JSON.stringify(args)}`);
    }
    return {
      exitCode: response.exitCode ?? 0,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    };
  }) as never);
}

const PR_BODY_EMPTY = [
  "## Why",
  "",
  "intro",
  "",
  "## Manual validation",
  "",
  "<!-- No manual validation required: pure-internal-logic change. -->",
  "",
  "## How to test",
  "",
  "tests",
].join("\n");

const PR_BODY_NON_EMPTY = [
  "## Why",
  "",
  "intro",
  "",
  "## Manual validation",
  "",
  "1. Run `npm run migrate`",
  "2. Confirm the new column exists",
  "",
  "## How to test",
  "",
  "tests",
].join("\n");

const PR_BODY_MISSING_SECTION = [
  "## Why",
  "",
  "intro",
  "",
  "## How to test",
  "",
  "tests",
].join("\n");

describe("runGatePhase", () => {
  let tmpRoot: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    // Notifier (when active) calls execa("which", ...) under the hood — inject
    // NoopNotifier so the execa-not-called assertions stay deterministic
    // across CI environments that may have FLOW_NOTIFY=1 set.
    __setNotifierForTests(NoopNotifier);
  });

  afterEach(async () => {
    __setNotifierForTests(null);
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  it("pr-missing: routes to needs-human without calling gh", async () => {
    const { tmp, task } = await setup({ status: "reviewing", pr: null });
    tmpRoot = tmp;
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "needs-human", reason: "pr-missing" });
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("needs-human");
    expect(reread.body).toContain("### gate (latest:");
  });

  it("worktree null in frontmatter: routes to needs-human without calling gh", async () => {
    const { tmp, task } = await setup({
      status: "reviewing",
      pr: 184,
      worktreeNullInFrontmatter: true,
    });
    tmpRoot = tmp;
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r.status).toBe("needs-human");
    if (r.status === "needs-human") expect(r.reason).toBe("worktree-missing");
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("needs-human");
  });

  it("worktree directory missing on disk but path set in frontmatter: falls back to target_repo and proceeds to gh", async () => {
    // Story 3 cleanup robustness: a user who manually `rm -rf`'d the
    // worktree directory before resuming a `gated` task whose PR was
    // merged externally must still reach the MERGED branch that
    // captures the SHA and hands off to merge for cleanup. Mirrors the
    // merge.ts:57 fallback contract.
    const { tmp, task } = await setup({
      status: "gated",
      pr: 184,
      worktreeOnDisk: false,
      manualValidation: true,
      mergeCommit: null,
    });
    tmpRoot = tmp;
    const view = vi.mocked(execa).mockImplementation((async (
      cmd: string,
      args: string[],
      opts?: { cwd?: string },
    ) => {
      // The cwd MUST be target_repo (= `tmp`) since the worktree dir is
      // gone. Pin this in the assertion to lock the fallback shape.
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        expect(opts?.cwd).toBe(tmp);
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          body: PR_BODY_NON_EMPTY,
          state: "MERGED",
          mergeCommit: { oid: "user-merged-after-rmdir" },
        }),
        stderr: "",
      };
    }) as never);
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "ok" });
    expect(view).toHaveBeenCalled();
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("merging");
    expect(reread.frontmatter.merge_commit).toBe("user-merged-after-rmdir");
  });

  it("gh non-zero exit: routes to needs-human gh-error with stderr in phase output", async () => {
    const { tmp, task } = await setup({ status: "reviewing", pr: 184 });
    tmpRoot = tmp;
    mockGhPrView({ exitCode: 1, stderr: "auth required" });
    const logger = makeLogger();
    const r = await runGatePhase(task, logger, makeJsonl());
    expect(r).toEqual({ status: "needs-human", reason: "gh-error" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("needs-human");
    expect(reread.body).toContain("auth required");
    expect(logger.errors.some((e) => e.includes("gh pr view"))).toBe(true);
  });

  it("state=MERGED: captures mergeCommit.oid, transitions to merging, returns ok", async () => {
    const { tmp, task } = await setup({
      status: "reviewing",
      pr: 184,
      mergeCommit: null,
    });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_EMPTY,
        state: "MERGED",
        mergeCommit: { oid: "abc123def456" },
      }),
    });
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "ok" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("merging");
    expect(reread.frontmatter.merge_commit).toBe("abc123def456");
    expect(reread.body).toContain("already-merged");
    expect(reread.body).toContain("abc123def456");
  });

  it("state=MERGED with merge_commit already set: keeps existing SHA, transitions to merging", async () => {
    const { tmp, task } = await setup({
      status: "merging",
      pr: 184,
      mergeCommit: "previously-recorded-sha",
    });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_EMPTY,
        state: "MERGED",
        mergeCommit: { oid: "should-not-overwrite" },
      }),
    });
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "ok" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.merge_commit).toBe("previously-recorded-sha");
    expect(reread.frontmatter.status).toBe("merging");
  });

  it("state=CLOSED: routes to needs-human pr-closed-without-merge", async () => {
    const { tmp, task } = await setup({ status: "reviewing", pr: 184 });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_EMPTY,
        state: "CLOSED",
        mergeCommit: null,
      }),
    });
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({
      status: "needs-human",
      reason: "pr-closed-without-merge",
    });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("needs-human");
    expect(reread.body).toContain("CLOSED");
  });

  it("state=OPEN + section empty: sets manual_validation=false, transitions to merging", async () => {
    const { tmp, task } = await setup({ status: "reviewing", pr: 184 });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_EMPTY,
        state: "OPEN",
        mergeCommit: null,
      }),
    });
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "ok" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("merging");
    expect(reread.frontmatter.manual_validation).toBe(false);
    expect(reread.body).toContain("auto-merge");
  });

  it("state=OPEN + section non-empty: sets manual_validation=true, transitions to gated, renders steps verbatim", async () => {
    const { tmp, task } = await setup({ status: "reviewing", pr: 184 });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_NON_EMPTY,
        state: "OPEN",
        mergeCommit: null,
      }),
    });
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({
      status: "needs-human",
      reason: "manual-validation-required",
    });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("gated");
    expect(reread.frontmatter.manual_validation).toBe(true);
    expect(reread.body).toContain("npm run migrate");
    expect(reread.body).toContain("Confirm the new column exists");
  });

  it("state=OPEN + section missing: routes to needs-human manual-validation-section-missing", async () => {
    const { tmp, task } = await setup({ status: "reviewing", pr: 184 });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_MISSING_SECTION,
        state: "OPEN",
        mergeCommit: null,
      }),
    });
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({
      status: "needs-human",
      reason: "manual-validation-section-missing",
    });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("needs-human");
    expect(reread.body).toContain("Manual validation");
  });

  it("re-entering with status=gated and a now-MERGED PR transitions to merging (Story 3)", async () => {
    const { tmp, task } = await setup({
      status: "gated",
      pr: 184,
      manualValidation: true,
      mergeCommit: null,
    });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_NON_EMPTY,
        state: "MERGED",
        mergeCommit: { oid: "user-merged-sha" },
      }),
    });
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "ok" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("merging");
    expect(reread.frontmatter.merge_commit).toBe("user-merged-sha");
  });

  it("re-entering with status=gating proceeds to body parsing without re-transitioning (Story 4)", async () => {
    const { tmp, task } = await setup({ status: "gating", pr: 184 });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_EMPTY,
        state: "OPEN",
        mergeCommit: null,
      }),
    });
    const r = await runGatePhase(task, makeLogger(), makeJsonl());
    expect(r).toEqual({ status: "ok" });
    const reread = await readTask(task.path);
    expect(reread.frontmatter.status).toBe("merging");
  });

  it("re-entering with status=gated and PR still OPEN + non-empty section: stays gated, no extra Phase-log row, notifier not re-fired", async () => {
    // Regression pin for the gated-loop bug. Without the
    // `from === "reviewing" || from === "gating"` guard in gate.ts,
    // re-entering against a settled `gated` task walks
    // `gated → gating → gated`, and because `transitionStatus` only
    // short-circuits on `from === to`, the second transition fires the
    // notifier (gated ∈ NOTIFY_STATUSES). Pin: zero notifier calls on
    // the persistent-gated re-entry, no spurious Phase-log row, and a
    // single ### gate subsection across two consecutive runs.
    const notifyFn = vi.fn<(args: NotifyArgs) => Promise<void>>(
      async () => undefined,
    );
    const notifySyncFn = vi.fn<(args: NotifyArgs) => void>(() => undefined);
    const notifier: Notifier = {
      notify: notifyFn,
      notifySync: notifySyncFn,
    };
    __setNotifierForTests(notifier);

    const { tmp, task } = await setup({
      status: "reviewing",
      pr: 184,
      manualValidation: null,
    });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_NON_EMPTY,
        state: "OPEN",
        mergeCommit: null,
      }),
    });

    // First run drives reviewing → gating → gated. Notifier fires once
    // on the gated transition — that's the user-visible signal.
    await runGatePhase(task, makeLogger(), makeJsonl());
    const afterFirst = await readTask(task.path);
    expect(afterFirst.frontmatter.status).toBe("gated");
    const gatedNotifyCallsAfterFirst = notifyFn.mock.calls.filter(
      (c) => c[0].status === "gated",
    );
    expect(gatedNotifyCallsAfterFirst).toHaveLength(1);

    // Second run with the PR still gated. Must NOT fire the notifier
    // again, must NOT add a `gated → gating` or `gating → gated` row to
    // the Phase log, and must keep the ### gate subsection a singleton.
    const second = await readTask(task.path);
    await runGatePhase(second, makeLogger(), makeJsonl());
    const afterSecond = await readTask(task.path);
    expect(afterSecond.frontmatter.status).toBe("gated");

    const gatedNotifyCallsAfterSecond = notifyFn.mock.calls.filter(
      (c) => c[0].status === "gated",
    );
    // Still exactly one notification — the second pass added none.
    expect(gatedNotifyCallsAfterSecond).toHaveLength(1);

    // No spurious Phase-log row from the second pass. Count
    // `gated → gating` / `gating → gated` transitions; should be
    // exactly one of each (from the first pass), not two.
    const gatedToGating = (afterSecond.body.match(/gated → gating/g) ?? []).length;
    const gatingToGated = (afterSecond.body.match(/gating → gated/g) ?? []).length;
    expect(gatedToGating).toBe(0);
    expect(gatingToGated).toBe(1);

    // Single ### gate subsection (idempotent upsert).
    const matches = afterSecond.body.match(/^### gate \(latest:/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("writes exactly one ### gate subsection across two runs (idempotent upsert)", async () => {
    const { tmp, task } = await setup({ status: "reviewing", pr: 184 });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_EMPTY,
        state: "OPEN",
        mergeCommit: null,
      }),
    });
    await runGatePhase(task, makeLogger(), makeJsonl());

    // Reset to gating to model a mid-flight crash that re-entered the phase.
    const between = await readTask(task.path);
    between.frontmatter.status = "gating";
    await writeTask(between);

    const second = await readTask(task.path);
    await runGatePhase(second, makeLogger(), makeJsonl());

    const reread = await readTask(task.path);
    const matches = reread.body.match(/^### gate \(latest:/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("emits gate.start, gate.gh.pr-view, gate.decision, gate.exit jsonl events", async () => {
    const { tmp, task } = await setup({ status: "reviewing", pr: 184 });
    tmpRoot = tmp;
    mockGhPrView({
      stdout: JSON.stringify({
        body: PR_BODY_EMPTY,
        state: "OPEN",
        mergeCommit: null,
      }),
    });
    const jsonl = makeJsonl();
    await runGatePhase(task, makeLogger(), jsonl);
    const events = jsonl.event.mock.calls.map((c) => c[0] as string);
    expect(events).toContain("gate.start");
    expect(events).toContain("gate.gh.pr-view");
    expect(events).toContain("gate.decision");
    expect(events).toContain("gate.exit");
  });
});
