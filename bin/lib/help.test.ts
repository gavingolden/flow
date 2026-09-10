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
    // `flow feature create -- fix the -h crash` should NOT short-circuit to help — the
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
    "feature",
    "epic",
    "ls",
    "attach",
    "done",
    "reap",
    "prompt",
    "install",
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
  // removes it from HELP_TEXT.feature sees a red test rather than shipping
  // stale help text.
  it("HELP_TEXT.feature documents --wait-for-copilot", () => {
    expect(HELP_TEXT.feature).toContain("--wait-for-copilot");
  });

  // Pin the annotation legend (added for the (done)/(crashed) split) so a
  // future editor who drops it from HELP_TEXT.ls sees a red test rather
  // than shipping an undocumented marker.
  it("HELP_TEXT.ls documents the (done) and (crashed) annotations", () => {
    expect(HELP_TEXT.ls).toContain("(done)");
    expect(HELP_TEXT.ls).toContain("(crashed)");
  });

  it("HELP_TEXT.feature documents --copilot-review with its three values and the auto default", () => {
    expect(HELP_TEXT.feature).toContain("--copilot-review");
    expect(HELP_TEXT.feature).toContain("auto|always|never");
    expect(HELP_TEXT.feature).toMatch(/default auto/);
  });

  it("HELP_TEXT.feature documents --effort with its five-value enum", () => {
    expect(HELP_TEXT.feature).toContain("--effort");
    expect(HELP_TEXT.feature).toContain("low|medium|high|xhigh|max");
  });

  it("HELP_TEXT.feature documents --model with its four-value enum", () => {
    expect(HELP_TEXT.feature).toContain("--model");
    expect(HELP_TEXT.feature).toContain("opus|haiku|sonnet|fable");
  });

  it("HELP_TEXT.epic documents both --effort and --model on create", () => {
    expect(HELP_TEXT.epic).toContain("--effort");
    expect(HELP_TEXT.epic).toContain("low|medium|high|xhigh|max");
    expect(HELP_TEXT.epic).toContain("--model");
    expect(HELP_TEXT.epic).toContain("opus|haiku|sonnet|fable");
  });

  it("HELP_TEXT.feature documents every per-phase --model-<phase> flag", () => {
    for (const flag of [
      "--model-planning",
      "--model-implement",
      "--model-review",
      "--model-fix-applier",
      "--model-consolidator",
      "--model-merge-resolver",
    ]) {
      expect(HELP_TEXT.feature).toContain(flag);
    }
    // The fix-applier-sonnet asymmetry and the config-only scout/coder grain are noted.
    expect(HELP_TEXT.feature).toMatch(/fix-applier.*sonnet/i);
    expect(HELP_TEXT.feature).toContain("config.models.scout|coder");
  });

  it("HELP_TEXT.epic documents --model-planning (create), --model (run), and the bind/launch surfaces", () => {
    expect(HELP_TEXT.epic).toContain("--model-planning");
    expect(HELP_TEXT.epic).toContain("--model <alias>");
    // The loop-era judgment knob is gone.
    expect(HELP_TEXT.epic).not.toContain("--model-judge");
    expect(HELP_TEXT.epic).not.toContain("epicJudge");
    // The new safe-write actuators are documented.
    expect(HELP_TEXT.epic).toContain("bind");
    expect(HELP_TEXT.epic).toContain("launch");
    expect(HELP_TEXT.epic).toContain("--external");
  });

  it("HELP_TEXT.epic documents the launch overrides and run --effort", () => {
    expect(HELP_TEXT.epic).toContain("Options (launch):");
    expect(HELP_TEXT.epic).toContain(
      "epic run <slug> [--model <alias>] [--effort <level>]",
    );
    expect(HELP_TEXT.epic).toContain(
      "epic launch <epic-slug> <feature-id> [--model <alias>] [--effort <level>] [--force]",
    );
  });

  it("HELP_TEXT.epic describes ls as the union of committed + run-state epics", () => {
    expect(HELP_TEXT.epic).toContain("run-state");
    expect(HELP_TEXT.epic).not.toContain("list every epic under ~/.flow/epics");
  });

  it("HELP_TEXT.epic documents the ls --all/-a, --done, and --all-repos flags", () => {
    expect(HELP_TEXT.epic).toContain(
      "flow epic ls [--all|-a] [--done] [--all-repos]",
    );
    expect(HELP_TEXT.epic).toContain("--done");
    expect(HELP_TEXT.epic).toContain("--all-repos");
  });

  it("HELP_TEXT.ls documents --all-repos and the repo-scoped default", () => {
    expect(HELP_TEXT.ls).toContain("--all-repos");
    expect(HELP_TEXT.ls).toMatch(/scoped to the current repo/i);
  });

  it("HELP_TOP and HELP_TEXT.feature both document --auto-merge, --no-wait-for-copilot, and --no-research", () => {
    for (const flag of [
      "--auto-merge",
      "--no-wait-for-copilot",
      "--no-research",
    ]) {
      expect(HELP_TOP).toContain(flag);
      expect(HELP_TEXT.feature).toContain(flag);
    }
  });

  it("HELP_TEXT.config names 'launch' in both its Usage list and its Subcommands prose", () => {
    expect(HELP_TEXT.config).toMatch(/Usage:[\s\S]*flow config launch/);
    expect(HELP_TEXT.config).toMatch(/Subcommands:[\s\S]*\n\s*launch\s/);
  });

  it("no help string mentions the removed 'interview.enabled' config key", () => {
    const haystack = [HELP_TOP, ...Object.values(HELP_TEXT)].join("\n");
    expect(haystack).not.toContain("interview.enabled");
  });

  it("Options (create) documents each config-backed flag's launch.<key> counterpart", () => {
    const pairs: Array<[string, string]> = [
      ["--effort", "launch.effort"],
      ["--auto-merge", "launch.autoMerge"],
      ["--wait-for-copilot", "launch.waitForCopilot"],
      ["--research", "launch.forceResearch"],
      ["--interview", "launch.interviewMode"],
    ];
    for (const [flag, key] of pairs) {
      expect(HELP_TEXT.feature).toContain(flag);
      expect(HELP_TEXT.feature).toContain(key);
    }
  });
});

describe("HELP_TOP", () => {
  it("starts with the flow header line", () => {
    expect(
      HELP_TOP.startsWith("flow — end-to-end pipelines for Claude Code"),
    ).toBe(true);
  });

  it("documents 'flow help <verb>' as a top-level form", () => {
    expect(HELP_TOP).toContain("flow help <verb>");
  });

  it("documents bare `flow` launching an interactive skill-loaded session", () => {
    expect(HELP_TOP).toContain("claude --add-dir ~/.flow/claude-home");
    expect(HELP_TOP).toContain("run 'flow help' for this help");
  });

  // Same flag-presence guard as above, applied to the top-level help block.
  it("documents --wait-for-copilot in the `flow feature create` synopsis", () => {
    expect(HELP_TOP).toContain("--wait-for-copilot");
  });

  it("documents --copilot-review in the `flow feature create` synopsis", () => {
    expect(HELP_TOP).toContain("--copilot-review");
  });

  it("documents --effort in the `flow feature create` synopsis", () => {
    expect(HELP_TOP).toContain("--effort");
  });

  it("documents --model in the `flow feature create` synopsis", () => {
    expect(HELP_TOP).toContain("--model");
    expect(HELP_TOP).toContain("opus|haiku|sonnet|fable");
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
    const code = printVerbHelp("feature");
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(HELP_TEXT.feature);
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
    "feature",
    "epic",
    "ls",
    "attach",
    "done",
    "install",
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
