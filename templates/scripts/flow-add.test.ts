/**
 * Tests for flow-add.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  ArgError,
  buildTaskId,
  buildTaskMd,
  findCanonicalRoot,
  formatSuccessBlock,
  main,
  nextAvailableId,
  parseArgs,
  readExistingIds,
  slugify,
  type SpawnDetachFn,
} from "./flow-add";

class StringSink {
  text = "";
  write(chunk: string): void {
    this.text += chunk;
  }
}

// --- slugify ---

describe(slugify, () => {
  it("kebab-cases a plain feature request", () => {
    expect(slugify("add CSV export")).toBe("add-csv-export");
  });

  it("strips punctuation and collapses runs", () => {
    expect(slugify("Fix off-by-one in pagination!!!")).toBe(
      "fix-off-by-one-in-pagination",
    );
  });

  it("truncates to ≤ 5 words", () => {
    expect(
      slugify(
        "wire up the new dashboard to the analytics pipeline endpoint",
      ),
    ).toBe("wire-up-the-new-dashboard");
  });

  it("falls back to a deterministic filler when input is empty", () => {
    expect(slugify("")).toBe("task");
    expect(slugify("   ")).toBe("task");
  });

  it("falls back when input has no letters or digits", () => {
    expect(slugify("!!!---???")).toBe("task");
  });

  it("respects an explicit max", () => {
    expect(slugify("one two three four five six", 3)).toBe("one-two-three");
  });
});

// --- buildTaskId ---

describe(buildTaskId, () => {
  it("composes date and slug", () => {
    expect(buildTaskId("2026-04-29", "add-csv-export")).toBe(
      "2026-04-29-add-csv-export",
    );
  });
});

// --- nextAvailableId ---

describe(nextAvailableId, () => {
  it("returns the base when unused", () => {
    expect(nextAvailableId(new Set(), "2026-04-29-foo")).toBe(
      "2026-04-29-foo",
    );
  });

  it("walks numeric suffixes 2..9 in order", () => {
    expect(
      nextAvailableId(new Set(["2026-04-29-foo"]), "2026-04-29-foo"),
    ).toBe("2026-04-29-foo-2");
    expect(
      nextAvailableId(
        new Set(["2026-04-29-foo", "2026-04-29-foo-2"]),
        "2026-04-29-foo",
      ),
    ).toBe("2026-04-29-foo-3");
  });

  it("throws id-collision-exhausted when every suffix is taken", () => {
    const taken = new Set([
      "2026-04-29-foo",
      ...Array.from({ length: 8 }, (_, i) => `2026-04-29-foo-${i + 2}`),
    ]);
    expect(() => nextAvailableId(taken, "2026-04-29-foo")).toThrow(
      /id-collision-exhausted/,
    );
  });
});

// --- buildTaskMd ---

describe(buildTaskMd, () => {
  it("produces the canonical schema for a happy-path triage", () => {
    const md = buildTaskMd({
      id: "2026-04-29-add-csv-export",
      prompt: "add CSV export to the portfolio table",
      intent: "feature",
      summary: "ship a CSV export button on the portfolio table",
      clarifications: [
        "desktop view only — mobile deferred",
        "visible columns only",
        "respects current sort order",
      ],
      constraints: ["no backend round-trip; client-side only"],
      openQuestions: [],
      repoRoot: "/Users/me/code/repo",
      nowIso: "2026-04-29T10:30:00.000Z",
    });
    // Frozen byte regression — the schema is a contract; any change here is
    // either intentional (update the expected) or a bug. Keep the literal
    // alongside the input so it's easy to read the diff.
    const expected = `---
id: 2026-04-29-add-csv-export
status: triaged
created: 2026-04-29T10:30:00.000Z
updated: 2026-04-29T10:30:00.000Z
target_repo: /Users/me/code/repo
worktree: null
branch: null
pr: null
manual_validation: null
merge_commit: null
---

## User prompt

add CSV export to the portfolio table

## Triage

- intent: feature
- summary: ship a CSV export button on the portfolio table

## Clarifications

- desktop view only — mobile deferred
- visible columns only
- respects current sort order

## Constraints / out of scope

- no backend round-trip; client-side only

## Open questions

- none

## Progress

- [x] triage
- [ ] plan
- [ ] worktree
- [ ] implement
- [ ] verify
- [ ] ci
- [ ] review
- [ ] gate
- [ ] merge

## Phase log

- 2026-04-29T10:30:00.000Z triage complete

## Phase outputs

(empty — pipeline phases will populate)
`;
    expect(md).toBe(expected);
  });

  it("falls back to 'nothing flagged' when no constraints provided", () => {
    const md = buildTaskMd({
      id: "x",
      prompt: "p",
      intent: "feature",
      summary: "s",
      clarifications: [],
      constraints: [],
      openQuestions: [],
      repoRoot: "/r",
      nowIso: "2026-04-29T00:00:00.000Z",
    });
    expect(md).toContain("## Constraints / out of scope\n\n- nothing flagged\n");
    expect(md).toContain("## Open questions\n\n- none\n");
  });

  it("normalises clarifications with or without leading '- '", () => {
    const md = buildTaskMd({
      id: "x",
      prompt: "p",
      intent: "feature",
      summary: "s",
      clarifications: ["- already a bullet", "needs a bullet"],
      constraints: [],
      openQuestions: [],
      repoRoot: "/r",
      nowIso: "2026-04-29T00:00:00.000Z",
    });
    expect(md).toContain("- already a bullet\n- needs a bullet");
  });
});

// --- parseArgs ---

describe(parseArgs, () => {
  it("parses a happy-path argv", () => {
    expect(
      parseArgs([
        "add CSV export",
        "--intent",
        "feature",
        "--summary",
        "the summary",
      ]),
    ).toEqual({
      prompt: "add CSV export",
      intent: "feature",
      summary: "the summary",
      slug: undefined,
      clarifications: [],
      constraints: [],
      openQuestions: [],
    });
  });

  it("accumulates repeated --clarification, --constraint, --open-question", () => {
    const parsed = parseArgs([
      "p",
      "--intent",
      "bug",
      "--summary",
      "s",
      "--clarification",
      "c1",
      "--clarification",
      "c2",
      "--constraint",
      "x1",
      "--open-question",
      "q1",
      "--open-question",
      "q2",
    ]);
    expect(parsed.clarifications).toEqual(["c1", "c2"]);
    expect(parsed.constraints).toEqual(["x1"]);
    expect(parsed.openQuestions).toEqual(["q1", "q2"]);
  });

  it("captures --slug", () => {
    const parsed = parseArgs([
      "p",
      "--intent",
      "feature",
      "--summary",
      "s",
      "--slug",
      "my-slug",
    ]);
    expect(parsed.slug).toBe("my-slug");
  });

  it("throws ArgError when prompt is missing", () => {
    expect(() => parseArgs([])).toThrow(ArgError);
  });

  it("throws ArgError when --intent is missing", () => {
    expect(() => parseArgs(["p", "--summary", "s"])).toThrow(/--intent/);
  });

  it("throws ArgError when --summary is missing", () => {
    expect(() => parseArgs(["p", "--intent", "feature"])).toThrow(/--summary/);
  });

  it("throws ArgError on an invalid --intent value", () => {
    expect(() =>
      parseArgs(["p", "--intent", "bogus", "--summary", "s"]),
    ).toThrow(/--intent must be one of/);
  });

  it("throws ArgError on an unknown flag", () => {
    expect(() =>
      parseArgs([
        "p",
        "--intent",
        "feature",
        "--summary",
        "s",
        "--bogus",
      ]),
    ).toThrow(/unknown flag/);
  });

  it("throws ArgError when a flag value is missing", () => {
    expect(() => parseArgs(["p", "--intent"])).toThrow(/--intent requires/);
  });

  it("throws ArgError on a second positional argument", () => {
    expect(() =>
      parseArgs(["p", "extra", "--intent", "feature", "--summary", "s"]),
    ).toThrow(/unexpected positional argument/);
  });
});

// --- formatSuccessBlock ---

describe(formatSuccessBlock, () => {
  it("emits the documented copy-pasteable block byte-for-byte", () => {
    const text = formatSuccessBlock({
      id: "2026-04-29-add-csv-export",
      taskMdPath: "/Users/me/code/repo/.orchestrator/tasks/2026-04-29-add-csv-export.md",
      logsDir: "/Users/me/code/repo/.orchestrator/tasks/2026-04-29-add-csv-export",
    });
    expect(text).toBe(`task: 2026-04-29-add-csv-export
task-md: /Users/me/code/repo/.orchestrator/tasks/2026-04-29-add-csv-export.md
logs: /Users/me/code/repo/.orchestrator/tasks/2026-04-29-add-csv-export

Pipeline started (detached). Next:
  /flow status 2026-04-29-add-csv-export
  /flow watch 2026-04-29-add-csv-export
`);
  });
});

// --- readExistingIds ---

describe(readExistingIds, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flow-add-ids-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty list when the directory does not exist", () => {
    expect(readExistingIds(join(dir, "nope"))).toEqual([]);
  });

  it("collects ids from tasks/ and tasks/archive/", () => {
    mkdirSync(join(dir, "archive"), { recursive: true });
    writeFileSync(join(dir, "2026-04-29-aaa.md"), "x");
    writeFileSync(join(dir, "archive", "2026-04-29-bbb.md"), "x");
    writeFileSync(join(dir, "ignore.txt"), "x");
    expect(readExistingIds(dir).sort()).toEqual([
      "2026-04-29-aaa",
      "2026-04-29-bbb",
    ]);
  });
});

// --- findCanonicalRoot (real git) ---

function gitOnPath(): boolean {
  try {
    const r = spawnSync("git", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

describe.runIf(gitOnPath())(findCanonicalRoot, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flow-add-git-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function realRoot(p: string): string {
    // macOS prefixes /private to tmp paths; resolve the canonical form so
    // string compares match what `git rev-parse` returns.
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: p,
      encoding: "utf8",
    });
    return r.stdout.trim();
  }

  function git(args: string[], cwd: string): void {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${r.stderr || "(no stderr)"}`,
      );
    }
  }

  it("returns the toplevel for a plain init'd repo", () => {
    git(["init", "-q", "--initial-branch=main"], dir);
    writeFileSync(join(dir, "README"), "x");
    git(["add", "README"], dir);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
    expect(findCanonicalRoot(dir)).toBe(realRoot(dir));
  });

  it("returns the *primary* toplevel when invoked from a child worktree", () => {
    git(["init", "-q", "--initial-branch=main"], dir);
    writeFileSync(join(dir, "README"), "x");
    git(["add", "README"], dir);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
    const childDir = `${dir}-child`;
    git(["worktree", "add", "-b", "feature", childDir], dir);
    try {
      const primary = realRoot(dir);
      expect(findCanonicalRoot(childDir)).toBe(primary);
    } finally {
      rmSync(childDir, { recursive: true, force: true });
    }
  });

  it("returns null outside any git repo", () => {
    expect(findCanonicalRoot(dir)).toBe(null);
  });
});

// --- main (end-to-end with spawn injection) ---

describe(main, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flow-add-main-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  type CapturedSpawn = {
    fn: SpawnDetachFn;
    capturedArgv: string[][];
    capturedCwd: string[];
  };

  function captureSpawn(behavior: "ok" | "enoent" | "exit-1" = "ok"): CapturedSpawn {
    const capturedArgv: string[][] = [];
    const capturedCwd: string[] = [];
    const fn: SpawnDetachFn = (args) => {
      capturedArgv.push(args.argv);
      capturedCwd.push(args.cwd);
      if (behavior === "ok") return { ok: true };
      if (behavior === "enoent") return { ok: false, reason: "enoent" };
      return { ok: false, reason: "exit", code: 1, stderr: "boom\n" };
    };
    return { fn, capturedArgv, capturedCwd };
  }

  it("happy path — writes task.md and spawns flow run --detach with canonical cwd", async () => {
    const { fn, capturedArgv, capturedCwd } = captureSpawn("ok");
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(
      [
        "add CSV export",
        "--intent",
        "feature",
        "--summary",
        "ship CSV export",
        "--clarification",
        "desktop only",
      ],
      {
        cwd: "/some/where",
        nowIso: () => "2026-04-29T10:30:00.000Z",
        todayUtcDate: () => "2026-04-29",
        readExistingIds: () => [],
        findCanonicalRoot: () => dir,
        spawnDetach: fn,
        stdout,
        stderr,
      },
    );
    expect(code).toBe(0);
    expect(stderr.text).toBe("");
    expect(stdout.text).toContain("task: 2026-04-29-add-csv-export");
    expect(stdout.text).toContain("Pipeline started (detached)");
    expect(stdout.text).toContain("/flow status 2026-04-29-add-csv-export");
    expect(stdout.text).toContain("/flow watch 2026-04-29-add-csv-export");
    // Regression: the success block must come *after* the spawn returns ok.
    // Earlier versions emitted the whole block before the spawn, which lied
    // about pipeline state when the spawn later failed.
    const taskRecordedIdx = stdout.text.indexOf("task:");
    const pipelineStartedIdx = stdout.text.indexOf("Pipeline started");
    expect(taskRecordedIdx).toBeGreaterThanOrEqual(0);
    expect(pipelineStartedIdx).toBeGreaterThan(taskRecordedIdx);

    const taskMdPath = join(
      dir,
      ".orchestrator",
      "tasks",
      "2026-04-29-add-csv-export.md",
    );
    const body = readFileSync(taskMdPath, "utf8");
    expect(body).toContain("id: 2026-04-29-add-csv-export");
    expect(body).toContain(`target_repo: ${dir}`);
    expect(body).toContain("- desktop only");

    expect(capturedArgv).toEqual([
      ["flow", "run", "2026-04-29-add-csv-export", "--detach"],
    ]);
    expect(capturedCwd).toEqual([dir]);
  });

  it("uses --slug when provided instead of deriving from prompt", async () => {
    const { fn } = captureSpawn("ok");
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(
      [
        "anything goes here",
        "--intent",
        "feature",
        "--summary",
        "s",
        "--slug",
        "my-explicit-slug",
      ],
      {
        cwd: "/some/where",
        nowIso: () => "2026-04-29T00:00:00.000Z",
        todayUtcDate: () => "2026-04-29",
        readExistingIds: () => [],
        findCanonicalRoot: () => dir,
        spawnDetach: fn,
        stdout,
        stderr,
      },
    );
    expect(code).toBe(0);
    expect(stdout.text).toContain("task: 2026-04-29-my-explicit-slug");
  });

  it("walks numeric suffixes when the base id collides", async () => {
    const { fn } = captureSpawn("ok");
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(
      [
        "add CSV export",
        "--intent",
        "feature",
        "--summary",
        "s",
      ],
      {
        cwd: "/some/where",
        nowIso: () => "2026-04-29T00:00:00.000Z",
        todayUtcDate: () => "2026-04-29",
        readExistingIds: () => [
          "2026-04-29-add-csv-export",
          "2026-04-29-add-csv-export-2",
        ],
        findCanonicalRoot: () => dir,
        spawnDetach: fn,
        stdout,
        stderr,
      },
    );
    expect(code).toBe(0);
    expect(stdout.text).toContain("task: 2026-04-29-add-csv-export-3");
  });

  it("exits 4 with a colliding-ids list when every suffix is taken", async () => {
    const { fn } = captureSpawn("ok");
    const stdout = new StringSink();
    const stderr = new StringSink();
    const taken = [
      "2026-04-29-add-csv-export",
      ...Array.from({ length: 8 }, (_, i) => `2026-04-29-add-csv-export-${i + 2}`),
    ];
    const code = await main(
      ["add CSV export", "--intent", "feature", "--summary", "s"],
      {
        cwd: "/some/where",
        nowIso: () => "2026-04-29T00:00:00.000Z",
        todayUtcDate: () => "2026-04-29",
        readExistingIds: () => taken,
        findCanonicalRoot: () => dir,
        spawnDetach: fn,
        stdout,
        stderr,
      },
    );
    expect(code).toBe(4);
    expect(stderr.text).toContain("id collision");
    for (const id of taken) expect(stderr.text).toContain(id);
  });

  it("exits 3 when not inside a git repository", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(
      ["p", "--intent", "feature", "--summary", "s"],
      {
        cwd: "/some/where",
        findCanonicalRoot: () => null,
        stdout,
        stderr,
      },
    );
    expect(code).toBe(3);
    expect(stderr.text).toContain("must be run from inside a git repository");
    // Distinct error wording: this branch is for "user is outside any repo",
    // not "git binary missing". The git-missing branch has its own message
    // so the user can act — install git vs. cd into a repo.
    expect(stderr.text).not.toContain("git not found on PATH");
  });

  it("exits 3 with a distinct 'git not found on PATH' message when git is missing", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(
      ["p", "--intent", "feature", "--summary", "s"],
      {
        cwd: "/some/where",
        findCanonicalRootResult: () => ({ kind: "git-missing" }),
        stdout,
        stderr,
      },
    );
    expect(code).toBe(3);
    expect(stderr.text).toContain("git not found on PATH");
    expect(stderr.text).not.toContain(
      "must be run from inside a git repository",
    );
  });

  it("exits 2 when flow is not on PATH", async () => {
    const { fn } = captureSpawn("enoent");
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(
      ["p", "--intent", "feature", "--summary", "s"],
      {
        cwd: "/some/where",
        nowIso: () => "2026-04-29T00:00:00.000Z",
        todayUtcDate: () => "2026-04-29",
        readExistingIds: () => [],
        findCanonicalRoot: () => dir,
        spawnDetach: fn,
        stdout,
        stderr,
      },
    );
    expect(code).toBe(2);
    expect(stderr.text).toContain("flow CLI not found on PATH");
    // Regression: the "Pipeline started" half must NOT print on a failed
    // spawn — chat would otherwise lie about pipeline state. The
    // "task recorded" half (id + path) is still printed so the user can
    // pick up the file even though the pipeline didn't start.
    expect(stdout.text).toContain("task: 2026-04-29-p");
    expect(stdout.text).not.toContain("Pipeline started");
  });

  it("exits 5 with a usage error when --intent is missing", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(["p", "--summary", "s"], {
      cwd: dir,
      stdout,
      stderr,
    });
    expect(code).toBe(5);
    expect(stderr.text).toContain("--intent");
  });

  it("exits 5 with a usage error on an unknown flag", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(
      ["p", "--intent", "feature", "--summary", "s", "--bogus"],
      { cwd: dir, stdout, stderr },
    );
    expect(code).toBe(5);
    expect(stderr.text).toContain("unknown flag");
  });

  it("exits 1 when the spawned flow run exits non-zero", async () => {
    const { fn } = captureSpawn("exit-1");
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(
      ["p", "--intent", "feature", "--summary", "s"],
      {
        cwd: "/some/where",
        nowIso: () => "2026-04-29T00:00:00.000Z",
        todayUtcDate: () => "2026-04-29",
        readExistingIds: () => [],
        findCanonicalRoot: () => dir,
        spawnDetach: fn,
        stdout,
        stderr,
      },
    );
    expect(code).toBe(1);
    expect(stderr.text).toContain("exited with code 1");
    // Regression: same as the enoent path — "Pipeline started" must not
    // print on a non-zero spawn exit.
    expect(stdout.text).toContain("task: 2026-04-29-p");
    expect(stdout.text).not.toContain("Pipeline started");
  });

  it("exits 1 with an EEXIST race message when task.md is created between read and write", async () => {
    // Drive the wx-flag race branch: pre-create the task file with the
    // base id so writeFile fails EEXIST. The orchestrator's existing-id
    // snapshot is empty (so nextAvailableId returns the base id), but the
    // wx-flag check on disk wins — exactly the race the helper is
    // defending against.
    const { fn } = captureSpawn("ok");
    const stdout = new StringSink();
    const stderr = new StringSink();
    mkdirSync(join(dir, ".orchestrator", "tasks"), { recursive: true });
    writeFileSync(
      join(dir, ".orchestrator", "tasks", "2026-04-29-p.md"),
      "raced\n",
    );
    const code = await main(
      ["p", "--intent", "feature", "--summary", "s"],
      {
        cwd: "/some/where",
        nowIso: () => "2026-04-29T00:00:00.000Z",
        todayUtcDate: () => "2026-04-29",
        // Empty snapshot so nextAvailableId picks the base id; the on-disk
        // file is the only thing that triggers the wx-flag failure.
        readExistingIds: () => [],
        findCanonicalRoot: () => dir,
        spawnDetach: fn,
        stdout,
        stderr,
      },
    );
    expect(code).toBe(1);
    expect(stderr.text).toContain("task file already exists");
    expect(stderr.text).toContain("raced with another writer");
  });

  it("prints --help and exits 0", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await main(["--help"], { cwd: dir, stdout, stderr });
    expect(code).toBe(0);
    expect(stdout.text).toContain("Usage: ./scripts/flow-add.ts");
  });
});
