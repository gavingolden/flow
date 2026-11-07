import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGithubQuery,
  defaultExec,
  fetchGithubSnapshot,
  listRepoStates,
  makeStrictSameRepository,
  parseGithubResponse,
  parseWorktreeList,
  probeGitRefs,
  resolveGithubRepo,
  type ExecFn,
} from "./epic-manage-observe";
import { writeState, type PipelineState } from "./state";

let tmp!: string;

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "flow-observe-")),
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
const fakeExec =
  (handler: (cmd: string, args: string[]) => ReturnType<ExecFn>): ExecFn =>
  (cmd, args) =>
    handler(cmd, args);

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function initRepo(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

describe("buildGithubQuery", () => {
  it("emits one aliased request: open PRs, each watched PR, each branch", () => {
    const q = buildGithubQuery({
      owner: "me",
      name: "flow",
      watchedPrs: [12, 12, 40],
      branches: ["f1-epic", 'we"ird\\branch'],
    });
    expect(q).toContain('repository(owner: "me", name: "flow")');
    expect(q).toContain("open: pullRequests(states: OPEN, first: 100");
    expect(q).toContain("pr12: pullRequest(number: 12)");
    expect(q).toContain("pr40: pullRequest(number: 40)");
    expect(q.match(/pr12:/g)).toHaveLength(1);
    expect(q).toContain('br0: pullRequests(headRefName: "f1-epic"');
    expect(q).toContain('br1: pullRequests(headRefName: "we\\"ird\\\\branch"');
    expect(q).not.toContain("statusCheckRollup");
    expect(q).not.toMatch(/files|changedFiles/);
  });
});

describe("parseGithubResponse", () => {
  const node = (n: number, state: string) => ({
    number: n,
    headRefName: `b${n}`,
    state,
    mergedAt: state === "MERGED" ? "2026-10-26T00:00:00Z" : null,
  });

  it("flattens open/watched/branch aliases and dedupes by number", () => {
    const prs = parseGithubResponse(
      JSON.stringify({
        data: {
          repository: {
            open: {
              nodes: [node(1, "OPEN"), node(2, "OPEN")],
            },
            pr2: node(2, "OPEN"),
            pr3: node(3, "MERGED"),
            br0: { nodes: [node(4, "OPEN")] },
          },
        },
      }),
    );
    expect(prs?.map((p) => [p.number, p.state])).toEqual([
      [1, "OPEN"],
      [2, "OPEN"],
      [3, "MERGED"],
      [4, "OPEN"],
    ]);
    expect(prs?.find((p) => p.number === 3)?.mergedAt).toBe(
      "2026-10-26T00:00:00Z",
    );
  });

  it("uses partial data when one watched PR is unresolvable (null alias + errors)", () => {
    const prs = parseGithubResponse(
      JSON.stringify({
        data: {
          repository: { open: { nodes: [node(1, "OPEN")] }, pr999: null },
        },
        errors: [
          {
            message:
              "Could not resolve to a PullRequest with the number of 999.",
          },
        ],
      }),
    );
    expect(prs?.map((p) => p.number)).toEqual([1]);
  });

  it("returns null for garbage, a missing repository, or an empty body", () => {
    expect(parseGithubResponse("not json")).toBeNull();
    expect(parseGithubResponse("")).toBeNull();
    expect(
      parseGithubResponse(JSON.stringify({ data: { repository: null } })),
    ).toBeNull();
    expect(
      parseGithubResponse(JSON.stringify({ errors: [{ message: "x" }] })),
    ).toBeNull();
  });
});

describe("resolveGithubRepo / fetchGithubSnapshot", () => {
  it("resolves owner/name once from gh repo view", async () => {
    const exec = fakeExec(async () =>
      ok('{"owner":{"login":"me"},"name":"flow"}'),
    );
    expect(await resolveGithubRepo("/r", exec)).toEqual({
      owner: "me",
      name: "flow",
    });
    expect(
      await resolveGithubRepo(
        "/r",
        fakeExec(async () => ({ exitCode: 1, stdout: "", stderr: "no" })),
      ),
    ).toBeNull();
  });

  const input = {
    repo: "/r",
    owner: "me",
    name: "flow",
    watchedPrs: [1],
    branches: [],
    now: () => 777,
  };

  it("a non-zero gh exit with usable partial data is still an ok snapshot", async () => {
    const body = JSON.stringify({
      data: { repository: { open: { nodes: [] }, pr9: null } },
      errors: [{ message: "x" }],
    });
    const snap = await fetchGithubSnapshot({
      ...input,
      exec: fakeExec(async () => ({
        exitCode: 1,
        stdout: body,
        stderr: "boom",
      })),
    });
    expect(snap).toEqual({ ok: true, at: 777, prs: [] });
  });

  it("a timeout surfaces as ok:false", async () => {
    const snap = await fetchGithubSnapshot({
      ...input,
      exec: fakeExec(async () => ({
        exitCode: -1,
        stdout: "",
        stderr: "",
        timedOut: true,
      })),
    });
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.error).toMatch(/timed out/);
  });

  it("an unparseable response surfaces the first stderr line", async () => {
    const snap = await fetchGithubSnapshot({
      ...input,
      exec: fakeExec(async () => ({
        exitCode: 4,
        stdout: "",
        stderr:
          "gh: To get started with GitHub CLI, please run: gh auth login\nmore",
      })),
    });
    expect(snap).toMatchObject({
      ok: false,
      error: expect.stringContaining("gh auth login"),
    });
  });

  it("passes the query to gh api graphql with a timeout", async () => {
    const seen: { args: string[]; timeout: number }[] = [];
    await fetchGithubSnapshot({
      ...input,
      exec: async (_c, args, _cwd, timeout) => {
        seen.push({ args, timeout });
        return ok(JSON.stringify({ data: { repository: {} } }));
      },
    });
    expect(seen[0]!.args.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
    expect(seen[0]!.args[3]).toMatch(/^query=query \{/);
    expect(seen[0]!.timeout).toBe(30_000);
  });
});

describe("defaultExec", () => {
  it("kills a hung child at the timeout and reports timedOut", async () => {
    const started = Date.now();
    const r = await defaultExec("sleep", ["5"], tmp, 100);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("captures stdout and the exit code", async () => {
    const r = await defaultExec("sh", ["-c", "echo hi; exit 3"], tmp, 5000);
    expect(r).toMatchObject({ exitCode: 3, stdout: "hi\n" });
  });

  it("a missing binary resolves (never rejects) with a non-zero exit", async () => {
    const r = await defaultExec("flow-no-such-binary", [], tmp, 1000);
    expect(r.exitCode).not.toBe(0);
  });
});

describe("repo scoping", () => {
  const stateFor = (slug: string, repo: string): PipelineState => ({
    slug,
    phase: "implementing",
    repo,
    updatedAt: "2026-10-26T00:00:00Z",
  });

  it("another repo's state never counts as this repo's", () => {
    const mine = initRepo("mine");
    const other = initRepo("other");
    const stateDir = path.join(tmp, "state");
    writeState(stateFor("a", mine), stateDir);
    writeState(stateFor("b", other), stateDir);
    const same = makeStrictSameRepository(mine);
    expect(listRepoStates(same, stateDir).map((s) => s.slug)).toEqual(["a"]);
  });

  it("a linked worktree of the same repo counts as the same repo", () => {
    const mine = initRepo("mine");
    git(
      mine,
      "-c",
      "user.email=a@b.c",
      "-c",
      "user.name=x",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    );
    const wt = path.join(tmp, "wt");
    git(mine, "worktree", "add", "-q", "-b", "side", wt);
    expect(makeStrictSameRepository(wt)(mine)).toBe(true);
  });

  it("fails CLOSED when the caller's git common dir is unresolvable", () => {
    const mine = initRepo("mine");
    const notGit = path.join(tmp, "plain");
    fs.mkdirSync(notGit);
    const strict = makeStrictSameRepository(notGit);
    expect(strict(mine)).toBe(false);
    expect(strict(notGit)).toBe(false);
  });

  it("an empty or whitespace repo path matches nothing, even with a resolvable caller", () => {
    const strict = makeStrictSameRepository(initRepo("mine"));
    expect(strict("")).toBe(false);
    expect(strict("   ")).toBe(false);
  });
});

describe("git refs", () => {
  const PORCELAIN = `worktree /r
HEAD aaa
branch refs/heads/main

worktree /w/f1
HEAD bbb
branch refs/heads/f1-epic-sequencer-2

worktree /w/det
HEAD ccc
detached
`;

  it("parses worktree --porcelain including detached heads", () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual([
      { path: "/r", branch: "main" },
      { path: "/w/f1", branch: "f1-epic-sequencer-2" },
      { path: "/w/det" },
    ]);
  });

  it("collects branches, worktree branches/paths, and the per-worktree branch", async () => {
    const exec = fakeExec(async (_c, args) =>
      args[0] === "for-each-ref"
        ? ok(
            "refs/heads/main\nrefs/heads/f1\nrefs/remotes/origin/f2\nrefs/remotes/origin/HEAD\n",
          )
        : ok(PORCELAIN),
    );
    const refs = await probeGitRefs("/r", exec);
    expect([...refs!.branches].sort()).toEqual(["f1", "f2", "main"]);
    expect(refs!.worktreeBranches.has("f1-epic-sequencer-2")).toBe(true);
    expect(refs!.worktreePaths.has("/w/det")).toBe(true);
    expect(refs!.branchByWorktree.get("/w/f1")).toBe("f1-epic-sequencer-2");
    expect(refs!.branchByWorktree.has("/w/det")).toBe(false);
  });

  it("returns null when either probe fails or times out", async () => {
    expect(
      await probeGitRefs(
        "/r",
        fakeExec(async () => ({
          exitCode: -1,
          stdout: "",
          stderr: "",
          timedOut: true,
        })),
      ),
    ).toBeNull();
  });
});
