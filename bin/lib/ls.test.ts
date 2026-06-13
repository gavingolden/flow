import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRows,
  formatCostCell,
  formatNameCell,
  formatRepoCell,
  runLs,
  runLsCli,
} from "./ls";
import * as stateModule from "./state";
import * as tmuxModule from "./tmux";
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
  const name = overrides.name ?? "csv-export";
  return {
    id: `@${name}`,
    name,
    slug: name,
    activity: NOW / 1000,
    ...overrides,
  };
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
    const rows = await buildRows(
      [],
      [window({ name: "manual", activity: NOW / 1000 - 90 })],
      NOW,
    );
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

  it("renders activity for terminal phases (merged) so flow done --merged can audit", async () => {
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

  it("joins state to a renamed window via @flow-slug, not display name", async () => {
    // The user ran `tmux ,` and renamed the display from `csv-export` to
    // something more readable. The @flow-slug option is unchanged; the
    // join must still find the window.
    const rows = await buildRows(
      [state({ slug: "csv-export", phase: "verifying" })],
      [
        window({
          id: "@5",
          name: "csv export prototype",
          slug: "csv-export",
        }),
      ],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("csv-export");
    expect(rows[0].annotation).toBe("");
  });

  it("falls back to display name when @flow-slug is empty (pre-upgrade window)", async () => {
    const rows = await buildRows(
      [state({ slug: "legacy", phase: "implementing" })],
      [window({ id: "@1", name: "legacy", slug: "" })],
      NOW,
    );
    expect(rows[0].annotation).toBe("");
  });

  it("exposes repo as the basename of state.repo for a managed row", async () => {
    const rows = await buildRows(
      [state({ slug: "x", repo: "/Users/me/code/my-project" })],
      [window({ name: "x" })],
      NOW,
    );
    expect(rows[0].repo).toBe("my-project");
  });

  it("leaves repo empty for a (no state) row", async () => {
    const rows = await buildRows([], [window({ name: "manual" })], NOW);
    expect(rows[0].repo).toBe("");
  });

  it("does not double-count a renamed window as both state row and (no state) row", async () => {
    // Regression: if buildRows used `state.slug ↔ window.name` to gate the
    // (no state) emit, a renamed window would appear twice — once as the
    // matched state row, once as an unmanaged "(no state)" row.
    const rows = await buildRows(
      [state({ slug: "csv-export" })],
      [window({ id: "@5", name: "renamed-by-user", slug: "csv-export" })],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].annotation).toBe("");
  });
});

describe("buildRows — waitForCopilot indicator", () => {
  it("carries waitForCopilot:true onto the row and into the NAME cell", async () => {
    const rows = await buildRows(
      [state({ slug: "csv-export", waitForCopilot: true })],
      [window({ name: "csv-export" })],
      NOW,
    );
    expect(rows[0]).toMatchObject({ waitForCopilot: true, annotation: "" });
    expect(formatNameCell(rows[0])).toBe("csv-export (wait-copilot)");
  });

  it("leaves waitForCopilot false (no marker) when absent", async () => {
    const rows = await buildRows(
      [state({ slug: "csv-export" })],
      [window({ name: "csv-export" })],
      NOW,
    );
    expect(rows[0].waitForCopilot).toBe(false);
    expect(formatNameCell(rows[0])).toBe("csv-export");
  });

  it("(no state) rows are never wait-copilot", async () => {
    const rows = await buildRows([], [window({ name: "manual" })], NOW);
    expect(rows[0].waitForCopilot).toBe(false);
  });

  it("composes a (no window) drift annotation AND the wait-copilot marker", async () => {
    const rows = await buildRows(
      [state({ slug: "ghost", waitForCopilot: true })],
      [],
      NOW,
    );
    expect(rows[0]).toMatchObject({
      annotation: "(no window)",
      waitForCopilot: true,
    });
    expect(formatNameCell(rows[0])).toBe("ghost (no window) (wait-copilot)");
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
      {
        type: "user",
        message: { content: "Use the /flow-pipeline skill for: csv export" },
      },
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

  it("still populates the repo column when opts.cost is true", async () => {
    const rows = await buildRows(
      [state({ slug: "widget-pipeline", repo: "/a/b/widget" })],
      [window({ name: "widget-pipeline" })],
      NOW,
      { cost: true, projectsRoot },
    );
    expect(rows[0].repo).toBe("widget");
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
    expect(
      formatCostCell({
        total: 0,
        byModel: {},
        unknownModels: [],
        hasData: false,
      }),
    ).toBe("—");
  });

  it("renders $ with two decimals when data is present", () => {
    expect(
      formatCostCell({
        total: 2.345,
        byModel: {},
        unknownModels: [],
        hasData: true,
      }),
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

describe(formatRepoCell, () => {
  it("renders — for an unmanaged (no state) row with no repo", () => {
    expect(formatRepoCell("")).toBe("—");
  });

  it("renders the basename verbatim for a managed row", () => {
    expect(formatRepoCell("my-project")).toBe("my-project");
  });
});

describe("runLsCli (--help / -h short-circuit)", () => {
  // The help check must precede every state read and tmux query so the
  // shim is safe to invoke even when ~/.flow/state/ is unreadable.

  for (const flag of ["--help", "-h"]) {
    it(`exits 0 and prints help when args is ['${flag}']`, async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const code = await runLsCli([flag]);
      expect(code).toBe(0);
      expect(err).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls[0][0]).toMatch(/^flow ls — list active pipelines/);
      log.mockRestore();
      err.mockRestore();
    });
  }

  it("mentions the repository in the printed ls help text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runLsCli(["--help"]);
    expect(code).toBe(0);
    const logged = log.mock.calls.map((c) => String(c[0]));
    expect(logged.some((s) => /repositor/i.test(s))).toBe(true);
    log.mockRestore();
  });
});

describe("runLs empty state (Story 5 cross-verb voice)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the 'flow ls:'-prefixed empty-state line when no pipelines exist", async () => {
    vi.spyOn(stateModule, "listStates").mockReturnValue([]);
    vi.spyOn(tmuxModule, "listWindows").mockReturnValue([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runLs({ checkUpdate: () => ({ status: "current" }) });

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toBe("flow ls: no active pipelines");
  });
});

describe("runLs — update notice seam", () => {
  beforeEach(() => {
    vi.spyOn(stateModule, "listStates").mockReturnValue([]);
    vi.spyOn(tmuxModule, "listWindows").mockReturnValue([]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should print an update notice to stderr when checkUpdate reports behind", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runLs({
      checkUpdate: () => ({
        status: "behind",
        behind: 2,
        upgradeCmd: "flow setup --upgrade",
      }),
    });
    expect(code).toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("2 commits behind");
  });

  it("should not print a notice when checkUpdate reports current", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runLs({ checkUpdate: () => ({ status: "current" }) });
    expect(code).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  it("should not print a notice when checkUpdate reports skipped", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runLs({
      checkUpdate: () => ({ status: "skipped", reason: "fetch-failed" }),
    });
    expect(code).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });
});
