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
import {
  DELIVERY_MARKER_SQUASHED_CHARS,
  deliveryMarker,
  splitSeed,
  squash,
} from "./lib/seed-delivery";
import {
  assertSeedListExhaustive,
  PRODUCTION_SEEDS,
} from "./lib/seed-fixtures";
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
    // The real flowPipelineSeed production shape (bin/lib/seed-fixtures.ts) —
    // a SINGLE control-char-free line — not a hand-written two-line literal
    // no launcher actually produces.
    const SEED = PRODUCTION_SEEDS.find(
      (f) => f.name === "flowPipelineSeed",
    )!.seed;
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

    it("a standing corrupt record is NOT re-recorded by a later marker-bearing corrupt prompt (launch-window scoped, PR #719)", async () => {
      // #719's launch-window gate (a null-check on the removed mismatch
      // field), in seedIngest terms: the
      // comparison still runs on every prompt, but `record`'s
      // neverOverCorrupt flag keeps the ORIGINAL corruption's byte counts —
      // the ones the failure message points at — instead of overwriting them
      // with a later, unrelated submission's.
      const truncated = SEED.slice(0, 30) + SEED.slice(-10);
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
        readStdin: complete(payload(truncated)),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).not.toHaveBeenCalled();
    });

    it("still records corrupt once phase has advanced past starting (resume-path regression guard, PR #719)", async () => {
      // #719's plan originally proposed gating on `phase !== "starting"`,
      // which would have silently switched integrity checking off on both
      // resume paths — a resume state is already past `starting` by the time
      // this hook fires again.
      const truncated = SEED.slice(0, 30) + SEED.slice(-10);
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed: SEED, phase: "triaging" }),
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

describe("production seed shapes", () => {
  const payload = (prompt: string) =>
    JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt });
  const complete = (text: string) => async () => ({ text, complete: true });

  it("PRODUCTION_SEEDS is exhaustive over every *Seed builder in the three seed-owning modules (fails CI if a future builder ships without a fixture)", () => {
    expect(() => assertSeedListExhaustive()).not.toThrow();
  });

  it("assertSeedListExhaustive throws for a *Seed export with no fixture", () => {
    expect(() =>
      assertSeedListExhaustive({ "fake.ts": { futureThingSeed: () => "" } }),
    ).toThrow(/futureThingSeed/);
  });

  it("assertSeedListExhaustive ignores deliver*Seed delivery functions", () => {
    expect(() =>
      assertSeedListExhaustive({ "fake.ts": { deliverThingSeed: () => "" } }),
    ).not.toThrow();
  });

  it.each(PRODUCTION_SEEDS)(
    "$name contains no newline iff singleLine",
    ({ seed, singleLine }) => {
      if (singleLine) {
        expect(seed).not.toContain("\n");
      } else {
        expect(seed).toContain("\n");
      }
    },
  );

  it.each(PRODUCTION_SEEDS)(
    "$name squashes to at least twice the delivery-marker length",
    ({ seed }) => {
      expect(squashPrompt(seed).length).toBeGreaterThanOrEqual(
        2 * DELIVERY_MARKER_SQUASHED_CHARS,
      );
    },
  );

  it.each(PRODUCTION_SEEDS)(
    // deliveryMarker derives from the LEADING LINE, not the whole seed
    // (squashPrompt above) — for terminalContinueSeed those differ by ~800
    // chars, so a future builder with a genuinely short leading line could
    // pass the whole-seed guard above on the strength of its remainder while
    // collapsing the marker. Assert the leading-line squash directly too.
    "$name's leading line squashes to a non-degenerate marker",
    ({ seed }) => {
      expect(squash(splitSeed(seed).leadingLine).length).toBeGreaterThanOrEqual(
        16,
      );
    },
  );

  it.each(PRODUCTION_SEEDS)(
    "$name: a head+tail truncation records corrupt with both byte counts",
    async ({ seed }) => {
      // Deliberately NOT a 'middle third removed' recipe: that drops the
      // delivery marker entirely for flowPipelineResumeSeed and epicRunSeed
      // (their leading lines run past a third of the seed), which would
      // record FOREIGN instead of corrupt. Keeping 2x the squashed marker
      // length of RAW head chars always keeps the marker intact (squashing
      // only removes whitespace, so it can only shrink) while still
      // dropping the rest of the seed.
      const HEAD = 2 * DELIVERY_MARKER_SQUASHED_CHARS;
      const truncated = seed.slice(0, HEAD) + seed.slice(-10);
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed }),
        readStdin: complete(payload(truncated)),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledTimes(1);
      const written = saveState.mock.calls[0]![0] as PipelineState;
      expect(written.seedIngest).toEqual({
        at: FROZEN_NOW,
        outcome: "corrupt",
        expectedBytes: Buffer.byteLength(seed, "utf8"),
        submittedBytes: Buffer.byteLength(truncated, "utf8"),
      });
    },
  );

  it.each(PRODUCTION_SEEDS)(
    "$name: an intact submission records verified",
    async ({ seed }) => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed }),
        readStdin: complete(payload(seed)),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          seedIngest: { at: FROZEN_NOW, outcome: "verified" },
        }),
      );
    },
  );

  it.each(
    PRODUCTION_SEEDS.flatMap(({ name, seed }) =>
      ["what does the seed hook do?", "Use the /flow-pipeline skill"].map(
        (prompt) => ({ name, seed, prompt }),
      ),
    ),
  )(
    "$name: a genuinely foreign user-typed prompt ($prompt) writes nothing",
    async ({ seed, prompt }) => {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed }),
        readStdin: complete(payload(prompt)),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).not.toHaveBeenCalled();
    },
  );

  it("records corrupt with both byte counts for the recorded 2026-08-28 incident pair", async () => {
    const recorded = readFixture("seed-incident-2026-08-28.recorded.txt");
    const submitted = readFixture("seed-incident-2026-08-28.submitted.txt");
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState({ seed: recorded }),
      readStdin: complete(payload(submitted)),
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).toHaveBeenCalledTimes(1);
    const written = saveState.mock.calls[0]![0] as PipelineState;
    expect(written.seedIngest).toEqual({
      at: FROZEN_NOW,
      outcome: "corrupt",
      expectedBytes: Buffer.byteLength(recorded, "utf8"),
      submittedBytes: Buffer.byteLength(submitted, "utf8"),
    });
  });

  // KNOWN, BOUNDED RESIDUAL — regression-pinned, not desired behaviour. A
  // user-typed flow skill-invocation phrase can share its first
  // DELIVERY_MARKER_SQUASHED_CHARS squashed characters with an epic seed's
  // marker (epicCreateSeed and epicResumeSeed both open "Use the
  // /flow-epic-create skill", and epicRunSeed opens "Use the
  // /flow-epic-run skill"), so the hook reads it as a truncated delivery
  // ('corrupt') rather than FOREIGN. This is reachable only in a window
  // whose seed already failed to arrive: the hook short-circuits before the
  // stdin drain the moment a 'verified' outcome already stands (see the
  // terminal-outcomes short-circuit in `run`), and a healthy launch latches
  // 'verified' on the delivered first prompt — so a later, unrelated
  // skill-invocation phrase can only ever reach this comparison in an
  // already-corrupted window.
  it("KNOWN RESIDUAL: a user-typed epic skill-invocation phrase shares a 24-char marker with the epic seeds", async () => {
    const epicCreate = PRODUCTION_SEEDS.find(
      (f) => f.name === "epicCreateSeed",
    )!.seed;
    const epicResume = PRODUCTION_SEEDS.find(
      (f) => f.name === "epicResumeSeed",
    )!.seed;
    const epicRun = PRODUCTION_SEEDS.find(
      (f) => f.name === "epicRunSeed",
    )!.seed;

    for (const seed of [epicCreate, epicResume]) {
      const { deps, saveState } = makeDeps({
        pane: "%1",
        slug: "demo",
        state: fakeState({ seed }),
        readStdin: complete(payload("Use the /flow-epic-create skill")),
      });
      await expect(run(deps)).resolves.toBe(0);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          seedIngest: expect.objectContaining({ outcome: "corrupt" }),
        }),
      );
    }

    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState({ seed: epicRun }),
      readStdin: complete(payload("Use the /flow-epic-run skill")),
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        seedIngest: expect.objectContaining({ outcome: "corrupt" }),
      }),
    );
  });

  // KNOWN, BOUNDED RESIDUAL #1 — regression-pinned, not desired behaviour.
  // Corruption landing entirely INSIDE the first DELIVERY_MARKER_SQUASHED_CHARS
  // squashed characters strips the marker itself, so the hook cannot tell
  // truncation from an unrelated, FOREIGN prompt and writes nothing at all —
  // no 'corrupt' record, no recovery evidence. Bounded: that head region is
  // exactly what `deliverSeed` types alone and capture-verifies (with three
  // `C-u` retries) before the pane is ever handed to the operator, so a head
  // corruption fails the launch there instead of reaching this hook.
  it("KNOWN RESIDUAL: corruption inside the delivery marker reads FOREIGN and writes nothing", async () => {
    const seed = PRODUCTION_SEEDS.find(
      (f) => f.name === "flowPipelineSeed",
    )!.seed;
    const headCorrupted = `X${seed.slice(1)}`;
    const { deps, saveState } = makeDeps({
      pane: "%1",
      slug: "demo",
      state: fakeState({ seed }),
      readStdin: complete(payload(headCorrupted)),
    });
    await expect(run(deps)).resolves.toBe(0);
    expect(saveState).not.toHaveBeenCalled();
  });
});

