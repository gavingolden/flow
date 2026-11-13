import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalRepoName,
  formatScope,
  identityForState,
  originsFor,
  parseScope,
  readScope,
  scopeCovers,
  scopeMatches,
  scopeOrigin,
  specificity,
  stateInScope,
  updateScope,
} from "./manager-scope";
import { FINISHED_PHASE_SET, writeState, type PipelineState } from "./state";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mscope-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

describe("parseScope", () => {
  it("parses the three kinds and round-trips through formatScope", () => {
    for (const s of ["pipeline:my-slug", "epic:e1", "repo:flow"]) {
      const p = parseScope(s);
      expect(p).not.toBeNull();
      expect(formatScope(p!)).toBe(s);
    }
  });

  it("refuses all and unknown kinds", () => {
    expect(parseScope("all")).toBeNull();
    expect(parseScope("all:x")).toBeNull();
    expect(parseScope("repo:")).toBeNull();
    expect(parseScope("team:x")).toBeNull();
    expect(parseScope("repo:*")).toBeNull();
  });
});

describe("specificity and scopeMatches", () => {
  const id = { slug: "x", epic: "e", repo: "flow" };
  it("ranks pipeline > epic > repo", () => {
    expect(specificity(parseScope("pipeline:x")!)).toBe(3);
    expect(specificity(parseScope("epic:e")!)).toBe(2);
    expect(specificity(parseScope("repo:flow")!)).toBe(1);
  });

  it("matches on the right identity field only", () => {
    expect(scopeMatches(parseScope("pipeline:x")!, id)).toBe(true);
    expect(scopeMatches(parseScope("pipeline:y")!, id)).toBe(false);
    expect(scopeMatches(parseScope("epic:e")!, id)).toBe(true);
    expect(
      scopeMatches(parseScope("epic:e")!, { slug: "x", repo: "flow" }),
    ).toBe(false);
    expect(scopeMatches(parseScope("repo:flow")!, id)).toBe(true);
    expect(scopeMatches(parseScope("repo:other")!, id)).toBe(false);
  });
});

