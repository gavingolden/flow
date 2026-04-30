import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Spawn-driven smoke for `flow run --detach`. Verifies:
//   - parent prints "detached as pid <N>" + log path and exits 0 quickly
//   - .orchestrator/tasks/<id>/runner.pid is written and matches the printed PID
//   - the detached child survives the parent exiting (it would otherwise be
//     reaped along with the parent; this is the whole point of `--detach`)
//   - SIGTERM-ing the detached child triggers the reaper: status ends
//     `needs-human (signaled)`, runner.pid is removed
//
// Gated behind `RUN_INTEGRATION=1` because the worst-case wait for the
// child to settle is a few seconds and vitest's default test budget
// shouldn't pay that on every developer run.
const SHOULD_RUN = process.env.RUN_INTEGRATION === "1";
const describeMaybe = SHOULD_RUN ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

async function makeFixtureRepo(taskId: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-detach-smoke-"));
  await execa("git", ["init", "-q"], { cwd: tmp });
  await execa("git", ["config", "user.email", "test@test"], { cwd: tmp });
  await execa("git", ["config", "user.name", "test"], { cwd: tmp });
  // Provide a fake worktree script that simply sleeps. This keeps the
  // detached child's pipeline pinned in the worktree phase long enough
  // for the test to observe runner.pid and SIGTERM it.
  const scriptsDir = path.join(tmp, "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  // Use a #!/bin/sh shim instead of bun so the fixture has no runtime
  // dependency. The worktree phase invokes the script directly.
  const scriptPath = path.join(scriptsDir, "new-agent-worktree.ts");
  await fs.writeFile(scriptPath, "#!/bin/sh\nsleep 60\n", "utf8");
  await fs.chmod(scriptPath, 0o755);

  const tasksDir = path.join(tmp, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });
  const taskBody = [
    "---",
    `id: ${taskId}`,
    "status: triaged",
    "created: 2026-04-29T00:00:00.000Z",
    "updated: 2026-04-29T00:00:00.000Z",
    `target_repo: ${tmp}`,
    "worktree: null",
    "branch: null",
    "pr: null",
    "manual_validation: null",
    "merge_commit: null",
    "---",
    "",
    "## User prompt",
    "",
    "smoke",
    "",
    "## Phase log",
    "",
    "## Phase outputs",
    "",
  ].join("\n");
  await fs.writeFile(path.join(tasksDir, `${taskId}.md`), taskBody, "utf8");
  return tmp;
}

async function pollFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

