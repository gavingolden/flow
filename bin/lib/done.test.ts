import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs's readSync so the prompt path is fully controllable from
// tests. The real fs.readSync property isn't reconfigurable, so vi.spyOn
// fails — vi.mock at module scope is the only way in. Pass-through every
// other fs export so unrelated callers (none in this module's dep tree
// today, but defensive) keep working.
const readSyncMock = vi.hoisted(() =>
  vi.fn<(fd: number, buf: Buffer, ...rest: unknown[]) => number>(() => 0),
);
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readSync: readSyncMock };
});

// Mock tmux primitives so the help short-circuit test cannot accidentally
// run a kill or list against the user's real tmux session if the check
// regresses. The mocks are read-only spies; calls would surface as test
// failures via the `not.toHaveBeenCalled` assertions below.
const tmuxMock = vi.hoisted(() => ({
  killWindow: vi.fn(),
  listWindows: vi.fn(
    () => [] as { id: string; name: string; slug: string; activity: number }[],
  ),
  windowExists: vi.fn(() => false),
  findWindowBySlug: vi.fn(
    (windows: { id: string; slug: string; name: string }[], slug: string) =>
      windows.find((w) => w.slug === slug || w.name === slug),
  ),
  FLOW_SESSION: "flow",
}));
vi.mock("./tmux", () => tmuxMock);

const stateMock = vi.hoisted(() => ({
  deleteState: vi.fn(),
  listStates: vi.fn(
    () =>
      [] as {
        slug: string;
        phase: string;
        pr?: number;
        repo: string;
        updatedAt: string;
      }[],
  ),
  readState: vi.fn(
    (_slug: string) =>
      null as {
        slug: string;
        phase: string;
        pr?: number;
        repo: string;
        updatedAt: string;
      } | null,
  ),
}));
vi.mock("./state", () => stateMock);

const turnTrackingMock = vi.hoisted(() => ({
  deleteTurnTracking: vi.fn(),
}));
vi.mock("./stop-turn-tracking", () => turnTrackingMock);

import { runDone, runDoneCli } from "./done";

const state = (overrides: { slug: string; phase: string; pr?: number }) => ({
  slug: overrides.slug,
  phase: overrides.phase,
  pr: overrides.pr,
  repo: "/r",
  updatedAt: "2026-05-03T00:00:00Z",
});

const window = (slug: string) => ({
  id: `@${slug}`,
  name: slug,
  slug,
  activity: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  tmuxMock.listWindows.mockReturnValue([]);
  tmuxMock.windowExists.mockReturnValue(false);
  tmuxMock.findWindowBySlug.mockImplementation((windows, slug) =>
    windows.find(
      (w: { slug: string; name: string }) => w.slug === slug || w.name === slug,
    ),
  );
  stateMock.listStates.mockReturnValue([]);
  stateMock.readState.mockReturnValue(null);
});

