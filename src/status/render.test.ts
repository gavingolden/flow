import { describe, expect, it } from "vitest";
import { renderStatusDetail, renderStatusTable } from "./render.js";
import type { StatusRow } from "./rows.js";

const fixedNow = () => new Date("2026-04-30T01:00:00.000Z");

const baseRow: StatusRow = {
  id: "task-a",
  path: "/repo/.orchestrator/tasks/task-a.md",
  archived: false,
  status: "verifying",
  phase: "verify",
  pr: 42,
  branch: "agent/task-a",
  worktree: "/wt/task-a",
  created: "2026-04-29T22:00:00.000Z",
  updated: "2026-04-30T00:55:00.000Z",
  cost_total_usd: 1.2345,
  cost_partial: false,
  phases: [
    { name: "plan", attempts: 1, usd: 0.42, partial: false },
    { name: "implement", attempts: 2, usd: 0.8145, partial: false },
  ],
};

describe("renderStatusTable", () => {
  it("returns a single-line message when there are no rows", () => {
    expect(renderStatusTable([], { color: false })).toBe("no tasks found\n");
  });

  it("renders one row with header + data, columns aligned", () => {
    const out = renderStatusTable([baseRow], { color: false, now: fixedNow });
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ID\s+STATUS\s+PHASE\s+PR\s+UPDATED\s+COST$/);
    expect(lines[1]).toContain("task-a");
    expect(lines[1]).toContain("verifying");
    expect(lines[1]).toContain("verify");
    expect(lines[1]).toContain("#42");
    expect(lines[1]).toMatch(/\$1\.2345/);
    // No ANSI when colour disabled.
    expect(lines[1]).not.toMatch(/\[/);
  });

  it("emits red ANSI on the status cell for needs-human when colour=true", () => {
    const row = { ...baseRow, status: "needs-human" as const, phase: "verify" };
    const out = renderStatusTable([row], { color: true, now: fixedNow });
    // Red on, red off.
    expect(out).toMatch(/\x1b\[31m/);
  });

  it("does NOT emit ANSI when colour=false even for needs-human", () => {
    const row = { ...baseRow, status: "needs-human" as const, phase: "verify" };
    const out = renderStatusTable([row], { color: false, now: fixedNow });
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("formats cost as 4-decimal USD even for cents-scale runs", () => {
    const row = { ...baseRow, cost_total_usd: 0.0042 };
    const out = renderStatusTable([row], { color: false, now: fixedNow });
    expect(out).toContain("$0.0042");
  });

  it("renders relative-age strings for the UPDATED column", () => {
    const row = {
      ...baseRow,
      updated: "2026-04-29T01:00:00.000Z", // exactly 1 day before fixedNow
    };
    const out = renderStatusTable([row], { color: false, now: fixedNow });
    expect(out).toMatch(/\b1d\b/);
  });

  it("displays '-' for tasks with no PR yet", () => {
    const row = { ...baseRow, pr: null };
    const out = renderStatusTable([row], { color: false, now: fixedNow });
    expect(out).toMatch(/\s-\s/);
  });
});

describe("renderStatusDetail", () => {
  const body = [
    "## Phase log",
    "",
    "- 2026-04-29T00:00:00Z triaged → planning",
    "- 2026-04-29T00:05:00Z planning → planned",
    "",
    "## Phase outputs",
    "",
    "(empty)",
    ""
  ].join("\n");

  it("prints the frontmatter pointers, the phase log, and a per-phase cost block", () => {
    const out = renderStatusDetail(baseRow, body, { color: false });
    expect(out).toContain("# task-a");
    expect(out).toContain("status:");
    expect(out).toContain("verifying");
    expect(out).toContain("pr:");
    expect(out).toContain("#42");
    expect(out).toContain("branch:");
    expect(out).toContain("agent/task-a");
    expect(out).toContain("triaged → planning");
    expect(out).not.toContain("Phase outputs");
    expect(out).toContain("plan:");
    expect(out).toContain("implement:");
    expect(out).toContain("$0.4200");
    expect(out).toContain("$0.8145");
    expect(out).toContain("(2 attempts)");
    expect(out).toContain("total:");
    expect(out).toContain("$1.2345");
  });

  it("annotates partial phases with (partial)", () => {
    const row: StatusRow = {
      ...baseRow,
      phases: [
        { name: "verify", attempts: 1, usd: 0, partial: true },
      ],
      cost_total_usd: 0,
      cost_partial: true,
    };
    const out = renderStatusDetail(row, body, { color: false });
    expect(out).toContain("(partial)");
  });

  it("emits a friendly message when the task has no log files yet", () => {
    const row: StatusRow = {
      ...baseRow,
      phases: [],
      cost_total_usd: 0,
      cost_partial: false,
    };
    const out = renderStatusDetail(row, body, { color: false });
    expect(out).toContain("(no logs yet)");
  });

  it("does NOT emit ANSI for the (archived) marker when colour=false (regression: PR #23)", () => {
    // `pc.dim` defers to picocolors' own env detection and would emit ANSI
    // even when the caller has explicitly disabled colour. Route the dim
    // styling through the same opts.color decision as the rest of the
    // renderer so `--json` callers and non-TTY sinks stay clean.
    const row: StatusRow = { ...baseRow, archived: true };
    const out = renderStatusDetail(row, body, { color: false });
    expect(out).toContain("(archived)");
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("total in detail equals row.cost_total_usd to 4 decimals", () => {
    const row: StatusRow = {
      ...baseRow,
      phases: [
        { name: "plan", attempts: 1, usd: 0.42, partial: false },
        { name: "implement", attempts: 1, usd: 0.5145, partial: false },
        { name: "verify", attempts: 1, usd: 0.3, partial: false },
      ],
      cost_total_usd: 0.42 + 0.5145 + 0.3,
    };
    const out = renderStatusDetail(row, body, { color: false });
    const totalLine = out.split("\n").find((l) => l.startsWith("total:"))!;
    expect(totalLine).toContain("$1.2345");
  });
});
