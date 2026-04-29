import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Concurrent-spawn smoke for the cross-process claim primitive. Two
// `flow run <id>` subprocesses race against the same triaged task; we
// assert that exactly one wins the claim and the other exits 0 with the
// "already claimed" stderr message.
//
// The test is gated behind `RUN_INTEGRATION=1` because it spawns real
// CLI subprocesses (slow on CI) and pinned in the worktree phase via a
// long-sleep stub script, matching the pattern in run.detach.smoke.
const SHOULD_RUN = process.env.RUN_INTEGRATION === "1";
const describeMaybe = SHOULD_RUN ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runFlow(cwd: string, taskId: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [CLI, "run", taskId], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

async function makeFixtureRepo(taskId: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-claim-smoke-"));
  await execa("git", ["init", "-q"], { cwd: tmp });
  await execa("git", ["config", "user.email", "test@test"], { cwd: tmp });
  await execa("git", ["config", "user.name", "test"], { cwd: tmp });
  // Worktree-phase stub: sleep long enough that the loser's spawn
  // overlaps the winner's claim hold. The winner stays pinned in the
  // worktree phase; the loser sees `claimed-<id>.lock` with a live PID
  // and exits with the "already claimed" message.
  const scriptsDir = path.join(tmp, "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  const scriptPath = path.join(scriptsDir, "new-agent-worktree.ts");
  await fs.writeFile(scriptPath, "#!/bin/sh\nsleep 10\n", "utf8");
  await fs.chmod(scriptPath, 0o755);

  const tasksDir = path.join(tmp, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });
  const body = [
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
  await fs.writeFile(path.join(tasksDir, `${taskId}.md`), body, "utf8");
  return tmp;
}

describeMaybe("flow run claim race (integration smoke)", () => {
  let fixture: string | null = null;
  let aliveWinnerPid: number | null = null;

  beforeEach(() => {
    fixture = null;
    aliveWinnerPid = null;
  });
  afterEach(async () => {
    // Best-effort: kill any winner still pinned in the sleeping stub so
    // afterEach cleanup of the fixture directory doesn't race.
    if (aliveWinnerPid) {
      try { process.kill(aliveWinnerPid, "SIGKILL"); } catch {}
    }
    if (fixture) await fs.rm(fixture, { recursive: true, force: true });
  });

  it("two concurrent runners — exactly one acquires; loser exits 0 with the expected stderr", async () => {
    const taskId = "2026-04-29-claim-smoke";
    fixture = await makeFixtureRepo(taskId);

    // Spawn both runners as close together as possible. The winner pins
    // in the worktree-phase sleep; we wait for the loser to exit (it
    // returns quickly after observing the canonical lock).
    const a = runFlow(fixture, taskId);
    const b = runFlow(fixture, taskId);

    // Whichever finishes first is the loser (winner is pinned in the
    // 10s sleep). Wait for one to complete; that one must be the loser.
    const loser = await Promise.race([a, b]);

    expect(loser.exitCode, `loser stderr=${loser.stderr}`).toBe(0);
    expect(loser.stderr).toContain("already claimed");
    expect(loser.stderr).toContain(taskId);

    // Find the winner pid from runner.pid so we can clean it up.
    const pidPath = path.join(
      fixture,
      ".orchestrator",
      "tasks",
      taskId,
      "runner.pid",
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const raw = await fs.readFile(pidPath, "utf8");
        const n = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(n)) {
          aliveWinnerPid = n;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(aliveWinnerPid, "winner runner.pid not found").not.toBeNull();

    // Lock file is present while the winner runs.
    const lockPath = path.join(
      fixture,
      ".orchestrator",
      "tasks",
      taskId,
      `claimed-${taskId}.lock`,
    );
    const lockContents = await fs.readFile(lockPath, "utf8");
    expect(Number.parseInt(lockContents.trim(), 10)).toBe(aliveWinnerPid);
  }, 30_000);

  it("loser exits 0 even when the task status is in flight (winner mid-pipeline)", async () => {
    // Sanity check that the loser's exit code is not propagating a
    // stderr-implied failure: parent-script consumers must not see a
    // non-zero exit for "ran nothing because someone else owns it".
    const taskId = "2026-04-29-claim-smoke-2";
    fixture = await makeFixtureRepo(taskId);

    const winner = runFlow(fixture, taskId);
    // Give the winner a head start so its claim is already in place
    // when the second runner spawns.
    await new Promise((r) => setTimeout(r, 250));
    const loser = await runFlow(fixture, taskId);

    expect(loser.exitCode).toBe(0);
    expect(loser.stderr).toContain("already claimed");

    // Capture winner pid for cleanup. The winner is still sleeping.
    const pidPath = path.join(
      fixture,
      ".orchestrator",
      "tasks",
      taskId,
      "runner.pid",
    );
    try {
      const raw = await fs.readFile(pidPath, "utf8");
      aliveWinnerPid = Number.parseInt(raw.trim(), 10);
    } catch {}

    // Winner is still alive (pinned in sleep). Don't await it; the
    // afterEach kill will reap it.
    void winner;
  }, 30_000);
});
