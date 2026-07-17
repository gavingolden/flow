import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock tmux primitives so the help short-circuit cannot leak a tmux query
// against the user's real session. listWindows / sessionExists / execAttach
// must remain unmocked-but-uncalled — assertions below verify that.
const tmuxMock = vi.hoisted(() => ({
  execAttach: vi.fn(),
  findWindowBySlug: vi.fn(),
  listWindows: vi.fn(
    () => [] as { id: string; name: string; slug: string; activity: number }[],
  ),
  sessionExists: vi.fn(() => false),
  FLOW_SESSION: "flow",
}));
vi.mock("./tmux", () => tmuxMock);

// Mock the state reader so runAttach's plain-launcher hint path never touches
// the real ~/.flow/state. launcher.ts (plainAttachHint's module) also imports
// write/delete helpers from ./state, so stub those too.
const stateMock = vi.hoisted(() => ({
  readState: vi.fn((_slug: string): unknown => null),
  writeState: vi.fn(),
  deleteState: vi.fn(),
}));
vi.mock("./state", () => stateMock);

import { runAttach, runAttachCli } from "./attach";

describe("runAttachCli (--help / -h short-circuit)", () => {
  for (const flag of ["--help", "-h"]) {
    it(`exits 0 and prints help when args is ['${flag}']`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const code = runAttachCli([flag]);
      expect(code).toBe(0);
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls[0][0]).toMatch(
        /^flow attach — attach to a pipeline/,
      );
      expect(err).not.toHaveBeenCalled();
      log.mockRestore();
      err.mockRestore();
    });

    it(`does not query tmux when args is ['${flag}']`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      runAttachCli([flag]);
      expect(tmuxMock.sessionExists).not.toHaveBeenCalled();
      expect(tmuxMock.listWindows).not.toHaveBeenCalled();
      expect(tmuxMock.execAttach).not.toHaveBeenCalled();
      log.mockRestore();
    });
  }
});

describe("runAttachCli (multi-slug guard)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("errors with the single-window constraint and exits 1 without attaching", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runAttachCli(["a", "b"]);
    expect(code).toBe(1);
    expect(err).toHaveBeenCalled();
    expect(err.mock.calls[0][0]).toMatch(/single window/);
    expect(tmuxMock.execAttach).not.toHaveBeenCalled();
    expect(tmuxMock.sessionExists).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("runAttach (no-arg branch)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should exit 1 when no flow session exists", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tmuxMock.sessionExists.mockReturnValue(false);
    const code = runAttach();
    expect(code).toBe(1);
    expect(tmuxMock.execAttach).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("should exit 1 when the session has zero windows", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tmuxMock.sessionExists.mockReturnValue(true);
    tmuxMock.listWindows.mockReturnValue([]);
    const code = runAttach();
    expect(code).toBe(1);
    expect(tmuxMock.execAttach).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("should attach to the only window when exactly one exists", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tmuxMock.sessionExists.mockReturnValue(true);
    tmuxMock.listWindows.mockReturnValue([
      { id: "@1", name: "solo", slug: "solo-slug", activity: 100 },
    ]);
    runAttach();
    expect(tmuxMock.execAttach).toHaveBeenCalledWith("solo-slug");
    err.mockRestore();
  });

  it("should attach to the most-recently-active window when several exist", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tmuxMock.sessionExists.mockReturnValue(true);
    tmuxMock.listWindows.mockReturnValue([
      { id: "@1", name: "old", slug: "old-slug", activity: 100 },
      { id: "@2", name: "newest", slug: "newest-slug", activity: 300 },
      { id: "@3", name: "mid", slug: "mid-slug", activity: 200 },
    ]);
    runAttach();
    expect(tmuxMock.execAttach).toHaveBeenCalledWith("newest-slug");
    err.mockRestore();
  });

  it("should fall back to the display name when the chosen window has no slug", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tmuxMock.sessionExists.mockReturnValue(true);
    tmuxMock.listWindows.mockReturnValue([
      { id: "@1", name: "legacy-window", slug: "", activity: 500 },
    ]);
    runAttach();
    expect(tmuxMock.execAttach).toHaveBeenCalledWith("legacy-window");
    err.mockRestore();
  });

  it("should keep the earlier window on an activity tie", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tmuxMock.sessionExists.mockReturnValue(true);
    tmuxMock.listWindows.mockReturnValue([
      { id: "@1", name: "first", slug: "first-slug", activity: 200 },
      { id: "@2", name: "second", slug: "second-slug", activity: 200 },
    ]);
    runAttach();
    // Strict `>` in the reduce means the first window survives a tie —
    // pins the documented behavior so a `>` -> `>=` change can't slip through.
    expect(tmuxMock.execAttach).toHaveBeenCalledWith("first-slug");
    err.mockRestore();
  });
});

