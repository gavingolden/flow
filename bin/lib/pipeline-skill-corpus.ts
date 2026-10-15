/**
 * Single reader of the flow-pipeline supervisor skill for tests. The skill is
 * a core `SKILL.md` plus per-step docs under `references/phases/` and a
 * `references/hard-rules-detail.md`; the corpus is those files and NOTHING
 * else (the 16 older `references/*.md` stay out so count-sensitive assertions
 * keep counting what they always counted). On a tree with no `phases/`
 * directory the corpus is `SKILL.md` unchanged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PIPELINE_SKILL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  "pipeline",
  "flow-pipeline",
);

const PHASES_DIR = "references/phases";
const HARD_RULES_DETAIL = "references/hard-rules-detail.md";
const PHASE_DOC = /references\/phases\/[\w.-]+\.md/g;

export function readPipelineSkillDoc(rel: string): string {
  return fs.readFileSync(path.join(PIPELINE_SKILL_DIR, rel), "utf8");
}

export function readPipelineSkillCore(): string {
  return readPipelineSkillDoc("SKILL.md");
}

function tableRows(core: string, heading: string): string[][] {
  const lines = core.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/^\||\|\s*$/g, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows.slice(1);
}

const ticked = (cell: string | undefined): string[] =>
  [...(cell ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** Rows of the core's `## Phase dispatch` table: Step | phases | one-liner | doc. */
export function parseDispatchTable(
  core: string,
): { step: string; phases: string[]; doc: string }[] {
  return tableRows(core, "## Phase dispatch").map((c) => ({
    step: c[0] ?? "",
    phases: ticked(c[1]),
    doc: (c[3] ?? "").match(PHASE_DOC)?.[0] ?? "",
  }));
}

/** Rows of the core's `## On-demand references` table: doc | when. */
export function parseReferenceIndex(
  core: string,
): { doc: string; when: string }[] {
  return tableRows(core, "## On-demand references").map((c) => ({
    doc: ticked(c[0])[0] ?? "",
    when: c[1] ?? "",
  }));
}

function phaseDocsInOrder(core: string): string[] {
  const onDisk = (rel: string) =>
    fs.existsSync(path.join(PIPELINE_SKILL_DIR, rel));
  const ordered = [
    ...parseDispatchTable(core).map((r) => r.doc),
    ...parseReferenceIndex(core).map((r) => r.doc),
  ].filter((d) => d.startsWith(`${PHASES_DIR}/`));
  const dir = path.join(PIPELINE_SKILL_DIR, PHASES_DIR);
  const rest = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => `${PHASES_DIR}/${f}`)
    : [];
  return [...new Set([...ordered, ...rest])].filter(onDisk);
}

/** Core, then the step and off-path docs in table order, then hard-rules detail. */
export function readPipelineSkillCorpus(): string {
  const core = readPipelineSkillCore();
  const docs = phaseDocsInOrder(core);
  if (fs.existsSync(path.join(PIPELINE_SKILL_DIR, HARD_RULES_DETAIL)))
    docs.push(HARD_RULES_DETAIL);
  return docs.reduce((acc, rel) => {
    const sep = acc.endsWith("\n") ? "" : "\n";
    return acc + sep + readPipelineSkillDoc(rel);
  }, core);
}
