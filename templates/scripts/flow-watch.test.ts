/**
 * Tests for flow-watch.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isTerminalStatus,
  loadTasks,
  main,
  parseArgs,
  parseFrontmatterStatus,
  resolveTaskId,
  runWithBound,
  type SpawnedProc,
  type TaskInfo,
} from "./flow-watch";

// --- Test fixtures ---

function buildTaskMd(opts: {
  id: string;
  status: string;
  updated?: string;
}): string {
  const updated = opts.updated ?? "2026-04-29T00:00:00.000Z";
  return `---
id: ${opts.id}
status: ${opts.status}
created: 2026-04-29T00:00:00.000Z
updated: '${updated}'
---

## User prompt

stub
`;
}

function task(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: "2026-04-29-some-task",
    status: "implementing",
    updatedMs: Date.parse("2026-04-29T00:00:00Z"),
    ...overrides,
  };
}

class StringSink {
  text = "";
  write(chunk: string): void {
    this.text += chunk;
  }
}

/**
 * Builds a fake SpawnedProc that emits the given lines on its stdout (and
 * optionally on stderr), with an optional gap between each line. Honors
 * `kill()` by closing the streams early.
 */
function makeFakeProc(opts: {
  lines: string[];
  stderrLines?: string[];
  delayMs?: number;
  exitCode?: number;
}): SpawnedProc & { wasKilled: () => boolean } {
  let killed = false;
  let resolveExited: (n: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolveExited = r;
  });
  let stdoutDone = false;
  let stderrDone = !opts.stderrLines || opts.stderrLines.length === 0;
  const maybeResolve = (): void => {
    if (stdoutDone && stderrDone) {
      resolveExited(killed ? 143 : opts.exitCode ?? 0);
    }
  };
  const buildStream = (
    lines: string[],
    onDone: () => void,
  ): ReadableStream<Uint8Array> => {
    let cancelEnqueue = () => {};
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        let cancelled = false;
        cancelEnqueue = () => {
          cancelled = true;
        };
        try {
          for (const line of lines) {
            if (killed || cancelled) break;
            controller.enqueue(enc.encode(line));
            if (opts.delayMs && opts.delayMs > 0) {
              await new Promise((r) => setTimeout(r, opts.delayMs));
            }
          }
        } catch {
          // Stream cancelled mid-enqueue — fine, exit cleanly.
        }
        try {
          controller.close();
        } catch {
          // Already closed by cancel().
        }
        onDone();
      },
      cancel() {
        cancelEnqueue();
      },
    });
  };
  const stdout = buildStream(opts.lines, () => {
    stdoutDone = true;
    maybeResolve();
  });
  const stderr =
    opts.stderrLines && opts.stderrLines.length > 0
      ? buildStream(opts.stderrLines, () => {
          stderrDone = true;
          maybeResolve();
        })
      : undefined;
  return {
    stdout,
    stderr,
    kill() {
      killed = true;
    },
    exited,
    wasKilled: () => killed,
  };
}

// --- isTerminalStatus ---

