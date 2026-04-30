import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STATUS_TO_PHASE,
  inspectPhaseLogs,
  needsRecovery,
} from "./phase-recovery.js";

async function writeLog(
  taskDir: string,
  filename: string,
  events: unknown[],
): Promise<string> {
  const logsDir = path.join(taskDir, "logs");
  await fsp.mkdir(logsDir, { recursive: true });
  const filePath = path.join(logsDir, filename);
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fsp.writeFile(filePath, body, "utf8");
  return filePath;
}

describe("STATUS_TO_PHASE", () => {
  it("maps every transient phase-running status to its phase name", () => {
    expect(STATUS_TO_PHASE["creating-worktree"]).toBe("worktree");
    expect(STATUS_TO_PHASE["planning"]).toBe("plan");
    expect(STATUS_TO_PHASE["implementing"]).toBe("implement");
    expect(STATUS_TO_PHASE["verifying"]).toBe("verify");
    expect(STATUS_TO_PHASE["reviewing"]).toBe("review");
    expect(STATUS_TO_PHASE["gating"]).toBe("gate");
    expect(STATUS_TO_PHASE["merging"]).toBe("merge");
  });

  it("does not map settled or terminal statuses", () => {
    expect(STATUS_TO_PHASE["triaged"]).toBeUndefined();
    expect(STATUS_TO_PHASE["worktree-ready"]).toBeUndefined();
    expect(STATUS_TO_PHASE["planned"]).toBeUndefined();
    expect(STATUS_TO_PHASE["plan-pending-review"]).toBeUndefined();
    expect(STATUS_TO_PHASE["pr-open"]).toBeUndefined();
    expect(STATUS_TO_PHASE["ci"]).toBeUndefined();
    expect(STATUS_TO_PHASE["gated"]).toBeUndefined();
    expect(STATUS_TO_PHASE["merged"]).toBeUndefined();
    expect(STATUS_TO_PHASE["aborted"]).toBeUndefined();
    expect(STATUS_TO_PHASE["needs-human"]).toBeUndefined();
  });
});

