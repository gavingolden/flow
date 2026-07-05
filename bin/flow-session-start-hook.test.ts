import { describe, expect, it } from "vitest";
import { buildEnvelope, run, type Deps } from "./flow-session-start-hook";
import { flowPipelineResumeSeed } from "./lib/feature";
import { TERMINAL_PHASES, type PipelineState } from "./lib/state";

type Stub = {
  deps: Deps;
  outLines: string[];
  loadCalls: string[];
};

function makeDeps(opts: {
  stdin?: string;
  pane?: string;
  slug?: string;
  state?: PipelineState | null;
  markerExists?: boolean;
}): Stub {
  const outLines: string[] = [];
  const loadCalls: string[] = [];
  const deps: Deps = {
    readStdin: async () => opts.stdin ?? "",
    tmuxPane: opts.pane,
    showFlowSlug: () => opts.slug ?? "",
    loadState: (slug) => {
      loadCalls.push(slug);
      return opts.state ?? null;
    },
    markerExists: () => opts.markerExists ?? false,
    writeOut: (s) => {
      outLines.push(s);
    },
  };
  return { deps, outLines, loadCalls };
}

function fakeState(
  phase: string,
  worktree: string | undefined = "/tmp/wt",
): PipelineState {
  return {
    slug: "demo",
    phase,
    repo: "/tmp/repo",
    worktree,
    updatedAt: "2026-06-30T00:00:00Z",
  };
}

describe("buildEnvelope", () => {
  it("wraps the resume seed in the SessionStart additionalContext envelope", () => {
    const env = JSON.parse(buildEnvelope("csv-export")) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(env.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(env.hookSpecificOutput.additionalContext).toBe(
      flowPipelineResumeSeed("csv-export"),
    );
  });
});

describe("flow-session-start-hook — emits the resume seed", () => {
  it("emits the envelope for a non-terminal flow slug WITH a checkpoint.pending marker", async () => {
    const { deps, outLines } = makeDeps({
      stdin: JSON.stringify({ hook_event_name: "SessionStart" }),
      pane: "%1",
      slug: "demo",
      state: fakeState("checkpoint-pending-clear"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    const joined = outLines.join("");
    const env = JSON.parse(joined.trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(env.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(env.hookSpecificOutput.additionalContext).toContain(
      "--resume mode for: demo",
    );
  });
});

describe("flow-session-start-hook — silent no-op paths", () => {
  it("no-op (empty stdout, exit 0) when TMUX_PANE is undefined (unresolved slug)", async () => {
    const { deps, outLines, loadCalls } = makeDeps({
      pane: undefined,
      state: fakeState("implementing"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(outLines).toEqual([]);
    expect(loadCalls).toEqual([]);
  });

  it("no-op when @flow-slug is empty (non-flow window)", async () => {
    const { deps, outLines, loadCalls } = makeDeps({
      pane: "%1",
      slug: "",
      state: fakeState("implementing"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(outLines).toEqual([]);
    expect(loadCalls).toEqual([]);
  });

  it("no-op when state.json is missing for the slug", async () => {
    const { deps, outLines } = makeDeps({
      pane: "%1",
      slug: "ghost",
      state: null,
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(outLines).toEqual([]);
  });

  it("no-op at every terminal phase even with a marker present (EXCEPT gated)", async () => {
    // `gated` is deliberately excluded from the terminal no-op: a gated
    // pipeline carrying a checkpoint marker is a feedback-mode resume point,
    // so it emits (covered by the dedicated gated cases below). Every OTHER
    // terminal phase still no-ops even with a marker present.
    for (const phase of TERMINAL_PHASES.filter((p) => p !== "gated")) {
      const { deps, outLines } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState(phase),
        markerExists: true,
      });
      expect(await run(deps), phase).toBe(0);
      expect(outLines, phase).toEqual([]);
    }
  });

  it("emits the envelope at gated WITH a checkpoint marker (feedback-mode resume point)", async () => {
    const { deps, outLines } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("gated"),
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    const env = JSON.parse(outLines.join("").trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(env.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(env.hookSpecificOutput.additionalContext).toContain(
      "--resume mode for: demo",
    );
  });

  it("no-op at gated WITHOUT a checkpoint marker (a plain /clear at the gate still clears)", async () => {
    const { deps, outLines } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("gated"),
      markerExists: false,
    });
    expect(await run(deps)).toBe(0);
    expect(outLines).toEqual([]);
  });

  it("no-op for a non-terminal slug when the checkpoint.pending marker is absent", async () => {
    const { deps, outLines } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState("checkpoint-pending-clear"),
      markerExists: false,
    });
    expect(await run(deps)).toBe(0);
    expect(outLines).toEqual([]);
  });

  it("no-op for a non-terminal slug whose state carries no worktree", async () => {
    // Explicit `undefined` still triggers fakeState's `worktree = "/tmp/wt"`
    // default param, so override the field directly to get a genuinely
    // worktree-less state (no worktree ⇒ no marker path ⇒ hard no-op).
    const { deps, outLines } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: { ...fakeState("checkpoint-pending-clear"), worktree: undefined },
      markerExists: true,
    });
    expect(await run(deps)).toBe(0);
    expect(outLines).toEqual([]);
  });
});