describe("runDoneCli (--help / -h short-circuit)", () => {
  for (const flag of ["--help", "-h"]) {
    it(`exits 0 when args is ['${flag}']`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const code = runDoneCli([flag]);
      expect(code).toBe(0);
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls[0][0]).toMatch(/^flow done — close a pipeline/);
      expect(err).not.toHaveBeenCalled();
      log.mockRestore();
      err.mockRestore();
    });

    it(`does not touch tmux or state when args is ['${flag}']`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      runDoneCli([flag]);
      expect(tmuxMock.killWindow).not.toHaveBeenCalled();
      expect(tmuxMock.windowExists).not.toHaveBeenCalled();
      expect(tmuxMock.listWindows).not.toHaveBeenCalled();
      expect(stateMock.deleteState).not.toHaveBeenCalled();
      expect(stateMock.listStates).not.toHaveBeenCalled();
      expect(stateMock.readState).not.toHaveBeenCalled();
      log.mockRestore();
    });
  }

  it("short-circuits even when --help follows --merged", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = runDoneCli(["--merged", "--help"]);
    expect(code).toBe(0);
    expect(stateMock.listStates).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("short-circuits even when --help follows --orphans", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = runDoneCli(["--orphans", "--help"]);
    expect(code).toBe(0);
    expect(stateMock.listStates).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("runDone --merged (renamed from --all-merged)", () => {
  it("sweeps merged + cancelled states", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([
      state({ slug: "a", phase: "merged" }),
      state({ slug: "b", phase: "cancelled" }),
      state({ slug: "c", phase: "ci-wait" }),
    ]);
    tmuxMock.listWindows.mockReturnValue([window("a")]);

    const code = runDone(undefined, { merged: true, yes: true });

    expect(code).toBe(0);
    expect(stateMock.deleteState).toHaveBeenCalledWith("a");
    expect(stateMock.deleteState).toHaveBeenCalledWith("b");
    expect(stateMock.deleteState).not.toHaveBeenCalledWith("c");
    expect(turnTrackingMock.deleteTurnTracking).toHaveBeenCalledWith("a");
    expect(turnTrackingMock.deleteTurnTracking).toHaveBeenCalledWith("b");
    expect(turnTrackingMock.deleteTurnTracking).not.toHaveBeenCalledWith("c");
    expect(tmuxMock.killWindow).toHaveBeenCalledWith("a");
    expect(tmuxMock.killWindow).not.toHaveBeenCalledWith("b");
    log.mockRestore();
  });

  it("prints empty-sweep message when no terminal-phase pipelines exist", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([
      state({ slug: "live", phase: "implementing" }),
    ]);

    const code = runDone(undefined, { merged: true, yes: true });

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "flow done: no merged or cancelled pipelines to close.",
    );
    expect(stateMock.deleteState).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("runDone --orphans", () => {
  it("sweeps state files whose tmux window is missing, regardless of phase", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([
      state({ slug: "orphan-a", phase: "ci-wait", pr: 142 }),
      state({ slug: "orphan-b", phase: "needs-human" }),
      state({ slug: "live", phase: "implementing" }),
    ]);
    tmuxMock.listWindows.mockReturnValue([window("live")]);

    const code = runDone(undefined, { orphans: true, yes: true });

    expect(code).toBe(0);
    expect(stateMock.deleteState).toHaveBeenCalledWith("orphan-a");
    expect(stateMock.deleteState).toHaveBeenCalledWith("orphan-b");
    expect(stateMock.deleteState).not.toHaveBeenCalledWith("live");
    expect(turnTrackingMock.deleteTurnTracking).toHaveBeenCalledWith(
      "orphan-a",
    );
    expect(turnTrackingMock.deleteTurnTracking).toHaveBeenCalledWith(
      "orphan-b",
    );
    expect(turnTrackingMock.deleteTurnTracking).not.toHaveBeenCalledWith(
      "live",
    );
    // No window to kill for orphans (that's what makes them orphans).
    expect(tmuxMock.killWindow).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("includes the PR number in the preview when present", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([
      state({ slug: "orphan-pr", phase: "ci-wait", pr: 142 }),
      state({ slug: "orphan-no-pr", phase: "planning" }),
    ]);

    runDone(undefined, { orphans: true, yes: true });

    const messages = log.mock.calls.map((c) => c[0] as string);
    expect(messages).toContain("  orphan-pr (ci-wait #142)");
    expect(messages).toContain("  orphan-no-pr (planning)");
    log.mockRestore();
  });

  it("prints empty-sweep message when every state has a matching window", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([
      state({ slug: "live", phase: "implementing" }),
    ]);
    tmuxMock.listWindows.mockReturnValue([window("live")]);

    const code = runDone(undefined, { orphans: true, yes: true });

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "flow done: no orphan pipelines to close.",
    );
    expect(stateMock.deleteState).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("prints empty-sweep message when no state files exist at all", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([]);

    const code = runDone(undefined, { orphans: true, yes: true });

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "flow done: no orphan pipelines to close.",
    );
    log.mockRestore();
  });

  it("aborts without deleting when the user declines the prompt", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    readSyncMock.mockImplementation((_fd, buf) => {
      const bytes = Buffer.from("n\n");
      bytes.copy(buf as Buffer);
      return bytes.length;
    });

    stateMock.listStates.mockReturnValue([
      state({ slug: "orphan-a", phase: "ci-wait" }),
    ]);

    const code = runDone(undefined, { orphans: true });

    expect(code).toBe(0);
    expect(stateMock.deleteState).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("flow done: aborted — nothing closed");

    stdoutWrite.mockRestore();
    log.mockRestore();
  });

  it("proceeds with deletion when the user accepts the prompt", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    readSyncMock.mockImplementation((_fd, buf) => {
      const bytes = Buffer.from("y\n");
      bytes.copy(buf as Buffer);
      return bytes.length;
    });

    stateMock.listStates.mockReturnValue([
      state({ slug: "orphan-a", phase: "ci-wait" }),
    ]);

    const code = runDone(undefined, { orphans: true });

    expect(code).toBe(0);
    expect(stateMock.deleteState).toHaveBeenCalledWith("orphan-a");
    expect(turnTrackingMock.deleteTurnTracking).toHaveBeenCalledWith(
      "orphan-a",
    );

    stdoutWrite.mockRestore();
    log.mockRestore();
  });
});

describe("runDone (single name) closed: contract line", () => {
  it("prints the raw `closed: flow:<name>` token with no ANSI on accept", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    tmuxMock.windowExists.mockReturnValue(true);
    stateMock.readState.mockReturnValue(
      state({ slug: "feat-x", phase: "merged" }),
    );

    const code = runDone("feat-x", { yes: true });
    expect(code).toBe(0);
    // Contract: the closed: line is raw — never colorized, exact shape.
    expect(log).toHaveBeenCalledWith("closed: flow:feat-x");

    log.mockRestore();
  });
});

