import { describe, expect, it } from "vitest";
import { buildNewWindowArgs, parseAliveStatus } from "./tmux";

describe(parseAliveStatus, () => {
  it("returns true when pane_dead is 0 and pid probe succeeds", () => {
    expect(parseAliveStatus("0 4242", () => true)).toBe(true);
  });

  it("returns false when pane_dead is 1 (remain-on-exit corpse)", () => {
    expect(parseAliveStatus("1 4242", () => true)).toBe(false);
  });

  it("returns false when pid probe says the process is gone", () => {
    expect(parseAliveStatus("0 4242", () => false)).toBe(false);
  });

  it("returns false when stdout is empty (no panes)", () => {
    expect(parseAliveStatus("", () => true)).toBe(false);
  });

  it("returns false when the pid is unparseable", () => {
    expect(parseAliveStatus("0 not-a-pid", () => true)).toBe(false);
  });

  it("returns false when the pid is non-positive", () => {
    expect(parseAliveStatus("0 0", () => true)).toBe(false);
  });

  it("only inspects the first pane (the one we always launch into)", () => {
    const stdout = "0 4242\n1 9999\n";
    expect(parseAliveStatus(stdout, () => true)).toBe(true);
  });
});

describe(buildNewWindowArgs, () => {
  // Regression: bare `-t flow` resolves against the active window in some
  // tmux configs, so `new-window -t flow` from inside an existing flow
  // window fails with "index N in use" instead of picking the lowest free
  // slot. The trailing colon forces session-target semantics.
  it("targets the session with a trailing colon", () => {
    expect(buildNewWindowArgs("flow", "my-win", "/tmp", ["echo", "hi"])).toEqual([
      "new-window",
      "-t",
      "flow:",
      "-n",
      "my-win",
      "-c",
      "/tmp",
      "--",
      "echo",
      "hi",
    ]);
  });
});
