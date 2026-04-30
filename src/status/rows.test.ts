import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRowForId, buildStatusRows, priorStatusFromPhaseLog } from "./rows.js";

const taskBody = (
  fm: Record<string, unknown>,
  phaseLog = "(empty)",
): string => {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === "string") lines.push(`${k}: '${v}'`);
    else if (v === null) lines.push(`${k}: null`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  lines.push("");
  lines.push("## Phase log");
  lines.push("");
  lines.push(phaseLog);
  lines.push("");
  return lines.join("\n");
};

describe("priorStatusFromPhaseLog", () => {
  it("returns the most recent <from> in <from> → needs-human", () => {
    const body = [
      "## Phase log",
      "",
      "- 2026-04-29T00:00:00Z triaged → planning",
      "- 2026-04-29T00:01:00Z planning → planned",
      "- 2026-04-29T00:02:00Z planned → implementing",
      "- 2026-04-29T00:03:00Z implementing → verifying",
      "- 2026-04-29T00:04:00Z verifying → needs-human (timed out)",
    ].join("\n");
    expect(priorStatusFromPhaseLog(body)).toBe("verifying");
  });

  it("works with ASCII -> arrows too", () => {
    const body = [
      "## Phase log",
      "",
      "- 2026-04-29T00:00:00Z planning -> needs-human",
    ].join("\n");
    expect(priorStatusFromPhaseLog(body)).toBe("planning");
  });

  it("returns null when the log has no needs-human transition", () => {
    const body = [
      "## Phase log",
      "",
      "- 2026-04-29T00:00:00Z triaged → planning",
    ].join("\n");
    expect(priorStatusFromPhaseLog(body)).toBeNull();
  });

  it("returns null when the body has no Phase log section", () => {
    expect(priorStatusFromPhaseLog("nothing here")).toBeNull();
  });
});

describe("buildStatusRows", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-rows-"));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function seedTask(
    id: string,
    fm: Record<string, unknown>,
    opts: { archive?: boolean; phaseLog?: string } = {},
  ): Promise<void> {
    const dir = opts.archive
      ? path.join(tmp, ".orchestrator", "tasks", "archive")
      : path.join(tmp, ".orchestrator", "tasks");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, `${id}.md`),
      taskBody({ id, ...fm }, opts.phaseLog),
    );
  }

  const baseFm = {
    target_repo: "/repo",
    worktree: null,
    branch: null,
    pr: null,
    manual_validation: null,
    merge_commit: null,
  };

  it("returns only active tasks with no-arg call", async () => {
    await seedTask("active-a", {
      ...baseFm,
      status: "planning",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
    });
    await seedTask(
      "old-archived",
      {
        ...baseFm,
        status: "merged",
        created: "2026-04-25T00:00:00.000Z",
        updated: "2026-04-25T00:00:00.000Z",
      },
      { archive: true },
    );
    const rows = await buildStatusRows(tmp);
    expect(rows.map((r) => r.id)).toEqual(["active-a"]);
  });

  it("returns active + archived with includeArchived=true; archived flag set correctly", async () => {
    await seedTask("active", {
      ...baseFm,
      status: "planning",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
    });
    await seedTask(
      "old-archived",
      {
        ...baseFm,
        status: "merged",
        created: "2026-04-25T00:00:00.000Z",
        updated: "2026-04-25T00:00:00.000Z",
      },
      { archive: true },
    );
    const rows = await buildStatusRows(tmp, { includeArchived: true });
    expect(rows.map((r) => r.id).sort()).toEqual(["active", "old-archived"]);
    const archivedRow = rows.find((r) => r.id === "old-archived")!;
    const activeRow = rows.find((r) => r.id === "active")!;
    expect(archivedRow.archived).toBe(true);
    expect(activeRow.archived).toBe(false);
  });

  it("sorts most-recent-updated first; ties broken by id ascending", async () => {
    await seedTask("z-task", {
      ...baseFm,
      status: "planning",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
    });
    await seedTask("a-task", {
      ...baseFm,
      status: "planning",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
    });
    await seedTask("middle", {
      ...baseFm,
      status: "planning",
      created: "2026-04-28T00:00:00.000Z",
      updated: "2026-04-28T00:00:00.000Z",
    });
    const rows = await buildStatusRows(tmp);
    expect(rows.map((r) => r.id)).toEqual(["a-task", "z-task", "middle"]);
  });

  it("derives phase from phase log for needs-human tasks", async () => {
    await seedTask(
      "stuck",
      {
        ...baseFm,
        status: "needs-human",
        created: "2026-04-29T00:00:00.000Z",
        updated: "2026-04-29T00:00:00.000Z",
      },
      {
        phaseLog: [
          "- 2026-04-29T00:00:00Z triaged → planning",
          "- 2026-04-29T00:01:00Z planning → planned",
          "- 2026-04-29T00:02:00Z planned → implementing",
          "- 2026-04-29T00:03:00Z implementing → verifying",
          "- 2026-04-29T00:04:00Z verifying → needs-human (timed out)",
        ].join("\n"),
      },
    );
    const rows = await buildStatusRows(tmp);
    expect(rows[0]!.phase).toBe("verify");
  });

  it("contributes cost_total_usd: 0 / phases: [] for tasks with no logs dir", async () => {
    await seedTask("solo", {
      ...baseFm,
      status: "planning",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
    });
    const rows = await buildStatusRows(tmp);
    expect(rows[0]!.cost_total_usd).toBe(0);
    expect(rows[0]!.phases).toEqual([]);
    expect(rows[0]!.cost_partial).toBe(false);
  });

  it("returns [] cleanly when .orchestrator/tasks doesn't exist", async () => {
    const rows = await buildStatusRows(tmp);
    expect(rows).toEqual([]);
  });
});

describe("buildRowForId", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flow-rows-id-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("flags the row as archived when the file lives under tasks/archive/", async () => {
    const dir = path.join(tmp, ".orchestrator", "tasks", "archive");
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, "old.md");
    await fsp.writeFile(
      file,
      taskBody({
        id: "old",
        target_repo: "/repo",
        status: "merged",
        worktree: null,
        branch: null,
        pr: null,
        manual_validation: null,
        merge_commit: null,
        created: "2026-04-25T00:00:00.000Z",
        updated: "2026-04-25T00:00:00.000Z",
      }),
    );
    const row = await buildRowForId(tmp, file);
    expect(row.archived).toBe(true);
    expect(row.status).toBe("merged");
  });
});