describe("runDone --merged --orphans (composed)", () => {
  it("unions the two filters with per-row tags and dedupes the overlap", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([
      // Merged-only: terminal phase, window still attached.
      state({ slug: "merged-live", phase: "merged" }),
      // Orphan-only: in-flight phase, window gone.
      state({ slug: "orphan-only", phase: "ci-wait", pr: 142 }),
      // Both: terminal phase AND window gone — must appear once, tagged "merged+orphan".
      state({ slug: "merged-orphan", phase: "cancelled" }),
      // Neither: in-flight + window present. Excluded.
      state({ slug: "live", phase: "implementing" }),
    ]);
    tmuxMock.listWindows.mockReturnValue([
      window("merged-live"),
      window("live"),
    ]);

    const code = runDone(undefined, { merged: true, orphans: true, yes: true });

    expect(code).toBe(0);
    const messages = log.mock.calls.map((c) => c[0] as string);
    expect(messages).toContain("will close 3 pipeline(s):");
    expect(messages).toContain("  merged-live (merged) [merged]");
    expect(messages).toContain("  orphan-only (ci-wait #142) [orphan]");
    expect(messages).toContain("  merged-orphan (cancelled) [merged+orphan]");
    // "live" is excluded entirely.
    expect(messages.some((m) => m.includes("live (implementing)"))).toBe(false);

    expect(stateMock.deleteState).toHaveBeenCalledWith("merged-live");
    expect(stateMock.deleteState).toHaveBeenCalledWith("orphan-only");
    expect(stateMock.deleteState).toHaveBeenCalledWith("merged-orphan");
    expect(stateMock.deleteState).not.toHaveBeenCalledWith("live");
    expect(turnTrackingMock.deleteTurnTracking).toHaveBeenCalledWith(
      "merged-live",
    );
    expect(turnTrackingMock.deleteTurnTracking).toHaveBeenCalledWith(
      "orphan-only",
    );
    expect(turnTrackingMock.deleteTurnTracking).toHaveBeenCalledWith(
      "merged-orphan",
    );
    expect(turnTrackingMock.deleteTurnTracking).not.toHaveBeenCalledWith(
      "live",
    );
    // Only existing windows get killed; "orphan-only" + "merged-orphan" have no window.
    expect(tmuxMock.killWindow).toHaveBeenCalledWith("merged-live");
    expect(tmuxMock.killWindow).not.toHaveBeenCalledWith("orphan-only");
    expect(tmuxMock.killWindow).not.toHaveBeenCalledWith("merged-orphan");
    log.mockRestore();
  });

  it("prints empty-sweep message when neither filter matches anything", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([
      state({ slug: "live", phase: "implementing" }),
    ]);
    tmuxMock.listWindows.mockReturnValue([window("live")]);

    const code = runDone(undefined, { merged: true, orphans: true, yes: true });

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "flow done: no merged, cancelled, or orphan pipelines to close.",
    );
    expect(stateMock.deleteState).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("CLI dispatches both flags into the composed path", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([]);

    const code = runDoneCli(["--merged", "--orphans", "--yes"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "flow done: no merged, cancelled, or orphan pipelines to close.",
    );
    log.mockRestore();
  });
});

describe("runDone(name) single-pipeline", () => {
  it("deletes both state and turn-tracking when hasState=true (state-file path)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    tmuxMock.windowExists.mockReturnValue(true);
    stateMock.readState.mockReturnValue(
      state({ slug: "my-slug", phase: "merged" }),
    );

    const code = runDone("my-slug", { yes: true });

    expect(code).toBe(0);
    expect(tmuxMock.killWindow).toHaveBeenCalledWith("my-slug");
    expect(stateMock.deleteState).toHaveBeenCalledWith("my-slug");
    expect(turnTrackingMock.deleteTurnTracking).toHaveBeenCalledWith("my-slug");
    log.mockRestore();
  });

  it("does NOT call deleteTurnTracking when hasState=false (window-only path)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tmuxMock.windowExists.mockReturnValue(true);
    stateMock.readState.mockReturnValue(null);

    const code = runDone("window-only", { yes: true });

    expect(code).toBe(0);
    expect(tmuxMock.killWindow).toHaveBeenCalledWith("window-only");
    expect(stateMock.deleteState).not.toHaveBeenCalled();
    expect(turnTrackingMock.deleteTurnTracking).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });
});

describe("runDoneCli --orphans / --merged plumbing", () => {
  it("dispatches --orphans without requiring a positional name", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([]);

    const code = runDoneCli(["--orphans", "--yes"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "flow done: no orphan pipelines to close.",
    );
    log.mockRestore();
  });

  it("dispatches --merged without requiring a positional name", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stateMock.listStates.mockReturnValue([]);

    const code = runDoneCli(["--merged", "--yes"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "flow done: no merged or cancelled pipelines to close.",
    );
    log.mockRestore();
  });

  it("errors with the renamed hint when no name and no sweep flag are passed", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = runDoneCli([]);

    expect(code).toBe(1);
    expect(err).toHaveBeenCalledWith(
      "flow done: <name> is required (or pass --merged / --orphans).",
    );
    err.mockRestore();
  });
});