describe(isTerminalStatus, () => {
  it("returns true for the canonical terminal statuses", () => {
    expect(isTerminalStatus("merged")).toBe(true);
    expect(isTerminalStatus("aborted")).toBe(true);
    expect(isTerminalStatus("needs-human")).toBe(true);
  });

  it("returns false for non-terminal statuses", () => {
    for (const s of ["implementing", "planning", "verifying", "ci"]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

// --- parseFrontmatterStatus ---

describe(parseFrontmatterStatus, () => {
  it("extracts status and updated from a well-formed frontmatter block", () => {
    const raw = `---
id: 2026-04-29-foo
status: implementing
updated: '2026-04-29T12:00:00.000Z'
---

body
`;
    expect(parseFrontmatterStatus(raw)).toEqual({
      status: "implementing",
      updated: "2026-04-29T12:00:00.000Z",
    });
  });

  it("returns undefined fields when frontmatter is missing", () => {
    expect(parseFrontmatterStatus("body only, no frontmatter")).toEqual({});
  });

  it("returns undefined for missing fields", () => {
    const raw = `---
id: foo
---
body
`;
    expect(parseFrontmatterStatus(raw)).toEqual({});
  });

  it("ignores body content that looks like frontmatter keys", () => {
    const raw = `---
status: planning
---

status: implementing
`;
    expect(parseFrontmatterStatus(raw)).toEqual({ status: "planning" });
  });

  it("strips matching surrounding quotes", () => {
    const raw = `---
status: "merged"
updated: '2026-04-29T12:00:00.000Z'
---
`;
    expect(parseFrontmatterStatus(raw)).toEqual({
      status: "merged",
      updated: "2026-04-29T12:00:00.000Z",
    });
  });
});

// --- loadTasks ---

describe(loadTasks, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flow-watch-tasks-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty list when the directory does not exist", async () => {
    expect(await loadTasks(join(dir, "nope"))).toEqual([]);
  });

  it("walks .md files and returns sorted TaskInfo entries", async () => {
    writeFileSync(
      join(dir, "2026-04-29-bbb.md"),
      buildTaskMd({ id: "2026-04-29-bbb", status: "merged" }),
    );
    writeFileSync(
      join(dir, "2026-04-29-aaa.md"),
      buildTaskMd({ id: "2026-04-29-aaa", status: "implementing" }),
    );
    const result = await loadTasks(dir);
    expect(result.map((t) => t.id)).toEqual([
      "2026-04-29-aaa",
      "2026-04-29-bbb",
    ]);
    expect(result[0].status).toBe("implementing");
    expect(result[1].status).toBe("merged");
  });

  it("ignores non-.md entries and subdirectories", async () => {
    writeFileSync(join(dir, "README"), "not markdown");
    writeFileSync(join(dir, "notes.txt"), "also not markdown");
    writeFileSync(
      join(dir, "2026-04-29-only.md"),
      buildTaskMd({ id: "2026-04-29-only", status: "planning" }),
    );
    const result = await loadTasks(dir);
    expect(result.map((t) => t.id)).toEqual(["2026-04-29-only"]);
  });

  it("skips files without a status frontmatter field", async () => {
    writeFileSync(join(dir, "broken.md"), "no frontmatter here\n");
    writeFileSync(
      join(dir, "ok.md"),
      buildTaskMd({ id: "ok", status: "planning" }),
    );
    const result = await loadTasks(dir);
    expect(result.map((t) => t.id)).toEqual(["ok"]);
  });

  it("scans both tasks/ and tasks/archive/ and returns a merged sorted list", async () => {
    require("node:fs").mkdirSync(join(dir, "archive"), { recursive: true });
    writeFileSync(
      join(dir, "active.md"),
      buildTaskMd({ id: "active", status: "implementing" }),
    );
    writeFileSync(
      join(dir, "archive", "old.md"),
      buildTaskMd({ id: "old", status: "merged" }),
    );
    writeFileSync(
      join(dir, "archive", "older.md"),
      buildTaskMd({ id: "older", status: "aborted" }),
    );
    const result = await loadTasks(dir);
    expect(result.map((t) => t.id)).toEqual(["active", "old", "older"]);
    expect(result.find((t) => t.id === "old")?.status).toBe("merged");
    expect(result.find((t) => t.id === "older")?.status).toBe("aborted");
  });

  it("does not double-count an id present in both tasks/ and archive/ (active wins by sort, both surface)", async () => {
    // No de-dup is performed — if a task somehow lives in both directories
    // the wrapper surfaces both so the inconsistency is visible in any
    // "available ids" listing rather than silently swallowed.
    require("node:fs").mkdirSync(join(dir, "archive"), { recursive: true });
    writeFileSync(
      join(dir, "dup.md"),
      buildTaskMd({ id: "dup", status: "implementing" }),
    );
    writeFileSync(
      join(dir, "archive", "dup.md"),
      buildTaskMd({ id: "dup", status: "merged" }),
    );
    const result = await loadTasks(dir);
    expect(result.length).toBe(2);
  });
});

// --- resolveTaskId ---

describe(resolveTaskId, () => {
  it("returns explicit-active when explicit id is present and non-terminal", () => {
    const tasks = [task({ id: "a", status: "implementing" })];
    expect(resolveTaskId({ explicitId: "a", tasks })).toEqual({
      kind: "explicit-active",
      id: "a",
    });
  });

  it("returns explicit-terminal when explicit id is present and terminal", () => {
    const tasks = [task({ id: "a", status: "merged" })];
    expect(resolveTaskId({ explicitId: "a", tasks })).toEqual({
      kind: "explicit-terminal",
      id: "a",
      status: "merged",
    });
  });

  it("returns unknown preserving the input task order in `available` when the explicit id is missing", () => {
    // `loadTasks` already sorts ids ascending; `resolveTaskId` is a pure
    // transformation that preserves whatever order it was handed. This test
    // documents that contract — the sort lives in `loadTasks`, not here.
    const tasks = [
      task({ id: "z", status: "implementing" }),
      task({ id: "a", status: "merged" }),
    ];
    const r = resolveTaskId({ explicitId: "missing", tasks });
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") {
      expect(r.available).toEqual(["z", "a"]);
      expect(r.id).toBe("missing");
    }
  });

  it("returns follow when no id and exactly one non-terminal task exists", () => {
    const tasks = [
      task({ id: "a", status: "merged" }),
      task({ id: "b", status: "implementing" }),
    ];
    expect(resolveTaskId({ tasks })).toEqual({ kind: "follow", id: "b" });
  });

  it("returns ambiguous when multiple non-terminal tasks exist", () => {
    const tasks = [
      task({ id: "a", status: "implementing" }),
      task({ id: "b", status: "planning" }),
      task({ id: "c", status: "merged" }),
    ];
    const r = resolveTaskId({ tasks });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map((t) => t.id)).toEqual(["a", "b"]);
    }
  });

  it("falls back to most-recently-updated terminal task when none are non-terminal", () => {
    const tasks = [
      task({
        id: "old",
        status: "merged",
        updatedMs: Date.parse("2026-04-01T00:00:00Z"),
      }),
      task({
        id: "new",
        status: "aborted",
        updatedMs: Date.parse("2026-04-29T00:00:00Z"),
      }),
    ];
    expect(resolveTaskId({ tasks })).toEqual({
      kind: "terminal-fallback",
      id: "new",
      status: "aborted",
    });
  });

  it("returns unknown with empty available when no tasks exist", () => {
    expect(resolveTaskId({ tasks: [] })).toEqual({
      kind: "unknown",
      id: "",
      available: [],
    });
  });
});

