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

  it("guards every `claude -p` mention with a context-boundary token in its section", () => {
    // The Tier-2 leaf subprocess (`claude -p /deep-research`) is permitted ONLY
    // in a standalone context — never inside the /flow-pipeline supervisor or
    // the #354 discovery sub-agent. The boundary is enforced at runtime by the
    // CLAUDE_CODE_CHILD_SESSION / FLOW_PIPELINE guard. This lint pins the doc to
    // that contract: any `claude -p` mention must be co-located (same `## `
    // section) with at least one guard token, so an UNGUARDED `claude -p` —
    // documenting a Tier-2 invocation without its standalone-only guard — goes
    // red here instead of silently shipping a no-nested-LLM-boundary breach.
    const GUARD_TOKENS = ["CLAUDE_CODE_CHILD_SESSION", "FLOW_PIPELINE"];
    // Split on `## ` section headings; each chunk is one section's body. A
    // `claude -p` in a section with no guard token is a violation.
    const sections = content.split(/^## /m);
    const unguarded = sections.filter(
      (section) =>
        section.includes("claude -p") &&
        !GUARD_TOKENS.some((token) => section.includes(token)),
    );
    expect(
      unguarded,
      "Every `claude -p` mention in skills/universal/flow-research/SKILL.md must " +
        "appear in the same `## ` section as a context-boundary guard token " +
        `(${GUARD_TOKENS.join(" / ")}) — the Tier-2 leaf subprocess is ` +
        "standalone-only and forbidden inside the supervisor / discovery " +
        "sub-agent. Found " +
        unguarded.length +
        " section(s) with an unguarded `claude -p`.",
    ).toEqual([]);
  });

  it("retains the three-tier fallback tokens (a silent drop goes red)", () => {
    // A regression that removes the Tier-2 fallback must fail loudly rather than
    // quietly reverting to the tier-3-only shape. Anchor on the load-bearing
    // tokens the prose must keep.
    for (const token of [
      "/deep-research",
      "CLAUDE_CODE_CHILD_SESSION",
      "FLOW_PIPELINE",
      "research.deepResearchFallback",
    ]) {
      expect(
        content.includes(token),
        `skills/universal/flow-research/SKILL.md must mention '${token}' — it is ` +
          "load-bearing for the three-tier agy-absent fallback (Section 6). A " +
          "silent drop would erase the Tier-2 path or its guard/config gate.",
      ).toBe(true);
    }
  });
});
