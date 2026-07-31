import { describe, expect, it, vi } from "vitest";
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

  it("does not swallow a two-line fragment where a non-placeholder `<` on line 1 and a `>` redirect on line 2 would otherwise pair up", () => {
    const cmd =
      "IFS=$'\\t' read -r A B < <(jq -r '[.a,.b] | @tsv' \"$FILE\")\njq '.x' \"$FILE\" > \"$OUT\"";
    const substituted = substitutePlaceholders(cmd);
    expect(substituted).toContain("read -r A B");
    expect(substituted).toContain("jq -r '[.a,.b] | @tsv'");
    expect(substituted).toContain("jq '.x'");
    expect(substituted).toContain('> "$OUT"');
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

describe("hasShellcheck", () => {
  it("returns a boolean without throwing regardless of whether shellcheck is installed", () => {
    // Runs unconditionally under CI so an always-true/always-false
    // regression in hasShellcheck() itself is not undetectable simply
    // because this host happens to lack shellcheck.
    expect(typeof hasShellcheck()).toBe("boolean");
  });
});

// shellcheck is absent on this host; only assert real-binary behavior when present.
const describeShellcheck = hasShellcheck() ? describe : describe.skip;
describeShellcheck("shellcheckOk", () => {
  it("passes a clean fragment", () => {
    expect(shellcheckOk("git log")).toBe(true);
  });

  it("fails a fragment with a real shellcheck error", () => {
    // SC2086: unquoted variable expansion — a genuine shellcheck finding,
    // not a bash syntax error, so this exercises shellcheckOk specifically
    // rather than duplicating bashParses coverage.
    expect(shellcheckOk('VAR="a b"\necho $VAR')).toBe(false);
  });
});

describe("shellcheckOk — negative fixture independent of a real shellcheck install", () => {
  it("returns false when the underlying shellcheck process reports a non-zero exit, without requiring shellcheck on this host", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawnSync: (cmd: string, ...rest: unknown[]) => {
          if (cmd === "shellcheck") {
            return { status: 1, error: undefined } as ReturnType<
              typeof actual.spawnSync
            >;
          }
          return (actual.spawnSync as (...a: unknown[]) => unknown)(
            cmd,
            ...rest,
          );
        },
      };
    });
    const mocked = await import("./command-lint");
    expect(mocked.shellcheckOk("this is not valid shell $(")).toBe(false);
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });
});
