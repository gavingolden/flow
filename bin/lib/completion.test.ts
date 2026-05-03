import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompletion } from "./completion";
import { resolveFlowSource } from "./paths";
import { VERBS } from "./verbs";

const FLOW_SOURCE = resolveFlowSource();

describe("flow completion", () => {
  let stderrSpy!: ReturnType<typeof vi.spyOn>;
  let captured!: string;
  let stderrCaptured!: string[];

  function out(s: string): void {
    captured += s;
  }

  beforeEach(() => {
    captured = "";
    stderrCaptured = [];
    stderrSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      stderrCaptured.push(msg);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("prints the bash script byte-for-byte", () => {
    const code = runCompletion("bash", { out });
    expect(code).toBe(0);
    const onDisk = fs.readFileSync(path.join(FLOW_SOURCE, "completions", "flow.bash"), "utf8");
    expect(captured).toBe(onDisk);
  });

  it("prints the zsh script byte-for-byte", () => {
    const code = runCompletion("zsh", { out });
    expect(code).toBe(0);
    const onDisk = fs.readFileSync(path.join(FLOW_SOURCE, "completions", "flow.zsh"), "utf8");
    expect(captured).toBe(onDisk);
  });

  it("exits 2 with an error message for an unsupported shell", () => {
    const code = runCompletion("fish", { out });
    expect(code).toBe(2);
    expect(stderrCaptured).toEqual([
      "flow completion: unsupported shell 'fish' (supported: bash, zsh)",
    ]);
    expect(captured).toBe("");
  });

  it("exits 2 when no shell is provided", () => {
    const code = runCompletion(undefined, { out });
    expect(code).toBe(2);
    expect(stderrCaptured[0]).toBe("flow completion: shell argument is required");
    expect(stderrCaptured[1]).toBe("usage: flow completion <bash|zsh>");
  });

  for (const flag of ["--help", "-h"]) {
    it(`exits 0 with verb-specific help for '${flag}' (no fs read)`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = runCompletion(flag, { out });
      expect(code).toBe(0);
      expect(captured).toBe("");
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls[0][0]).toMatch(/^flow completion — print a shell completion/);
      expect(stderrCaptured).toEqual([]);
      log.mockRestore();
    });

    it(`exits 0 and prints help for 'bash ${flag}' (no script emitted)`, () => {
      // Regression: `flow completion bash --help` previously printed the
      // bash completion script because runCompletion only inspected the
      // first arg. Every other verb honours --help anywhere — completion
      // must match.
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = runCompletion("bash", { out }, [flag]);
      expect(code).toBe(0);
      expect(captured).toBe("");
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls[0][0]).toMatch(/^flow completion — print a shell completion/);
      expect(stderrCaptured).toEqual([]);
      log.mockRestore();
    });
  }
});

describe("completion scripts stay in sync with VERBS", () => {
  // The verb-list-stays-in-sync property test: every verb dispatched by
  // bin/flow must appear in both shell scripts. Without this assertion, the
  // static scripts silently rot when a new verb lands. The test reads both
  // scripts from disk and looks for each verb as a whole-word match.
  //
  // Aliases (`a`) and short flags (`-v`, `-h`) have to use word-boundary
  // checks rather than substring checks to avoid spurious matches inside
  // longer words (e.g. "bash" contains "a"). The regex below requires a
  // non-word character on each side.

  function verbInScript(verb: string, script: string): boolean {
    const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`).test(script);
  }

  it("bash script lists every verb", () => {
    const script = fs.readFileSync(path.join(FLOW_SOURCE, "completions", "flow.bash"), "utf8");
    const missing = VERBS.filter((v) => !verbInScript(v, script));
    expect(missing).toEqual([]);
  });

  it("zsh script lists every verb", () => {
    const script = fs.readFileSync(path.join(FLOW_SOURCE, "completions", "flow.zsh"), "utf8");
    const missing = VERBS.filter((v) => !verbInScript(v, script));
    expect(missing).toEqual([]);
  });

  it("bash script contains the registration line", () => {
    const script = fs.readFileSync(path.join(FLOW_SOURCE, "completions", "flow.bash"), "utf8");
    expect(script).toContain("complete -F _flow flow");
  });

  it("zsh script starts with the #compdef directive and ends with compdef registration", () => {
    const script = fs.readFileSync(path.join(FLOW_SOURCE, "completions", "flow.zsh"), "utf8");
    expect(script.startsWith("#compdef flow")).toBe(true);
    expect(script).toContain("compdef _flow flow");
  });
});
