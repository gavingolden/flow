import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { run, seedIntact, type Deps } from "./flow-seed-ingested-hook";
import type { PipelineState } from "./lib/state";

function readFixture(name: string): string {
  return fs.readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

const FROZEN_NOW = "2026-06-28T00:00:00.000Z";

function fakeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    slug: "demo",
    phase: "starting",
    repo: "/tmp/repo",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(opts: {
  pane?: string;
  slug?: string;
  flowSlugEnv?: string;
  state?: PipelineState | null;
  readStdin?: () => Promise<string>;
}): { deps: Deps; saveState: ReturnType<typeof vi.fn> } {
  const saveState = vi.fn();
  const deps: Deps = {
    flowSlugEnv: opts.flowSlugEnv,
    tmuxPane: opts.pane,
    showFlowSlug: () => opts.slug ?? "",
    loadState: () => opts.state ?? null,
    saveState,
    nowIso: () => FROZEN_NOW,
    // Default: benign empty payload. Every existing test's state carries no
    // `seed`, so the no-seed early-exit means this is never actually invoked
    // unless a test explicitly overrides it to exercise the comparison path.
    readStdin: opts.readStdin ?? (async () => ""),
  };
  return { deps, saveState };
}

describe("flow-seed-ingested-hook", () => {
  it("stamps seedIngestedAt given a flow-session env", async () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState(),
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "demo", seedIngestedAt: FROZEN_NOW }),
    );
  });

  it("stamps via FLOW_SLUG with no pane at all (plain launcher)", async () => {
    const { deps, saveState } = makeDeps({
      pane: undefined,
      flowSlugEnv: "demo",
      state: fakeState(),
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "demo", seedIngestedAt: FROZEN_NOW }),
    );
  });

  it("ignores a shape-invalid FLOW_SLUG and falls back to the pane", async () => {
    const loadCalls: string[] = [];
    const saveState = vi.fn();
    const deps: Deps = {
      flowSlugEnv: "NOT A SLUG",
      tmuxPane: "%1",
      showFlowSlug: () => "pane-slug",
      loadState: (slug) => {
        loadCalls.push(slug);
        return fakeState({ slug: "pane-slug" });
      },
      saveState,
      nowIso: () => FROZEN_NOW,
      readStdin: async () => "",
    };
    await expect(run(deps)).resolves.toBe(0);
    expect(loadCalls).toEqual(["pane-slug"]);
  });

  it("no-ops when not in tmux (pane undefined)", async () => {
    const { deps, saveState } = makeDeps({
      pane: undefined,
      slug: "demo",
      state: fakeState(),
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).not.toHaveBeenCalled();
  });

  it("no-ops when @flow-slug is empty (not a flow window)", async () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "",
      state: fakeState(),
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).not.toHaveBeenCalled();
  });

  it("no-ops when state.json is missing for the slug", async () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "ghost",
      state: null,
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).not.toHaveBeenCalled();
  });

  it("is idempotent: does not re-stamp a state that already has the marker", async () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState({ seedIngestedAt: "2026-06-27T12:00:00.000Z" }),
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).not.toHaveBeenCalled();
  });

  it("preserves the rest of the state when stamping (spread, not replace)", async () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState({ phase: "starting", pr: 7, effort: "high" }),
    });
    await run(deps);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "demo",
        phase: "starting",
        pr: 7,
        effort: "high",
        seedIngestedAt: FROZEN_NOW,
      }),
    );
  });

  describe("seed integrity comparison (state.seed present)", () => {
    const SEED =
      "[pipeline-slug: demo]\nUse the /flow-pipeline skill for: csv export";

    it("stamps seedIngestedAt (never seedMismatch) when the submitted prompt contains the seed intact", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: async () =>
          JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: SEED }),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({ seedIngestedAt: FROZEN_NOW }),
      );
      const written = saveState.mock.calls[0]![0] as PipelineState;
      expect(written.seedMismatch).toBeUndefined();
    });

    it("a supervisor preamble/trailing note around the intact seed still counts (containment, not equality)", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: async () =>
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            prompt: `note: resuming\n${SEED}\n(auto-submitted)`,
          }),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({ seedIngestedAt: FROZEN_NOW }),
      );
    });

    it("writes seedMismatch (and does NOT stamp seedIngestedAt) when the submitted prompt has the seed's MIDDLE removed — the observed truncation failure shape", async () => {
      // This is RED on main: the pre-Task-3 hook ignores stdin entirely and
      // always stamps seedIngestedAt regardless of what actually landed.
      const truncated = SEED.slice(0, 10) + SEED.slice(-10); // drop the middle
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: async () =>
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            prompt: truncated,
          }),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledTimes(1);
      const written = saveState.mock.calls[0]![0] as PipelineState;
      expect(written.seedIngestedAt).toBeUndefined();
      expect(written.seedMismatch).toEqual({
        at: FROZEN_NOW,
        expectedBytes: Buffer.byteLength(SEED, "utf8"),
        submittedBytes: Buffer.byteLength(truncated, "utf8"),
      });
    });

    it("behaves exactly as today (stamps, no comparison) when state.seed is absent, never invoking readStdin", async () => {
      const readStdin = vi.fn(async () => {
        throw new Error("must not be called when state.seed is absent");
      });
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState(),
        readStdin,
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(readStdin).not.toHaveBeenCalled();
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({ seedIngestedAt: FROZEN_NOW }),
      );
    });

    it("behaves exactly as today (stamps, exits 0) when stdin is unreadable", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: async () => {
          throw new Error("pipe closed");
        },
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({ seedIngestedAt: FROZEN_NOW }),
      );
    });

    it("behaves exactly as today (stamps, exits 0) when stdin is malformed JSON", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: async () => "{not json",
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({ seedIngestedAt: FROZEN_NOW }),
      );
    });

    it("behaves exactly as today (stamps, exits 0) when the payload has no `prompt` field", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: async () =>
          JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({ seedIngestedAt: FROZEN_NOW }),
      );
    });

    it("seedIntact reports the real 2026-08-28 corruption as NOT intact", () => {
      // The recorded/submitted pair is a 3-byte transposition ("agent to" ->
      // "ageno" plus a trailing "t t"), not whitespace — a squash-based
      // comparison must still catch it.
      const recorded = readFixture("seed-incident-2026-08-28.recorded.txt");
      const submitted = readFixture("seed-incident-2026-08-28.submitted.txt");
      expect(seedIntact(recorded, submitted)).toBe(false);
    });
  });

  describe("launch-window seedMismatch gate", () => {
    const SEED =
      "[pipeline-slug: demo]\nUse the /flow-pipeline skill for: csv export";
    const truncated = SEED.slice(0, 10) + SEED.slice(-10);

    it("does not record a new seedMismatch when state.seedMismatch is already set", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({
          seed: SEED,
          seedMismatch: {
            at: "2026-06-27T23:00:00.000Z",
            expectedBytes: 1,
            submittedBytes: 2,
          },
        }),
        readStdin: async () =>
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            prompt: truncated,
          }),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).not.toHaveBeenCalled();
    });

    it("still records a mismatch when phase has advanced past starting but seedMismatch is unset (resume-path regression guard)", async () => {
      // The plan's originally-proposed gate (`phase !== "starting"`) would
      // have silently switched off integrity checking here — resume states
      // are already past `starting` by the time this hook fires again.
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED, phase: "triaging" }),
        readStdin: async () =>
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            prompt: truncated,
          }),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledTimes(1);
      const written = saveState.mock.calls[0]![0] as PipelineState;
      expect(written.seedMismatch).toEqual({
        at: FROZEN_NOW,
        expectedBytes: Buffer.byteLength(SEED, "utf8"),
        submittedBytes: Buffer.byteLength(truncated, "utf8"),
      });
    });
  });
});

describe("flow-seed-ingested-hook never writes global settings", () => {
  // Structural guard: the hook must touch ONLY ~/.flow/state, never the user's
  // global ~/.claude/settings.json. It has no code path to settings; this pins
  // that it never grows one (mirrors tmux.test.ts's retired-symbols guard).
  const hookSource = fs.readFileSync(
    fileURLToPath(new URL("./flow-seed-ingested-hook.ts", import.meta.url)),
    "utf8",
  );

  it.each([".claude/settings.json", "settings-merge", "CLAUDE_SETTINGS_PATH"])(
    "does not reference the global-settings surface '%s'",
    (symbol) => {
      expect(hookSource).not.toContain(symbol);
    },
  );
});
