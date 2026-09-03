import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural lint for the narrowed "raw `claude -p`" rule, so it cannot
 * regress to either pole: back to a blanket "never `claude -p`" (which
 * would make `flow-claude-headless` itself contradict the documented
 * rule), or forward to a silent, unguarded relaxation (a prose mention of
 * `claude -p` with no pointer to the sanctioned helper).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const SKILL_MD_PATH = path.join(
  REPO_ROOT,
  "skills/pipeline/flow-pipeline/SKILL.md",
);
const AGENTS_MD_PATH = path.join(REPO_ROOT, "AGENTS.md");
const HEADLESS_REFERENCE_PATH = path.join(
  REPO_ROOT,
  "skills/pipeline/flow-pipeline/references/headless-claude.md",
);
const ASSESSMENT_PATH = path.join(
  REPO_ROOT,
  "docs/nested-subagents-assessment.md",
);

describe("headless-claude rule lint", () => {
  it("SKILL.md's Hard-rules blockquote names flow-claude-headless alongside raw `claude -p`, and drops the old blanket sentence", () => {
    const content = fs.readFileSync(SKILL_MD_PATH, "utf8");
    const lines = content.split("\n");
    const headingIdx = lines.findIndex((l) => l.trim() === "# Hard rules");
    let i = headingIdx + 1;
    while (lines[i].trim() === "") i++;
    const blockLines: string[] = [];
    while (lines[i]?.startsWith(">")) {
      blockLines.push(lines[i]);
      i++;
    }
    const blockquote = blockLines.join("\n");
    expect(
      blockquote.includes("raw `claude -p`"),
      "skills/pipeline/flow-pipeline/SKILL.md's Hard-rules opening " +
        "blockquote must contain 'raw `claude -p`' (the narrowed rule, not " +
        "a blanket prohibition).",
    ).toBe(true);
    expect(
      blockquote.includes("flow-claude-headless"),
      "skills/pipeline/flow-pipeline/SKILL.md's Hard-rules opening " +
        "blockquote must name 'flow-claude-headless' as the sanctioned " +
        "site alongside the raw `claude -p` prohibition.",
    ).toBe(true);
    expect(
      content.includes("Never spawn a separate `claude -p` subprocess"),
      "skills/pipeline/flow-pipeline/SKILL.md must no longer contain the " +
        "old blanket sentence 'Never spawn a separate `claude -p` " +
        "subprocess' — it has been narrowed to 'raw `claude -p`' plus the " +
        "flow-claude-headless carve-out.",
    ).toBe(false);
  });

  it("AGENTS.md's Supervisor and sub-skills section names flow-claude-headless and 'raw'", () => {
    const content = fs.readFileSync(AGENTS_MD_PATH, "utf8");
    const sections = content.split(/^## /m);
    const section = sections.find((s) =>
      s.startsWith("Supervisor and sub-skills"),
    );
    expect(
      section,
      "AGENTS.md must have a '## Supervisor and sub-skills' section.",
    ).toBeDefined();
    expect(section?.includes("flow-claude-headless")).toBe(true);
    expect(section?.includes("raw")).toBe(true);
  });

  it("references/headless-claude.md exists and names flow-claude-headless, FLOW_SLUG, TMUX_PANE, and #618", () => {
    expect(fs.existsSync(HEADLESS_REFERENCE_PATH)).toBe(true);
    const content = fs.readFileSync(HEADLESS_REFERENCE_PATH, "utf8");
    for (const token of [
      "flow-claude-headless",
      "FLOW_SLUG",
      "TMUX_PANE",
      "#618",
    ]) {
      expect(
        content.includes(token),
        `skills/pipeline/flow-pipeline/references/headless-claude.md must ` +
          `mention '${token}'.`,
      ).toBe(true);
    }
  });

  it("docs/nested-subagents-assessment.md has a '## Headless' section referencing #618", () => {
    const content = fs.readFileSync(ASSESSMENT_PATH, "utf8");
    expect(/^## Headless/m.test(content)).toBe(true);
    expect(content.includes("#618")).toBe(true);
  });
});
