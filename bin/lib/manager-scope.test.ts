import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalRepoName,
  formatScope,
  identityForState,
  parseScope,
  readScope,
  scopeCovers,
  scopeMatches,
  specificity,
  writeScope,
} from "./manager-scope";
import { writeState } from "./state";

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
    writeScope(f, dir);
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
    writeScope(
      {
        version: 1,
        scopes: ["repo:flow"],
        updatedAt: "2026-01-01T00:00:00.000Z",
        source: "cli",
      },
      dir,
    );
    expect(scopeCovers("x", { stateDir, home: dir })).toBe(true);
    expect(scopeCovers("missing", { stateDir, home: dir })).toBe(false);
  });
});