describe("canonicalRepoName", () => {
  it("names a linked worktree after the main checkout", () => {
    const main = path.join(dir, "flow");
    fs.mkdirSync(main);
    git(main, "init", "-q");
    git(
      main,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    );
    const wt = path.join(dir, "flow-feature");
    git(main, "worktree", "add", "-q", wt, "-b", "feature");
    expect(canonicalRepoName(main)).toBe("flow");
    expect(canonicalRepoName(wt)).toBe("flow");
    expect(
      identityForState({
        slug: "s",
        phase: "planning",
        repo: wt,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }).repo,
    ).toBe("flow");
  });

  it("returns null outside a repository and falls back to the basename in identityForState", () => {
    expect(canonicalRepoName(dir)).toBeNull();
    expect(
      identityForState({
        slug: "s",
        phase: "planning",
        repo: "/nonexistent/proj",
        epic: { slug: "e", featureId: "f1" },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({ slug: "s", epic: "e", repo: "proj" });
  });
});

describe("scope.json", () => {
  it("round-trips and reads a missing file as null", () => {
    expect(readScope(dir)).toBeNull();
    const f = {
      version: 1 as const,
      scopes: ["repo:flow"],
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "cli" as const,
    };
    updateScope(() => f, dir);
    expect(readScope(dir)).toEqual(f);
  });

  it("scopeCovers is false with no file, true for an unfinished covered pipeline", () => {
    const stateDir = path.join(dir, "state");
    writeState(
      {
        slug: "x",
        phase: "planning",
        repo: "/r/flow",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      stateDir,
    );
    expect(scopeCovers("x", { stateDir, home: dir })).toBe(false);
    updateScope(
      () => ({
        version: 1,
        scopes: ["repo:flow"],
        updatedAt: "2026-01-01T00:00:00.000Z",
        source: "cli",
      }),
      dir,
    );
    expect(scopeCovers("x", { stateDir, home: dir })).toBe(true);
    expect(scopeCovers("missing", { stateDir, home: dir })).toBe(false);
  });
});

describe("focus notes and updateScope", () => {
  const base = {
    version: 1 as const,
    scopes: ["repo:flow"],
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "cli" as const,
  };

  it("should drop a malformed focus entry without dropping the file", () => {
    fs.writeFileSync(
      path.join(dir, "scope.json"),
      JSON.stringify({
        ...base,
        pendingResolve: true,
        focus: [
          { id: "f1", text: "ship f3", at: "t", from: "launch" },
          { id: "f2", text: 5, at: "t", from: "launch" },
          { id: "f3", text: "x", at: "t", from: "someone" },
          "junk",
        ],
      }),
    );
    expect(readScope(dir)).toEqual({
      ...base,
      pendingResolve: true,
      focus: [{ id: "f1", text: "ship f3", at: "t", from: "launch" }],
    });
  });

  it("should land an entry change and a focus change in one write", () => {
    updateScope(() => base, dir);
    const next = updateScope(
      (cur) => ({
        ...cur!,
        scopes: [...cur!.scopes, "epic:e1"],
        focus: [
          { id: "n1", text: "epic e1 first", at: "t", from: "owner-words" },
        ],
      }),
      dir,
    );
    const onDisk = readScope(dir);
    expect(onDisk).toEqual(next);
    expect(onDisk?.scopes).toEqual(["repo:flow", "epic:e1"]);
    expect(onDisk?.focus).toHaveLength(1);
  });

  it("should pass null to the updater when there is no scope file", () => {
    let seen: unknown = "unset";
    updateScope((cur) => {
      seen = cur;
      return base;
    }, dir);
    expect(seen).toBeNull();
  });
});

describe("per-entry origins", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "scopeorig-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const put = (extra: object) =>
    fs.writeFileSync(
      path.join(home, "scope.json"),
      JSON.stringify({
        version: 1,
        scopes: ["repo:a", "epic:e1"],
        updatedAt: "t",
        source: "cli",
        ...extra,
      }),
    );

  it("round-trips valid origins and drops malformed ones and ones for absent entries", () => {
    put({
      origins: {
        "repo:a": "flag",
        "epic:e1": "bogus",
        "repo:gone": "words",
      },
    });
    expect(readScope(home)?.origins).toEqual({ "repo:a": "flag" });
    put({ origins: "nope" });
    expect(readScope(home)?.origins).toBeUndefined();
  });

  it("falls back to the file-level source for an entry without an origin", () => {
    put({ origins: { "repo:a": "words" } });
    const f = readScope(home);
    expect(scopeOrigin(f, "repo:a")).toBe("words");
    expect(scopeOrigin(f, "epic:e1")).toBe("flag");
    expect(scopeOrigin({ source: "owner-words" }, "x")).toBe("words");
  });

  it("originsFor marks the fresh entries and keeps the others' origin", () => {
    put({ origins: { "repo:a": "flag" } });
    expect(
      originsFor(readScope(home), ["repo:a", "epic:e1"], ["epic:e1"], "words"),
    ).toEqual({ "repo:a": "flag", "epic:e1": "words" });
  });
});

describe("stateInScope", () => {
  const file = {
    version: 1 as const,
    scopes: ["repo:flow"],
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "cli" as const,
  };
  const st = (phase: string): PipelineState => ({
    slug: "x",
    phase,
    repo: "/r/flow",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("should be true for an in-scope merged pipeline", () => {
    expect(FINISHED_PHASE_SET.has("merged")).toBe(true);
    expect(stateInScope(st("merged"), file)).toBe(true);
    expect(stateInScope(st("planning"), file)).toBe(true);
  });

  it("should be false with no file or an unmatched scope", () => {
    expect(stateInScope(st("planning"), null)).toBe(false);
    expect(
      stateInScope(st("planning"), { ...file, scopes: ["repo:other"] }),
    ).toBe(false);
  });
});
