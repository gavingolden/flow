import { describe, expect, it } from "vitest";
import {
  renderBoard,
  renderEpicList,
  renderTickSummary,
  type EpicListRow,
} from "./epic-render";
import type { BoardRow, ReconcileSummary } from "./epic-reconcile";

describe("renderBoard", () => {
  const board: BoardRow[] = [
    {
      id: "schema",
      status: "merged",
      slug: "watchlist-schema",
      pr: 12,
      phase: "merged",
      dependsOn: [],
    },
    {
      id: "list-ui",
      status: "running",
      slug: "watchlist-list-ui",
      pr: 14,
      phase: "ci-wait",
      dependsOn: ["backend"],
    },
    {
      id: "nav-wiring",
      status: "blocked",
      dependsOn: ["list-ui", "add-form"],
    },
  ];
  const summary: ReconcileSummary = {
    ready: 0,
    running: 1,
    blocked: 1,
    merged: 1,
    total: 3,
  };

  it("emits the header + one row per feature with status/slug/pr/phase", () => {
    const out = renderBoard(board, summary);
    expect(out).toContain("FEATURE");
    expect(out).toContain("STATUS");
    expect(out).toContain("WAITS ON");
    expect(out).toContain("schema");
    expect(out).toContain("watchlist-list-ui");
    expect(out).toContain("#14");
    expect(out).toContain("ci-wait");
    // The lines: header + 3 feature rows + summary line = 5.
    expect(out.split("\n")).toHaveLength(5);
  });

  it("shows unmet deps only for a blocked row, a dash elsewhere", () => {
    const out = renderBoard(board, summary);
    expect(out).toContain("list-ui, add-form"); // blocked nav-wiring's WAITS ON
    const navLine = out.split("\n").find((l) => l.startsWith("nav-wiring"))!;
    expect(navLine).toContain("list-ui, add-form");
    const schemaLine = out.split("\n").find((l) => l.startsWith("schema"))!;
    expect(schemaLine).toContain("—"); // merged schema waits on nothing
  });

  it("ends with the ready/running/blocked/merged summary line", () => {
    const out = renderBoard(board, summary);
    expect(out).toContain("ready: 0   running: 1   blocked: 1   merged: 1 / 3");
  });

  it("renders an external marker for an adopted merged row", () => {
    const adoptedBoard: BoardRow[] = [
      {
        id: "schema",
        status: "merged",
        adopted: true,
        issueNumber: 310,
        dependsOn: [],
      },
    ];
    const s: ReconcileSummary = {
      ready: 0,
      running: 0,
      blocked: 0,
      merged: 1,
      total: 1,
    };
    const out = renderBoard(adoptedBoard, s);
    expect(out).toContain("merged (external #310)");
  });

  it("renders the bare external marker for an adopted row without an issueNumber", () => {
    const adoptedBoard: BoardRow[] = [
      {
        id: "schema",
        status: "merged",
        adopted: true,
        dependsOn: [],
      },
    ];
    const s: ReconcileSummary = {
      ready: 0,
      running: 0,
      blocked: 0,
      merged: 1,
      total: 1,
    };
    const out = renderBoard(adoptedBoard, s);
    expect(out).toContain("merged (external)");
    expect(out).not.toContain("external #");
  });
});

describe("renderEpicList", () => {
  const rows: EpicListRow[] = [
    {
      slug: "watchlist",
      ready: 0,
      running: 2,
      blocked: 1,
      merged: 2,
      total: 5,
      status: "running",
    },
    {
      slug: "billing",
      ready: 0,
      running: 0,
      blocked: 0,
      merged: 3,
      total: 3,
      status: "done",
    },
  ];

  it("emits one row per epic with per-state counts + overall status", () => {
    const out = renderEpicList(rows);
    expect(out).toContain("EPIC");
    expect(out).toContain("watchlist");
    expect(out).toContain("billing");
    expect(out).toContain("2 / 5");
    expect(out).toContain("3 / 3");
    expect(out).toContain("running");
    expect(out).toContain("done");
    expect(out.split("\n")).toHaveLength(3); // header + 2 epics
  });

  it("renders an empty-state line when there are no epics", () => {
    expect(renderEpicList([])).toBe("no epics");
  });
});

describe("renderTickSummary", () => {
  it("a multi-feature launch carries the (parallel) [n/K] marker", () => {
    const out = renderTickSummary(
      [
        { id: "list-ui", slug: "watchlist-list-ui" },
        { id: "add-form", slug: "watchlist-add-form" },
      ],
      { used: 2, max: 3 },
    );
    expect(out).toContain("(parallel)");
    expect(out).toContain("[2/3]");
    expect(out).toContain("list-ui, add-form");
  });

  it("a single launch reads `launched <id> → flow:<slug> [n/K]`, no (parallel)", () => {
    const out = renderTickSummary(
      [{ id: "schema", slug: "watchlist-schema" }],
      { used: 1, max: 3 },
    );
    expect(out).toContain("launched schema");
    expect(out).toContain("flow:watchlist-schema");
    expect(out).toContain("[1/3]");
    expect(out).not.toContain("(parallel)");
  });

  it("nothing launched this tick → empty string", () => {
    expect(renderTickSummary([], { used: 0, max: 3 })).toBe("");
  });
});
