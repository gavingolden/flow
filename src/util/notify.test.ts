import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildPayload,
  createNotifier,
  escapeForAppleScript,
  NoopNotifier,
  NOTIFY_STATUSES,
  type Notifier,
  type NotifyArgs,
  type NotifyDeps,
} from "./notify.js";
import type { TaskStatus } from "../state/phases.js";
import type { Task } from "../state/task-file.js";

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

interface Harness {
  notifier: Notifier;
  spawnCalls: SpawnCall[];
  unrefMock: ReturnType<typeof vi.fn>;
  onMock: ReturnType<typeof vi.fn>;
  whichMock: ReturnType<typeof vi.fn>;
  ghRepoViewMock: ReturnType<typeof vi.fn>;
}

function makeTask(overrides: Partial<Task["frontmatter"]> = {}, body = ""): Task {
  return {
    path: "/tmp/task.md",
    frontmatter: {
      id: "2026-04-29-x",
      status: "needs-human",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
      target_repo: "/repo",
      worktree: null,
      branch: null,
      pr: null,
      manual_validation: null,
      merge_commit: null,
      ...overrides,
    },
    body,
  };
}

function makeHarness(opts: {
  whichResult?: string | null;
  ghRepoViewResult?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnImpl?: NotifyDeps["spawn"];
  childFactory?: () => ChildProcess;
} = {}): Harness {
  const spawnCalls: SpawnCall[] = [];
  const unrefMock = vi.fn();
  const onMock = vi.fn();
  const defaultChildFactory = (): ChildProcess =>
    ({ unref: unrefMock, on: onMock }) as unknown as ChildProcess;
  const childFactory = opts.childFactory ?? defaultChildFactory;
  const defaultSpawn: NotifyDeps["spawn"] = (cmd, args, options) => {
    spawnCalls.push({ command: cmd, args, options });
    return childFactory();
  };
  const whichMock = vi.fn(async () => opts.whichResult ?? null);
  const ghRepoViewMock = vi.fn(async () => opts.ghRepoViewResult ?? null);
  const notifier = createNotifier({
    platform: opts.platform ?? "darwin",
    env: opts.env ?? { FLOW_NOTIFY: "1" },
    spawn: opts.spawnImpl ?? defaultSpawn,
    which: whichMock,
    ghRepoView: ghRepoViewMock,
  });
  return {
    notifier,
    spawnCalls,
    unrefMock,
    onMock,
    whichMock,
    ghRepoViewMock,
  };
}

describe("createNotifier — gating", () => {
  it("non-darwin returns NoopNotifier", () => {
    const n = createNotifier({
      platform: "linux",
      env: { FLOW_NOTIFY: "1" },
    });
    expect(n).toBe(NoopNotifier);
  });

  it("env unset returns NoopNotifier", () => {
    const n = createNotifier({
      platform: "darwin",
      env: {},
    });
    expect(n).toBe(NoopNotifier);
  });

  it("env=\"0\" returns NoopNotifier", () => {
    const n = createNotifier({
      platform: "darwin",
      env: { FLOW_NOTIFY: "0" },
    });
    expect(n).toBe(NoopNotifier);
  });

  it("env=\"true\" returns NoopNotifier (only literal '1' enables)", () => {
    const n = createNotifier({
      platform: "darwin",
      env: { FLOW_NOTIFY: "true" },
    });
    expect(n).toBe(NoopNotifier);
  });

  it("darwin + FLOW_NOTIFY=1 returns active notifier", async () => {
    const { notifier, spawnCalls } = makeHarness();
    await notifier.notify({
      task: makeTask(),
      status: "needs-human",
      reason: "verify-exhausted",
    });
    expect(notifier).not.toBe(NoopNotifier);
    expect(spawnCalls).toHaveLength(1);
  });
});

