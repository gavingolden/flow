import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Smoke for the runner's "subprocess succeeded but parent never advanced"
// recovery diagnostic. Synthesizes the failure shape on disk (status
// `creating-worktree` + a JSONL log carrying a stream-json result success
// but no flow-level kind:result), runs `flow run <id>`, and asserts the
// recovery line lands in the run log. The pipeline itself fails after
// the diagnostic (no worktree script provided) — that's expected: the
// diagnostic must run before the pipeline starts, and "the line is in
// the log" is the only thing this test pins down. Phase idempotency is
// already covered by the per-phase unit tests.
const SHOULD_RUN = process.env.RUN_INTEGRATION === "1";
const describeMaybe = SHOULD_RUN ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

describeMaybe("flow run — phase-recovery diagnostic (integration smoke)", () => {
  let fixture: string | null = null;

  beforeEach(() => {
    fixture = null;
  });
  afterEach(async () => {
    if (fixture) await fs.rm(fixture, { recursive: true, force: true });
  });

  it("logs `recovering: phase <name> subprocess completed in prior run` when the JSONL evidence matches", async () => {
    const taskId = "2026-04-30-recovery-smoke";
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), "flow-recovery-smoke-"));
    await execa("git", ["init", "-q"], { cwd: fixture });
    await execa("git", ["config", "user.email", "test@test"], { cwd: fixture });
    await execa("git", ["config", "user.name", "test"], { cwd: fixture });

    const tasksDir = path.join(fixture, ".orchestrator", "tasks");
    await fs.mkdir(tasksDir, { recursive: true });

    // Synthesize the recovery shape: status `creating-worktree` (mapped to
    // the worktree phase) + a JSONL log under <taskDir>/logs/ carrying a
    // stream-json `type:result subtype:success` event with no companion
    // flow-level `kind:result` event.
    const taskDir = path.join(tasksDir, taskId);
    const logsDir = path.join(taskDir, "logs");
    await fs.mkdir(logsDir, { recursive: true });
    const jsonlPath = path.join(
      logsDir,
      "worktree-2026-04-30T10-00-00-000Z.jsonl",
    );
    const body =
      JSON.stringify({ ts: "x", kind: "info", msg: "starting" }) +
      "\n" +
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 10,
        total_cost_usd: 1.23,
      }) +
      "\n";
    await fs.writeFile(jsonlPath, body, "utf8");

    const taskBody = [
      "---",
      `id: ${taskId}`,
      "status: creating-worktree",
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
    await fs.writeFile(path.join(tasksDir, `${taskId}.md`), taskBody, "utf8");

    const child = spawn(TSX, [CLI, "run", taskId], {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    });

    const runsDir = path.join(fixture, ".orchestrator", "runs");
    const runLogs = (await fs.readdir(runsDir)).filter((n) =>
      n.startsWith(taskId),
    );
    expect(runLogs.length, `runs dir empty? stderr=${stderr}`).toBeGreaterThan(0);
    const runLogBody = await fs.readFile(
      path.join(runsDir, runLogs[0]!),
      "utf8",
    );
    expect(runLogBody).toContain(
      "recovering: phase worktree subprocess completed in prior run; re-entering phase to resume",
    );
  });

  it("does NOT log the recovery line when the JSONL has no stream-json result success", async () => {
    const taskId = "2026-04-30-no-recovery-smoke";
    fixture = await fs.mkdtemp(
      path.join(os.tmpdir(), "flow-no-recovery-smoke-"),
    );
    await execa("git", ["init", "-q"], { cwd: fixture });
    await execa("git", ["config", "user.email", "test@test"], { cwd: fixture });
    await execa("git", ["config", "user.name", "test"], { cwd: fixture });

    const tasksDir = path.join(fixture, ".orchestrator", "tasks");
    await fs.mkdir(tasksDir, { recursive: true });

    // Same setup, but JSONL has only an info event — neither stream-json
    // result nor flow-result, so the detector returns "no recovery".
    const taskDir = path.join(tasksDir, taskId);
    const logsDir = path.join(taskDir, "logs");
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(
      path.join(logsDir, "worktree-2026-04-30T10-00-00-000Z.jsonl"),
      JSON.stringify({ ts: "x", kind: "info", msg: "starting" }) + "\n",
      "utf8",
    );

    const taskBody = [
      "---",
      `id: ${taskId}`,
      "status: creating-worktree",
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
    await fs.writeFile(path.join(tasksDir, `${taskId}.md`), taskBody, "utf8");

    const child = spawn(TSX, [CLI, "run", taskId], {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    });

    const runsDir = path.join(fixture, ".orchestrator", "runs");
    const runLogs = (await fs.readdir(runsDir)).filter((n) =>
      n.startsWith(taskId),
    );
    expect(runLogs.length).toBeGreaterThan(0);
    const runLogBody = await fs.readFile(
      path.join(runsDir, runLogs[0]!),
      "utf8",
    );
    expect(runLogBody).not.toContain(
      "recovering: phase worktree subprocess completed in prior run",
    );
  });
});
