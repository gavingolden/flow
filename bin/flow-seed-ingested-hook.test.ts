import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STDIN_TIMEOUT_MS,
  defaultReadStdin,
  deliveryMarkerPresent,
  run,
  seedIntact,
  squashPrompt,
  type Deps,
} from "./flow-seed-ingested-hook";
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
  readStdin?: () => Promise<{ text: string; complete: boolean }>;
}): { deps: Deps; saveState: ReturnType<typeof vi.fn> } {
  const saveState = vi.fn();
  const deps: Deps = {
    flowSlugEnv: opts.flowSlugEnv,
    tmuxPane: opts.pane,
    showFlowSlug: () => opts.slug ?? "",
    loadState: () => opts.state ?? null,
    saveState,
    nowIso: () => FROZEN_NOW,
    // Default: benign empty payload. Every no-seed test hits the
    // not-applicable early-exit, so this is never actually invoked unless a
    // test explicitly overrides it to exercise the comparison path.
    readStdin: opts.readStdin ?? (async () => ({ text: "", complete: true })),
  };
  return { deps, saveState };
}

describe("flow-seed-ingested-hook", () => {
  it("records not-applicable given a flow-session env and no recorded seed", async () => {
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState(),
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "demo",
        seedIngest: {
          at: FROZEN_NOW,
          outcome: "not-applicable",
          reason: "no-seed-recorded",
        },
      }),
    );
  });

  it("records via FLOW_SLUG with no pane at all (plain launcher)", async () => {
    const { deps, saveState } = makeDeps({
      pane: undefined,
      flowSlugEnv: "demo",
      state: fakeState(),
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "demo",
        seedIngest: expect.objectContaining({ outcome: "not-applicable" }),
      }),
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
      readStdin: async () => ({ text: "", complete: true }),
    };
    await expect(run(deps)).resolves.toBe(0);
    expect(loadCalls).toEqual(["pane-slug", "pane-slug"]);
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

  it("short-circuits on the two TERMINAL outcomes without re-writing", async () => {
    for (const seedIngest of [
      { at: "2026-06-27T12:00:00.000Z", outcome: "verified" as const },
      {
        at: "2026-06-27T12:00:00.000Z",
        outcome: "not-applicable" as const,
        reason: "no-seed-recorded" as const,
      },
    ]) {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seedIngest }),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).not.toHaveBeenCalled();
    }
  });

  it("preserves the rest of the state when recording (spread, not replace)", async () => {
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
        seedIngest: expect.objectContaining({ outcome: "not-applicable" }),
      }),
    );
  });

  it("records not-applicable for a whitespace-only seed (no vacuous pass)", async () => {
    for (const seed of ["", "   \n\t "]) {
      const readStdin = vi.fn(async () => ({ text: "", complete: true }));
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed }),
        readStdin,
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(readStdin).not.toHaveBeenCalled();
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          seedIngest: {
            at: FROZEN_NOW,
            outcome: "not-applicable",
            reason: "no-seed-recorded",
          },
        }),
      );
    }
  });

  describe("seed integrity comparison (state.seed present)", () => {
    const SEED =
      "[pipeline-slug: demo]\nUse the /flow-pipeline skill for: csv export";
    const payload = (prompt: string) =>
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt });
    const complete = (text: string) => async () => ({ text, complete: true });

    it("records verified when the submitted prompt contains the seed intact", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: complete(payload(SEED)),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          seedIngest: { at: FROZEN_NOW, outcome: "verified" },
        }),
      );
    });

    it("a supervisor preamble/trailing note around the intact seed still counts (containment, not equality)", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: complete(
          payload(`note: resuming\n${SEED}\n(auto-submitted)`),
        ),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          seedIngest: { at: FROZEN_NOW, outcome: "verified" },
        }),
      );
    });

    it("records corrupt when the submitted prompt has the seed's MIDDLE removed — the observed truncation failure shape", async () => {
      const truncated = SEED.slice(0, 30) + SEED.slice(-10); // drop the middle
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: complete(payload(truncated)),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledTimes(1);
      const written = saveState.mock.calls[0]![0] as PipelineState;
      expect(written.seedIngest).toEqual({
        at: FROZEN_NOW,
        outcome: "corrupt",
        expectedBytes: Buffer.byteLength(SEED, "utf8"),
        submittedBytes: Buffer.byteLength(truncated, "utf8"),
      });
    });

    it("writes NOTHING for a foreign (user-typed) prompt carrying no delivery marker", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: complete(payload("what does this repo do?")),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).not.toHaveBeenCalled();
    });

    it("a standing corrupt record survives a later foreign prompt (byte counts still describe the corrupted delivery)", async () => {
      const standing = {
        at: "2026-06-27T12:00:00.000Z",
        outcome: "corrupt" as const,
        expectedBytes: 999,
        submittedBytes: 111,
      };
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED, seedIngest: standing }),
        readStdin: complete(payload("unrelated later chatter")),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).not.toHaveBeenCalled();
    });

    it("a standing corrupt record is never downgraded by an unverified outcome", async () => {
      const standing = {
        at: "2026-06-27T12:00:00.000Z",
        outcome: "corrupt" as const,
        expectedBytes: 999,
        submittedBytes: 111,
      };
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED, seedIngest: standing }),
        readStdin: async () => ({ text: "", complete: false }),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).not.toHaveBeenCalled();
    });

    it("a standing corrupt record IS cleared by a later intact submission (PR #686 clear-on-intact-retry)", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({
          seed: SEED,
          seedIngest: {
            at: "2026-06-27T12:00:00.000Z",
            outcome: "corrupt",
            expectedBytes: 999,
            submittedBytes: 111,
          },
        }),
        readStdin: complete(payload(SEED)),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          seedIngest: { at: FROZEN_NOW, outcome: "verified" },
        }),
      );
    });

    it("records unverified{stdin-error} when the stdin drain throws", async () => {
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
        expect.objectContaining({
          seedIngest: {
            at: FROZEN_NOW,
            outcome: "unverified",
            reason: "stdin-error",
          },
        }),
      );
    });

    it("records unverified{stdin-timeout} when the drain came back incomplete", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: async () => ({ text: payload(SEED), complete: false }),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          seedIngest: {
            at: FROZEN_NOW,
            outcome: "unverified",
            reason: "stdin-timeout",
          },
        }),
      );
    });

    it("records unverified{payload-unparsable} on malformed JSON", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: complete("{not json"),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          seedIngest: {
            at: FROZEN_NOW,
            outcome: "unverified",
            reason: "payload-unparsable",
          },
        }),
      );
    });

    it("records unverified{no-prompt-field} when the payload carries no prompt", async () => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED }),
        readStdin: complete(
          JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
        ),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          seedIngest: {
            at: FROZEN_NOW,
            outcome: "unverified",
            reason: "no-prompt-field",
          },
        }),
      );
    });

    it("re-reads state immediately before writing, so a concurrent supervisor write is not clobbered", async () => {
      const saveState = vi.fn();
      let call = 0;
      const deps: Deps = {
        tmuxPane: "%1",
        showFlowSlug: () => "demo",
        // Second read (the pre-write re-read) sees the supervisor's advance.
        loadState: () =>
          ++call === 1
            ? fakeState({ seed: SEED })
            : fakeState({ seed: SEED, phase: "planning", pr: 42 }),
        saveState,
        nowIso: () => FROZEN_NOW,
        readStdin: complete(payload(SEED)),
      };
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "planning", pr: 42 }),
      );
    });
  });
});

