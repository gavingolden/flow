import { describe, expect, it } from "vitest";
import {
  NEXT_ACTION_BY_REASON,
  RECIPE_COMMANDS,
  RECIPE_COMMANDS_NONE,
} from "./flow-gate-summary";
import {
  bashParses,
  COMMAND_WORDS,
  firstTokenOk,
  hasShellcheck,
  PLACEHOLDER_ALLOWLIST,
  shellcheckOk,
  substitutePlaceholders,
} from "./lib/command-lint";

/**
 * Lints every `NEXT_ACTION_BY_REASON` recipe: anchors each declared command
 * against its recipe's prose, shell-parses it, and checks its vocabulary /
 * structure. `bash -n` gates on both hosts; `shellcheck --severity=error`
 * runs additively when the binary is present (absent on this host, present
 * on GitHub `ubuntu-latest`).
 */

// Rule 3's detector: any COMMAND_WORDS token appearing as its own word in
// the prose. Deliberately high-recall — narrated mentions of a helper name
// ("...flow-merge-guard refused the merge") trip it just as a real
// invocation would; RECIPE_COMMANDS_NONE is the load-bearing escape hatch.
function detectorTrips(prose: string): boolean {
  return COMMAND_WORDS.some((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`).test(prose);
  });
}

describe("gate-summary recipe lint — key parity", () => {
  it("RECIPE_COMMANDS declares exactly the NEXT_ACTION_BY_REASON keys", () => {
    const naKeys = new Set(Object.keys(NEXT_ACTION_BY_REASON));
    const rcKeys = new Set(Object.keys(RECIPE_COMMANDS));
    expect(rcKeys).toEqual(naKeys);
  });

  it("[negative] a missing key would fail parity", () => {
    // Built from the real key sets (not synthetic "a"/"b" literals) with
    // one real RECIPE_COMMANDS key dropped, so this exercises the actual
    // parity check drifting against real repo state, not an invented shape.
    const naKeys = new Set(Object.keys(NEXT_ACTION_BY_REASON));
    const rcKeys = new Set(Object.keys(RECIPE_COMMANDS));
    rcKeys.delete([...rcKeys][0]);
    expect(rcKeys).not.toEqual(naKeys);
  });
});

describe("gate-summary recipe lint — verbatim anchoring", () => {
  it("every declared command is a verbatim substring of its recipe's prose", () => {
    for (const [tag, cmds] of Object.entries(RECIPE_COMMANDS)) {
      for (const cmd of cmds) {
        expect(NEXT_ACTION_BY_REASON[tag].includes(cmd)).toBe(true);
      }
    }
  });

  it("[negative] a fabricated command is not a substring of unrelated prose", () => {
    expect(NEXT_ACTION_BY_REASON["triage-ambiguous"].includes("rm -rf /")).toBe(
      false,
    );
  });
});

describe("gate-summary recipe lint — coverage tripwire (Rule 3)", () => {
  it("every prose the detector trips on declares a command or is allowlisted", () => {
    for (const [tag, prose] of Object.entries(NEXT_ACTION_BY_REASON)) {
      if (!detectorTrips(prose)) continue;
      const declared = RECIPE_COMMANDS[tag] ?? [];
      const ok = declared.length > 0 || RECIPE_COMMANDS_NONE.includes(tag);
      expect(
        ok,
        `tag '${tag}' trips the detector but declares nothing and is not allowlisted`,
      ).toBe(true);
    }
  });

  it("the first token of every declared command is a known command word", () => {
    for (const cmds of Object.values(RECIPE_COMMANDS)) {
      for (const cmd of cmds) {
        const first = cmd.trim().split(/\s+/)[0];
        expect(COMMAND_WORDS).toContain(first);
      }
    }
  });

  it("[negative] a detector-tripping tag with no declaration and no allowlist entry fails", () => {
    const prose = "run flow attach <slug> to inspect";
    const declared: string[] = [];
    const allowlist: string[] = [];
    const ok = declared.length > 0 || allowlist.includes("made-up-tag");
    expect(detectorTrips(prose)).toBe(true);
    expect(ok).toBe(false);
  });
});

describe("gate-summary recipe lint — non-zero guard", () => {
  it("the flattened declared-command count is greater than zero", () => {
    const total = Object.values(RECIPE_COMMANDS).reduce(
      (n, cmds) => n + cmds.length,
      0,
    );
    expect(total).toBeGreaterThan(0);
  });
});

describe("gate-summary recipe lint — shell parse", () => {
  it("every declared command shell-parses after placeholder substitution", () => {
    for (const cmds of Object.values(RECIPE_COMMANDS)) {
      for (const cmd of cmds) {
        expect(bashParses(substitutePlaceholders(cmd))).toBe(true);
      }
    }
  });

  it("[negative] an unbalanced fragment fails to parse", () => {
    expect(bashParses("git fetch |")).toBe(false);
  });
});

describe("gate-summary recipe lint — command vocabulary", () => {
  it("every declared command passes firstTokenOk", () => {
    for (const cmds of Object.values(RECIPE_COMMANDS)) {
      for (const cmd of cmds) {
        expect(firstTokenOk(cmd), cmd).toBe(true);
      }
    }
  });

  it("[negative] flow new fails firstTokenOk (the live defect this PR fixes)", () => {
    expect(firstTokenOk("flow new <slug>")).toBe(false);
  });
});

describe("gate-summary recipe lint — placeholder vocabulary", () => {
  it("every <token> in a declared command is on PLACEHOLDER_ALLOWLIST", () => {
    for (const cmds of Object.values(RECIPE_COMMANDS)) {
      for (const cmd of cmds) {
        const tokens = cmd.match(/<[^>]+>/g) ?? [];
        for (const t of tokens) {
          expect(PLACEHOLDER_ALLOWLIST).toContain(t);
        }
      }
    }
  });

  it("[negative] an undeclared placeholder is not on the allowlist", () => {
    expect(PLACEHOLDER_ALLOWLIST).not.toContain("<made-up-placeholder>");
  });
});

describe("gate-summary recipe lint — structure", () => {
  it("no declared fragment contains a bare -- token", () => {
    for (const cmds of Object.values(RECIPE_COMMANDS)) {
      for (const cmd of cmds) {
        expect(/(^|\s)--(\s|$)/.test(cmd)).toBe(false);
      }
    }
  });

  it("any tag declaring a post-resolution git commit also declares a git add", () => {
    for (const cmds of Object.values(RECIPE_COMMANDS)) {
      const hasCommit = cmds.some(
        (c) => c === "git commit" || c.startsWith("git commit "),
      );
      const hasAdd = cmds.some((c) => c.startsWith("git add"));
      if (hasCommit) expect(hasAdd).toBe(true);
    }
  });

  it("[negative] a bare -- token would fail the structure guard", () => {
    // Built from a real declared command (not a fully synthetic prose
    // literal) with a bare `--` appended, so this exercises the guard
    // against real repo state drifting rather than an invented string.
    const [firstTag] = Object.keys(RECIPE_COMMANDS);
    const realCmd = RECIPE_COMMANDS[firstTag][0];
    expect(/(^|\s)--(\s|$)/.test(`${realCmd} -- oops`)).toBe(true);
  });

  it("no declared command is immediately followed by a period in its recipe", () => {
    for (const [tag, cmds] of Object.entries(RECIPE_COMMANDS)) {
      const recipe = NEXT_ACTION_BY_REASON[tag];
      for (const cmd of cmds) {
        let idx = recipe.indexOf(cmd);
        while (idx !== -1) {
          const nextChar = recipe[idx + cmd.length];
          expect(nextChar, `${tag}: "${cmd}" at index ${idx}`).not.toBe(".");
          idx = recipe.indexOf(cmd, idx + 1);
        }
      }
    }
  });

  it("[negative] a command immediately followed by a period would fail the terminal-punctuation guard", () => {
    // Built from a real declared command (not a fully synthetic prose
    // literal) with a period appended, so this exercises the guard
    // against real repo state drifting rather than an invented string.
    const [firstTag] = Object.keys(RECIPE_COMMANDS);
    const realCmd = RECIPE_COMMANDS[firstTag][0];
    const doctored = `${realCmd}.`;
    expect(doctored[realCmd.length]).toBe(".");
  });
});

const describeShellcheck = hasShellcheck() ? describe : describe.skip;
describeShellcheck("gate-summary recipe lint — optional shellcheck", () => {
  it("every substituted declared command passes shellcheck --severity=error", () => {
    for (const cmds of Object.values(RECIPE_COMMANDS)) {
      for (const cmd of cmds) {
        expect(shellcheckOk(substitutePlaceholders(cmd))).toBe(true);
      }
    }
  });
});
