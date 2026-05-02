import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRows, formatCostCell } from "./ls";
import { encodeProjectSegment } from "./cost";
import type { PipelineState } from "./state";
import type { TmuxWindow } from "./tmux";

const NOW = Date.UTC(2026, 3, 30, 12, 30, 0); // 2026-04-30T12:30:00Z

function state(overrides: Partial<PipelineState>): PipelineState {
  return {
    slug: "csv-export",
    phase: "starting",
    repo: "/repo",
    worktree: "/repo/wt/csv-export",
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function window(overrides: Partial<TmuxWindow>): TmuxWindow {
  return { name: "csv-export", activity: NOW / 1000, ...overrides };
}

describe(buildRows, () => {
  it("joins state with matching window and pulls phase + activity from state.json", async () => {
    const rows = await buildRows(
      [
        state({
          slug: "csv-export",
          phase: "reviewing",
          pr: 142,
          updatedAt: new Date(NOW - 120_000).toISOString(),
        }),
      ],
      [window({ name: "csv-export" })],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "csv-export",
      phase: "reviewing",
      pr: "#142",
      lastActivity: "2m ago",
      annotation: "",
    });
    expect(rows[0].cost).toBeUndefined();
  });

  it("annotates state without matching window as (no window)", async () => {
    const rows = await buildRows([state({ slug: "ghost" })], [], NOW);
    expect(rows[0].annotation).toBe("(no window)");
  });

  it("annotates window without matching state as (no state)", async () => {
    const rows = await buildRows([], [window({ name: "manual" })], NOW);
    expect(rows[0].annotation).toBe("(no state)");
    expect(rows[0].phase).toBe("—");
    expect(rows[0].pr).toBe("—");
  });

  it("falls back to tmux activity for (no state) rows", async () => {
    const rows = await buildRows([], [window({ name: "manual", activity: NOW / 1000 - 90 })], NOW);
    expect(rows[0].lastActivity).toBe("1m ago");
  });

  it("renders the pre-worktree window with the supervisor's transitions", async () => {
    const rows = await buildRows(
      [
        state({
          slug: "csv-export",
          phase: "triaging",
          worktree: undefined,
          updatedAt: new Date(NOW - 5_000).toISOString(),
        }),
      ],
      [window({ name: "csv-export" })],
      NOW,
    );
    expect(rows[0].phase).toBe("triaging");
    expect(rows[0].lastActivity).toBe("5s ago");
  });

  it("renders missing pr as '—'", async () => {
    const rows = await buildRows(
      [state({ slug: "x", pr: undefined })],
      [window({ name: "x" })],
      NOW,
    );
    expect(rows[0].pr).toBe("—");
  });

  it("renders activity for terminal phases (merged) so flow done --all-merged can audit", async () => {
    const rows = await buildRows(
      [
        state({
          slug: "shipped",
          phase: "merged",
          pr: 99,
          updatedAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
        }),
      ],
      [window({ name: "shipped" })],
      NOW,
    );
    expect(rows[0].phase).toBe("merged");
    expect(rows[0].lastActivity).toBe("3h ago");
  });

  it("renders — when state.updatedAt is unparseable", async () => {
    const rows = await buildRows(
      [state({ slug: "x", updatedAt: "not-a-date" })],
      [window({ name: "x" })],
      NOW,
    );
    expect(rows[0].lastActivity).toBe("—");
  });
});

describe("buildRows + cost", () => {
  let projectsRoot: string;

  beforeEach(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ls-cost-"));
  });

  afterEach(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  function seedSession(repo: string, slug: string, lines: object[]): void {
    const projectDir = path.join(projectsRoot, encodeProjectSegment(repo));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${slug}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n"),
    );
  }

  it("attaches a CostBreakdown when opts.cost is true", async () => {
    const repo = "/some/repo";
    seedSession(repo, "csv-export", [
      { type: "user", message: { content: "Use the /flow-pipeline skill for: csv export" } },
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ]);
    const rows = await buildRows(
      [state({ slug: "csv-export", repo })],
      [window({ name: "csv-export" })],
      NOW,
      { cost: true, projectsRoot },
    );
    expect(rows[0].cost?.hasData).toBe(true);
    expect(rows[0].cost?.total).toBeCloseTo(3, 6);
  });

  it("returns hasData:false in the cost field when no JSONL exists", async () => {
    const rows = await buildRows(
      [state({ slug: "csv-export", repo: "/no/jsonl/here" })],
      [window({ name: "csv-export" })],
      NOW,
      { cost: true, projectsRoot },
    );
    expect(rows[0].cost).toBeDefined();
    expect(rows[0].cost?.hasData).toBe(false);
  });
});

describe(formatCostCell, () => {
  it("renders — when no data", () => {
    expect(formatCostCell(undefined)).toBe("—");
    expect(formatCostCell({ total: 0, byModel: {}, unknownModels: [], hasData: false })).toBe("—");
  });

  it("renders $ with two decimals when data is present", () => {
    expect(
      formatCostCell({ total: 2.345, byModel: {}, unknownModels: [], hasData: true }),
    ).toBe("$2.35");
  });

  it("prefixes with ~ when unknown models inflated under-counting risk", () => {
    expect(
      formatCostCell({
        total: 1.2,
        byModel: {},
        unknownModels: ["claude-experimental"],
        hasData: true,
      }),
    ).toBe("~$1.20");
  });
});