describeMaybe("flow run --detach (integration smoke)", () => {
  let fixture: string | null = null;
  let detachedPid: number | null = null;

  beforeEach(() => {
    fixture = null;
    detachedPid = null;
  });
  afterEach(async () => {
    // Best-effort cleanup of any detached child still alive.
    if (detachedPid) {
      try { process.kill(detachedPid, "SIGKILL"); } catch {}
    }
    if (fixture) await fs.rm(fixture, { recursive: true, force: true });
  });

  it("attached run with a crashing worktree script exits 1, plaintext log records ERROR, task ends at the failure status", async () => {
    // Covers the *clean failure* path: phase returns `failed` PhaseResult,
    // the runner does not invoke the reaper, the existing failure UX is
    // preserved (process exits 1, plaintext log gets an ERROR line). Per
    // PRD: the reaper does not turn `failed` outcomes into `needs-human`.
    const taskId = "2026-04-29-attached-fail";
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), "flow-attached-fail-"));
    await execa("git", ["init", "-q"], { cwd: fixture });
    await execa("git", ["config", "user.email", "test@test"], { cwd: fixture });
    await execa("git", ["config", "user.name", "test"], { cwd: fixture });
    // Note: no scripts/new-agent-worktree.ts — the worktree phase will
    // return `failed` PhaseResult (not throw).
    const tasksDir = path.join(fixture, ".orchestrator", "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    const body = [
      "---",
      `id: ${taskId}`,
      "status: triaged",
      "created: 2026-04-29T00:00:00.000Z",
      "updated: 2026-04-29T00:00:00.000Z",
      `target_repo: ${fixture}`,
      "worktree: null",
      "branch: null",
      "pr: null",
      "manual_validation: null",
      "merge_commit: null",
      "---",
      "",
      "## User prompt",
      "",
      "smoke",
      "",
      "## Phase log",
      "",
      "## Phase outputs",
      "",
    ].join("\n");
    await fs.writeFile(path.join(tasksDir, `${taskId}.md`), body, "utf8");

    const child = spawn(TSX, [CLI, "run", taskId], {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    });

    expect(exitCode, `stderr=${stderr}`).toBe(1);

    // runner.pid was written and then unlinked on the failure path.
    const pidPath = path.join(fixture, ".orchestrator", "tasks", taskId, "runner.pid");
    await expect(fs.access(pidPath)).rejects.toThrow();

    // Existing failure UX preserved: status stayed at the failure point
    // (creating-worktree); reaper did NOT remap it to needs-human.
    const taskPath = path.join(fixture, ".orchestrator", "tasks", `${taskId}.md`);
    const finalBody = await fs.readFile(taskPath, "utf8");
    expect(finalBody).toMatch(/^status: creating-worktree$/m);
    expect(finalBody).not.toContain("needs-human");
  });

  it("flow run <id> against a plan-pending-review task is a friendly no-op (exit 0, stderr names both resume skills, no claim acquired)", async () => {
    // PR 12 added a checkpoint exit branch to runCommand for tasks at
    // status `plan-pending-review`. The runner's CLAIMABLE_STATUSES set
    // already excludes the status (so falling through would silently
    // exit), but the explicit branch surfaces the resume affordances on
    // stderr instead of a silent zero-output exit. Pin both halves: the
    // exit code, and the message naming both skills.
    const taskId = "2026-04-30-checkpoint-noop";
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), "flow-checkpoint-noop-"));
    await execa("git", ["init", "-q"], { cwd: fixture });
    await execa("git", ["config", "user.email", "test@test"], { cwd: fixture });
    await execa("git", ["config", "user.name", "test"], { cwd: fixture });
    const tasksDir = path.join(fixture, ".orchestrator", "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    const body = [
      "---",
      `id: ${taskId}`,
      "status: plan-pending-review",
      "created: 2026-04-30T00:00:00.000Z",
      "updated: 2026-04-30T00:00:00.000Z",
      `target_repo: ${fixture}`,
      "worktree: null",
      "branch: null",
      "pr: null",
      "manual_validation: null",
      "merge_commit: null",
      "---",
      "",
      "## User prompt",
      "",
      "smoke",
      "",
      "## Phase log",
      "",
      "## Phase outputs",
      "",
    ].join("\n");
    await fs.writeFile(path.join(tasksDir, `${taskId}.md`), body, "utf8");

    const child = spawn(TSX, [CLI, "run", taskId], {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    });

    expect(exitCode, `stderr=${stderr}\nstdout=${stdout}`).toBe(0);
    expect(stderr).toContain("/flow-approve");
    expect(stderr).toContain("/flow-revise");
    expect(stderr).toContain(taskId);

    // No claim/runner.pid was written — the no-op exits before
    // acquireClaim runs.
    const pidPath = path.join(fixture, ".orchestrator", "tasks", taskId, "runner.pid");
    await expect(fs.access(pidPath)).rejects.toThrow();

    // Status is unchanged.
    const reread = await fs.readFile(path.join(tasksDir, `${taskId}.md`), "utf8");
    expect(reread).toMatch(/^status: plan-pending-review$/m);
  });

  it("flow run <id> against a paused task is a friendly no-op (exit 0, stderr names flow resume, no claim acquired)", async () => {
    // PR 16 added a defensive pause-check at runCommand startup that
    // mirrors the plan-pending-review early-exit. A manual `flow run
    // <id>` against a paused task must surface the resume affordance on
    // stderr and exit 0 without acquiring the claim or running the
    // pipeline (which would otherwise hit the in-loop pause check,
    // record a redundant transition, and exit anyway).
    const taskId = "2026-04-30-paused-noop";
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), "flow-paused-noop-"));
    await execa("git", ["init", "-q"], { cwd: fixture });
    await execa("git", ["config", "user.email", "test@test"], { cwd: fixture });
    await execa("git", ["config", "user.name", "test"], { cwd: fixture });
    const tasksDir = path.join(fixture, ".orchestrator", "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    const body = [
      "---",
      `id: ${taskId}`,
      "status: pr-open",
      "created: 2026-04-30T00:00:00.000Z",
      "updated: 2026-04-30T00:00:00.000Z",
      `target_repo: ${fixture}`,
      "worktree: null",
      "branch: null",
      "pr: null",
      "manual_validation: null",
      "merge_commit: null",
      "paused_from: pr-open",
      "---",
      "",
      "## User prompt",
      "",
      "smoke",
      "",
      "## Phase log",
      "",
      "## Phase outputs",
      "",
    ].join("\n");
    await fs.writeFile(path.join(tasksDir, `${taskId}.md`), body, "utf8");
    const taskDir = path.join(tasksDir, taskId);
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, ".pause"), "", "utf8");

    const child = spawn(TSX, [CLI, "run", taskId], {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    });

    expect(exitCode, `stderr=${stderr}\nstdout=${stdout}`).toBe(0);
    expect(stderr).toContain("is paused");
    expect(stderr).toContain(`flow resume ${taskId}`);

    // No claim / runner.pid was written — the no-op exits before
    // acquireClaim runs.
    const pidPath = path.join(taskDir, "runner.pid");
    await expect(fs.access(pidPath)).rejects.toThrow();
    // Status is unchanged.
    const reread = await fs.readFile(path.join(tasksDir, `${taskId}.md`), "utf8");
    expect(reread).toMatch(/^status: pr-open$/m);
  });

  it("parent exits 0 quickly, runner.pid is written, child survives parent exit, SIGTERM reaps to needs-human", async () => {
    const taskId = "2026-04-29-detach-smoke";
    fixture = await makeFixtureRepo(taskId);
    const start = Date.now();
    const child = spawn(TSX, [CLI, "run", taskId, "--detach"], {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    });
    const dur = Date.now() - start;
    expect(exitCode, `parent stderr=${stderr}\nstdout=${stdout}`).toBe(0);
    // Detach should be fast — the parent does at most: open log fd, spawn,
    // print, exit. Generous bound for CI.
    expect(dur).toBeLessThan(8_000);
    expect(stdout).toMatch(/detached as pid \d+/);
    expect(stdout).toMatch(/log → /);

    const pidMatch = stdout.match(/detached as pid (\d+)/);
    const printedPid = pidMatch ? Number.parseInt(pidMatch[1]!, 10) : NaN;
    expect(Number.isFinite(printedPid)).toBe(true);
    detachedPid = printedPid;

    const pidPath = path.join(
      fixture,
      ".orchestrator",
      "tasks",
      taskId,
      "runner.pid",
    );
    const pidFromFile = await pollFor(
      async () => {
        try {
          const raw = await fs.readFile(pidPath, "utf8");
          const n = Number.parseInt(raw.trim(), 10);
          return Number.isFinite(n) ? n : null;
        } catch {
          return null;
        }
      },
      3_000,
    );
    expect(pidFromFile).toBe(printedPid);

    // Confirm the detached child is still alive after the parent exited —
    // this is the whole point of `--detach`. process.kill(pid, 0) is a
    // signal-0 probe: returns true if the process exists, throws ESRCH if
    // not. (Permission errors throw EPERM but won't apply for our own
    // child.)
    let aliveAfterParentExit = false;
    try {
      process.kill(printedPid, 0);
      aliveAfterParentExit = true;
    } catch {}
    expect(aliveAfterParentExit).toBe(true);

    // SIGTERM the child — this should trigger the runner's exit handler:
    // unlink runner.pid, reap status to needs-human (signaled). We can't
    // observe the handler running directly, but we can poll for its
    // observable side-effects.
    process.kill(printedPid, "SIGTERM");
    detachedPid = null;

    const pidGone = await pollFor(
      async () => {
        try {
          await fs.access(pidPath);
          return false;
        } catch {
          return true;
        }
      },
      5_000,
    );
    expect(pidGone, "runner.pid should be unlinked by the SIGTERM exit handler").toBe(true);

    const taskPath = path.join(fixture, ".orchestrator", "tasks", `${taskId}.md`);
    const finalBody = await fs.readFile(taskPath, "utf8");
    expect(finalBody).toMatch(/^status: needs-human$/m);
    expect(finalBody).toContain("→ needs-human (signaled)");
  });
});