// --- parseArgs ---

describe(parseArgs, () => {
  it("returns defaults when given no args", () => {
    expect(parseArgs([])).toEqual({
      id: undefined,
      phase: undefined,
      seconds: 30,
      events: 50,
    });
  });

  it("captures a bare positional id", () => {
    expect(parseArgs(["my-task"])).toMatchObject({ id: "my-task" });
  });

  it("extracts --phase value", () => {
    expect(parseArgs(["my-task", "--phase", "plan"])).toMatchObject({
      id: "my-task",
      phase: "plan",
    });
  });

  it("overrides --seconds and --events", () => {
    expect(parseArgs(["--seconds", "10", "--events", "5"])).toMatchObject({
      seconds: 10,
      events: 5,
    });
  });

  it("throws on --seconds 0", () => {
    expect(() => parseArgs(["--seconds", "0"])).toThrow(
      /must be a positive integer/,
    );
  });

  it("throws on --events -1", () => {
    expect(() => parseArgs(["--events", "-1"])).toThrow(
      /must be a positive integer/,
    );
  });

  it("throws on non-numeric --seconds", () => {
    expect(() => parseArgs(["--seconds", "abc"])).toThrow(
      /must be a positive integer/,
    );
  });

  it("throws on unknown flags", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
  });

  it("throws on a second positional argument", () => {
    expect(() => parseArgs(["one", "two"])).toThrow(
      /unexpected positional argument/,
    );
  });
});

