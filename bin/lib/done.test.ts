import { describe, expect, it, vi } from "vitest";

// Mock tmux primitives so the help short-circuit test cannot accidentally
// run a kill or list against the user's real tmux session if the check
// regresses. The mocks are read-only spies; calls would surface as test
// failures via the `not.toHaveBeenCalled` assertions below.
const tmuxMock = vi.hoisted(() => ({
  killWindow: vi.fn(),
  listWindows: vi.fn(() => [] as { name: string; activity: number }[]),
  windowExists: vi.fn(() => false),
  FLOW_SESSION: "flow",
}));
vi.mock("./tmux", () => tmuxMock);

const stateMock = vi.hoisted(() => ({
  deleteState: vi.fn(),
  listStates: vi.fn(() => [] as never[]),
  readState: vi.fn(() => null),
}));
vi.mock("./state", () => stateMock);

import { runDoneCli } from "./done";

describe("runDoneCli (--help / -h short-circuit)", () => {
  for (const flag of ["--help", "-h"]) {
    it(`exits 0 when args is ['${flag}']`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
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

  it("short-circuits even when --help follows --all-merged", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = runDoneCli(["--all-merged", "--help"]);
    expect(code).toBe(0);
    expect(stateMock.listStates).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
