#!/usr/bin/env bun
/**
 * Maintainer-only helper: measures the always-loaded ("eager") instruction
 * set every Claude Code session pays for on turn 1 (CLAUDE.md + its
 * resolved `@import` chain, depth<=4, plus any rule file under
 * .claude/rules (any nesting) lacking a `paths:` frontmatter key — those
 * load unconditionally too), versus the "lazy" set (`paths:`-scoped rule
 * files, loaded only when a matching file is touched), plus the
 * installed-skill frontmatter cost.
 *
 * Reuses bin/lib/transcript-audit.ts's estimateStaticCost/estimateTokens/
 * estimateFrontmatterCost rather than re-deriving char/token counts.
 *
 * Usage:
 *   flow-context-budget [--repo <dir>] [--json]
 *
 * Exit codes: always 0 (a measurement tool, not a gate).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  estimateFrontmatterCost,
  estimateStaticCost,
  type FrontmatterEstimate,
  type StaticCostEstimate,
} from "./lib/transcript-audit";

const MAX_IMPORT_DEPTH = 4;

/**
 * Extracts `@path` imports from markdown, skipping inline code spans and
 * fenced code blocks — an `@AGENTS.md` mention inside a code span
 * (documentation, not a live import) must not be treated as an import.
 * Matches Claude Code's own memory-import resolution, which recognises an
 * `@path` token anywhere in a line, not just whole-line, e.g. "See
 * @README for project overview and @package.json for available npm
 * commands" imports both `README` and `package.json`.
 */
export function parseImports(markdown: string): string[] {
  const withoutFences = stripFencedBlocks(markdown);
  const imports: string[] = [];
  for (const rawLine of withoutFences.split("\n")) {
    const line = stripInlineCodeSpans(rawLine);
    for (const match of line.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      imports.push(match[1].replace(/[.,;:)]+$/, ""));
    }
  }
  return imports;
}

function stripFencedBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function stripInlineCodeSpans(line: string): string {
  return line.replace(/`[^`]*`/g, "");
}

/** Whether a rule file's frontmatter has a `paths:` key (lazy-loaded). */
export function hasPathsFrontmatter(markdown: string): boolean {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  return /^paths:/m.test(match[1]);
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function resolveImportChain(
  entryFile: string,
  repoRoot: string,
): Promise<string[]> {
  const resolved: string[] = [];
  const seen = new Set<string>();
  let frontier = [entryFile];
  let depth = 0;
  while (frontier.length > 0 && depth < MAX_IMPORT_DEPTH) {
    const next: string[] = [];
    for (const file of frontier) {
      const abs = path.isAbsolute(file) ? file : path.join(repoRoot, file);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const content = await readIfExists(abs);
      if (content === null) continue;
      if (abs !== path.join(repoRoot, "CLAUDE.md")) resolved.push(abs);
      const imports = parseImports(content);
      for (const imp of imports) {
        const importAbs = path.isAbsolute(imp)
          ? imp
          : path.join(path.dirname(abs), imp);
        next.push(importAbs);
      }
    }
    frontier = next;
    depth += 1;
  }
  return resolved;
}

async function findRuleFiles(repoRoot: string): Promise<string[]> {
  const rulesDir = path.join(repoRoot, ".claude", "rules");
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  }
  await walk(rulesDir);
  return out;
}

export async function resolveAlwaysLoaded(repoRoot: string): Promise<{
  alwaysLoaded: StaticCostEstimate;
  lazy: StaticCostEstimate;
  skillFrontmatter: FrontmatterEstimate;
}> {
  const claudeMd = path.join(repoRoot, "CLAUDE.md");
  const eagerPaths: string[] = [];
  const claudeMdContent = await readIfExists(claudeMd);
  if (claudeMdContent !== null) {
    eagerPaths.push(claudeMd);
    const chain = await resolveImportChain(claudeMd, repoRoot);
    eagerPaths.push(...chain);
  }

  const ruleFiles = await findRuleFiles(repoRoot);
  const lazyPaths: string[] = [];
  for (const ruleFile of ruleFiles) {
    const content = await readIfExists(ruleFile);
    if (content === null) continue;
    if (hasPathsFrontmatter(content)) {
      lazyPaths.push(ruleFile);
    } else {
      eagerPaths.push(ruleFile);
    }
  }

  const alwaysLoaded = await estimateStaticCost([...new Set(eagerPaths)]);
  const lazy = await estimateStaticCost(lazyPaths);
  const skillFrontmatter = await estimateFrontmatterCost(
    path.join(repoRoot, "skills"),
  );

  return { alwaysLoaded, lazy, skillFrontmatter };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let repoRoot = process.cwd();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") {
      repoRoot = path.resolve(args[++i] ?? repoRoot);
    } else if (args[i] === "--json") {
      json = true;
    }
  }

  const result = await resolveAlwaysLoaded(repoRoot);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log(
    `Always-loaded: ${result.alwaysLoaded.totals.chars} chars / ${result.alwaysLoaded.totals.lines} lines / ~${result.alwaysLoaded.totals.estTokens} tokens across ${result.alwaysLoaded.files.length} file(s):`,
  );
  for (const f of result.alwaysLoaded.files) {
    console.log(`  ${f.path} (${f.chars} chars)`);
  }
  console.log(
    `Lazy (paths:-scoped): ${result.lazy.totals.chars} chars across ${result.lazy.files.length} file(s).`,
  );
  console.log(
    `Skill frontmatter total: ~${result.skillFrontmatter.total} tokens.`,
  );
  process.exit(0);
}

if (import.meta.main) {
  main();
}