describe("ActiveNotifier — status filtering", () => {
  it("does not spawn for routine statuses", async () => {
    const { notifier, spawnCalls } = makeHarness();
    await notifier.notify({
      task: makeTask({ status: "planning" }),
      status: "planning",
      reason: "moving along",
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it.each<TaskStatus>([
    "needs-human",
    "gated",
    "merged",
    "aborted",
    "plan-pending-review",
  ])(
    "fires for attention status %s",
    async (status) => {
      const { notifier, spawnCalls } = makeHarness();
      await notifier.notify({
        task: makeTask({ status }),
        status,
        reason: "r",
      });
      expect(spawnCalls).toHaveLength(1);
    },
  );

  it("NOTIFY_STATUSES contains exactly the attention literals", () => {
    const expected: TaskStatus[] = [
      "needs-human",
      "gated",
      "merged",
      "aborted",
      "plan-pending-review",
    ];
    for (const s of expected) expect(NOTIFY_STATUSES.has(s)).toBe(true);
    expect(NOTIFY_STATUSES.size).toBe(expected.length);
  });

  it("plan-pending-review payload renders the resume affordance", () => {
    const payload = buildPayload(
      {
        task: makeTask({ id: "task-y", status: "plan-pending-review" }),
        status: "plan-pending-review",
        reason: "intent: feature",
      },
      "",
    );
    expect(payload.title).toBe("flow: plan-pending-review");
    expect(payload.subtitle).toBe("task-y");
    expect(payload.message).toBe(
      "plan ready — /flow-approve task-y or /flow-revise task-y",
    );
  });
});

describe("ActiveNotifier — backend selection", () => {
  it("uses terminal-notifier when on PATH", async () => {
    const { notifier, spawnCalls } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
    });
    await notifier.notify({
      task: makeTask(),
      status: "needs-human",
      reason: "r",
    });
    expect(spawnCalls[0]?.command).toBe("terminal-notifier");
  });

  it("falls back to osascript when which returns null", async () => {
    const { notifier, spawnCalls } = makeHarness({ whichResult: null });
    await notifier.notify({
      task: makeTask(),
      status: "needs-human",
      reason: "r",
    });
    expect(spawnCalls[0]?.command).toBe("osascript");
    expect(spawnCalls[0]?.args[0]).toBe("-e");
  });

  it("caches backend lookup across notify calls", async () => {
    const { notifier, whichMock } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
    });
    const args: NotifyArgs = {
      task: makeTask(),
      status: "needs-human",
      reason: "r",
    };
    await notifier.notify(args);
    await notifier.notify(args);
    expect(whichMock).toHaveBeenCalledTimes(1);
  });
});

describe("ActiveNotifier — payload", () => {
  it("terminal-notifier argv carries title/subtitle/message", async () => {
    const { notifier, spawnCalls } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
    });
    await notifier.notify({
      task: makeTask({ id: "task-x" }),
      status: "needs-human",
      reason: "verify-exhausted",
    });
    const argv = spawnCalls[0]?.args ?? [];
    expect(argv).toEqual([
      "-title",
      "flow: needs-human",
      "-subtitle",
      "task-x",
      "-message",
      "verify-exhausted",
    ]);
  });

  it("falls back to first user prompt line when reason is missing", () => {
    const body = [
      "## User prompt",
      "",
      "Fix the bug",
      "",
      "## Phase log",
      "",
    ].join("\n");
    const payload = buildPayload(
      { task: makeTask({}, body), status: "needs-human" },
      body,
    );
    expect(payload.message).toBe("Fix the bug");
  });

  it("falls back to '(no reason)' when neither reason nor user prompt is available", () => {
    const payload = buildPayload(
      { task: makeTask({}, ""), status: "needs-human" },
      "",
    );
    expect(payload.message).toBe("(no reason)");
  });

  it("truncates a 200-char reason to 120 chars + ellipsis", () => {
    const reason = "a".repeat(200);
    const payload = buildPayload(
      { task: makeTask(), status: "needs-human", reason },
      "",
    );
    // 120 chars + the ellipsis character
    expect(payload.message).toBe(`${"a".repeat(120)}…`);
    expect([...payload.message].length).toBe(121);
  });

  it("collapses multi-line reasons to a single line", () => {
    const payload = buildPayload(
      {
        task: makeTask(),
        status: "needs-human",
        reason: "line1\nline2",
      },
      "",
    );
    expect(payload.message).toBe("line1 line2");
  });
});

