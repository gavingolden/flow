import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { NEXT_ACTION_BY_REASON } from "./flow-gate-summary";
import {
  bashParses,
  COMMAND_WORDS,
  firstTokenOk,
  hasShellcheck,
  shellcheckOk,
  substitutePlaceholders,
} from "./lib/command-lint";

/**
 * Coherence lint over the failure docs: subset tag parity between
 * `references/failure-recovery.md`'s cap table and `NEXT_ACTION_BY_REASON`,
 * plus command validity over the cap table's command cells and every
 * ```bash fence (failure-recovery.md's + SKILL.md's retained `# Failure
 * paths` canonical chain). Reads failure-recovery.md, which holds the
 * three no-retry-escalation fences moved out of SKILL.md.
 */

const FAILURE_RECOVERY_PATH = path.resolve(
  __dirname,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "references",
  "failure-recovery.md",
);
const SKILL_MD_PATH = path.resolve(
  __dirname,
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
  "SKILL.md",
);

const failureRecoveryMd = fs.readFileSync(FAILURE_RECOVERY_PATH, "utf8");
const skillMd = fs.readFileSync(SKILL_MD_PATH, "utf8");

/**
 * Extract every `NEEDS HUMAN: <tag>` occurrence from cap-table rows only
 * (lines starting with `|`) — scoping to table rows keeps the resume-tree's
 * hard-wrapped `pr-closed-without-merge` prose mention out of the
 * extractor. Strips a trailing backtick (via the closing-backtick anchor),
 * a `<...>` argument, and any `:`-suffix.
 */
function extractCapTableTags(md: string): string[] {
  const tags: string[] = [];
  for (const line of md.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const re = /NEEDS HUMAN: ([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const firstToken = m[1].trim().split(/\s+/)[0];
      const tag = firstToken.split(":")[0];
      tags.push(tag);
    }
  }
  return tags;
}

function extractCapTableBacktickSpans(md: string): string[] {
  const spans: string[] = [];
  for (const line of md.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const re = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) spans.push(m[1]);
  }
  return spans;
}

/**
 * Select command-SHAPED backtick cells WITHOUT presupposing the answer
 * (i.e. without filtering on `COMMAND_WORDS`, the same vocabulary
 * `firstTokenOk` asserts against below — filtering on it here made the
 * selector and the assertion share a predicate, so a cell led by an
 * unknown/dangerous token, e.g. `rm -rf` or `curl ... | sh`, was DROPPED
 * from the corpus instead of FAILED). A span is command-shaped when either:
 * (a) its first token is a recognised command word (`flow`, `gh`, `git`, a
 * `bin/*.ts` helper name, ...) — covers the normal recipe cells, or
 * (b) it has 2+ tokens and looks like an invocation regardless of whether
 * the leading token is recognised — a flag-bearing second token (`-rf`,
 * `--force`) or a pipe/`&&` chain. This still excludes bare status/phase
 * literals (`ci-wait`, `phase: cancelled`) and prose fragments (`kill
 * this`) that have neither a recognised leading word nor flag/pipe syntax.
 */
function looksCommandShaped(span: string): boolean {
  const trimmed = span.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0];
  if (COMMAND_WORDS.includes(first)) return true;
  if (
    tokens.length >= 2 &&
    (tokens[1].startsWith("-") ||
      trimmed.includes("|") ||
      trimmed.includes("&&"))
  ) {
    return true;
  }
  return false;
}

function extractBashFences(md: string): string[] {
  const re = /```bash\n([\s\S]*?)\n```/g;
  const fences: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) fences.push(m[1]);
  return fences;
}

/** Slice from `# Failure paths` to the next top-level (`# `) heading. */
function sliceFailurePathsSection(md: string): string {
  const idx = md.indexOf("\n# Failure paths");
  if (idx === -1)
    throw new Error("`# Failure paths` heading not found in SKILL.md");
  const rest = md.slice(idx + 1);
  const nextHeadingIdx = rest.slice(2).search(/\n# [^#]/);
  return nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx + 2);
}

describe("failure docs lint — cap-table tag parity (subset rule)", () => {
  it("every cap-table NEEDS HUMAN tag is a NEXT_ACTION_BY_REASON key", () => {
    const tags = extractCapTableTags(failureRecoveryMd);
    expect(tags.length).toBeGreaterThanOrEqual(17);
    const naKeys = new Set(Object.keys(NEXT_ACTION_BY_REASON));
    for (const tag of tags) {
      expect(
        naKeys.has(tag),
        `cap-table tag '${tag}' has no NEXT_ACTION_BY_REASON entry`,
      ).toBe(true);
    }
  });

  it("[negative] a fabricated cap-table tag would fail parity", () => {
    const naKeys = new Set(Object.keys(NEXT_ACTION_BY_REASON));
    expect(naKeys.has("this-tag-does-not-exist")).toBe(false);
  });
});

describe("failure docs lint — cap-table command cells", () => {
  it("every command-shaped backtick cell shell-parses and passes firstTokenOk", () => {
    const spans = extractCapTableBacktickSpans(failureRecoveryMd);
    const cells = spans.filter(looksCommandShaped);
    // Measured at 12 cells on this corpus; floor left with a little slack
    // rather than pinned exactly, per fix C's guidance in pr-review #506.
    expect(cells.length).toBeGreaterThanOrEqual(10);
    for (const cell of cells) {
      expect(bashParses(substitutePlaceholders(cell)), cell).toBe(true);
      expect(firstTokenOk(cell), cell).toBe(true);
    }
  });

  it("[negative] flow new fails firstTokenOk even inside a cap-table-shaped cell", () => {
    expect(firstTokenOk("flow new <slug>")).toBe(false);
  });

  it("[negative] an unknown-token command cell with flag syntax is selected as command-shaped, not silently dropped", () => {
    expect(looksCommandShaped("rm -rf <path>")).toBe(true);
    expect(firstTokenOk("rm -rf <path>")).toBe(false);
  });

  it("[negative] bare status/phase literals and prose are not swept in as command-shaped", () => {
    expect(looksCommandShaped("ci-wait")).toBe(false);
    expect(looksCommandShaped("kill this")).toBe(false);
  });
});

describe("failure docs lint — fenced blocks", () => {
  it("failure-recovery.md carries >= 4 ```bash fences, all shell-parseable", () => {
    const fences = extractBashFences(failureRecoveryMd);
    expect(fences.length).toBeGreaterThanOrEqual(4);
    for (const fence of fences) {
      expect(bashParses(substitutePlaceholders(fence))).toBe(true);
    }
  });

  it("SKILL.md's `# Failure paths` section retains >= 1 shell-parseable ```bash fence", () => {
    const section = sliceFailurePathsSection(skillMd);
    const fences = extractBashFences(section);
    expect(fences.length).toBeGreaterThanOrEqual(1);
    for (const fence of fences) {
      expect(bashParses(substitutePlaceholders(fence))).toBe(true);
    }
  });

  it("[negative] an unbalanced fence fails to parse", () => {
    expect(bashParses(substitutePlaceholders("git fetch |"))).toBe(false);
  });
});

const describeShellcheck = hasShellcheck() ? describe : describe.skip;
describeShellcheck("failure docs lint — optional shellcheck", () => {
  it("every substituted fence passes shellcheck --severity=error", () => {
    const fences = [
      ...extractBashFences(failureRecoveryMd),
      ...extractBashFences(sliceFailurePathsSection(skillMd)),
    ];
    for (const fence of fences) {
      expect(shellcheckOk(substitutePlaceholders(fence))).toBe(true);
    }
  });
});
