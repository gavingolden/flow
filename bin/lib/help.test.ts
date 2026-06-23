import { describe, expect, it, vi } from "vitest";
import {
  argsContainHelp,
  HELP_TEXT,
  HELP_TOP,
  isHelpFlag,
  printTopHelp,
  printVerbHelp,
  runHelpVerb,
} from "./help";

describe("isHelpFlag", () => {
  it("matches --help", () => {
    expect(isHelpFlag("--help")).toBe(true);
  });

  it("matches -h", () => {
    expect(isHelpFlag("-h")).toBe(true);
  });

  it("rejects undefined", () => {
    expect(isHelpFlag(undefined)).toBe(false);
  });

  it("rejects unrelated flags and verbs", () => {
    for (const arg of ["help", "-help", "--h", "--Help", "-H", "new", ""]) {
      expect(isHelpFlag(arg)).toBe(false);
    }
  });
});

describe("argsContainHelp", () => {
  it("returns false for an empty arg list", () => {
    expect(argsContainHelp([])).toBe(false);
  });

  it("returns true when --help is the only arg", () => {
    expect(argsContainHelp(["--help"])).toBe(true);
  });

  it("returns true when -h is the only arg", () => {
    expect(argsContainHelp(["-h"])).toBe(true);
  });

  it("returns true when --help follows other flags", () => {
    expect(argsContainHelp(["--no-auto-merge", "--help"])).toBe(true);
  });

  it("returns true when -h is buried among other args", () => {
    expect(argsContainHelp(["fix", "the", "thing", "-h"])).toBe(true);
  });

  it("returns false when no --help / -h appears", () => {
    expect(argsContainHelp(["--no-auto-merge", "fix the thing"])).toBe(false);
  });

  it("stops scanning at `--` so a literal -h after the sentinel is treated as data", () => {
    // `flow new -- fix the -h crash` should NOT short-circuit to help — the
    // user's description happens to contain `-h` as a literal token.
    expect(argsContainHelp(["--", "fix", "the", "-h", "crash"])).toBe(false);
    expect(argsContainHelp(["--", "--help"])).toBe(false);
  });

  it("still recognises --help / -h that appear before `--`", () => {
    expect(argsContainHelp(["--help", "--", "rest"])).toBe(true);
    expect(argsContainHelp(["-h", "--", "rest"])).toBe(true);
  });
});

describe("HELP_TEXT", () => {
  // Every user-facing verb dispatched by bin/flow must have a help entry.
  // Aliases (`a`, `-v`, `--version`, `--help`, `-h`, `help`) canonicalize
  // through bin/flow's runHelpVerb, so they don't need their own entries.
  const REQUIRED_VERBS = [
    "new",
    "epic",
    "ls",
    "attach",
    "done",
    "migrate",
    "setup",
    "completion",
    "version",
  ] as const;

  it.each(REQUIRED_VERBS)("has a non-empty entry for '%s'", (verb) => {
    expect(HELP_TEXT[verb]).toBeDefined();
    expect(HELP_TEXT[verb].length).toBeGreaterThan(0);
  });

  it.each(REQUIRED_VERBS)("entry for '%s' starts with 'flow %s'", (verb) => {
    expect(HELP_TEXT[verb].startsWith(`flow ${verb}`)).toBe(true);
  });

  // Flag-presence guard. The verb-presence assertions above don't catch a
  // silent deletion of a single flag from the verb's help body. Pin the
  // newly-added `--wait-for-copilot` flag here so a future editor who
  // removes it from HELP_TEXT.new sees a red test rather than shipping
  // stale help text.
  it("HELP_TEXT.new documents --wait-for-copilot", () => {
    expect(HELP_TEXT.new).toContain("--wait-for-copilot");
  });

  it("HELP_TEXT.new documents --copilot-review with its three values and the auto default", () => {
    expect(HELP_TEXT.new).toContain("--copilot-review");
    expect(HELP_TEXT.new).toContain("auto|always|never");
    expect(HELP_TEXT.new).toMatch(/default auto/);
  });

  it("HELP_TEXT.new documents --effort with its five-value enum", () => {
    expect(HELP_TEXT.new).toContain("--effort");
    expect(HELP_TEXT.new).toContain("low|medium|high|xhigh|max");
  });
});

describe("HELP_TOP", () => {
  it("starts with the flow header line", () => {
    expect(
      HELP_TOP.startsWith("flow — tmux-driven pipelines for Claude Code"),
    ).toBe(true);
  });

  it("documents 'flow help <verb>' as a top-level form", () => {
    expect(HELP_TOP).toContain("flow help <verb>");
  });

  // Same flag-presence guard as above, applied to the top-level help block.
  it("documents --wait-for-copilot in the `flow new` synopsis", () => {
    expect(HELP_TOP).toContain("--wait-for-copilot");
  });

  it("documents --copilot-review in the `flow new` synopsis", () => {
    expect(HELP_TOP).toContain("--copilot-review");
  });

  it("documents --effort in the `flow new` synopsis", () => {
    expect(HELP_TOP).toContain("--effort");
  });
});

describe("printTopHelp", () => {
  it("writes HELP_TOP to stdout and nothing to stderr", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    printTopHelp();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(HELP_TOP);
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
});

describe("printVerbHelp", () => {
  it("returns 0 and prints the verb's help text to stdout", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = printVerbHelp("new");
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(HELP_TEXT.new);
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });

  it("returns 1 and prints a stderr error for an unknown verb", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = printVerbHelp("nonsense");
    expect(code).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith("flow help: unknown verb 'nonsense'");
    log.mockRestore();
    err.mockRestore();
  });
});

describe("runHelpVerb", () => {
  it("prints top-level help when no args are passed", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = runHelpVerb([]);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(HELP_TOP);
    log.mockRestore();
  });

  for (const self of ["help", "--help", "-h"]) {
    it(`collapses self-reference '${self}' to top-level help`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = runHelpVerb([self]);
      expect(code).toBe(0);
      expect(log).toHaveBeenCalledWith(HELP_TOP);
      log.mockRestore();
    });
  }

  it("canonicalises 'a' to 'attach'", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = runHelpVerb(["a"]);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(HELP_TEXT.attach);
    log.mockRestore();
  });

  for (const alias of ["-v", "--version"]) {
    it(`canonicalises '${alias}' to 'version'`, () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = runHelpVerb([alias]);
      expect(code).toBe(0);
      expect(log).toHaveBeenCalledWith(HELP_TEXT.version);
      log.mockRestore();
    });
  }

  it("returns 1 for an unknown target", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runHelpVerb(["nonsense"]);
    expect(code).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith("flow help: unknown verb 'nonsense'");
    log.mockRestore();
    err.mockRestore();
  });

  it.each([
    "new",
    "ls",
    "attach",
    "done",
    "migrate",
    "setup",
    "completion",
    "version",
  ])(
    "'flow help %s' prints the same body as the verb's --help intercept",
    (verb) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = runHelpVerb([verb]);
      expect(code).toBe(0);
      expect(log).toHaveBeenCalledWith(HELP_TEXT[verb]);
      log.mockRestore();
    },
  );
});
