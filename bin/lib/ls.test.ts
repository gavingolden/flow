import { describe, expect, it } from "vitest";
import { buildRows, humanizeActivity } from "./ls";
import type { PipelineState } from "./state";
import type { TmuxWindow } from "./tmux";

const NOW = Date.UTC(2026, 3, 30, 12, 30, 0); // 2026-04-30T12:30:00Z

function state(overrides: Partial<PipelineState>): PipelineState {
  return {
    slug: "csv-export",
    phase: "starting",
    repo: "/repo",
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function window(overrides: Partial<TmuxWindow>): TmuxWindow {
  return { name: "csv-export", activity: NOW / 1000, ...overrides };
}

describe(buildRows, () => {
  it("joins state with matching window", () => {
    const rows = buildRows(
      [state({ slug: "csv-export", phase: "reviewing", pr: 142 })],
      [window({ name: "csv-export", activity: NOW / 1000 - 120 })],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "csv-export",
      phase: "reviewing",
      pr: "#142",
      annotation: "",
    });
    expect(rows[0].lastActivity).toContain("ago");
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

  it("uses state.updatedAt when no window activity is available", () => {
    const updatedAt = new Date(NOW - 600_000).toISOString(); // 10 minutes ago
    const rows = buildRows([state({ slug: "x", updatedAt })], [], NOW);
    expect(rows[0].lastActivity).toBe("10m ago");
  });

  it("renders missing pr as '—'", () => {
    const rows = buildRows([state({ slug: "x" })], [window({ name: "x" })], NOW);
    expect(rows[0].pr).toBe("—");
  });
});

describe(humanizeActivity, () => {
  it("formats sub-minute as seconds", () => {
    expect(humanizeActivity(NOW - 30_000, NOW)).toBe("30s ago");
  });
  it("formats sub-hour as minutes", () => {
    expect(humanizeActivity(NOW - 12 * 60_000, NOW)).toBe("12m ago");
  });
  it("formats sub-day as hours", () => {
    expect(humanizeActivity(NOW - 3 * 60 * 60_000, NOW)).toBe("3h ago");
  });
  it("formats multi-day", () => {
    expect(humanizeActivity(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe("2d ago");
  });
});