describe("ActiveNotifier — click URL", () => {
  it("omits -open when pr is null (terminal-notifier backend)", async () => {
    const { notifier, spawnCalls, ghRepoViewMock } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
      ghRepoViewResult: "owner/repo",
    });
    await notifier.notify({
      task: makeTask({ pr: null }),
      status: "needs-human",
      reason: "r",
    });
    expect(spawnCalls[0]?.args).not.toContain("-open");
    expect(ghRepoViewMock).not.toHaveBeenCalled();
  });

  it("appends -open <url> when pr is set and ghRepoView resolves", async () => {
    const { notifier, spawnCalls } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
      ghRepoViewResult: "gavingolden/flow",
    });
    await notifier.notify({
      task: makeTask({ pr: 184 }),
      status: "needs-human",
      reason: "r",
    });
    const argv = spawnCalls[0]?.args ?? [];
    expect(argv).toContain("-open");
    expect(argv[argv.length - 1]).toBe("https://github.com/gavingolden/flow/pull/184");
  });

  it("omits -open when ghRepoView returns null", async () => {
    const { notifier, spawnCalls } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
      ghRepoViewResult: null,
    });
    await notifier.notify({
      task: makeTask({ pr: 184 }),
      status: "needs-human",
      reason: "r",
    });
    expect(spawnCalls[0]?.args).not.toContain("-open");
  });

  it("caches ghRepoView per target_repo", async () => {
    const { notifier, ghRepoViewMock } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
      ghRepoViewResult: "gavingolden/flow",
    });
    await notifier.notify({
      task: makeTask({ pr: 1 }),
      status: "needs-human",
      reason: "r",
    });
    await notifier.notify({
      task: makeTask({ pr: 2 }),
      status: "needs-human",
      reason: "r",
    });
    expect(ghRepoViewMock).toHaveBeenCalledTimes(1);
  });

  it("osascript backend never receives -open even with a PR url", async () => {
    const { notifier, spawnCalls } = makeHarness({
      whichResult: null,
      ghRepoViewResult: "gavingolden/flow",
    });
    await notifier.notify({
      task: makeTask({ pr: 7 }),
      status: "needs-human",
      reason: "r",
    });
    expect(spawnCalls[0]?.args).not.toContain("-open");
  });

  it("osascript backend skips the gh repo view round-trip entirely", async () => {
    // Regression for the wasted-work issue: previously the URL was
    // resolved before the backend, so every osascript notification paid
    // a `gh` call whose result was thrown away.
    const { notifier, ghRepoViewMock } = makeHarness({
      whichResult: null,
      ghRepoViewResult: "gavingolden/flow",
    });
    await notifier.notify({
      task: makeTask({ pr: 7 }),
      status: "needs-human",
      reason: "r",
    });
    expect(ghRepoViewMock).not.toHaveBeenCalled();
  });
});

describe("escapeForAppleScript", () => {
  it("escapes backslash and double-quote and collapses newlines", () => {
    const out = escapeForAppleScript('a\\b"c\nd');
    expect(out).toBe('a\\\\b\\"c d');
  });

  it("escapes backslash before quote (order matters)", () => {
    // Input: bare quote. Output: backslash + quote.
    expect(escapeForAppleScript('"')).toBe('\\"');
  });

  it("collapses CRLF runs to a single space", () => {
    expect(escapeForAppleScript("a\r\nb\nc")).toBe("a b c");
  });
});

describe("ActiveNotifier — osascript invocation", () => {
  it("argv is exactly ['-e', '<script>'] with all fields escaped", async () => {
    const { notifier, spawnCalls } = makeHarness({ whichResult: null });
    await notifier.notify({
      task: makeTask({ id: 'has"quote' }),
      status: "needs-human",
      reason: 'msg "quote" \\back\nlinetwo',
    });
    const argv = spawnCalls[0]?.args ?? [];
    expect(argv).toHaveLength(2);
    expect(argv[0]).toBe("-e");
    const script = argv[1] ?? "";
    expect(script).toContain('display notification "msg \\"quote\\" \\\\back linetwo"');
    expect(script).toContain('with title "flow: needs-human"');
    expect(script).toContain('subtitle "has\\"quote"');
  });
});

