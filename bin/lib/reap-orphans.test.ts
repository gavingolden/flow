import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as livenessModule from "./liveness";
import { reapableStartingOrphans, reapStartingOrphans } from "./reap-orphans";
import { writeState, statePath, type PipelineState } from "./state";
import type { TmuxWindow } from "./tmux";

/**
 * A guaranteed-not-alive pid, for exercising the real (unmocked)
 * `livenessOf`'s dead/stale branch without spawning anything (the
 * isAlive probe short-circuits before `ps` is ever invoked). Mirrors
 * `lock.test.ts`'s `pickDeadPid` helper.
 */
function pickDeadPid(): number {
  for (const candidate of [999999, 998123, 987654]) {
    try {
      process.kill(candidate, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a dead PID for the test");
}

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

  it("reaps a dead/stale-process orphan even when a matching window is still present", () => {
    // The file signal now overrides window presence: a window can survive
    // its owning process dying, so `livenessOf` returning dead/stale must
    // still reap the state regardless of the window fixture.
    const deadPid = pickDeadPid();
    const slugs = reapableStartingOrphans(
      [
        state({
          slug: "crashed-with-window",
          pid: deadPid,
          procStartedAt: 1_700_000_000,
        }),
      ],
      [window("crashed-with-window")],
      NOW,
      GRACE_MS,
    );
    expect(slugs).toEqual(["crashed-with-window"]);
  });

  it("never reaps an alive-process state even with no matching window", () => {
    // A positive liveness read overrides an otherwise-missing-window signal —
    // an alive process is never reaped, regardless of window presence. The
    // "stale" test above gets a genuine verdict for free (isAlive
    // short-circuits before touching `ps`); "alive" needs a REAL `ps` spawn
    // via `pidStartEpoch`, which is unavailable under vitest's node runtime
    // (`Bun.spawnSync` is undefined there — the same reason no test in this
    // repo exercises `tmux.ts`'s real spawn path) — so this spies on
    // `livenessOf` directly instead of deriving a real verdict.
    const spy = vi.spyOn(livenessModule, "livenessOf").mockReturnValue("alive");
    const slugs = reapableStartingOrphans(
      [
        state({
          slug: "alive-no-window",
          pid: 4242,
          procStartedAt: 1_700_000_000,
        }),
      ],
      [],
      NOW,
      GRACE_MS,
    );
    expect(slugs).toEqual([]);
    spy.mockRestore();
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
