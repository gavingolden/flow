import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySelfRow, seedEpicBoard, selfMarkEpicRow } from "./epic-self-mark";
import { serializeEpicStatus, type EpicStatusFile } from "./epic-status-schema";
import { writeEpicRunState } from "./epic-run-state";
import { writeState } from "./state";

let root!: string;
let repo!: string;
let stateDir!: string;
let epicsDir!: string;

const EPIC = "demo";
const BOARD = ".flow/epics/demo/status.json";
const IDS = ["a", "b", "c"];

function git(args: string[], cwd = repo) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function gitTry(args: string[], cwd = repo) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function commitAll(msg: string) {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", msg]);
}

function writeBoard(file: EpicStatusFile) {
  fs.mkdirSync(path.join(repo, ".flow/epics/demo"), { recursive: true });
  fs.writeFileSync(path.join(repo, BOARD), serializeEpicStatus(file));
}

const readBoard = (): EpicStatusFile =>
  JSON.parse(fs.readFileSync(path.join(repo, BOARD), "utf8"));

function board(rows: Record<string, EpicStatusFile["features"][string]>) {
  return { version: 1 as const, epicId: "demo-id", features: rows };
}

const notStarted = { status: "not-started" as const };

function bindSlug(slug: string, featureId: string) {
  writeState(
    {
      slug,
      phase: "implementing",
      repo,
      updatedAt: "2026-07-03T00:00:00Z",
      epic: { slug: EPIC, featureId },
    },
    stateDir,
  );
}

function mark(over: Partial<Parameters<typeof selfMarkEpicRow>[0]> = {}) {
  return selfMarkEpicRow({
    cwd: repo,
    stateDir,
    epicsDir,
    commit: true,
    ...over,
  });
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "flow-self-mark-")),
  );
  repo = path.join(root, "repo");
  stateDir = path.join(root, "state");
  epicsDir = path.join(root, "epics");
  fs.mkdirSync(repo);
  fs.mkdirSync(stateDir);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(repo, ".flow/epics/demo"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".flow/epics/demo/manifest.json"),
    JSON.stringify({
      epicId: "demo-id",
      prompt: "p",
      createdAt: "2026-07-03T00:00:00Z",
      features: IDS.map((id) => ({
        id,
        title: id,
        description: id,
        dependsOn: [],
      })),
    }),
  );
  writeBoard(board({ a: notStarted, b: notStarted, c: notStarted }));
  commitAll("init");
  git(["checkout", "-q", "-b", "feat-a"]);
  bindSlug("feat-a", "a");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("applySelfRow", () => {
  it("should flip only the own row and report a change", () => {
    const existing = board({ a: notStarted, b: { status: "merged", pr: 5 } });
    const { file, changed } = applySelfRow(existing, "demo-id", "a", 9);
    expect(changed).toBe(true);
    expect(file.features).toEqual({
      a: { status: "merged", pr: 9 },
      b: { status: "merged", pr: 5 },
    });
  });

  it("should report no change when the row is already merged", () => {
    const existing = board({ a: { status: "merged", pr: 9 } });
    expect(applySelfRow(existing, "demo-id", "a", 9).changed).toBe(false);
  });

  it("should seed an absent board with every feature not-started", () => {
    const { file } = applySelfRow(null, "demo-id", "b", 3, IDS);
    expect(file.features).toEqual({
      a: notStarted,
      b: { status: "merged", pr: 3 },
      c: notStarted,
    });
  });
});