describe("squashPrompt / seedIntact / deliveryMarkerPresent", () => {
  // The real flowPipelineSeed production shape (bin/lib/seed-fixtures.ts) —
  // a SINGLE control-char-free line — not a hand-written two-line literal no
  // launcher actually produces.
  const SEED = PRODUCTION_SEEDS.find(
    (f) => f.name === "flowPipelineSeed",
  )!.seed;

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

  it("seedIntact reports the real 2026-08-28 corruption as NOT intact", () => {
    // The recorded/submitted pair is a 3-byte transposition ("agent to" ->
    // "ageno" plus a trailing "t t"), not whitespace — a squash-based
    // comparison must still catch it.
    const recorded = readFixture("seed-incident-2026-08-28.recorded.txt");
    const submitted = readFixture("seed-incident-2026-08-28.submitted.txt");
    expect(seedIntact(recorded, submitted)).toBe(false);
  });

  it("seedIntact('', anything) is false — an empty expectation never passes vacuously", () => {
    expect(seedIntact("", "anything at all")).toBe(false);
    expect(seedIntact("   \n ", "anything at all")).toBe(false);
    expect(seedIntact("", "")).toBe(false);
  });

  it("deliveryMarkerPresent matches on the head-anchored delivery marker alone", () => {
    // Under the head marker (the first DELIVERY_MARKER_SQUASHED_CHARS
    // squashed characters of the leading line), a prompt carrying only the
    // marker — not the whole leading line — still counts.
    const marker = deliveryMarker(SEED);
    expect(marker.length).toBe(DELIVERY_MARKER_SQUASHED_CHARS);
    expect(deliveryMarkerPresent(SEED, `${marker} and nothing else`)).toBe(
      true,
    );
    // The full seed obviously carries its own marker.
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
