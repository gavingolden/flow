import { describe, expect, it } from "vitest";
import { buildRows } from "./ls";
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
  it("joins state with matching window and pulls phase + activity from state.json", () => {
    const rows = buildRows(
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
  });

  it("annotates state without matching window as (no window)", () => {
    const rows = buildRows([state({ slug: "ghost" })], [], NOW);
    expect(rows[0].annotation).toBe("(no window)");
  });

  it("annotates window without matching state as (no state)", () => {
    const rows = buildRows([], [window({ name: "manual" })], NOW);
    expect(rows[0].annotation).toBe("(no state)");
    expect(rows[0].phase).toBe("—");
    expect(rows[0].pr).toBe("—");
  });

  it("falls back to tmux activity for (no state) rows", () => {
    const rows = buildRows([], [window({ name: "manual", activity: NOW / 1000 - 90 })], NOW);
    expect(rows[0].lastActivity).toBe("1m ago");
  });

  it("renders the pre-worktree window with the supervisor's transitions", () => {
    // After flow new: phase = "starting".
    // Supervisor's first action in step 1: flow-state-update --phase triaging.
    const rows = buildRows(
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

  it("renders missing pr as '—'", () => {
    const rows = buildRows([state({ slug: "x", pr: undefined })], [window({ name: "x" })], NOW);
    expect(rows[0].pr).toBe("—");
  });

  it("renders activity for terminal phases (merged) so flow done --all-merged can audit", () => {
    const rows = buildRows(
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

  it("renders — when state.updatedAt is unparseable", () => {
    const rows = buildRows(
      [state({ slug: "x", updatedAt: "not-a-date" })],
      [window({ name: "x" })],
      NOW,
    );
    expect(rows[0].lastActivity).toBe("—");
  });
});
