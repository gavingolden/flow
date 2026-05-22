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

import { runAttach, runAttachCli } from "./attach";

describe("runAttachCli (--help / -h short-circuit)", () => {
  for (const flag of ["--help", "-h"]) {
    it(`exits 0 and prints help when args is ['${flag}']`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const code = runAttachCli([flag]);
      expect(code).toBe(0);
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls[0][0]).toMatch(/^flow attach — attach to a pipeline/);
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
});
