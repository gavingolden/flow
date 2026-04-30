import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Worker-pool race smoke for `flow run --all`. Two concurrent schedulers
// drain the same fixture queue of N triaged tasks; we assert that across
// the union of both schedulers' children, every task's claim was acquired
// exactly once (no task picked up twice; no task left unclaimed).
//
// The test is gated behind `RUN_INTEGRATION=1` because it spawns 12
// real CLI subprocesses (2 schedulers × 5 children + losers) and pins
// each winner in the worktree phase via a long sleep stub — slow on CI.
const SHOULD_RUN = process.env.RUN_INTEGRATION === "1";
const describeMaybe = SHOULD_RUN ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

const TASK_COUNT = 5;

async function makeFixtureRepo(): Promise<{ dir: string; ids: string[] }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-all-smoke-"));
  await execa("git", ["init", "-q"], { cwd: tmp });
  await execa("git", ["config", "user.email", "test@test"], { cwd: tmp });
  await execa("git", ["config", "user.name", "test"], { cwd: tmp });

  // Worktree-phase stub: the winning child for each task pins inside
  // this sleep, which is long enough for the loser to observe the
  // canonical lock and exit quickly. The afterEach cleanup kills any
  // sleeping winners.
  const scriptsDir = path.join(tmp, "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  const scriptPath = path.join(scriptsDir, "new-agent-worktree.ts");
  await fs.writeFile(scriptPath, "#!/bin/sh\nsleep 30\n", "utf8");
  await fs.chmod(scriptPath, 0o755);

  const tasksDir = path.join(tmp, ".orchestrator", "tasks");
  await fs.mkdir(tasksDir, { recursive: true });

  const ids: string[] = [];
  for (let i = 0; i < TASK_COUNT; i++) {
    const id = `2026-04-30-run-all-smoke-${i}`;
    ids.push(id);
    // Stagger created timestamps so listTriagedTasks returns a stable
    // order. Both schedulers see the same list.
    const created = `2026-04-29T00:00:0${i}.000Z`;
    const body = [
      "---",
      `id: ${id}`,
      "status: triaged",
      `created: ${created}`,
      `updated: ${created}`,
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
    await fs.writeFile(path.join(tasksDir, `${id}.md`), body, "utf8");
  }
  return { dir: tmp, ids };
}

interface SchedulerHandle {
  child: ChildProcess;
  done: Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

function spawnScheduler(cwd: string): SchedulerHandle {
  const child = spawn(TSX, [CLI, "run", "--all", "--max", String(TASK_COUNT)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString("utf8");
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  const done = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    },
  );
  return { child, done };
}

describeMaybe("flow run --all worker-pool race (integration smoke)", () => {
  let fixture: { dir: string; ids: string[] } | null = null;
  const aliveWinnerPids: number[] = [];

  beforeEach(() => {
    fixture = null;
    aliveWinnerPids.length = 0;
  });
  afterEach(async () => {
    // Best-effort: kill every winner still pinned in the worktree-phase
    // sleep stub so afterEach cleanup of the fixture directory doesn't
    // race the children.
    for (const pid of aliveWinnerPids) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    if (fixture) await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  it(
    "two concurrent schedulers — every task claimed exactly once across the union",
    async () => {
      fixture = await makeFixtureRepo();

      // Spawn both schedulers as close together as possible. Each will
      // drain up to 5 children in parallel; for each task, exactly one
      // child wins the claim, the other exits 0 with "already claimed".
      const a = spawnScheduler(fixture.dir);
      const b = spawnScheduler(fixture.dir);

      // Wait until every task has its runner.pid file written by the
      // winning child (the loser child for that task never writes one).
      // A pid per task means the race resolved cleanly — exactly one
      // winner per slot.
      const tasksDir = path.join(fixture.dir, ".orchestrator", "tasks");
      const winners = new Map<string, number>();
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && winners.size < fixture.ids.length) {
        for (const id of fixture.ids) {
          if (winners.has(id)) continue;
          const pidPath = path.join(tasksDir, id, "runner.pid");
          try {
            const raw = await fs.readFile(pidPath, "utf8");
            const n = Number.parseInt(raw.trim(), 10);
            if (Number.isFinite(n) && n > 0) {
              winners.set(id, n);
              aliveWinnerPids.push(n);
            }
          } catch {}
        }
        if (winners.size < fixture.ids.length) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      expect(winners.size, `expected ${fixture.ids.length} winners; got ${winners.size}`)
        .toBe(fixture.ids.length);

      // Distinct winner pids — no single child should somehow own two
      // tasks. (The claim primitive guarantees this; we assert anyway so
      // a future regression in `acquireClaim` surfaces here.)
      const pidSet = new Set(winners.values());
      expect(pidSet.size).toBe(fixture.ids.length);

      // Each task's lock file points to that task's winner.
      for (const id of fixture.ids) {
        const lockPath = path.join(tasksDir, id, `claimed-${id}.lock`);
        const lockRaw = await fs.readFile(lockPath, "utf8");
        expect(Number.parseInt(lockRaw.trim(), 10)).toBe(winners.get(id));
      }

      // Sanity: both schedulers participated. Each scheduler saw all N
      // triaged tasks at startup and spawned one worker per task, so
      // across the union of all jsonl files we expect 2N
      // `worker.spawn` events (2 schedulers × N tasks). We can't
      // assume the file count is 2: when the schedulers spawn within
      // the same millisecond the stamp collides and both append to one
      // shared file (line-atomic appends keep the events distinct).
      const runsDir = path.join(fixture.dir, ".orchestrator", "runs");
      const runsEntries = await fs.readdir(runsDir).catch(() => []);
      const jsonlFiles = runsEntries.filter((n) => n.startsWith("all-") && n.endsWith(".jsonl"));
      expect(jsonlFiles.length).toBeGreaterThanOrEqual(1);
      let totalSpawnEvents = 0;
      for (const name of jsonlFiles) {
        const txt = await fs.readFile(path.join(runsDir, name), "utf8");
        for (const line of txt.split("\n")) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.name === "worker.spawn") totalSpawnEvents++;
          } catch {}
        }
      }
      expect(totalSpawnEvents).toBe(fixture.ids.length * 2);

      // Tear down: kill the winners so the scheduler's drain wraps up
      // and `a.done` / `b.done` resolve. We don't wait on the schedulers
      // here — afterEach handles any leftover pids — but we do sever
      // the spawn promises to avoid an unhandled-rejection on test exit.
      for (const pid of aliveWinnerPids) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
      // Wait for both schedulers to wind down (or kill them if they
      // hang past the timeout) so the test exits cleanly.
      const settle = Promise.allSettled([a.done, b.done]);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      await Promise.race([settle, timeout]);
      try { a.child.kill("SIGKILL"); } catch {}
      try { b.child.kill("SIGKILL"); } catch {}
    },
    60_000,
  );

  it("empty queue: prints 'queue empty' on stderr, exits 0, no children spawned", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-all-empty-"));
    try {
      await execa("git", ["init", "-q"], { cwd: tmp });
      await execa("git", ["config", "user.email", "test@test"], { cwd: tmp });
      await execa("git", ["config", "user.name", "test"], { cwd: tmp });
      await fs.mkdir(path.join(tmp, ".orchestrator", "tasks"), { recursive: true });

      const result = await execa(TSX, [CLI, "run", "--all"], {
        cwd: tmp,
        reject: false,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("flow: queue empty — nothing to do");
      // No worker.spawn events emitted — the scheduler short-circuited
      // before reaching the drain loop.
      const runsDir = path.join(tmp, ".orchestrator", "runs");
      const entries = await fs.readdir(runsDir);
      const jsonl = entries.find((n) => n.startsWith("all-") && n.endsWith(".jsonl"));
      expect(jsonl, "expected a scheduler jsonl log").toBeTruthy();
      const txt = await fs.readFile(path.join(runsDir, jsonl!), "utf8");
      expect(txt).not.toContain('"name":"worker.spawn"');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