describe("inspectPhaseLogs", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-phase-recovery-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("returns null when the logs/ directory does not exist", async () => {
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence).toBeNull();
    expect(needsRecovery(evidence)).toBe(false);
  });

  it("returns null for a status without a phase mapping (e.g. triaged), even with logs present", async () => {
    await writeLog(tmp, "implement-2026-04-29T10-00-00-000Z.jsonl", [
      { type: "result", subtype: "success", is_error: false },
    ]);
    const evidence = await inspectPhaseLogs(tmp, "triaged");
    expect(evidence).toBeNull();
  });

  it("returns null when there are no JSONL files for the mapped phase", async () => {
    // verify-phase logs exist but the status maps to implement.
    await writeLog(tmp, "verify-2026-04-29T10-00-00-000Z.jsonl", [
      { type: "result", subtype: "success" },
    ]);
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence).toBeNull();
  });

  it("flags recovery for stream-json result success with no flow-result", async () => {
    const filePath = await writeLog(
      tmp,
      "implement-2026-04-29T10-00-00-000Z.jsonl",
      [
        { ts: "x", kind: "info", msg: "starting" },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 10,
          total_cost_usd: 1.23,
        },
      ],
    );
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence).not.toBeNull();
    expect(evidence!.phase).toBe("implement");
    expect(evidence!.jsonlPath).toBe(filePath);
    expect(evidence!.subprocessSucceeded).toBe(true);
    expect(evidence!.flowResultRecorded).toBe(false);
    expect(needsRecovery(evidence)).toBe(true);
  });

  it("does not flag recovery for stream-json result with is_error: true", async () => {
    await writeLog(tmp, "implement-2026-04-29T10-00-00-000Z.jsonl", [
      { type: "result", is_error: true },
    ]);
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence).not.toBeNull();
    expect(evidence!.subprocessSucceeded).toBe(false);
    expect(evidence!.flowResultRecorded).toBe(false);
    expect(needsRecovery(evidence)).toBe(false);
  });

  it("does not flag recovery when both stream-json result success AND flow-result are present", async () => {
    await writeLog(tmp, "implement-2026-04-29T10-00-00-000Z.jsonl", [
      { type: "result", subtype: "success", is_error: false },
      { ts: "x", kind: "result", status: "ok" },
    ]);
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence!.subprocessSucceeded).toBe(true);
    expect(evidence!.flowResultRecorded).toBe(true);
    expect(needsRecovery(evidence)).toBe(false);
  });

  it("does not flag recovery when only the flow-result is recorded with status: failed", async () => {
    await writeLog(tmp, "implement-2026-04-29T10-00-00-000Z.jsonl", [
      { ts: "x", kind: "info", msg: "starting" },
      { ts: "x", kind: "result", status: "failed", reason: "boom" },
    ]);
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence!.subprocessSucceeded).toBe(false);
    expect(evidence!.flowResultRecorded).toBe(true);
    expect(needsRecovery(evidence)).toBe(false);
  });

  it("does not flag recovery when neither shape is present", async () => {
    await writeLog(tmp, "implement-2026-04-29T10-00-00-000Z.jsonl", [
      { ts: "x", kind: "info", msg: "starting" },
      { ts: "x", kind: "info", msg: "still going" },
    ]);
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence!.subprocessSucceeded).toBe(false);
    expect(evidence!.flowResultRecorded).toBe(false);
    expect(needsRecovery(evidence)).toBe(false);
  });

  it("tolerates a truncated last line by skipping the partial JSON", async () => {
    const logsDir = path.join(tmp, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    const filePath = path.join(
      logsDir,
      "implement-2026-04-29T10-00-00-000Z.jsonl",
    );
    const body =
      JSON.stringify({ ts: "x", kind: "info", msg: "first" }) +
      "\n" +
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
      }) +
      "\n" +
      `{"ts":"x","kind":"info","msg":"trunca`; // partial JSON, no newline
    await fsp.writeFile(filePath, body, "utf8");
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence).not.toBeNull();
    expect(evidence!.subprocessSucceeded).toBe(true);
    expect(evidence!.flowResultRecorded).toBe(false);
    expect(needsRecovery(evidence)).toBe(true);
  });

  it("inspects only the latest stamp when multiple JSONL files exist for the same phase", async () => {
    // Older attempt: subprocess never reached result.
    await writeLog(tmp, "implement-2026-04-29T09-00-00-000Z.jsonl", [
      { ts: "x", kind: "info", msg: "old run, never finished" },
    ]);
    // Latest attempt: subprocess success but no flow-result.
    const latestPath = await writeLog(
      tmp,
      "implement-2026-04-29T10-00-00-000Z.jsonl",
      [{ type: "result", subtype: "success", is_error: false }],
    );
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence!.jsonlPath).toBe(latestPath);
    expect(needsRecovery(evidence)).toBe(true);
  });

  it("ignores lines that don't match either type:result or kind:result", async () => {
    await writeLog(tmp, "implement-2026-04-29T10-00-00-000Z.jsonl", [
      { ts: "x", kind: "info", msg: "noise" },
      { type: "tool_use", name: "Read", input: { path: "x" } },
      { ts: "x", kind: "exec", cmd: "git", args: ["status"] },
    ]);
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence!.subprocessSucceeded).toBe(false);
    expect(evidence!.flowResultRecorded).toBe(false);
    expect(needsRecovery(evidence)).toBe(false);
  });

  it("returns null for an empty JSONL file", async () => {
    const logsDir = path.join(tmp, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    await fsp.writeFile(
      path.join(logsDir, "implement-2026-04-29T10-00-00-000Z.jsonl"),
      "",
      "utf8",
    );
    const evidence = await inspectPhaseLogs(tmp, "implementing");
    expect(evidence).toBeNull();
  });
});
