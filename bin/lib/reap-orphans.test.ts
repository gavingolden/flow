import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reapableStartingOrphans, reapStartingOrphans } from "./reap-orphans";
import { writeState, statePath, type PipelineState } from "./state";
import type { TmuxWindow } from "./tmux";

const NOW = Date.UTC(2026, 5, 28, 12, 0, 0);
const GRACE_MS = 60_000;

function state(overrides: Partial<PipelineState>): PipelineState {
  return {
    slug: "orphan",
    phase: "starting",
    repo: "/repo",
    updatedAt: new Date(NOW - 2 * GRACE_MS).toISOString(),
    ...overrides,
  };
}

function window(slug: string): TmuxWindow {
  return { id: `@${slug}`, name: slug, slug, activity: 0 };
}

describe(reapableStartingOrphans, () => {
  it("reaps a stale phase=starting state with no live window", () => {
    const slugs = reapableStartingOrphans(
      [state({ slug: "stale-start" })],
      [],
      NOW,
      GRACE_MS,
    );
    expect(slugs).toEqual(["stale-start"]);
  });

  it("does NOT reap a past-starting (e.g. verifying) no-window state", () => {
    // A legitimately resumable crash keeps its (no window) resume hint.
    const slugs = reapableStartingOrphans(
      [
        state({
          slug: "crashed-verify",
          phase: "verifying",
          updatedAt: new Date(NOW - 10 * GRACE_MS).toISOString(),
        }),
      ],
      [],
      NOW,
      GRACE_MS,
    );
    expect(slugs).toEqual([]);
  });

  it("never reaps a state whose tmux window is alive, regardless of phase", () => {
    const slugs = reapableStartingOrphans(
      [
        state({ slug: "cold-start" }), // phase=starting, but window present
      ],
      [window("cold-start")],
      NOW,
      GRACE_MS,
    );
    expect(slugs).toEqual([]);
  });

  it("does NOT reap a within-grace phase=starting no-window state", () => {
    const slugs = reapableStartingOrphans(
      [
        state({
          slug: "just-launched",
          updatedAt: new Date(NOW - GRACE_MS / 2).toISOString(),
        }),
      ],
      [],
      NOW,
      GRACE_MS,
    );
    expect(slugs).toEqual([]);
  });

  it("never reaps when updatedAt is unparseable (treated as fresh)", () => {
    const slugs = reapableStartingOrphans(
      [state({ slug: "bad-date", updatedAt: "not-a-date" })],
      [],
      NOW,
      GRACE_MS,
    );
    expect(slugs).toEqual([]);
  });

  it("reaps only the qualifying slugs from a mixed set", () => {
    const slugs = reapableStartingOrphans(
      [
        state({ slug: "reap-me" }),
        state({ slug: "alive", phase: "starting" }),
        state({ slug: "past", phase: "planning" }),
        state({
          slug: "fresh",
          updatedAt: new Date(NOW - GRACE_MS / 3).toISOString(),
        }),
      ],
      [window("alive")],
      NOW,
      GRACE_MS,
    );
    expect(slugs).toEqual(["reap-me"]);
  });
});

describe(reapStartingOrphans, () => {
  let stateDir!: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-reap-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("deletes the reaped orphan's state file and leaves others intact", () => {
    const stale = state({
      slug: "stale-start",
      updatedAt: new Date(NOW - 2 * GRACE_MS).toISOString(),
    });
    const keep = state({
      slug: "keep",
      phase: "verifying",
      updatedAt: new Date(NOW - 2 * GRACE_MS).toISOString(),
    });
    writeState(stale, stateDir);
    writeState(keep, stateDir);

    const reaped = reapStartingOrphans(
      [stale, keep],
      [],
      NOW,
      GRACE_MS,
      stateDir,
    );

    expect(reaped).toEqual(["stale-start"]);
    expect(fs.existsSync(statePath("stale-start", stateDir))).toBe(false);
    expect(fs.existsSync(statePath("keep", stateDir))).toBe(true);
  });
});
