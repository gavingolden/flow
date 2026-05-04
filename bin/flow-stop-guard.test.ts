import { describe, expect, it } from "vitest";
import {
  buildReminder,
  nextStepLabel,
  run,
  type Deps,
} from "./flow-stop-guard";
import {
  PENDING_PHASES,
  STEP_PHASES,
  TERMINAL_PHASES,
  type PipelineState,
} from "./lib/state";

type Stub = {
  deps: Deps;
  errLines: string[];
  loadCalls: string[];
};

function makeDeps(opts: {
  stdin?: string;
  pane?: string;
  slug?: string;
  state?: PipelineState | null;
}): Stub {
  const errLines: string[] = [];
  const loadCalls: string[] = [];
  const deps: Deps = {
    readStdin: async () => opts.stdin ?? "",
    tmuxPane: opts.pane,
    showFlowSlug: () => opts.slug ?? "",
    loadState: (slug) => {
      loadCalls.push(slug);
      return opts.state ?? null;
    },
    writeErr: (s) => {
      errLines.push(s);
    },
  };
  return { deps, errLines, loadCalls };
}

function fakeState(phase: string): PipelineState {
  return {
    slug: "demo",
    phase,
    repo: "/tmp/repo",
    updatedAt: "2026-05-03T00:00:00Z",
  };
}

describe("flow-stop-guard short-circuits", () => {
  it("exits 0 when stop_hook_active is true (loop-break)", async () => {
    const { deps, loadCalls } = makeDeps({
      stdin: JSON.stringify({ stop_hook_active: true }),
      pane: "%1",
      slug: "demo",
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(0);
    expect(loadCalls).toEqual([]);
  });

  it("exits 0 when TMUX_PANE is undefined (not in tmux)", async () => {
    const { deps, loadCalls } = makeDeps({
      stdin: JSON.stringify({}),
      pane: undefined,
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(0);
    expect(loadCalls).toEqual([]);
  });

  it("exits 0 when @flow-slug is empty (not a flow window)", async () => {
    const { deps, loadCalls } = makeDeps({
      stdin: JSON.stringify({}),
      pane: "%1",
      slug: "",
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(0);
    expect(loadCalls).toEqual([]);
  });

  it("exits 0 when state.json is missing for the slug", async () => {
    const { deps, errLines } = makeDeps({
      stdin: JSON.stringify({}),
      pane: "%1",
      slug: "ghost",
      state: null,
    });
    expect(await run(deps)).toBe(0);
    expect(errLines).toEqual([]);
  });

  it("exits 0 when stdin is empty (no hook payload)", async () => {
    const { deps } = makeDeps({
      stdin: "",
      pane: "%1",
      slug: "demo",
      state: fakeState("merged"),
    });
    expect(await run(deps)).toBe(0);
  });

  it("exits 0 when stdin is malformed JSON (treats as no input)", async () => {
    const { deps } = makeDeps({
      stdin: "{not json",
      pane: "%1",
      slug: "demo",
      state: fakeState("merged"),
    });
    expect(await run(deps)).toBe(0);
  });

  it("malformed JSON does not bypass the phase check (still blocks mid-pipeline)", async () => {
    // Regression guard: the malformed-JSON branch falls through to the rest
    // of the checks rather than short-circuiting like `stop_hook_active`.
    // If a future refactor accidentally collapses the two, mid-pipeline
    // turn-ends would silently exit 0 whenever the harness sent garbage.
    const { deps, errLines } = makeDeps({
      stdin: "{not json",
      pane: "%1",
      slug: "demo",
      state: fakeState("implementing"),
    });
    expect(await run(deps)).toBe(2);
    expect(errLines.join("")).toContain("DO NOT END THE TURN");
  });
});

describe("flow-stop-guard allows legitimate end phases", () => {
  it.each([...TERMINAL_PHASES])("exits 0 at terminal phase %s", async (phase) => {
    const { deps, errLines } = makeDeps({
      stdin: "{}",
      pane: "%1",
      slug: "demo",
      state: fakeState(phase),
    });
    expect(await run(deps)).toBe(0);
    expect(errLines).toEqual([]);
  });

  it.each([...PENDING_PHASES])("exits 0 at pending phase %s", async (phase) => {
    const { deps, errLines } = makeDeps({
      stdin: "{}",
      pane: "%1",
      slug: "demo",
      state: fakeState(phase),
    });
    expect(await run(deps)).toBe(0);
    expect(errLines).toEqual([]);
  });
});

describe("flow-stop-guard blocks mid-pipeline", () => {
  const blockable = STEP_PHASES.filter((p) => p !== "starting"); // tested separately

  it.each([...blockable])("exits 2 at step phase %s", async (phase) => {
    const { deps, errLines } = makeDeps({
      stdin: "{}",
      pane: "%1",
      slug: "demo",
      state: fakeState(phase),
    });
    expect(await run(deps)).toBe(2);
    const joined = errLines.join("");
    expect(joined).toContain(`phase=${phase}`);
    expect(joined).toContain("DO NOT END THE TURN");
  });

  it("blocks at phase=starting and points back to step 1", async () => {
    const { deps, errLines } = makeDeps({
      stdin: "{}",
      pane: "%1",
      slug: "demo",
      state: fakeState("starting"),
    });
    expect(await run(deps)).toBe(2);
    expect(errLines.join("")).toContain("step 1 (triage)");
  });

  it("reminder names the documented next step for each phase", async () => {
    const expected: Array<[string, string]> = [
      ["triaging", "step 2 (worktree-create)"],
      ["worktree-create", "step 3 (plan)"],
      ["planning", "step 4 (approval)"],
      ["implementing", "step 5.5 (installing-skills)"],
      ["installing-skills", "step 6 (verify)"],
      ["verifying", "step 7 (ci-wait)"],
      ["ci-wait", "step 8 (review)"],
      ["reviewing", "step 9 (gate)"],
      ["gating", "step 10 (merge)"],
      ["merging", "step 10 (finalize merge to MERGED)"],
    ];
    for (const [phase, label] of expected) {
      const { deps, errLines } = makeDeps({
        stdin: "{}",
        pane: "%1",
        slug: "demo",
        state: fakeState(phase),
      });
      expect(await run(deps)).toBe(2);
      expect(errLines.join(""), `phase=${phase}`).toContain(label);
    }
  });
});

describe("nextStepLabel + buildReminder", () => {
  it("nextStepLabel falls back to a generic message for unknown phase", () => {
    expect(nextStepLabel("not-a-real-phase")).toContain("next step");
  });

  it("buildReminder includes the literal DO NOT END THE TURN", () => {
    const lines = buildReminder("implementing", "step 5.5 (installing-skills)");
    expect(lines.join("\n")).toContain("DO NOT END THE TURN");
  });

  it("buildReminder lists every pending phase so the model sees the full opt-out set", () => {
    const lines = buildReminder("triaging", "step 2 (worktree-create)");
    const joined = lines.join("\n");
    for (const p of PENDING_PHASES) expect(joined).toContain(p);
  });
});
