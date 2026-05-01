import { describe, expect, it } from "vitest";
import { buildRows } from "./ls";
import type { FlowStatus } from "./flow-status";
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

function readerFor(map: Record<string, FlowStatus | null>) {
  return (worktree: string) => map[worktree] ?? null;
}

describe(buildRows, () => {
  it("joins state with matching window and pulls phase + activity from .flow-status", () => {
    const status: FlowStatus = {
      phase: "reviewing",
      lastTransitionAt: new Date(NOW - 120_000).toISOString(),
    };
    const rows = buildRows(
      [state({ slug: "csv-export", pr: 142 })],
      [window({ name: "csv-export" })],
      NOW,
      readerFor({ "/repo/wt/csv-export": status }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "csv-export",
      phase: "reviewing",
      pr: "#142",
      lastActivity: "2m ago",
      annotation: "",
    });
  });

  it("annotates state without matching window as (no window)", () => {
    const rows = buildRows([state({ slug: "ghost" })], [], NOW, readerFor({}));
    expect(rows[0].annotation).toBe("(no window)");
  });

  it("annotates window without matching state as (no state)", () => {
    const rows = buildRows([], [window({ name: "manual" })], NOW, readerFor({}));
    expect(rows[0].annotation).toBe("(no state)");
    expect(rows[0].phase).toBe("—");
    expect(rows[0].pr).toBe("—");
  });

  it("falls back to tmux activity for (no state) rows", () => {
    const rows = buildRows(
      [],
      [window({ name: "manual", activity: NOW / 1000 - 90 })],
      NOW,
      readerFor({}),
    );
    expect(rows[0].lastActivity).toBe("1m ago");
  });

  it("falls back to state.phase + state.updatedAt when .flow-status is missing", () => {
    // Pre-worktree window: state.json exists (written by flow new), worktree
    // path is set but the file under it doesn't exist yet.
    const rows = buildRows(
      [state({ slug: "csv-export", phase: "triaging", updatedAt: new Date(NOW - 90_000).toISOString() })],
      [window({ name: "csv-export" })],
      NOW,
      readerFor({}),
    );
    expect(rows[0].phase).toBe("triaging");
    expect(rows[0].lastActivity).toBe("1m ago");
  });

  it("falls back to state.phase + state.updatedAt when state lacks a worktree path", () => {
    // Pre-flow-new-worktree window: cold-start, no worktree at all yet.
    const rows = buildRows(
      [
        state({
          slug: "csv-export",
          phase: "starting",
          worktree: undefined,
          updatedAt: new Date(NOW - 5_000).toISOString(),
        }),
      ],
      [window({ name: "csv-export" })],
      NOW,
      readerFor({}),
    );
    expect(rows[0].phase).toBe("starting");
    expect(rows[0].lastActivity).toBe("5s ago");
  });

  it("prefers .flow-status over state.phase when both exist", () => {
    // .flow-status takes precedence; state.json is the fallback only.
    const status: FlowStatus = {
      phase: "implementing",
      lastTransitionAt: new Date(NOW - 30_000).toISOString(),
    };
    const rows = buildRows(
      [state({ slug: "csv-export", phase: "starting" })],
      [window({ name: "csv-export" })],
      NOW,
      readerFor({ "/repo/wt/csv-export": status }),
    );
    expect(rows[0].phase).toBe("implementing");
    expect(rows[0].lastActivity).toBe("30s ago");
  });

  it("renders missing pr as '—'", () => {
    const rows = buildRows(
      [state({ slug: "x" })],
      [window({ name: "x" })],
      NOW,
      readerFor({}),
    );
    expect(rows[0].pr).toBe("—");
  });

  it("renders activity for terminal phases (merged) so flow done --all-merged can audit", () => {
    const status: FlowStatus = {
      phase: "merged",
      lastTransitionAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    };
    const rows = buildRows(
      [state({ slug: "shipped", pr: 99 })],
      [window({ name: "shipped" })],
      NOW,
      readerFor({ "/repo/wt/csv-export": status }),
    );
    expect(rows[0].phase).toBe("merged");
    expect(rows[0].lastActivity).toBe("3h ago");
  });
});
