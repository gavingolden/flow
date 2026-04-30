import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateTaskCost, parsePhaseCost } from "./cost.js";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "cost.fixtures",
);

describe("parsePhaseCost", () => {
  it("sums total_cost_usd across every type:result event", async () => {
    const r = await parsePhaseCost(path.join(fixturesDir, "normal-result.jsonl"));
    expect(r.hasResult).toBe(true);
    expect(r.usd).toBeCloseTo(0.4203, 6);
  });

  it("returns hasResult=false for a phase that crashed before result", async () => {
    const r = await parsePhaseCost(
      path.join(fixturesDir, "crash-no-result.jsonl"),
    );
    expect(r.hasResult).toBe(false);
    expect(r.usd).toBe(0);
  });

  it("sums across mixed-model invocations and skips malformed lines", async () => {
    const r = await parsePhaseCost(path.join(fixturesDir, "mixed-models.jsonl"));
    expect(r.hasResult).toBe(true);
    expect(r.usd).toBeCloseTo(2.0001 + 0.0102, 6);
  });

  it("does NOT count flow's side-channel kind:result toward hasResult", async () => {
    // The flow runner emits its own {kind:"result"} after the Claude stream
    // ends. Treating that as a real result would mask LLM crashes — every
    // phase would always look complete. Guard the contract here.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-cost-"));
    try {
      const f = path.join(tmp, "log.jsonl");
      await fsp.writeFile(
        f,
        '{"ts":"2026-04-29T12:00:00.000Z","kind":"result","status":"ok"}\n',
      );
      const r = await parsePhaseCost(f);
      expect(r.hasResult).toBe(false);
      expect(r.usd).toBe(0);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns zeros cleanly for a missing file (does not throw)", async () => {
    const r = await parsePhaseCost(path.join(fixturesDir, "no-such-file.jsonl"));
    expect(r).toEqual({ usd: 0, hasResult: false });
  });
});

describe("aggregateTaskCost", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-aggregate-"));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function seedLogs(files: Array<{ name: string; from: string }>): Promise<string> {
    const taskDir = path.join(tmp, "task");
    const logsDir = path.join(taskDir, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    for (const f of files) {
      await fsp.copyFile(f.from, path.join(logsDir, f.name));
    }
    return taskDir;
  }

  it("returns zeros for a task with no logs dir", async () => {
    const out = await aggregateTaskCost(path.join(tmp, "absent"));
    expect(out).toEqual({ total: 0, partial: false, phases: [] });
  });

  it("rolls up retry attempts: multiple files per phase sum together with attempts > 1", async () => {
    const taskDir = await seedLogs([
      {
        name: "verify-2026-04-29T10-00-00-000Z.jsonl",
        from: path.join(fixturesDir, "retry-attempt-1.jsonl"),
      },
      {
        name: "verify-2026-04-29T11-00-00-000Z.jsonl",
        from: path.join(fixturesDir, "retry-attempt-2.jsonl"),
      },
    ]);
    const out = await aggregateTaskCost(taskDir);
    expect(out.phases).toHaveLength(1);
    expect(out.phases[0]).toMatchObject({
      name: "verify",
      attempts: 2,
      partial: false,
    });
    expect(out.phases[0]!.usd).toBeCloseTo(0.75, 6);
    expect(out.total).toBeCloseTo(0.75, 6);
    expect(out.partial).toBe(false);
  });

  it("flags partial when one of two attempts has no result event", async () => {
    const taskDir = await seedLogs([
      {
        name: "verify-2026-04-29T10-00-00-000Z.jsonl",
        from: path.join(fixturesDir, "retry-attempt-1.jsonl"),
      },
      {
        name: "verify-2026-04-29T11-00-00-000Z.jsonl",
        from: path.join(fixturesDir, "crash-no-result.jsonl"),
      },
    ]);
    const out = await aggregateTaskCost(taskDir);
    expect(out.phases[0]!.partial).toBe(true);
    expect(out.partial).toBe(true);
    expect(out.phases[0]!.usd).toBeCloseTo(0.5, 6);
  });

  it("preserves first-seen execution order across phases", async () => {
    // Stamp ordering puts worktree first then plan — the aggregate should
    // surface phases in that order regardless of alphabetical ordering.
    const taskDir = await seedLogs([
      {
        name: "worktree-2026-04-29T09-00-00-000Z.jsonl",
        from: path.join(fixturesDir, "normal-result.jsonl"),
      },
      {
        name: "plan-2026-04-29T10-00-00-000Z.jsonl",
        from: path.join(fixturesDir, "mixed-models.jsonl"),
      },
    ]);
    const out = await aggregateTaskCost(taskDir);
    expect(out.phases.map((p) => p.name)).toEqual(["worktree", "plan"]);
  });

  it("task total equals the sum of per-phase costs to within float epsilon", async () => {
    const taskDir = await seedLogs([
      {
        name: "plan-2026-04-29T10-00-00-000Z.jsonl",
        from: path.join(fixturesDir, "mixed-models.jsonl"),
      },
      {
        name: "implement-2026-04-29T11-00-00-000Z.jsonl",
        from: path.join(fixturesDir, "retry-attempt-1.jsonl"),
      },
      {
        name: "implement-2026-04-29T12-00-00-000Z.jsonl",
        from: path.join(fixturesDir, "retry-attempt-2.jsonl"),
      },
    ]);
    const out = await aggregateTaskCost(taskDir);
    const sum = out.phases.reduce((acc, p) => acc + p.usd, 0);
    expect(Math.abs(out.total - sum)).toBeLessThan(1e-9);
  });
});
