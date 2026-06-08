#!/usr/bin/env bun
/**
 * Validates internal markdown links and SKILL.md frontmatter.
 *
 * Usage:
 *   flow-md-validate <path>
 *
 * Exit codes:
 *   0 — clean
 *   1 — violations (printed to stdout)
 *   2 — usage / I-O error (printed to stderr)
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ViolationKind =
  | "broken-link-target"
  | "broken-link-anchor"
  | "missing-frontmatter"
  | "missing-frontmatter-name";

export type Violation = {
  file: string;
  line: number;
  kind: ViolationKind;
  detail: string;
};

const IGNORE_DIRS = new Set(["node_modules", ".git", ".flow-tmp"]);
const EXTERNAL_RE = /^(https?|mailto|tel|ftp):/i;
const LINK_RE = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/;

export function walkMarkdownFiles(root: string): string[] {
  const stat = fs.statSync(root);
  if (stat.isFile()) return root.endsWith(".md") ? [root] : [];
  const out: string[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      out.push(...walkMarkdownFiles(path.join(root, e.name)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(path.join(root, e.name));
    }
  }
  return out.sort();
}

/**
 * GitHub-style heading slug. Canonical algorithm:
 *   1. strip emphasis/code markers (`* ~`); keep underscores
 *   2. lowercase
 *   3. strip non-word, non-space, non-hyphen chars
 *   4. spaces → hyphen (no collapse — GitHub preserves repeated dashes)
 *
 * Matching GitHub exactly is the goal: false positives (we say "broken"
 * when GitHub navigates fine) would block valid PRs. False negatives (we
 * miss a real break) are recoverable through review.
 */
export function slugifyHeading(text: string): string {
  return text
    .replace(/[`*~]/g, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/ /g, "-");
}

/**
 * Replace fenced code blocks and inline-code spans with whitespace, preserving
 * line numbers and column offsets. Required because docs like `architecture.md`
 * carry code samples whose `[…](…)` content would otherwise trip the link
 * scanner.
 */
export function stripCode(source: string): string {
  const lines = source.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence;
      lines[i] = lines[i].replace(/\S/g, " ");
      continue;
    }
    if (inFence) {
      lines[i] = lines[i].replace(/\S/g, " ");
    } else {
      lines[i] = lines[i].replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    }
  }
  return lines.join("\n");
}

export function extractHeadings(
  source: string,
): { line: number; slug: string }[] {
  // Track fenced-code state ourselves; do NOT call stripCode, which would
  // wipe inline-code spans from heading text (e.g. `## \`name\` Error` would
  // collapse to "Error" and lose the slug).
  const lines = source.split("\n");
  const counts = new Map<string, number>();
  const out: { line: number; slug: string }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    const base = slugifyHeading(m[1]);
    if (!base) continue;
    const n = counts.get(base) ?? 0;
    out.push({ line: i + 1, slug: n === 0 ? base : `${base}-${n}` });
    counts.set(base, n + 1);
  }
  return out;
}

export function extractLinks(
  source: string,
): { line: number; raw: string; isImage: boolean }[] {
  const stripped = stripCode(source);
  const out: { line: number; raw: string; isImage: boolean }[] = [];
  let line = 1;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(stripped)) !== null) {
    for (let i = lastIdx; i < m.index; i++) if (stripped[i] === "\n") line++;
    lastIdx = m.index;
    out.push({ line, raw: m[2], isImage: m[1] === "!" });
  }
  return out;
}

export function parseFrontmatter(source: string): string | null {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) return null;
  const after = source.slice(source.startsWith("---\r\n") ? 5 : 4);
  const end = after.search(/\n---(?:\s|$)/);
  if (end === -1) return null;
  return after.slice(0, end);
}

export function validateFile(absPath: string): Violation[] {
  const violations: Violation[] = [];
  const source = fs.readFileSync(absPath, "utf8");

  if (path.basename(absPath) === "SKILL.md") {
    const fm = parseFrontmatter(source);
    if (fm === null) {
      violations.push({
        file: absPath,
        line: 1,
        kind: "missing-frontmatter",
        detail: "SKILL.md missing YAML frontmatter",
      });
    } else if (!/^name:\s*\S/m.test(fm)) {
      violations.push({
        file: absPath,
        line: 1,
        kind: "missing-frontmatter-name",
        detail: "SKILL.md frontmatter missing field: name",
      });
    }
  }

  const fileDir = path.dirname(absPath);
  const ownHeadings = extractHeadings(source);

  for (const { line, raw, isImage } of extractLinks(source)) {
    if (isImage) continue;
    if (EXTERNAL_RE.test(raw)) continue;

    const hashIdx = raw.indexOf("#");
    const linkPath = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
    const anchor = hashIdx === -1 ? null : raw.slice(hashIdx + 1);

    if (linkPath === "") {
      if (anchor && !ownHeadings.some((h) => h.slug === anchor)) {
        violations.push({
          file: absPath,
          line,
          kind: "broken-link-anchor",
          detail: `#${anchor}`,
        });
      }
      continue;
    }

    const target = path.resolve(fileDir, linkPath);
    if (!fs.existsSync(target)) {
      violations.push({
        file: absPath,
        line,
        kind: "broken-link-target",
        detail: linkPath,
      });
      continue;
    }

    if (anchor && target.endsWith(".md")) {
      const targetHeadings = extractHeadings(fs.readFileSync(target, "utf8"));
      if (!targetHeadings.some((h) => h.slug === anchor)) {
        violations.push({
          file: absPath,
          line,
          kind: "broken-link-anchor",
          detail: `${linkPath}#${anchor}`,
        });
      }
    }
  }

  return violations;
}

export type RunReport = {
  fileCount: number;
  linkCount: number;
  violations: Violation[];
};

export function runValidation(target: string): RunReport {
  const files = walkMarkdownFiles(target);
  const violations: Violation[] = [];
  let linkCount = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    linkCount += extractLinks(source).filter(
      (l) => !l.isImage && !EXTERNAL_RE.test(l.raw),
    ).length;
    violations.push(...validateFile(file));
  }
  violations.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
  return { fileCount: files.length, linkCount, violations };
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    const usage =
      "Usage: flow-md-validate <path>\n\n" +
      "Validates internal markdown links (relative paths + heading anchors) and\n" +
      "SKILL.md frontmatter presence.\n\n" +
      "Exit codes: 0 clean, 1 violations, 2 usage/I-O error.";
    if (argv[0] === "--help" || argv[0] === "-h") {
      console.log(usage);
      return 0;
    }
    console.error(usage);
    return 2;
  }
  if (argv.length > 1) {
    console.error("Error: too many arguments. Pass exactly one path.");
    return 2;
  }
  const target = path.resolve(argv[0]);
  if (!fs.existsSync(target)) {
    console.error(`Error: path does not exist: ${argv[0]}`);
    return 2;
  }
  const report = runValidation(target);
  const root = fs.statSync(target).isDirectory()
    ? target
    : path.dirname(target);
  for (const v of report.violations) {
    const rel = path.relative(root, v.file);
    console.log(`${rel}:${v.line}: ${v.kind}: ${v.detail}`);
  }
  console.log(
    `flow-md-validate: ${report.fileCount} files, ${report.linkCount} internal links, ${report.violations.length} violations`,
  );
  return report.violations.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
