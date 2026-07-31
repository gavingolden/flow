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
 * paths` canonical chain). Run LAST — it reads failure-recovery.md after
 * Task 5 moved the four no-retry-escalation fences into it.
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
  it("every command-word-led backtick cell shell-parses and passes firstTokenOk", () => {
    const spans = extractCapTableBacktickSpans(failureRecoveryMd);
    const cells = spans.filter((s) =>
      COMMAND_WORDS.includes(s.trim().split(/\s+/)[0]),
    );
    expect(cells.length).toBeGreaterThanOrEqual(5);
    for (const cell of cells) {
      expect(bashParses(substitutePlaceholders(cell)), cell).toBe(true);
      expect(firstTokenOk(cell), cell).toBe(true);
    }
  });

  it("[negative] flow new fails firstTokenOk even inside a cap-table-shaped cell", () => {
    expect(firstTokenOk("flow new <slug>")).toBe(false);
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
