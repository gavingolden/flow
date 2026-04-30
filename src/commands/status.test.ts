import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { statusCommand } from "./status.js";

class StringSink extends Writable {
  buffer = "";
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    cb();
  }
}

async function makeRepo(): Promise<string> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-status-cmd-"));
  await execa("git", ["init", "-q"], { cwd: tmp });
  await execa("git", ["config", "user.email", "t@t"], { cwd: tmp });
  await execa("git", ["config", "user.name", "t"], { cwd: tmp });
  return tmp;
}

async function writeTaskFile(
  repo: string,
  id: string,
  fm: Record<string, unknown>,
  opts: { archive?: boolean; phaseLog?: string } = {},
): Promise<void> {
  const dir = opts.archive
    ? path.join(repo, ".orchestrator", "tasks", "archive")
    : path.join(repo, ".orchestrator", "tasks");
  await fsp.mkdir(dir, { recursive: true });
  const lines = ["---", `id: ${id}`];
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === "string") lines.push(`${k}: '${v}'`);
    else if (v === null) lines.push(`${k}: null`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push("---", "", "## Phase log", "", opts.phaseLog ?? "(empty)", "");
  await fsp.writeFile(path.join(dir, `${id}.md`), lines.join("\n"), "utf8");
}

const baseFm = {
  target_repo: "/repo",
  worktree: null,
  branch: null,
  pr: null,
  manual_validation: null,
  merge_commit: null,
};

describe("statusCommand", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
  });
  afterEach(async () => {
    await fsp.rm(repo, { recursive: true, force: true });
  });

  it("with no id, prints the table and exits 0", async () => {
    await writeTaskFile(repo, "alpha", {
      ...baseFm,
      status: "planning",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await statusCommand(undefined, {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(0);
    expect(stdout.buffer).toContain("ID");
    expect(stdout.buffer).toContain("alpha");
    expect(stdout.buffer).toContain("planning");
  });

  it("--json emits valid JSON parseable by JSON.parse", async () => {
    await writeTaskFile(repo, "alpha", {
      ...baseFm,
      status: "planning",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await statusCommand(undefined, { json: true }, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.buffer) as { tasks: unknown[] };
    expect(parsed.tasks).toHaveLength(1);
    const t0 = parsed.tasks[0] as Record<string, unknown>;
    expect(t0["id"]).toBe("alpha");
    expect(t0["phase"]).toBe("plan");
    expect(t0["cost_total_usd"]).toBe(0);
    expect(t0["cost_partial"]).toBe(false);
    expect(t0["phases"]).toEqual([]);
  });

  it("--all includes archived tasks; without it, archived tasks are absent", async () => {
    await writeTaskFile(repo, "active", {
      ...baseFm,
      status: "planning",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
    });
    await writeTaskFile(
      repo,
      "old",
      {
        ...baseFm,
        status: "merged",
        created: "2026-04-25T00:00:00.000Z",
        updated: "2026-04-25T00:00:00.000Z",
      },
      { archive: true },
    );

    const noAll = new StringSink();
    await statusCommand(undefined, { json: true }, {
      stdout: noAll,
      stderr: new StringSink(),
      cwd: repo,
    });
    const noAllParsed = JSON.parse(noAll.buffer) as { tasks: Array<{ id: string }> };
    expect(noAllParsed.tasks.map((t) => t.id)).toEqual(["active"]);

    const withAll = new StringSink();
    await statusCommand(undefined, { json: true, all: true }, {
      stdout: withAll,
      stderr: new StringSink(),
      cwd: repo,
    });
    const withAllParsed = JSON.parse(withAll.buffer) as {
      tasks: Array<{ id: string; archived: boolean }>;
    };
    expect(withAllParsed.tasks.map((t) => t.id).sort()).toEqual(["active", "old"]);
    expect(withAllParsed.tasks.find((t) => t.id === "old")!.archived).toBe(true);
  });

  it("with a known id, prints drill-down and exits 0", async () => {
    await writeTaskFile(repo, "alpha", {
      ...baseFm,
      status: "verifying",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
    });
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await statusCommand("alpha", {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(0);
    expect(stdout.buffer).toContain("# alpha");
    expect(stdout.buffer).toContain("status:");
    expect(stdout.buffer).toContain("verifying");
    expect(stdout.buffer).toContain("## Phase log");
    expect(stdout.buffer).toContain("## Cost");
  });

  it("with an unknown id, exits 1 and writes a not-found error to stderr", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await statusCommand("nope", {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(1);
    expect(stderr.buffer).toContain("not found");
    expect(stderr.buffer).toContain("nope");
  });

  it("resolves an archived id even without --all (drill-down still works post-archival)", async () => {
    await writeTaskFile(
      repo,
      "old",
      {
        ...baseFm,
        status: "merged",
        created: "2026-04-25T00:00:00.000Z",
        updated: "2026-04-25T00:00:00.000Z",
      },
      { archive: true },
    );
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await statusCommand("old", {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(0);
    expect(stdout.buffer).toContain("# old");
    expect(stdout.buffer).toContain("(archived)");
  });

  it("outside a git repo, prints a clear error and exits 1", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-status-nogit-"));
    try {
      const stdout = new StringSink();
      const stderr = new StringSink();
      const code = await statusCommand(undefined, {}, {
        stdout,
        stderr,
        cwd: tmp,
      });
      expect(code).toBe(1);
      expect(stderr.buffer).toContain("git repository");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("with no tasks, prints 'no tasks found' and exits 0", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const code = await statusCommand(undefined, {}, {
      stdout,
      stderr,
      cwd: repo,
    });
    expect(code).toBe(0);
    expect(stdout.buffer).toContain("no tasks found");
  });
});