describe("squashPrompt / seedIntact / deliveryMarkerPresent", () => {
  const SEED =
    "[pipeline-slug: demo]\nUse the /flow-pipeline skill for: csv export";

  it("squashPrompt strips ALL whitespace (an 80-column pane wrap still matches)", () => {
    expect(squashPrompt(" a\n b\tc  ")).toBe("abc");
    expect(squashPrompt("")).toBe("");
  });

  it("seedIntact is containment, not equality", () => {
    expect(seedIntact(SEED, `preamble\n${SEED}\ntrailer`)).toBe(true);
    expect(seedIntact(SEED, SEED)).toBe(true);
  });

  it("seedIntact ignores whitespace differences introduced by pane wrapping", () => {
    expect(seedIntact(SEED, SEED.replace(/ /g, "\n  "))).toBe(true);
  });

  it("seedIntact is false when the seed's middle is missing", () => {
    expect(seedIntact(SEED, SEED.slice(0, 30) + SEED.slice(-10))).toBe(false);
  });

  it("seedIntact('', anything) is false — an empty expectation never passes vacuously", () => {
    expect(seedIntact("", "anything at all")).toBe(false);
    expect(seedIntact("   \n ", "anything at all")).toBe(false);
    expect(seedIntact("", "")).toBe(false);
  });

  it("deliveryMarkerPresent matches on the leading line alone", () => {
    expect(
      deliveryMarkerPresent(SEED, "[pipeline-slug: demo] and nothing else"),
    ).toBe(true);
    // The full seed obviously carries its own leading line.
    expect(deliveryMarkerPresent(SEED, SEED)).toBe(true);
  });

  it("deliveryMarkerPresent is false for a user-typed prompt", () => {
    expect(deliveryMarkerPresent(SEED, "what does this repo do?")).toBe(false);
  });

  it("deliveryMarkerPresent is false for a seed with no content", () => {
    expect(deliveryMarkerPresent("", "anything")).toBe(false);
  });
});

describe("defaultReadStdin", () => {
  const realStdin = process.stdin;
  afterEach(() => {
    Object.defineProperty(process, "stdin", {
      value: realStdin,
      configurable: true,
    });
    vi.useRealTimers();
  });

  function stubStdin(): PassThrough {
    const fake = new PassThrough();
    Object.defineProperty(process, "stdin", {
      value: fake,
      configurable: true,
    });
    return fake;
  }

  it("resolves {complete:false} on the STDIN_TIMEOUT_MS backstop when the stream never ends", async () => {
    vi.useFakeTimers();
    stubStdin();
    const p = defaultReadStdin();
    vi.advanceTimersByTime(STDIN_TIMEOUT_MS);
    await expect(p).resolves.toEqual({ text: "", complete: false });
  });

  it("resolves EARLY with {complete:true} once the accumulated buffer parses, without waiting for `end`", async () => {
    const fake = stubStdin();
    const text = JSON.stringify({ prompt: "hello" });
    const p = defaultReadStdin();
    fake.write(text);
    // Deliberately never `end()` — an early resolve is the whole point.
    await expect(p).resolves.toEqual({ text, complete: true });
  });

  it("keeps draining across a split payload and resolves at the chunk that completes the JSON", async () => {
    const fake = stubStdin();
    const text = JSON.stringify({ prompt: "hello world" });
    const p = defaultReadStdin();
    fake.write(text.slice(0, 10));
    fake.write(text.slice(10));
    await expect(p).resolves.toEqual({ text, complete: true });
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
