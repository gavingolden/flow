import { describe, expect, it, vi } from "vitest";

// Mock tmux primitives so the help short-circuit cannot leak a tmux query
// against the user's real session. listWindows / sessionExists / execAttach
// must remain unmocked-but-uncalled — assertions below verify that.
const tmuxMock = vi.hoisted(() => ({
  execAttach: vi.fn(),
  listWindows: vi.fn(() => [] as { name: string; activity: number }[]),
  sessionExists: vi.fn(() => false),
  FLOW_SESSION: "flow",
}));
vi.mock("./tmux", () => tmuxMock);

import { runAttachCli } from "./attach";

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
