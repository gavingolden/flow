import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural lint for `skills/universal/flow-research/SKILL.md`.
 *
 * The skill's load-bearing `AGENTS.md` constraint is "No nested LLM": Claude
 * orchestrates only, and every token-spending model call fans out to `agy`
 * subprocesses via `flow-delegate` — never a nested Claude sub-agent. The
 * SKILL.md Constraints section asserts this rule is "enforced by a structural
 * lint on this file"; this test is that lint. It reads the SKILL.md and asserts
 * the procedure spawns no Claude fan-out tool: no `subagent_type` field and no
 * `Task(` invocation anywhere in the file. A future edit that reaches for a
 * nested sub-agent (and documents it in the SKILL.md) goes red on `npm run
 * verify` instead of silently shipping a doc whose self-claimed enforcement
 * doesn't exist.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLOW_RESEARCH_SKILL_MD_PATH = path.resolve(
  HERE,
  "..",
  "skills",
  "universal",
  "flow-research",
  "SKILL.md",
);
const content = fs.readFileSync(FLOW_RESEARCH_SKILL_MD_PATH, "utf8");

describe("flow-research SKILL.md no-nested-LLM lint", () => {
  it("contains no subagent_type or Task( token (the no-nested-LLM constraint)", () => {
    const offenders = [...content.matchAll(/subagent_type|\bTask\(/g)].map(
      (m) => m[0],
    );
    expect(
      offenders,
      "skills/universal/flow-research/SKILL.md must contain NO 'subagent_type' " +
        "or 'Task(' token — the load-bearing no-nested-LLM constraint requires " +
        "every token-spending model call to fan out to `agy` via `flow-delegate`, " +
        "never a nested Claude sub-agent. Found: " +
        JSON.stringify(offenders),
    ).toEqual([]);
  });

  it("self-references this lint so the SKILL.md claim stays anchored", () => {
    expect(
      content.includes("flow-research-skill-lint.test.ts"),
      "skills/universal/flow-research/SKILL.md must name " +
        "'flow-research-skill-lint.test.ts' so the Constraints-section claim " +
        "that the no-nested-LLM rule is lint-enforced points at the real lint " +
        "(this file). If you rename this test, update the SKILL.md reference in " +
        "the same commit.",
    ).toBe(true);
  });
});
