import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRows as buildRowsImpl,
  formatCostCell,
  formatEpicCell,
  formatKindCell,
  formatNameCell,
  formatRepoCell,
  printOrphanRecovery,
  resolveRowKind,
  runLs,
  runLsCli,
  type LsOptions,
  type Row,
} from "./ls";
import * as stateModule from "./state";
import * as tmuxModule from "./tmux";
import * as livenessModule from "./liveness";
import { encodeProjectSegment } from "./cost";
import type { PipelineState } from "./state";
import type { TmuxWindow } from "./tmux";
import type { InstallDriftResult } from "./install-drift";

const NOW = Date.UTC(2026, 3, 30, 12, 30, 0); // 2026-04-30T12:30:00Z

/** No-drift stub for `checkDrift` — a required LsOptions field most tests
 * here don't exercise directly (install-drift.test.ts owns the detector's
 * own behaviour; the "update notice seam" describe block below covers the
 * emit/no-emit wiring). */
const NO_DRIFT: () => InstallDriftResult = () => ({ status: "clean" });

/** `buildRows` with `checkDrift` defaulted, so the ~26 existing call sites
 * below don't each need to know about a field they never exercise. Any
 * call site that DOES pass its own `opts` still wins via the spread. */
function buildRows(
  states: PipelineState[],
  windows: TmuxWindow[],
  nowMs: number,
  opts: Partial<LsOptions> = {},
): ReturnType<typeof buildRowsImpl> {
  return buildRowsImpl(states, windows, nowMs, {
    checkDrift: NO_DRIFT,
    ...opts,
  });
}

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
    expect(rows[0].epic).toBe("");
    // kind: "" is the only legal empty value, documented at bin/lib/ls.ts's
    // unmanaged-window fallback — pin it so a future default change is caught.
    expect(rows[0].kind).toBe("");
  });

  it("pulls the epic slug from state.epic for an epic-launched pipeline", async () => {
    const rows = await buildRows(
      [
        state({
          slug: "csv-export",
          epic: { slug: "checkout-revamp", featureId: "csv-export" },
        }),
      ],
      [window({ name: "csv-export" })],
      NOW,
    );
    expect(rows[0].epic).toBe("checkout-revamp");
  });

  it("renders an empty epic field for a non-epic pipeline", async () => {
    const rows = await buildRows([state({ slug: "csv-export" })], [], NOW);
    expect(rows[0].epic).toBe("");
  });

  it.each(["feature", "epic-design", "epic-run"] as const)(
    "buildRows carries the persisted kind %s straight through to the row",
    async (kind) => {
      const rows = await buildRows(
        [state({ slug: "csv-export", kind })],
        [],
        NOW,
      );
      expect(rows[0].kind).toBe(kind);
    },
  );

  it("resolveRowKind falls back to epic-design for an absent kind at an epic phase", () => {
    expect(
      resolveRowKind(state({ phase: "epic-designing", kind: undefined })),
    ).toBe("epic-design");
  });

  it("resolveRowKind falls back to feature for an absent kind at a non-epic phase", () => {
    expect(
      resolveRowKind(state({ phase: "implementing", kind: undefined })),
    ).toBe("feature");
  });

  it("a non-feature row with no state.epic membership falls back to its own slug under EPIC", async () => {
    const rows = await buildRows(
      [
        state({
          slug: "design-thing",
          phase: "epic-designing",
          kind: "epic-design",
        }),
      ],
      [],
      NOW,
    );
    expect(rows[0].epic).toBe("design-thing");
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

describe("buildRows — liveness annotation ('(crashed)')", () => {
  // buildRows' job here is only to WIRE a matched window's livenessOf verdict
  // to the annotation — livenessOf's own dead/stale/alive/unknown logic is
  // liveness.test.ts's job, so every case here spies on livenessOf directly
  // rather than re-deriving a real verdict (no real process probe needed).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // This whole block is scoped to NON-TERMINAL phases — buildRows checks
  // phase before liveness (see the phase-x-liveness matrix below), so every
  // fixture in THIS block pins an explicit "verifying" phase rather than
  // relying on state()'s default. This assertion instead guards the
  // fixtures elsewhere that DO rely on state()'s default phase and assume
  // it stays non-terminal: the top-level describe("buildRows") block, the
  // waitForCopilot block, and the orphan-recovery footnote block.
  // If "starting" (state()'s default phase) is ever changed to a terminal
  // value, those blocks would silently stop exercising the liveness path
  // they claim to cover.
  it("state()'s default phase is non-terminal (guards this block's premise)", () => {
    expect(stateModule.TERMINAL_PHASE_SET.has(state({}).phase)).toBe(false);
  });

  it("annotates a matched window whose recorded process is dead/stale as (crashed)", async () => {
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("stale");
    const rows = await buildRows(
      [
        state({
          slug: "csv-export",
          phase: "verifying",
          pid: 4242,
          procStartedAt: 1_700_000_000,
        }),
      ],
      [window({ name: "csv-export" })],
      NOW,
    );
    expect(rows[0].annotation).toBe("(crashed)");
  });

  it("does not annotate a matched window whose recorded process is alive (regression pin: liveness does not disturb the healthy case)", async () => {
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("alive");
    const rows = await buildRows(
      [
        state({
          slug: "csv-export",
          phase: "verifying",
          pid: 4242,
          procStartedAt: 1_700_000_000,
        }),
      ],
      [window({ name: "csv-export" })],
      NOW,
    );
    expect(rows[0].annotation).toBe("");
  });

  it("does not annotate a matched window with no liveness signal (old-format state, unknown verdict — regression pin)", async () => {
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("unknown");
    const rows = await buildRows(
      [state({ slug: "csv-export", phase: "verifying" })], // no pid/procStartedAt — old-format
      [window({ name: "csv-export" })],
      NOW,
    );
    expect(rows[0].annotation).toBe("");
  });

  // Liveness-first verdict matrix: the file-signal verdict outranks window
  // existence, so a live PLAIN pipeline (windowless by design) shows healthy.
  it("windowless + alive ⇒ no annotation (a live plain pipeline is never reaped-looking)", async () => {
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("alive");
    const rows = await buildRows(
      [
        state({
          slug: "plain-live",
          phase: "verifying",
          pid: 4242,
          procStartedAt: 1_700_000_000,
        }),
      ],
      [],
      NOW,
    );
    expect(rows[0].annotation).toBe("");
  });

  it("windowless + dead/stale ⇒ (crashed)", async () => {
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("dead");
    const rows = await buildRows(
      [
        state({
          slug: "ghost",
          phase: "verifying",
          pid: 4242,
          procStartedAt: 1_700_000_000,
        }),
      ],
      [],
      NOW,
    );
    expect(rows[0].annotation).toBe("(crashed)");
  });

  it("windowless + unknown (legacy state, no pid signal) ⇒ (no window)", async () => {
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("unknown");
    const rows = await buildRows(
      [state({ slug: "ghost", phase: "verifying" })],
      [],
      NOW,
    );
    expect(rows[0].annotation).toBe("(no window)");
  });
});

describe("buildRows — phase-aware annotation (terminal phases outrank liveness)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const LIVENESS_VERDICTS = ["alive", "dead", "stale", "unknown"] as const;
  const matrix = stateModule.TERMINAL_PHASES.flatMap((phase) =>
    LIVENESS_VERDICTS.map((verdict) => [phase, verdict] as const),
  );

  // Literal bucket-membership pin, independent of FINISHED_PHASES: the
  // matrix test below derives its expected annotation from the SAME
  // constant the implementation reads, so a bucket misclassification
  // (e.g. someone moves "cancelled" into AWAITING_HUMAN_PHASES) would flip
  // both sides in lockstep and the matrix test would still pass. This
  // table hand-lists every terminal phase's expected annotation so moving
  // a phase between buckets fails the suite.
  const EXPECTED_ANNOTATION_BY_PHASE: Record<string, "(done)" | ""> = {
    merged: "(done)",
    cancelled: "(done)",
    "epic-approved": "(done)",
    gated: "",
    "needs-human": "",
  };

  it("pins every terminal phase's expected annotation bucket by literal", () => {
    expect(Object.keys(EXPECTED_ANNOTATION_BY_PHASE).sort()).toEqual(
      [...stateModule.TERMINAL_PHASES].sort(),
    );
  });

  it.each(matrix)(
    "phase=%s, liveness=%s ⇒ correct bucket annotation, needsResumeHint false",
    async (phase, verdict) => {
      vi.spyOn(livenessModule, "livenessOf").mockReturnValue(verdict);
      const rows = await buildRows(
        [
          state({
            slug: "terminal-row",
            phase,
            pid: 4242,
            procStartedAt: 1_700_000_000,
          }),
        ],
        [], // no window: proves the phase check pre-empts BOTH the liveness
        // verdict and the window-existence fallback, not just the verdict.
        NOW,
      );
      expect(rows[0].annotation).toBe(EXPECTED_ANNOTATION_BY_PHASE[phase]);
      expect(rows[0].needsResumeHint).toBe(false);
    },
  );

  // NEW case, not a re-parametrization of EXPECTED_ANNOTATION_BY_PHASE
  // above: that table's rows carry no `kind`, so the fallback resolves
  // "epic-approved" to "epic-design" and stays green untouched. A row whose
  // persisted kind IS "epic-run" is the carve-out — but ONLY while its run
  // window is still live: its shared state.json's phase describes the
  // design lifecycle, not the run, so a FINISHED phase must render no
  // annotation and no resume hint while the window is present (the row is
  // live, not orphaned).
  it("kind=epic-run at a FINISHED phase with a live window ⇒ empty annotation, needsResumeHint false", async () => {
    const rows = await buildRows(
      [
        state({
          slug: "run-row",
          phase: "epic-approved",
          kind: "epic-run",
        }),
      ],
      [window({ name: "run-row" })],
      NOW,
    );
    expect(rows[0].annotation).toBe("");
    expect(rows[0].needsResumeHint).toBe(false);
  });

  // Regression pin for the finding this PR fixed: without the `window`
  // condition, a FINISHED (or never-launched) epic-run row with no window
  // suppressed "(done)" unconditionally and rendered blank forever,
  // indistinguishable from a genuinely live run. With no window present,
  // "(done)" must render — and must NOT fall through to `livenessOf`
  // (no pid is recorded for the run window, so that path would misread
  // "(crashed)").
  it("kind=epic-run at a FINISHED phase with NO window ⇒ (done), not blank or (crashed)", async () => {
    const rows = await buildRows(
      [
        state({
          slug: "run-row",
          phase: "epic-approved",
          kind: "epic-run",
        }),
      ],
      [],
      NOW,
    );
    expect(rows[0].annotation).toBe("(done)");
    expect(rows[0].needsResumeHint).toBe(false);
  });

  // Regression pin alongside the carve-out above: a "feature" row (or any
  // non-epic-run kind) at a FINISHED phase still renders "(done)".
  it("kind=feature at a FINISHED phase still renders (done) (regression pin)", async () => {
    const rows = await buildRows(
      [
        state({
          slug: "done-row",
          phase: "merged",
          kind: "feature",
        }),
      ],
      [],
      NOW,
    );
    expect(rows[0].annotation).toBe("(done)");
  });

  // Named regression case: this is the bug report. A merged pipeline with a
  // dead recorded pid must read (done), never (crashed).
  it("phase=merged + dead pid ⇒ (done), never (crashed) (regression pin)", async () => {
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("dead");
    const rows = await buildRows(
      [
        state({
          slug: "merged-row",
          phase: "merged",
          pid: 4242,
          procStartedAt: 1_700_000_000,
        }),
      ],
      [window({ name: "merged-row" })],
      NOW,
    );
    expect(rows[0].annotation).toBe("(done)");
    expect(rows[0].annotation).not.toBe("(crashed)");
  });

  // Story 3: a merged pipeline's (done) label must not depend on whether a
  // pid was ever recorded at all — dead, live, and pid-less all agree.
  it("merged ⇒ (done) regardless of dead pid, live pid, or no pid recorded", async () => {
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("dead");
    const deadRows = await buildRows(
      [state({ slug: "m1", phase: "merged", pid: 1, procStartedAt: 1 })],
      [],
      NOW,
    );
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("alive");
    const liveRows = await buildRows(
      [state({ slug: "m2", phase: "merged", pid: 2, procStartedAt: 2 })],
      [],
      NOW,
    );
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("unknown");
    const noPidRows = await buildRows(
      [state({ slug: "m3", phase: "merged" })], // no pid/procStartedAt at all
      [],
      NOW,
    );
    expect(deadRows[0].annotation).toBe("(done)");
    expect(liveRows[0].annotation).toBe("(done)");
    expect(noPidRows[0].annotation).toBe("(done)");
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

describe(formatEpicCell, () => {
  it("renders — for a pipeline that isn't epic-launched", () => {
    expect(formatEpicCell("")).toBe("—");
  });

  it("renders the epic slug verbatim for an epic-launched pipeline", () => {
    expect(formatEpicCell("checkout-revamp")).toBe("checkout-revamp");
  });
});

describe(formatKindCell, () => {
  it("renders — for the empty-string kind (unmanaged '(no state)' rows only)", () => {
    expect(formatKindCell("")).toBe("—");
  });

  it("renders each PipelineKind verbatim", () => {
    expect(formatKindCell("feature")).toBe("feature");
    expect(formatKindCell("epic-design")).toBe("epic-design");
    expect(formatKindCell("epic-run")).toBe("epic-run");
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

    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toBe("flow ls: no active pipelines");
  });
});

describe("runLs — printed table header", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the header row includes an EPIC column (unit-automates PR Test Steps item 4: `bun bin/flow ls | head -1 | grep -q 'EPIC'`)", async () => {
    vi.spyOn(stateModule, "listStates").mockReturnValue([
      state({ slug: "some-pipeline", phase: "verifying", repo: "/repo" }),
    ]);
    vi.spyOn(tmuxModule, "listWindows").mockReturnValue([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });

    expect(code).toBe(0);
    const headerLine = String(log.mock.calls[0][0]);
    expect(headerLine).toContain("EPIC");
  });

  it("the header row includes a KIND column, and a data row renders its cell", async () => {
    vi.spyOn(stateModule, "listStates").mockReturnValue([
      state({
        slug: "some-pipeline",
        phase: "verifying",
        repo: "/repo",
        kind: "feature",
      }),
    ]);
    vi.spyOn(tmuxModule, "listWindows").mockReturnValue([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });

    expect(code).toBe(0);
    const headerLine = String(log.mock.calls[0][0]);
    const kindHeaderIndex = headerLine.indexOf("KIND");
    expect(kindHeaderIndex).toBeGreaterThan(-1);

    // Not just "the word appears somewhere" — the data row must actually
    // render a kind value at (roughly) the same column as the header.
    const dataLine = String(
      log.mock.calls.find((call) =>
        String(call[0]).includes("some-pipeline"),
      )?.[0],
    );
    expect(dataLine).toContain("feature");
  });
});

describe("runLs — orphan recovery footnote", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces `flow feature resume <slug>` below the table for an orphan ('(no window)') row", async () => {
    // A PAST-`starting` crash for `ghost` with no matching tmux window → buildRows
    // annotates it `(no window)` and the recovery footnote prints its restart
    // command. (phase must be past `starting`, else the lazy reaper would silently
    // reap it as a never-started orphan rather than offer a resume.)
    vi.spyOn(stateModule, "listStates").mockReturnValue([
      state({ slug: "ghost", phase: "verifying", repo: "/repo" }),
    ]);
    vi.spyOn(tmuxModule, "listWindows").mockReturnValue([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("flow feature resume ghost");
  });

  it("surfaces `flow feature resume <slug>` below the table for a (crashed) row (window present, process dead/stale)", async () => {
    // A window IS matched for the slug, but the file-signal liveness check
    // reports the recorded process dead/stale — buildRows annotates
    // "(crashed)" and printOrphanRecovery's widened filter must still catch
    // it (not just the "(no window)" case).
    vi.spyOn(stateModule, "listStates").mockReturnValue([
      state({ slug: "zombie", phase: "verifying", repo: "/repo" }),
    ]);
    vi.spyOn(tmuxModule, "listWindows").mockReturnValue([
      window({ name: "zombie" }),
    ]);
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("dead");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("(crashed)");
    expect(out).toContain("flow feature resume zombie");
  });

  it("preserved behaviour: phase=reviewing + dead pid ⇒ (crashed) and present in the footer", async () => {
    // Pins a second non-terminal phase (not just 'verifying') through the
    // same crashed+footer path, so the phase-first branch is proven not to
    // special-case 'verifying' specifically.
    vi.spyOn(stateModule, "listStates").mockReturnValue([
      state({
        slug: "reviewing-zombie",
        phase: "reviewing",
        repo: "/repo",
        pid: 4242,
        procStartedAt: 1_700_000_000,
      }),
    ]);
    vi.spyOn(tmuxModule, "listWindows").mockReturnValue([
      window({ name: "reviewing-zombie" }),
    ]);
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("dead");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("(crashed)");
    expect(out).toContain("flow feature resume reviewing-zombie");
  });

  it("does NOT surface a merged pipeline under 'pipelines needing resume', even with a dead recorded pid", async () => {
    // Sibling to the (crashed) case above, opposite outcome: a finished
    // pipeline is never a resume candidate, regardless of liveness.
    vi.spyOn(stateModule, "listStates").mockReturnValue([
      state({
        slug: "done-pipeline",
        phase: "merged",
        repo: "/repo",
        pid: 4242,
        procStartedAt: 1_700_000_000,
      }),
    ]);
    vi.spyOn(tmuxModule, "listWindows").mockReturnValue([]);
    vi.spyOn(livenessModule, "livenessOf").mockReturnValue("dead");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("done-pipeline (done)");
    expect(out).not.toContain("pipelines needing resume");
    expect(out).not.toContain("flow feature resume done-pipeline");
  });

  it("footer eligibility follows needsResumeHint, not the annotation string (decoupling guard)", () => {
    // Real buildRows always sets annotation and needsResumeHint together
    // (by design — see the phase-first block's comment), so this
    // deliberately hand-builds a Row[] that decouples them: a row whose
    // annotation happens to read "(crashed)" but whose needsResumeHint is
    // false must be ABSENT from the footer, and the converse (annotation
    // "" but needsResumeHint true) must be PRESENT. This is the only
    // regression guard against printOrphanRecovery silently reverting to
    // string-matching the annotation instead of reading needsResumeHint.
    const falseFlagCrashed: Row = {
      name: "false-flag",
      repo: "/repo",
      kind: "feature",
      epic: "",
      phase: "merged",
      pr: "—",
      lastActivity: "—",
      annotation: "(crashed)",
      needsResumeHint: false,
      waitForCopilot: false,
    };
    const trueFlagHealthyLooking: Row = {
      name: "true-flag",
      repo: "/repo",
      kind: "feature",
      epic: "",
      phase: "verifying",
      pr: "—",
      lastActivity: "—",
      annotation: "",
      needsResumeHint: true,
      waitForCopilot: false,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printOrphanRecovery([falseFlagCrashed, trueFlagHealthyLooking]);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toContain("flow feature resume false-flag");
    expect(out).toContain("flow feature resume true-flag");
  });

  it("prints no recovery footnote when every pipeline has a live window", async () => {
    // Non-orphan output must be unchanged — no `flow feature resume` line leaks.
    vi.spyOn(stateModule, "listStates").mockReturnValue([
      state({ slug: "csv-export", repo: "/repo" }),
    ]);
    vi.spyOn(tmuxModule, "listWindows").mockReturnValue([
      window({ name: "csv-export" }),
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toMatch(/flow feature resume/);
  });
});

describe("runLs — lazy orphan reaper (Task 6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reaps a stale phase=starting no-window orphan (absent) but keeps a past-starting (no window) resume hint", async () => {
    // A never-started orphan: phase `starting`, no window, updatedAt far older
    // than the grace window (NOW is months before the real Date.now() runLs
    // uses). A past-`starting` crash with no window is a legitimately resumable
    // pipeline and must survive the sweep with its `(no window)` annotation.
    vi.spyOn(stateModule, "listStates").mockReturnValue([
      state({ slug: "reap-ls-stale", phase: "starting", repo: "/repo" }),
      state({ slug: "reap-ls-crashed", phase: "verifying", repo: "/repo" }),
    ]);
    vi.spyOn(tmuxModule, "listWindows").mockReturnValue([]);
    // Stub the reaper's delete so it never touches the real ~/.flow.
    const del = vi.spyOn(stateModule, "deleteState").mockReturnValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    // The stale starting/no-window orphan was reaped: deleted + not shown.
    expect(del).toHaveBeenCalledWith("reap-ls-stale", undefined);
    expect(out).not.toContain("reap-ls-stale");
    // The past-starting crash survives with its resume hint.
    expect(out).toContain("reap-ls-crashed");
    expect(out).toContain("(no window)");
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
        upgradeCmd: "flow install --upgrade",
      }),
      checkDrift: NO_DRIFT,
    });
    expect(code).toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("2 commits behind");
  });

  it("should not print a notice when checkUpdate reports current", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });
    expect(code).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  it("should not print a notice when checkUpdate reports skipped", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runLs({
      checkUpdate: () => ({ status: "skipped", reason: "fetch-failed" }),
      checkDrift: NO_DRIFT,
    });
    expect(code).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  it("should print a drift notice to stderr when checkDrift reports drift", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: () => ({
        status: "drifted",
        entries: [
          { kind: "missing", displayName: "flow-foo", target: "/x/flow-foo" },
        ],
      }),
    });
    expect(code).toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("flow install --upgrade");
  });

  it("should not print a drift notice when checkDrift reports clean", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runLs({
      checkUpdate: () => ({ status: "current" }),
      checkDrift: NO_DRIFT,
    });
    expect(code).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });
});