describe("selfMarkEpicRow", () => {
  it("should write and commit only the own row, leaving others byte-identical", () => {
    const before = fs.readFileSync(path.join(repo, BOARD), "utf8");
    const r = mark({ slug: "feat-a", pr: 11 });
    expect(r).toMatchObject({
      outcome: "written",
      featureId: "a",
      committed: true,
    });
    const after = readBoard();
    expect(after.features).toEqual({
      a: { status: "merged", pr: 11 },
      b: notStarted,
      c: notStarted,
    });
    expect(before.split("\n").filter((l) => l.includes('"b"'))).toEqual(
      fs
        .readFileSync(path.join(repo, BOARD), "utf8")
        .split("\n")
        .filter((l) => l.includes('"b"')),
    );
    expect(git(["log", "-1", "--format=%s"]).trim()).toBe(
      "chore(epic): mark a merged on the demo board (#11)",
    );
    expect(git(["show", "--name-only", "--format=", "HEAD"]).trim()).toBe(
      BOARD,
    );
  });

  it("should be unchanged and make no commit on a rerun", () => {
    mark({ slug: "feat-a", pr: 11 });
    const head = git(["rev-parse", "HEAD"]);
    const r = mark({ slug: "feat-a", pr: 11 });
    expect(r).toMatchObject({ outcome: "unchanged", committed: false });
    expect(git(["rev-parse", "HEAD"])).toBe(head);
  });

  it("should return not-bound for a slug with no epic binding", () => {
    expect(mark({ slug: "other", pr: 1 }).outcome).toBe("not-bound");
  });

  it("should refuse a binding conflict", () => {
    writeEpicRunState(
      {
        epicSlug: EPIC,
        repo,
        manifestPath: "m",
        manifestSha: "s",
        createdAt: "x",
        updatedAt: "x",
        features: { b: { slug: "feat-a", launchedAt: "x" } },
      },
      epicsDir,
    );
    expect(mark({ slug: "feat-a", pr: 1 })).toMatchObject({
      outcome: "refused",
      reason: "binding-conflict",
    });
  });

  it("should refuse on the base branch", () => {
    git(["checkout", "-q", "main"]);
    expect(mark({ slug: "feat-a", pr: 1 })).toMatchObject({
      outcome: "refused",
      reason: "on-base-branch",
    });
  });

  it("should refuse a detached HEAD", () => {
    git(["checkout", "-q", "--detach"]);
    expect(mark({ slug: "feat-a", pr: 1 })).toMatchObject({
      reason: "detached-head",
    });
  });

  it("should refuse when no PR number is known", () => {
    expect(mark({ slug: "feat-a" })).toMatchObject({ reason: "no-pr" });
  });

  it("should refuse an unknown feature id", () => {
    bindSlug("feat-a", "zzz");
    expect(mark({ slug: "feat-a", pr: 1 })).toMatchObject({
      reason: "unknown-feature",
    });
  });

  it("should refuse an epicId mismatch", () => {
    writeBoard({ ...board({ a: notStarted }), epicId: "other" });
    expect(mark({ slug: "feat-a", pr: 1 })).toMatchObject({
      reason: "epic-id-mismatch",
    });
  });

  it("should refuse an unreadable board and manifest", () => {
    fs.writeFileSync(path.join(repo, BOARD), "{not json");
    expect(mark({ slug: "feat-a", pr: 1 })).toMatchObject({
      reason: "board-unreadable",
    });
    fs.rmSync(path.join(repo, ".flow/epics/demo/manifest.json"));
    expect(mark({ slug: "feat-a", pr: 1 })).toMatchObject({
      reason: "manifest-unreadable",
    });
  });

  it("should create an absent board seeded with every feature", () => {
    git(["rm", "-q", BOARD]);
    git(["commit", "-q", "-m", "drop board"]);
    mark({ slug: "feat-a", pr: 2 });
    expect(readBoard().features).toEqual({
      a: { status: "merged", pr: 2 },
      b: notStarted,
      c: notStarted,
    });
  });

  it("should accept the explicit form for a merged PR and refuse a foreign open PR", () => {
    const gh = (state: string, head: string) => () => ({
      stdout: JSON.stringify({ state, headRefName: head }),
      stderr: "",
      exitCode: 0,
    });
    const explicit = { epicSlug: EPIC, featureId: "a", pr: 7 };
    expect(mark({ explicit, gh: gh("OPEN", "someone-else") })).toMatchObject({
      reason: "pr-not-merged",
    });
    expect(mark({ explicit, gh: gh("MERGED", "x") })).toMatchObject({
      outcome: "written",
      pr: 7,
    });
  });

  it("should push with `git push origin HEAD`, never forced", () => {
    const calls: string[][] = [];
    const real = (argv: string[], cwd: string) => {
      if (argv[0] === "push") {
        calls.push(argv);
        return { stdout: "", stderr: "To origin\n", exitCode: 0 };
      }
      const r = gitTry(argv, cwd);
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.status ?? -1,
      };
    };
    const r = mark({ slug: "feat-a", pr: 4, push: true, git: real });
    expect(calls).toEqual([["push", "origin", "HEAD"]]);
    expect(r).toMatchObject({ committed: true, pushed: true });
  });

  it("should report push-failed with the commit kept", () => {
    const real = (argv: string[], cwd: string) => {
      if (argv[0] === "push") {
        return { stdout: "", stderr: "denied\n", exitCode: 1 };
      }
      const r = gitTry(argv, cwd);
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.status ?? -1,
      };
    };
    expect(
      mark({ slug: "feat-a", pr: 4, push: true, git: real }),
    ).toMatchObject({
      outcome: "refused",
      reason: "push-failed",
      committed: true,
    });
  });
});

