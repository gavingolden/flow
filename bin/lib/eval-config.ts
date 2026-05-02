/**
 * Resolve the skill set used for one eval config.
 *
 * - `pr7` → the live `<flow-source>/skills/pipeline/` directory. Frontmatter
 *   `model:` and `effort:` keys are present, so Claude Code will use the tuned
 *   models PR 7 picked.
 * - `defaults` → a per-run tmpdir mirror of the same skills with `model:` and
 *   `effort:` stripped from each SKILL.md's YAML frontmatter, so Claude Code
 *   falls back to its built-in default model + effort.
 *
 * Mirrors are built fresh per `flow eval` invocation (caller passes the
 * destination path) so we never mutate the user's `~/.claude/skills/` and
 * never carry stale state between runs.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Config = "pr7" | "defaults";

/**
 * The pipeline skills the eval harness mirrors / symlinks into each scratch
 * repo. Exported because both `eval-config.buildSkillSet` (mirror builder)
 * and `eval-runner.symlinkSkills` (per-repo symlink wiring) need to agree on
 * the set; defining it once here keeps the two in lockstep.
 */
export const SKILL_NAMES = [
  "flow-pipeline",
  "product-planning",
  "new-feature",
  "verify",
  "pr-review",
];

/**
 * Returns a directory containing one entry per pipeline skill, suitable for
 * being symlinked under `<scratch>/.claude/skills/<name>` by the runner.
 *
 * For `pr7`, that directory is the live `skills/pipeline/` itself — no copy
 * needed. For `defaults`, we materialise a fresh mirror at `mirrorDest`.
 */
export function buildSkillSet(
  config: Config,
  flowSource: string,
  mirrorDest: string,
): string {
  const live = path.join(flowSource, "skills", "pipeline");
  if (!fs.existsSync(live)) {
    throw new Error(`flow source skills missing: ${live}`);
  }
  if (config === "pr7") return live;

  fs.mkdirSync(mirrorDest, { recursive: true });
  for (const name of SKILL_NAMES) {
    const srcSkill = path.join(live, name);
    if (!fs.existsSync(srcSkill)) continue;
    const dstSkill = path.join(mirrorDest, name);
    fs.cpSync(srcSkill, dstSkill, { recursive: true, dereference: true });
    const dstSkillMd = path.join(dstSkill, "SKILL.md");
    if (fs.existsSync(dstSkillMd)) {
      const original = fs.readFileSync(dstSkillMd, "utf8");
      fs.writeFileSync(dstSkillMd, stripModelAndEffort(original));
    }
  }
  return mirrorDest;
}

/**
 * Strip `model:` and `effort:` lines from a SKILL.md's YAML frontmatter.
 * Leaves the body untouched and preserves frontmatter formatting (line breaks,
 * other keys) so a side-by-side diff between live and mirrored skills shows
 * only the dropped lines.
 */
export function stripModelAndEffort(skillMd: string): string {
  // Frontmatter must be the first --- delimited block.
  if (!skillMd.startsWith("---\n") && !skillMd.startsWith("---\r\n")) return skillMd;
  const end = skillMd.indexOf("\n---", 4);
  if (end === -1) return skillMd;

  const frontmatter = skillMd.slice(4, end);
  const rest = skillMd.slice(end);
  const lines = frontmatter.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    // A new top-level YAML key resets the skipping mode (frontmatter is one
    // level deep — no nested objects under model/effort).
    if (/^[A-Za-z_][\w-]*:/.test(line)) {
      skipping = /^(model|effort):/.test(line);
    }
    if (!skipping) kept.push(line);
  }
  return "---\n" + kept.join("\n") + rest;
}
