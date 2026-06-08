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

const STACK_SKILLS = ["svelte", "supabase-project", "tailwind-shadcn"] as const;

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
});
