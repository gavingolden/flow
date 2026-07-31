import { describe, expect, it } from "vitest";
import {
  bashParses,
  COMMAND_WORDS,
  firstTokenOk,
  hasShellcheck,
  helperNames,
  PLACEHOLDER_ALLOWLIST,
  shellcheckOk,
  substitutePlaceholders,
} from "./command-lint";

describe("substitutePlaceholders", () => {
  it("replaces a simple placeholder", () => {
    expect(substitutePlaceholders("flow attach <slug>")).toBe(
      "flow attach PLACEHOLDER",
    );
  });

  it("replaces the compound <merged|gated|...> placeholder in one pass, without leaving a bare pipe", () => {
    const cmd =
      "flow-state-update --phase <merged|gated|...> --force --slug <victim-slug>";
    const substituted = substitutePlaceholders(cmd);
    expect(substituted).not.toContain("|");
    expect(bashParses(substituted)).toBe(true);
  });

  it("leaves pipe-free fragments with no placeholders untouched", () => {
    expect(substitutePlaceholders("git log")).toBe("git log");
  });
});

describe("bashParses", () => {
  it("accepts a valid compound command", () => {
    expect(bashParses("cd PLACEHOLDER && git fetch origin PLACEHOLDER")).toBe(
      true,
    );
  });

  it("rejects a syntactically invalid fragment", () => {
    expect(bashParses("git fetch |")).toBe(false);
  });
});

describe("firstTokenOk", () => {
  it("rejects flow new — the live defect this PR fixes", () => {
    expect(firstTokenOk("flow new <slug>")).toBe(false);
  });

  it("accepts flow feature resume — the corrected recipe", () => {
    expect(firstTokenOk("flow feature resume <slug>")).toBe(true);
  });

  it("accepts a bare helper-basename leader", () => {
    expect(firstTokenOk("flow-state-update --phase <slug>")).toBe(true);
  });

  it("rejects an unknown leading token", () => {
    expect(firstTokenOk("rm -rf <slug>")).toBe(false);
  });
});

describe("COMMAND_WORDS", () => {
  it("includes the closed base set", () => {
    for (const w of ["git", "gh", "flow", "cd", "npm", "bun", "test"]) {
      expect(COMMAND_WORDS).toContain(w);
    }
  });

  it("includes helper basenames (e.g. flow-state-update)", () => {
    expect(COMMAND_WORDS).toContain("flow-state-update");
  });

  it("matches helperNames() for every non-base entry", () => {
    const names = helperNames();
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(COMMAND_WORDS).toContain(n);
  });
});

describe("PLACEHOLDER_ALLOWLIST", () => {
  it("carries the compound placeholder used by terminal-regression's recovery recipe", () => {
    expect(PLACEHOLDER_ALLOWLIST).toContain("<merged|gated|...>");
  });
});

// shellcheck is absent on this host; only assert behavior when present.
const describeShellcheck = hasShellcheck() ? describe : describe.skip;
describeShellcheck("shellcheckOk", () => {
  it("passes a clean fragment", () => {
    expect(shellcheckOk("git log")).toBe(true);
  });
});
