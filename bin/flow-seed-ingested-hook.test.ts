import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { run, type Deps } from "./flow-seed-ingested-hook";
import type { PipelineState } from "./lib/state";

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
}): { deps: Deps; saveState: ReturnType<typeof vi.fn> } {
  const saveState = vi.fn();
  const deps: Deps = {
    flowSlugEnv: opts.flowSlugEnv,
    tmuxPane: opts.pane,
    showFlowSlug: () => opts.slug ?? "",
    loadState: () => opts.state ?? null,
    saveState,
    nowIso: () => FROZEN_NOW,
  };
  return { deps, saveState };
}

describe("flow-seed-ingested-hook", () => {
  it("stamps seedIngestedAt given a flow-session env", () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState(),
    });
    expect(run(deps)).toBe(0);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "demo", seedIngestedAt: FROZEN_NOW }),
    );
  });

  it("stamps via FLOW_SLUG with no pane at all (plain launcher)", () => {
    const { deps, saveState } = makeDeps({
      pane: undefined,
      flowSlugEnv: "demo",
      state: fakeState(),
    });
    expect(run(deps)).toBe(0);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "demo", seedIngestedAt: FROZEN_NOW }),
    );
  });

  it("ignores a shape-invalid FLOW_SLUG and falls back to the pane", () => {
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
    };
    expect(run(deps)).toBe(0);
    expect(loadCalls).toEqual(["pane-slug"]);
  });

  it("no-ops when not in tmux (pane undefined)", () => {
    const { deps, saveState } = makeDeps({
      pane: undefined,
      slug: "demo",
      state: fakeState(),
    });
    expect(run(deps)).toBe(0);
    expect(saveState).not.toHaveBeenCalled();
  });

  it("no-ops when @flow-slug is empty (not a flow window)", () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "",
      state: fakeState(),
    });
    expect(run(deps)).toBe(0);
    expect(saveState).not.toHaveBeenCalled();
  });

  it("no-ops when state.json is missing for the slug", () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "ghost",
      state: null,
    });
    expect(run(deps)).toBe(0);
    expect(saveState).not.toHaveBeenCalled();
  });

  it("is idempotent: does not re-stamp a state that already has the marker", () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState({ seedIngestedAt: "2026-06-27T12:00:00.000Z" }),
    });
    expect(run(deps)).toBe(0);
    expect(saveState).not.toHaveBeenCalled();
  });

  it("preserves the rest of the state when stamping (spread, not replace)", () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState({ phase: "starting", pr: 7, effort: "high" }),
    });
    run(deps);
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
