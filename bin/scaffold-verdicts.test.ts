import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintVerdicts, parseVerdictTable } from "./lib/scaffold-verdicts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const DOC_PATH = path.join(REPO_ROOT, "docs", "eval", "scaffold-verdicts.md");

const FIXTURE_MD = `# fixture

## Verdicts

| Candidate | Outcome | Scope | Decision metric | Before report | After report | Note |
| --- | --- | --- | --- | --- | --- | --- |
| \`candidate-a\` | remove | full | metric-a | docs/eval/scaffold-verdicts.md | docs/eval/scaffold-verdicts.md | note-a |
| \`candidate-b\` | TBD | bogus-scope | | missing/before.json | missing/after.json | |

## Other section
not a table
`;

describe("parseVerdictTable", () => {
  it("parses rows with the right fields", () => {
    const rows = parseVerdictTable(FIXTURE_MD);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      candidate: "candidate-a",
      outcome: "remove",
      scope: "full",
      decisionMetric: "metric-a",
      beforeReport: "docs/eval/scaffold-verdicts.md",
      afterReport: "docs/eval/scaffold-verdicts.md",
      note: "note-a",
    });
    expect(rows[1].candidate).toBe("candidate-b");
    expect(rows[1].outcome).toBe("TBD");
  });
});

describe("lintVerdicts", () => {
  it("flags TBD outcome, bad scope, and missing report paths", () => {
    const rows = parseVerdictTable(FIXTURE_MD);
    const misses = lintVerdicts(rows, REPO_ROOT);
    expect(
      misses.some((m) => m.includes("candidate-b") && m.includes("TBD")),
    ).toBe(true);
    expect(misses.some((m) => m.includes("bogus-scope"))).toBe(true);
    expect(misses.some((m) => m.includes("missing/before.json"))).toBe(true);
    expect(misses.some((m) => m.includes("missing/after.json"))).toBe(true);
    // exactly-3-rows check also fires since the fixture only has 2
    expect(misses.some((m) => m.includes("exactly 3"))).toBe(true);
  });
});

describe("committed docs/eval/scaffold-verdicts.md", () => {
  const md = fs.readFileSync(DOC_PATH, "utf8");
  const rows = parseVerdictTable(md);

  it("parses to exactly 3 rows with the expected candidate ids", () => {
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.candidate)).toEqual([
      "verify-loop-subagent-isolation",
      "haiku-gatekeeper",
      "checkpoint-pending-clear",
    ]);
  });

  const anyTBD = rows.some((r) => r.outcome === "TBD" || r.scope === "TBD");

  describe.skipIf(anyTBD)("once every row is filled", () => {
    it("has no lint misses", () => {
      expect(lintVerdicts(rows, REPO_ROOT)).toEqual([]);
    });
  });
});