describe("concurrent sibling branches", () => {
  it("should merge two branches flipping different rows with no conflict", () => {
    git(["checkout", "-q", "main"]);
    git(["checkout", "-q", "-b", "feat-b"]);
    bindSlug("feat-b", "b");
    mark({ slug: "feat-b", pr: 22 });
    git(["checkout", "-q", "feat-a"]);
    mark({ slug: "feat-a", pr: 21 });
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--no-edit", "feat-a"]);
    const merged = gitTry(["merge", "-q", "--no-edit", "feat-b"]);
    expect(merged.status).toBe(0);
    expect(readBoard().features).toEqual({
      a: { status: "merged", pr: 21 },
      b: { status: "merged", pr: 22 },
      c: notStarted,
    });
  });
});

describe("--resolve-conflict", () => {
  it("should yield the base side plus the own row, staged, with no markers", () => {
    // Base has no board yet, so both sides add it (add/add conflict).
    git(["checkout", "-q", "main"]);
    git(["rm", "-q", BOARD]);
    git(["commit", "-q", "-m", "no board on base"]);
    git(["checkout", "-q", "feat-a"]);
    git(["rebase", "-q", "main"]);
    mark({ slug: "feat-a", pr: 21 });
    git(["checkout", "-q", "main"]);
    writeBoard(
      board({ a: notStarted, b: { status: "merged", pr: 22 }, c: notStarted }),
    );
    commitAll("board lands on base with b merged");
    git(["checkout", "-q", "feat-a"]);
    expect(gitTry(["merge", "main"]).status).not.toBe(0);

    const r = mark({ slug: "feat-a", pr: 21, resolveConflict: true });

    expect(r).toMatchObject({ outcome: "written", committed: false });
    const text = fs.readFileSync(path.join(repo, BOARD), "utf8");
    expect(text).not.toContain("<<<<<<<");
    expect(readBoard().features).toEqual({
      a: { status: "merged", pr: 21 },
      b: { status: "merged", pr: 22 },
      c: notStarted,
    });
    expect(git(["ls-files", "-u", "--", BOARD]).trim()).toBe("");
    expect(git(["diff", "--name-only", "--cached"]).trim()).toBe(BOARD);
  });

  it("should refuse when the board is not conflicted", () => {
    expect(
      mark({ slug: "feat-a", pr: 1, resolveConflict: true }),
    ).toMatchObject({ reason: "not-conflicted" });
  });
});

describe("seedEpicBoard", () => {
  it("should write an all-not-started board without a commit", () => {
    git(["rm", "-q", BOARD]);
    git(["commit", "-q", "-m", "drop board"]);
    const head = git(["rev-parse", "HEAD"]);
    const r = seedEpicBoard({ cwd: repo, epicSlug: EPIC });
    expect(r).toMatchObject({ outcome: "written", committed: false });
    expect(readBoard()).toEqual(
      board({ a: notStarted, b: notStarted, c: notStarted }),
    );
    expect(git(["rev-parse", "HEAD"])).toBe(head);
  });

  it("should leave an existing board alone and refuse on the base branch", () => {
    expect(seedEpicBoard({ cwd: repo, epicSlug: EPIC }).outcome).toBe(
      "unchanged",
    );
    git(["checkout", "-q", "main"]);
    expect(seedEpicBoard({ cwd: repo, epicSlug: EPIC })).toMatchObject({
      reason: "on-base-branch",
    });
  });
});
