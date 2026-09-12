/**
 * Regression test for stack-skill frontmatter discipline (Item 20).
 *
 * Each `skills/stacks/<name>/SKILL.md` description must contain explicit
 * `TRIGGER when` and `SKIP when` markers so Claude Code's skill matcher
 * has both positive signals and competing-stack anti-signals to gate on.
 * Without the anti-triggers, all three stack skills would auto-load in
 * unrelated repos.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// `flow-cloudflare-pages` is the one `skills/stacks/` directory deliberately
// absent from this list: its frontmatter sets `disable-model-invocation: true`,
// so Claude Code never puts it in the skill listing and TRIGGER/SKIP markers
// cannot route it. The coverage test at the bottom of this file asserts that
// exemption mechanically, so a NEW stack skill cannot be omitted here silently.
const STACK_SKILLS = [
  "flow-svelte",
  "flow-supabase-project",
  "flow-tailwind-shadcn",
  "flow-testing-svelte",
] as const;

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function readFrontmatterDescription(skill: string): string {
  const skillPath = path.join(repoRoot, "skills", "stacks", skill, "SKILL.md");
  const content = fs.readFileSync(skillPath, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`${skill}: no YAML frontmatter block found`);
  const frontmatter = match[1]!;
  const descMatch = frontmatter.match(/description:\s*>-?\s*\n([\s\S]+)/);
  if (!descMatch)
    throw new Error(`${skill}: no folded 'description:' block found`);
  // Mimic YAML folded-scalar (`>-`) whitespace handling: collapse runs of
  // whitespace (including the line continuations and leading indent) into
  // single spaces so the assertions read against the semantic content,
  // not the source-file line wrapping.
  return descMatch[1]!.replace(/\s+/g, " ").trim();
}

describe("stack-skill frontmatter", () => {
  for (const skill of STACK_SKILLS) {
    describe(skill, () => {
      it("description names explicit TRIGGER signals", () => {
        const desc = readFrontmatterDescription(skill);
        expect(desc).toMatch(/TRIGGER when/);
      });

      it("description names explicit SKIP anti-signals", () => {
        const desc = readFrontmatterDescription(skill);
        expect(desc).toMatch(/SKIP when/);
      });
    });
  }

  // Without this, a newly added stack skill can be omitted from
  // STACK_SKILLS and silently escape both assertions above — the whole
  // file would stay green while the new skill auto-loads in unrelated
  // repos, which is exactly the failure the suite exists to prevent.
  it("every skills/stacks/ directory is either covered or exempt", () => {
    const stacksDir = path.join(repoRoot, "skills", "stacks");
    const dirs = fs
      .readdirSync(stacksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const dir of dirs) {
      if ((STACK_SKILLS as readonly string[]).includes(dir)) continue;

      const skillPath = path.join(stacksDir, dir, "SKILL.md");
      const content = fs.readFileSync(skillPath, "utf8");
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = match ? match[1]! : "";
      expect(
        /^disable-model-invocation:\s*true\s*$/m.test(frontmatter),
        `skills/stacks/${dir} is neither listed in STACK_SKILLS nor sets ` +
          "`disable-model-invocation: true` in its frontmatter. Add it to " +
          "STACK_SKILLS (and give its description TRIGGER/SKIP markers), or " +
          "set disable-model-invocation if it should never enter the skill " +
          "listing.",
      ).toBe(true);
    }
  });
});