describe("ActiveNotifier — fire-and-forget mechanics", () => {
  it("spawns with detached: true and stdio: 'ignore'", async () => {
    const { notifier, spawnCalls } = makeHarness();
    await notifier.notify({
      task: makeTask(),
      status: "needs-human",
      reason: "r",
    });
    const opts = spawnCalls[0]?.options ?? {};
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
  });

  it("calls unref() on the returned ChildProcess", async () => {
    const { notifier, unrefMock } = makeHarness();
    await notifier.notify({
      task: makeTask(),
      status: "needs-human",
      reason: "r",
    });
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it("propagates synchronous spawn throws (transitionStatus boundary catches them)", async () => {
    const throwingSpawn: NotifyDeps["spawn"] = () => {
      throw new Error("ENOENT");
    };
    const { notifier } = makeHarness({ spawnImpl: throwingSpawn });
    await expect(
      notifier.notify({
        task: makeTask(),
        status: "needs-human",
        reason: "r",
      }),
    ).rejects.toThrow("ENOENT");
  });

  it("registers a no-op 'error' listener on the spawned child", async () => {
    // Regression: without this listener, an async spawn failure (binary
    // missing on PATH after the which cache was warmed, sandbox EPERM,
    // fork failure) emits 'error' on the child and propagates as
    // uncaughtException, crashing the orchestrator.
    const { notifier, onMock } = makeHarness();
    await notifier.notify({
      task: makeTask(),
      status: "needs-human",
      reason: "r",
    });
    expect(onMock).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("the registered 'error' handler swallows the event without throwing", async () => {
    const handlers: Array<(...a: unknown[]) => void> = [];
    const onMock = vi.fn((event: string, fn: (...a: unknown[]) => void) => {
      if (event === "error") handlers.push(fn);
    });
    const childFactory = (): ChildProcess =>
      ({ unref: vi.fn(), on: onMock }) as unknown as ChildProcess;
    const { notifier } = makeHarness({ childFactory });
    await notifier.notify({
      task: makeTask(),
      status: "needs-human",
      reason: "r",
    });
    expect(handlers).toHaveLength(1);
    expect(() => handlers[0]?.(new Error("ENOENT-async"))).not.toThrow();
  });
});

describe("ActiveNotifier — notifySync (exit-handler path)", () => {
  it("reaches spawn synchronously without yielding", () => {
    // Regression for the exit-handler bug: an async notify with awaits
    // before spawn would never reach spawn from inside Node's 'exit'
    // event because the event loop is already torn down. notifySync
    // must reach spawn within the synchronous call.
    const { notifier, spawnCalls } = makeHarness();
    notifier.notifySync({
      task: makeTask(),
      status: "needs-human",
      reason: "from-reaper",
    });
    expect(spawnCalls).toHaveLength(1);
  });

  it("uses osascript by default (no which lookup)", () => {
    const { notifier, spawnCalls, whichMock } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
    });
    notifier.notifySync({
      task: makeTask(),
      status: "needs-human",
      reason: "r",
    });
    // which is async — calling it from notifySync would yield, so
    // notifySync must NOT call it. Default backend is osascript.
    expect(whichMock).not.toHaveBeenCalled();
    expect(spawnCalls[0]?.command).toBe("osascript");
  });

  it("reuses a backend cached by an earlier async notify call", async () => {
    const { notifier, spawnCalls } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
    });
    // Warm the cache via the async path.
    await notifier.notify({
      task: makeTask(),
      status: "needs-human",
      reason: "warmup",
    });
    expect(spawnCalls[0]?.command).toBe("terminal-notifier");
    // Now the sync path picks up the cached terminal-notifier backend.
    notifier.notifySync({
      task: makeTask(),
      status: "needs-human",
      reason: "from-reaper",
    });
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]?.command).toBe("terminal-notifier");
  });

  it("filters by NOTIFY_STATUSES", () => {
    const { notifier, spawnCalls } = makeHarness();
    notifier.notifySync({
      task: makeTask({ status: "planning" }),
      status: "planning",
      reason: "routine",
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it("does not call gh repo view (no network on the exit path)", () => {
    const { notifier, ghRepoViewMock } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
      ghRepoViewResult: "gavingolden/flow",
    });
    notifier.notifySync({
      task: makeTask({ pr: 12 }),
      status: "needs-human",
      reason: "r",
    });
    expect(ghRepoViewMock).not.toHaveBeenCalled();
  });

  it("emits -open when the repo cache was already warmed for this target_repo", async () => {
    const { notifier, spawnCalls } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
      ghRepoViewResult: "gavingolden/flow",
    });
    // Warm the repoCache via async notify (different task, same repo).
    await notifier.notify({
      task: makeTask({ pr: 1 }),
      status: "needs-human",
      reason: "r",
    });
    notifier.notifySync({
      task: makeTask({ pr: 42 }),
      status: "needs-human",
      reason: "r",
    });
    const argv = spawnCalls[1]?.args ?? [];
    expect(argv).toContain("-open");
    expect(argv[argv.length - 1]).toBe(
      "https://github.com/gavingolden/flow/pull/42",
    );
  });

  it("omits -open when the cache is cold (cannot block on gh)", () => {
    const { notifier, spawnCalls } = makeHarness({
      whichResult: "/usr/local/bin/terminal-notifier",
      ghRepoViewResult: "gavingolden/flow",
    });
    // No prior async call — cache is cold. The sync path picks
    // osascript because the backend cache is also cold; -open is moot
    // there. Force terminal-notifier via a recording trick: warm only
    // the backend cache by stubbing notify's first-await.
    // Simpler: assert that with a cold cache, no -open is emitted via
    // the default osascript path.
    notifier.notifySync({
      task: makeTask({ pr: 7 }),
      status: "needs-human",
      reason: "r",
    });
    expect(spawnCalls[0]?.command).toBe("osascript");
    expect(spawnCalls[0]?.args).not.toContain("-open");
  });

  it("registers an 'error' listener on the child (sync path)", () => {
    const { notifier, onMock } = makeHarness();
    notifier.notifySync({
      task: makeTask(),
      status: "needs-human",
      reason: "r",
    });
    expect(onMock).toHaveBeenCalledWith("error", expect.any(Function));
  });
});

describe("NoopNotifier", () => {
  it("notify is a no-op that resolves", async () => {
    await expect(NoopNotifier.notify({
      task: makeTask(),
      status: "needs-human",
    })).resolves.toBeUndefined();
  });

  it("notifySync is a no-op", () => {
    expect(() =>
      NoopNotifier.notifySync({
        task: makeTask(),
        status: "needs-human",
      }),
    ).not.toThrow();
  });
});
