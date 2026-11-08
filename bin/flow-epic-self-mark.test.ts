import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./flow-epic-self-mark";
import { serializeEpicStatus } from "./lib/epic-status-schema";
import { writeState } from "./lib/state";

let root!: string;
let repo!: string;
let stateDir!: string;
let epicsDir!: string;
let out!: string[];
let err!: string[];

const BOARD = ".flow/epics/demo/status.json";

function git(args: string[]) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function bind(extra: Record<string, unknown> = {}) {
  writeState(
    {
      slug: "feat-a",
      phase: "implementing",
      repo,
      updatedAt: "2026-07-03T00:00:00Z",
      epic: { slug: "demo", featureId: "a" },
      ...extra,
    },
    stateDir,
  );
}

const ghReply =
  (payload: unknown, exitCode = 0) =>
  () => ({
    stdout: JSON.stringify(payload),
    stderr: "",
    exitCode,
  });

const run = (argv: string[], deps: Parameters<typeof main>[1] = {}) =>
  main(argv, { cwd: repo, stateDir, epicsDir, env: {}, ...deps });

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "flow-sm-cli-")),
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
      features: ["a", "b"].map((id) => ({
        id,
        title: id,
        description: id,
        dependsOn: [],
      })),
    }),
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  git(["checkout", "-q", "-b", "feat-a"]);
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    err.push(String(s));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("flow-epic-self-mark usage", () => {
  it.each([
    [["--bogus"]],
    [["--seed"]],
    [["--epic-slug", "demo"]],
    [["--feature", "a"]],
    [["--pr", "abc"]],
    [["--epic-slug", "demo", "--feature", "a", "--pr", "3", "--slug", "x"]],
  ])("should exit 2 for %j", (argv) => {
    expect(run(argv)).toBe(2);
    expect(err.join("")).toContain("usage:");
  });
});

describe("flow-epic-self-mark ambient form", () => {
  it("should exit 0 silently for a pipeline with no epic binding", () => {
    expect(run(["--slug", "nobody", "--commit"])).toBe(0);
    expect(out.join("")).toBe("");
  });

  it("should exit 0 when no slug can be resolved", () => {
    expect(run(["--commit"])).toBe(0);
  });

  it("should write to the state's worktree rather than the shell cwd", () => {
    bind({ worktree: repo, pr: 5 });
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    expect(run(["--slug", "feat-a", "--commit"], { cwd: elsewhere })).toBe(0);
    const board = JSON.parse(fs.readFileSync(path.join(repo, BOARD), "utf8"));
    expect(board.features).toEqual({
      a: { status: "merged", pr: 5 },
      b: { status: "not-started" },
    });
    expect(git(["log", "-1", "--format=%s"]).trim()).toContain("(#5)");
  });

  it("should resolve the slug from $FLOW_SLUG", () => {
    bind({ pr: 5 });
    expect(run(["--commit"], { env: { FLOW_SLUG: "feat-a" } })).toBe(0);
    expect(fs.existsSync(path.join(repo, BOARD))).toBe(true);
  });

  it("should fall back to gh for the PR number when state has none", () => {
    bind();
    const gh = vi.fn(ghReply({ number: 8 }));
    expect(run(["--slug", "feat-a"], { gh })).toBe(0);
    expect(gh).toHaveBeenCalledWith([
      "pr",
      "view",
      "feat-a",
      "--json",
      "number",
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(repo, BOARD), "utf8")).features.a.pr,
    ).toBe(8);
  });

  it("should exit 1 with the reason and a remedy when refused", () => {
    bind({ pr: 5 });
    git(["checkout", "-q", "main"]);
    expect(run(["--slug", "feat-a", "--json"])).toBe(1);
    expect(JSON.parse(out.join("")).reason).toBe("on-base-branch");
    expect(err.join("")).toContain("remedy:");
  });
});

describe("flow-epic-self-mark explicit form", () => {
  const argv = ["--epic-slug", "demo", "--feature", "a", "--pr", "3"];

  it("should write a row for a merged PR", () => {
    expect(
      run(argv, { gh: ghReply({ state: "MERGED", headRefName: "x" }) }),
    ).toBe(0);
    expect(fs.existsSync(path.join(repo, BOARD))).toBe(true);
  });

  it("should refuse a PR that is neither merged nor this branch's own", () => {
    expect(
      run(argv, { gh: ghReply({ state: "OPEN", headRefName: "other" }) }),
    ).toBe(1);
    expect(err.join("")).toContain("pr-not-merged");
  });
});

describe("flow-epic-self-mark --seed", () => {
  it("should write the all-not-started board and nothing else", () => {
    expect(run(["--seed", "--epic-slug", "demo"])).toBe(0);
    expect(fs.readFileSync(path.join(repo, BOARD), "utf8")).toBe(
      serializeEpicStatus({
        version: 1,
        epicId: "demo-id",
        features: {
          a: { status: "not-started" },
          b: { status: "not-started" },
        },
      }),
    );
    expect(git(["log", "--oneline"]).trim().split("\n")).toHaveLength(1);
  });
});

describe("flow-epic-self-mark.ts is executable", () => {
  it("has the exec bit set", () => {
    const mode = fs.statSync(
      path.resolve(__dirname, "flow-epic-self-mark.ts"),
    ).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});
