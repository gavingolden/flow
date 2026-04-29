import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTaskInput } from "./git.js";

describe("resolveTaskInput", () => {
  let repoRoot: string;
  let tasksDir: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-resolve-"));
    tasksDir = path.join(repoRoot, ".orchestrator", "tasks");
    await fs.mkdir(path.join(tasksDir, "archive"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const writeTask = async (rel: string): Promise<string> => {
    const abs = path.join(tasksDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "---\nid: x\n---\n");
    return abs;
  };

  it("resolves a bare id to tasks/<id>.md", async () => {
    const expected = await writeTask("2026-04-29-foo.md");
    const got = await resolveTaskInput("2026-04-29-foo", repoRoot);
    expect(got).toEqual({ kind: "ok", path: expected });
  });

  it("resolves a bare id to tasks/archive/<id>.md", async () => {
    const expected = await writeTask("archive/2026-04-29-foo.md");
    const got = await resolveTaskInput("2026-04-29-foo", repoRoot);
    expect(got).toEqual({ kind: "ok", path: expected });
  });

  it("returns not-found for a bare id with no matching .md", async () => {
    const got = await resolveTaskInput("2026-04-29-missing", repoRoot);
    expect(got).toEqual({
      kind: "not-found",
      input: "2026-04-29-missing",
      inputKind: "id",
    });
  });

  it("resolves an absolute path to a top-level task .md", async () => {
    const expected = await writeTask("2026-04-29-foo.md");
    const got = await resolveTaskInput(expected, repoRoot);
    expect(got).toEqual({ kind: "ok", path: expected });
  });

  it("resolves an absolute path to an archived task .md", async () => {
    const expected = await writeTask("archive/2026-04-29-foo.md");
    const got = await resolveTaskInput(expected, repoRoot);
    expect(got).toEqual({ kind: "ok", path: expected });
  });

  it("resolves a relative path against the injected cwd", async () => {
    const expected = await writeTask("2026-04-29-foo.md");
    const got = await resolveTaskInput(
      "./.orchestrator/tasks/2026-04-29-foo.md",
      repoRoot,
      repoRoot,
    );
    expect(got).toEqual({ kind: "ok", path: expected });
  });

  it("resolves a relative path from a nested cwd", async () => {
    const expected = await writeTask("2026-04-29-foo.md");
    const got = await resolveTaskInput(
      "tasks/2026-04-29-foo.md",
      repoRoot,
      path.join(repoRoot, ".orchestrator"),
    );
    expect(got).toEqual({ kind: "ok", path: expected });
  });

  it("resolves a bare .md filename relative to cwd", async () => {
    // The user is sitting in `.orchestrator/tasks/` (e.g. tab-completed
    // `<id>.md`) and types `flow run <id>.md`. The input has no path
    // separator, no leading `.` or `~`, isn't absolute — but it ends in
    // `.md`, so the resolver must treat it as a path, not a bare id
    // (which would look up `<id>.md.md`).
    const expected = await writeTask("2026-04-29-foo.md");
    const got = await resolveTaskInput(
      "2026-04-29-foo.md",
      repoRoot,
      tasksDir,
    );
    expect(got).toEqual({ kind: "ok", path: expected });
  });

  it("expands ~ against os.homedir()", async () => {
    // Build a fake home with the tasks layout under it so the tilde
    // expansion lands on a real on-disk file. We don't trust the real
    // os.homedir() to contain anything specific.
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "flow-resolve-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const homeRepo = path.join(fakeHome, "repo");
      const homeTasks = path.join(homeRepo, ".orchestrator", "tasks");
      await fs.mkdir(homeTasks, { recursive: true });
      const expected = path.join(homeTasks, "2026-04-29-foo.md");
      await fs.writeFile(expected, "---\nid: x\n---\n");
      const got = await resolveTaskInput(
        "~/repo/.orchestrator/tasks/2026-04-29-foo.md",
        homeRepo,
      );
      expect(got).toEqual({ kind: "ok", path: expected });
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns not-found for an absolute path that does not exist", async () => {
    const missing = path.join(tasksDir, "2026-04-29-nope.md");
    const got = await resolveTaskInput(missing, repoRoot);
    expect(got).toEqual({
      kind: "not-found",
      input: missing,
      inputKind: "path",
    });
  });

  it("returns invalid for a .md outside the tasks dir", async () => {
    const outside = path.join(repoRoot, "elsewhere.md");
    await fs.writeFile(outside, "x");
    const got = await resolveTaskInput(outside, repoRoot);
    expect(got.kind).toBe("invalid");
    if (got.kind === "invalid") {
      expect(got.reason).toMatch(/must live under/);
    }
  });

  it("returns invalid for a .md inside a phase subdir", async () => {
    await writeTask("2026-04-29-foo.md");
    const planDir = path.join(tasksDir, "2026-04-29-foo-plan");
    await fs.mkdir(planDir, { recursive: true });
    const inside = path.join(planDir, "prd.md");
    await fs.writeFile(inside, "x");
    const got = await resolveTaskInput(inside, repoRoot);
    expect(got.kind).toBe("invalid");
    if (got.kind === "invalid") {
      expect(got.reason).toMatch(/top-level task .md files/);
    }
  });

  it("returns invalid for a non-.md file under tasks/", async () => {
    const stray = path.join(tasksDir, "notes.txt");
    await fs.writeFile(stray, "x");
    const got = await resolveTaskInput(stray, repoRoot);
    expect(got.kind).toBe("invalid");
    if (got.kind === "invalid") {
      expect(got.reason).toMatch(/expected a \.md task file/);
    }
  });

  it("resolves a phase subdir (-plan) to its sibling .md", async () => {
    const expected = await writeTask("2026-04-29-foo.md");
    const planDir = path.join(tasksDir, "2026-04-29-foo-plan");
    await fs.mkdir(planDir, { recursive: true });
    const got = await resolveTaskInput(planDir, repoRoot);
    expect(got).toEqual({ kind: "ok", path: expected });
  });

  it("resolves a phase subdir (-implement) to its sibling .md", async () => {
    const expected = await writeTask("2026-04-29-foo.md");
    const implDir = path.join(tasksDir, "2026-04-29-foo-implement");
    await fs.mkdir(implDir, { recursive: true });
    const got = await resolveTaskInput(implDir, repoRoot);
    expect(got).toEqual({ kind: "ok", path: expected });
  });

  it("resolves the runtime task dir (no suffix) to its sibling .md", async () => {
    const expected = await writeTask("2026-04-29-foo.md");
    const runDir = path.join(tasksDir, "2026-04-29-foo");
    await fs.mkdir(runDir, { recursive: true });
    const got = await resolveTaskInput(runDir, repoRoot);
    expect(got).toEqual({ kind: "ok", path: expected });
  });

  it("returns not-found for a directory with no matching sibling .md", async () => {
    const orphan = path.join(tasksDir, "2026-04-29-orphan-plan");
    await fs.mkdir(orphan, { recursive: true });
    const got = await resolveTaskInput(orphan, repoRoot);
    expect(got).toEqual({
      kind: "not-found",
      input: orphan,
      inputKind: "path",
    });
  });

  it("returns ambiguous when two sibling stems both prefix-match", async () => {
    const fooMd = await writeTask("2026-04-29-foo.md");
    const fooBarMd = await writeTask("2026-04-29-foo-bar.md");
    const dir = path.join(tasksDir, "2026-04-29-foo-bar-plan");
    await fs.mkdir(dir, { recursive: true });
    const got = await resolveTaskInput(dir, repoRoot);
    expect(got.kind).toBe("ambiguous");
    if (got.kind === "ambiguous") {
      // Candidates must be returned sorted so the error output is
      // deterministic across filesystems / `readdir` orderings.
      expect(got.candidates).toEqual([fooBarMd, fooMd].sort());
    }
  });

  it("returns invalid for a directory two levels under tasks/", async () => {
    await writeTask("2026-04-29-foo.md");
    const nested = path.join(tasksDir, "2026-04-29-foo-plan", "nested");
    await fs.mkdir(nested, { recursive: true });
    const got = await resolveTaskInput(nested, repoRoot);
    expect(got.kind).toBe("invalid");
    if (got.kind === "invalid") {
      expect(got.reason).toMatch(/direct child/);
    }
  });

  it("returns invalid for a directory outside tasks/", async () => {
    const src = path.join(repoRoot, "src");
    await fs.mkdir(src, { recursive: true });
    const got = await resolveTaskInput(src, repoRoot);
    expect(got.kind).toBe("invalid");
    if (got.kind === "invalid") {
      expect(got.reason).toMatch(/under/);
    }
  });
});