// --- runWithBound ---

describe(runWithBound, () => {
  it("emits all lines and an EOF footer when within both bounds (follow mode)", async () => {
    const proc = makeFakeProc({ lines: ["a\n", "b\n", "c\n"] });
    const out = new StringSink();
    const code = await runWithBound({
      flowLogArgs: ["log", "id", "--follow"],
      secondsCap: 10,
      eventsCap: 50,
      mode: "follow",
      idForFooter: "id",
      spawn: () => proc,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(out.text).toContain("a\nb\nc\n");
    expect(out.text).toContain("(log stream ended)");
  });

  it("stops at the events cap, kills the child, and prints the events footer", async () => {
    const proc = makeFakeProc({
      lines: ["a\n", "b\n", "c\n", "d\n", "e\n"],
    });
    const out = new StringSink();
    const code = await runWithBound({
      flowLogArgs: ["log", "id", "--follow"],
      secondsCap: 60,
      eventsCap: 3,
      mode: "follow",
      idForFooter: "my-task",
      spawn: () => proc,
      stdout: out,
    });
    expect(code).toBe(0);
    // Exactly three event lines, then the footer.
    const eventLines = out.text
      .split("\n")
      .filter((l) => l.length === 1 && /[a-e]/.test(l));
    expect(eventLines).toEqual(["a", "b", "c"]);
    expect(out.text).toContain("(stopped after 3 events");
    expect(out.text).toContain("/flow-watch my-task");
    expect(proc.wasKilled()).toBe(true);
  });

  it("stops at the wall-clock cap and prints the time footer (follow mode)", async () => {
    // 5 lines, 50ms apart → ~250ms total. Cap at 1 second wall-clock but only
    // 2 events render in time before… actually we want time to fire first, so
    // raise the events cap and slow the cadence.
    const proc = makeFakeProc({
      lines: Array(20).fill("evt\n"),
      delayMs: 30,
    });
    const out = new StringSink();
    const start = Date.now();
    // 0.1s wall-clock — the timer should fire before 20 events arrive.
    // (We can't pass 0.1 through parseArgs, but runWithBound takes a raw number.)
    const code = await runWithBound({
      flowLogArgs: ["log", "id", "--follow"],
      secondsCap: 0.1,
      eventsCap: 999,
      mode: "follow",
      idForFooter: "my-task",
      spawn: () => proc,
      stdout: out,
    });
    const elapsed = Date.now() - start;
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(2000);
    expect(out.text).toContain("(stopped after 0.1s");
    expect(proc.wasKilled()).toBe(true);
  });

  it("does not arm the wall-clock timer in tail mode", async () => {
    // 10 lines, all instant. Tail mode → seconds bound is irrelevant; the
    // events bound is what protects against runaway logs. Set events high
    // and confirm we still get the EOF footer (no timer side-effects).
    const proc = makeFakeProc({ lines: Array(10).fill("evt\n") });
    const out = new StringSink();
    const code = await runWithBound({
      flowLogArgs: ["log", "id"],
      secondsCap: 30,
      eventsCap: 50,
      mode: "tail",
      idForFooter: "my-task",
      spawn: () => proc,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(out.text).toContain("(end of log)");
    // Tail mode never sends SIGTERM when the stream ends naturally.
    expect(proc.wasKilled()).toBe(false);
  });

  it("propagates the child's non-zero exit code on natural EOF (so wrapper failures are visible)", async () => {
    const proc = makeFakeProc({ lines: ["partial\n"], exitCode: 2 });
    const out = new StringSink();
    const code = await runWithBound({
      flowLogArgs: ["log", "id"],
      secondsCap: 30,
      eventsCap: 50,
      mode: "tail",
      idForFooter: "id",
      spawn: () => proc,
      stdout: out,
    });
    expect(code).toBe(2);
    expect(out.text).toContain("partial");
  });

  it("returns 0 when the wrapper itself stopped the child (kill is not a child failure)", async () => {
    // Child would exit 143 (SIGTERM) but stoppedReason is `events`, so the
    // wrapper should not surface that as a failure to the user.
    const proc = makeFakeProc({
      lines: ["a\n", "b\n", "c\n", "d\n"],
    });
    const out = new StringSink();
    const code = await runWithBound({
      flowLogArgs: ["log", "id", "--follow"],
      secondsCap: 60,
      eventsCap: 2,
      mode: "follow",
      idForFooter: "id",
      spawn: () => proc,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(proc.wasKilled()).toBe(true);
  });

  it("folds stderr lines into the same event budget so they cannot bypass the bound", async () => {
    const proc = makeFakeProc({
      lines: ["out1\n", "out2\n"],
      stderrLines: ["err1\n", "err2\n", "err3\n"],
    });
    const out = new StringSink();
    const errSink = new StringSink();
    const code = await runWithBound({
      flowLogArgs: ["log", "id", "--follow"],
      secondsCap: 60,
      eventsCap: 3,
      mode: "follow",
      idForFooter: "id",
      spawn: () => proc,
      stdout: out,
      stderr: errSink,
    });
    expect(code).toBe(0);
    // Combined stdout-line count + stderr-line count is bounded at 3.
    const outLines = out.text
      .split("\n")
      .filter((l) => /^out\d$/.test(l)).length;
    const errLines = errSink.text
      .split("\n")
      .filter((l) => /^err\d$/.test(l)).length;
    expect(outLines + errLines).toBeLessThanOrEqual(3);
  });

  it("emits the ENOENT error and exits non-zero when flow is not on PATH", async () => {
    const err = new Error("spawn flow ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    const stderr = new StringSink();
    const code = await runWithBound({
      flowLogArgs: ["log", "id", "--follow"],
      secondsCap: 30,
      eventsCap: 50,
      mode: "follow",
      idForFooter: "id",
      spawn: () => {
        throw err;
      },
      stdout: new StringSink(),
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text).toContain("flow CLI not found on PATH");
  });
});

// --- main ---

describe(main, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flow-watch-main-"));
    writeFileSync(
      join(dir, ".gitkeep"),
      "",
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setupTasks(
    files: Array<{ id: string; status: string; updated?: string }>,
  ): void {
    const tasksDir = join(dir, ".orchestrator", "tasks");
    require("node:fs").mkdirSync(tasksDir, { recursive: true });
    for (const f of files) {
      writeFileSync(join(tasksDir, `${f.id}.md`), buildTaskMd(f));
    }
  }

  it("prints `(resolved id: …)` and tails when no id is given but one task is non-terminal", async () => {
    setupTasks([{ id: "auto-1", status: "implementing" }]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main([], {
      cwd: dir,
      stdout,
      stderr,
      spawn: () => makeFakeProc({ lines: ["e1\n"] }),
    });
    expect(code).toBe(0);
    expect(stdout.text).toContain("(resolved id: auto-1)");
    expect(stdout.text).toContain("Tailing");
  });

  it("lists candidates and exits 1 when multiple non-terminal tasks exist", async () => {
    setupTasks([
      { id: "a-task", status: "implementing" },
      { id: "b-task", status: "planning" },
    ]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main([], { cwd: dir, stdout, stderr });
    expect(code).toBe(1);
    expect(stderr.text).toContain("multiple non-terminal tasks");
    expect(stderr.text).toContain("a-task");
    expect(stderr.text).toContain("b-task");
  });

  it("falls back to the most-recently-updated task when none are non-terminal", async () => {
    setupTasks([
      {
        id: "old",
        status: "merged",
        updated: "2026-04-01T00:00:00.000Z",
      },
      {
        id: "new",
        status: "aborted",
        updated: "2026-04-29T00:00:00.000Z",
      },
    ]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main([], {
      cwd: dir,
      stdout,
      stderr,
      spawn: () => makeFakeProc({ lines: ["e\n"] }),
    });
    expect(code).toBe(0);
    expect(stdout.text).toContain(
      "(no active task — showing last events of new, status=aborted)",
    );
  });

  it("prints the available-ids list and exits 1 for an unknown id", async () => {
    setupTasks([{ id: "alpha", status: "implementing" }]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(["zeta"], { cwd: dir, stdout, stderr });
    expect(code).toBe(1);
    expect(stderr.text).toContain("task 'zeta' not found");
    expect(stderr.text).toContain("alpha");
  });

  it("treats a terminal explicit id as a finite tail", async () => {
    setupTasks([{ id: "done-task", status: "merged" }]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(["done-task"], {
      cwd: dir,
      stdout,
      stderr,
      spawn: () => makeFakeProc({ lines: ["last-line\n"] }),
    });
    expect(code).toBe(0);
    expect(stdout.text).toContain(
      "(task done-task is merged — showing last events)",
    );
    expect(stdout.text).toContain("(end of log)");
  });

  it("resolves an explicit id that lives only in tasks/archive/", async () => {
    // Terminal tasks are moved to archive/ per docs/task-schema.md, but
    // `flow log` still finds them via findTaskFile. The wrapper has to mirror
    // that or the SKILL.md guarantee for `/flow-watch <merged-id>` breaks.
    const tasksDir = join(dir, ".orchestrator", "tasks", "archive");
    require("node:fs").mkdirSync(tasksDir, { recursive: true });
    require("node:fs").writeFileSync(
      join(tasksDir, "archived-task.md"),
      buildTaskMd({ id: "archived-task", status: "merged" }),
    );
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(["archived-task"], {
      cwd: dir,
      stdout,
      stderr,
      spawn: () => makeFakeProc({ lines: ["evt\n"] }),
    });
    expect(code).toBe(0);
    expect(stdout.text).toContain(
      "(task archived-task is merged — showing last events)",
    );
  });

  it("forwards --phase to flow log without stripping it", async () => {
    setupTasks([{ id: "alive", status: "implementing" }]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    let capturedArgv: string[] = [];
    const code = await main(["alive", "--phase", "plan"], {
      cwd: dir,
      stdout,
      stderr,
      spawn: (argv) => {
        capturedArgv = argv;
        return makeFakeProc({ lines: [] });
      },
    });
    expect(code).toBe(0);
    expect(capturedArgv).toEqual([
      "flow",
      "log",
      "alive",
      "--follow",
      "--phase",
      "plan",
    ]);
  });

  it("strips --seconds and --events from the flow log argv", async () => {
    setupTasks([{ id: "alive", status: "implementing" }]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    let capturedArgv: string[] = [];
    await main(["alive", "--seconds", "5", "--events", "10"], {
      cwd: dir,
      stdout,
      stderr,
      spawn: (argv) => {
        capturedArgv = argv;
        return makeFakeProc({ lines: [] });
      },
    });
    expect(capturedArgv).not.toContain("--seconds");
    expect(capturedArgv).not.toContain("--events");
  });

  it("emits a usage error and exits 1 on bad flag values", async () => {
    setupTasks([{ id: "alive", status: "implementing" }]);
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(["alive", "--seconds", "0"], {
      cwd: dir,
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text).toContain("must be a positive integer");
  });
});