describe("runAttach (named branch)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should attach when the named window exists", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tmuxMock.sessionExists.mockReturnValue(true);
    tmuxMock.findWindowBySlug.mockReturnValue({
      id: "@1",
      name: "x",
      slug: "x",
      activity: 1,
    });
    tmuxMock.execAttach.mockReturnValue(0);
    expect(runAttach("x")).toBe(0);
    expect(tmuxMock.execAttach).toHaveBeenCalledWith("x");
    err.mockRestore();
  });

  it("should exit 1 when the named window is not found", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tmuxMock.sessionExists.mockReturnValue(true);
    tmuxMock.findWindowBySlug.mockReturnValue(undefined);
    expect(runAttach("missing")).toBe(1);
    expect(tmuxMock.execAttach).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("plain-launcher hint (state exists, no tmux window)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints the plain attach hint (pid shown) and exits 1 when the slug has state but no window", () => {
    tmuxMock.sessionExists.mockReturnValue(true);
    tmuxMock.findWindowBySlug.mockReturnValue(undefined);
    stateMock.readState.mockReturnValue({
      slug: "plain-pipe",
      phase: "implementing",
      repo: "/r",
      pid: 4242,
      updatedAt: "2026-07-14T00:00:00Z",
      launcher: "plain",
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runAttach("plain-pipe");
    expect(code).toBe(1);
    const out = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("plain launcher");
    expect(out).toContain("pid 4242");
    expect(out).toContain("flow feature resume plain-pipe");
    expect(tmuxMock.execAttach).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("prints the hint even when no flow tmux session exists at all", () => {
    tmuxMock.sessionExists.mockReturnValue(false);
    stateMock.readState.mockReturnValue({
      slug: "plain-pipe",
      phase: "implementing",
      repo: "/r",
      updatedAt: "2026-07-14T00:00:00Z",
      launcher: "plain",
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runAttach("plain-pipe");
    expect(code).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "plain launcher",
    );
    err.mockRestore();
  });

  it("falls through to the generic not-found error for a tmux-launched pipeline with no confirmed plain launcher", () => {
    tmuxMock.sessionExists.mockReturnValue(true);
    tmuxMock.findWindowBySlug.mockReturnValue(undefined);
    stateMock.readState.mockReturnValue({
      slug: "tmux-pipe",
      phase: "implementing",
      repo: "/r",
      updatedAt: "2026-07-14T00:00:00Z",
      launcher: "tmux",
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runAttach("tmux-pipe");
    expect(code).toBe(1);
    const out = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toContain("plain launcher");
    expect(out).toContain("not found in 'flow' session");
    err.mockRestore();
  });

  it("keeps the generic not-found error when the slug has no state either", () => {
    tmuxMock.sessionExists.mockReturnValue(true);
    tmuxMock.findWindowBySlug.mockReturnValue(undefined);
    stateMock.readState.mockReturnValue(null);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runAttach("ghost");
    expect(code).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "not found in 'flow' session",
    );
    err.mockRestore();
  });
});
