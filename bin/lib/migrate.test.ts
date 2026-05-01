/**
 * Tests for `flow migrate`. Each test stands up a temp directory shaped
 * like a flow-installed repo, builds a plan, and checks that --apply
 * removes the right things and is idempotent.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execaSync } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrate, buildPlan } from "./migrate";

let repoRoot!: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-migrate-"));
  execaSync("git", ["init", "-q", "--initial-branch=main", repoRoot]);
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function writeGitignoreFixture(skillsLines: string[], scriptsLines: string[]) {
  const lines: string[] = [];
  if (skillsLines.length > 0) {
    lines.push("# managed by flow install-skills");
    lines.push("# (flow-managed; do not edit by hand)");
    lines.push(...skillsLines);
    lines.push("# end flow install-skills");
    lines.push("");
  }
  if (scriptsLines.length > 0) {
    lines.push("# managed by flow install-scripts");
    lines.push("# (symlinks resolve to absolute paths and aren't portable)");
    lines.push(...scriptsLines);
    lines.push("# end flow install-scripts");
  }
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), lines.join("\n") + "\n");
}

function createManagedSymlinks(paths: string[]) {
  for (const rel of paths) {
    const cleaned = rel.replace(/^\//, "");
    const abs = path.join(repoRoot, cleaned);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.symlinkSync("/nonexistent/source", abs);
  }
}

describe("flow migrate", () => {
  it("buildPlan: returns empty plan when no managed blocks present", () => {
    const plan = buildPlan(repoRoot);
    expect(plan.symlinksToRemove).toEqual([]);
    expect(plan.realFilesEncountered).toEqual([]);
    expect(plan.blocks.every((b) => !b.present)).toBe(true);
  });

  it("buildPlan: enumerates symlinks tracked in managed blocks", () => {
    writeGitignoreFixture(["/.claude/skills/alpha"], ["/scripts/foo.ts"]);
    createManagedSymlinks(["/.claude/skills/alpha", "/scripts/foo.ts"]);
    const plan = buildPlan(repoRoot);
    expect(plan.symlinksToRemove).toHaveLength(2);
    expect(plan.realFilesEncountered).toEqual([]);
  });

  it("buildPlan: distinguishes real files from symlinks at managed paths", () => {
    writeGitignoreFixture([], ["/scripts/foo.ts"]);
    fs.mkdirSync(path.join(repoRoot, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "scripts/foo.ts"), "user-replaced content");
    const plan = buildPlan(repoRoot);
    expect(plan.symlinksToRemove).toEqual([]);
    expect(plan.realFilesEncountered).toHaveLength(1);
  });

  it("dry-run does not modify the filesystem", () => {
    writeGitignoreFixture(["/.claude/skills/alpha"], ["/scripts/foo.ts"]);
    createManagedSymlinks(["/.claude/skills/alpha", "/scripts/foo.ts"]);
    const before = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    const code = runMigrate({}, repoRoot);
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8")).toBe(before);
    expect(fs.lstatSync(path.join(repoRoot, ".claude/skills/alpha")).isSymbolicLink()).toBe(true);
  });

  it("--apply removes symlinks and strips managed gitignore blocks", () => {
    writeGitignoreFixture(["/.claude/skills/alpha"], ["/scripts/foo.ts"]);
    createManagedSymlinks(["/.claude/skills/alpha", "/scripts/foo.ts"]);

    runMigrate({ apply: true }, repoRoot);

    expect(fs.existsSync(path.join(repoRoot, ".claude/skills/alpha"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "scripts/foo.ts"))).toBe(false);
    const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    expect(gitignore).not.toContain("# managed by flow install-skills");
    expect(gitignore).not.toContain("# managed by flow install-scripts");
  });

  it("--apply is idempotent (a second run is a no-op)", () => {
    writeGitignoreFixture(["/.claude/skills/alpha"], []);
    createManagedSymlinks(["/.claude/skills/alpha"]);
    runMigrate({ apply: true }, repoRoot);
    const after = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    runMigrate({ apply: true }, repoRoot);
    expect(fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8")).toBe(after);
  });

  it("--apply leaves real files untouched (never deletes user content)", () => {
    writeGitignoreFixture([], ["/scripts/foo.ts"]);
    fs.mkdirSync(path.join(repoRoot, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "scripts/foo.ts"), "user content");

    runMigrate({ apply: true }, repoRoot);

    expect(fs.readFileSync(path.join(repoRoot, "scripts/foo.ts"), "utf8")).toBe("user content");
  });

  it("refuses to proceed when non-terminal tasks exist in .orchestrator/tasks/", () => {
    writeGitignoreFixture(["/.claude/skills/alpha"], []);
    createManagedSymlinks(["/.claude/skills/alpha"]);
    const tasksDir = path.join(repoRoot, ".orchestrator", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task-1.md"), "---\nstatus: implementing\n---\n");

    const code = runMigrate({}, repoRoot);
    expect(code).toBe(1);
  });

  it("--include-orchestrator removes .orchestrator/ on apply", () => {
    fs.mkdirSync(path.join(repoRoot, ".orchestrator", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".orchestrator", "tasks", "old.md"), "---\nstatus: merged\n---\n");

    runMigrate({ apply: true, includeOrchestrator: true }, repoRoot);

    expect(fs.existsSync(path.join(repoRoot, ".orchestrator"))).toBe(false);
  });

  it("default --apply preserves .orchestrator/ even without flag", () => {
    fs.mkdirSync(path.join(repoRoot, ".orchestrator", "tasks"), { recursive: true });
    runMigrate({ apply: true }, repoRoot);
    expect(fs.existsSync(path.join(repoRoot, ".orchestrator"))).toBe(true);
  });
});
