#!/usr/bin/env bun
/**
 * Deterministic final-report check for the `/flow-coder` wrapper: compares the
 * code agent's `skills_read` / `skills_read_late` with every path its edit-set
 * entries were required to read (per-entry `skill_docs`, plus the design rule
 * paths when any entry edits a UI file), and emits one small JSON verdict.
 *
 * Usage:
 *   flow-coder-skills-check --artifact <path> (--edit-set-file <path> | --edit-set <json>) [--design <path>]...
 *
 * Prints one JSON line (a `SkillsCheck`) on stdout and exits 0. The wrapper
 * sends at most one continuation when `needsContinuation` is true; step 5 of
 * `/flow-new-feature` registers `untrackedTitle` / `untrackedBody` for a
 * design gap that survives it.
 *
 * Parsing is tolerant: `validateCoderResult` has no production caller, so a
 * missing or malformed `skills_read` / `skills_read_late` / `skill_docs`
 * counts as empty rather than an error.
 *
 * Exit codes: 0 verdict printed, 2 bad args or an unreadable/unparseable
 * artifact or edit-set (the edit-set must be a JSON array).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isUiFile } from "./flow-ui-validate";

export const DESIGN_GAP_TITLE =
  "UI edits skipped required design guidance — layout, spacing and keyboard access were not checked against it";

const GAP_PREFIX = "UI edits skipped required design guidance — ";
const GAP_SUFFIX = " not checked against it";

function gapClause(p: string): string {
  switch (path.basename(p)) {
    case "layout.md":
      return "layout";
    case "visual-design.md":
      return "spacing and visual hierarchy";
    case "accessibility.md":
      return "keyboard and screen-reader access";
    default:
      return "general UI rules";
  }
}

function gapTitle(missingDesign: string[]): string {
  const clauses = [...new Set(missingDesign.map(gapClause))];
  if (clauses.length >= 4) return DESIGN_GAP_TITLE;
  const list =
    clauses.length > 1
      ? `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`
      : clauses[0];
  return `${GAP_PREFIX}${list} were${GAP_SUFFIX}`;
}

function anchorPath(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(`${home}${path.sep}`)
    ? `~${p.slice(home.length)}`
    : p;
}

export type SkillsCheck = {
  required: string[];
  read: string[];
  missing: string[];
  late: string[];
  needsContinuation: boolean;
  missingDesign: string[];
  untrackedTitle: string | null;
  untrackedBody: string | null;
};

const USAGE =
  "usage: flow-coder-skills-check --artifact <path> (--edit-set-file <path> | --edit-set <json>) [--design <path>]...";

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function realOrNormalized(p: string): string {
  const n = path.normalize(p);
  try {
    return fs.realpathSync(n);
  } catch {
    return n;
  }
}

function dedupe(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const k = path.normalize(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function matcher(paths: string[]): (p: string) => boolean {
  const norm = new Set(paths.map((p) => path.normalize(p)));
  const real = new Set(paths.map(realOrNormalized));
  return (p) => norm.has(path.normalize(p)) || real.has(realOrNormalized(p));
}

function shortLabel(p: string): string {
  return path.join(path.basename(path.dirname(p)), path.basename(p));
}

export function checkSkillsRead(
  artifact: unknown,
  editSet: unknown,
  design: string[],
): SkillsCheck {
  const art =
    typeof artifact === "object" && artifact !== null
      ? (artifact as Record<string, unknown>)
      : {};
  const entries = (Array.isArray(editSet) ? editSet : []).filter(
    (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
  );

  const touchesUi = entries.some(
    (e) => typeof e.file === "string" && isUiFile(e.file),
  );
  const designRequired = touchesUi ? dedupe(design) : [];
  const required = dedupe([
    ...entries.flatMap((e) => strings(e.skill_docs)),
    ...designRequired,
  ]);

  const read = strings(art.skills_read);
  const isRead = matcher(read);
  const isLate = matcher(strings(art.skills_read_late));

  const missing = required.filter((p) => !isRead(p));
  const late = required.filter((p) => isLate(p));
  const isMissing = matcher(missing);
  const missingDesign = designRequired.filter((p) => isMissing(p));

  const gap = missingDesign.length > 0;
  const title = gap ? gapTitle(missingDesign) : null;
  return {
    required,
    read,
    missing,
    late,
    needsContinuation: missing.length > 0 || late.length > 0,
    missingDesign,
    untrackedTitle: title,
    untrackedBody: gap
      ? `**Short form:** [V:2|C:Small|R:Low] ${title} — skipped: ${missingDesign.map(shortLabel).join(", ")} [anchor: ${anchorPath(missingDesign[0])}]`
      : null,
  };
}

type Args = {
  artifact?: string;
  editSetFile?: string;
  editSet?: string;
  design: string[];
};

function parseArgs(argv: string[]): Args | string {
  const args: Args = { design: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      flag !== "--artifact" &&
      flag !== "--edit-set-file" &&
      flag !== "--edit-set" &&
      flag !== "--design"
    ) {
      return `unknown argument '${flag}'`;
    }
    if (value === undefined) return `${flag} needs a value`;
    i++;
    if (flag === "--design") args.design.push(value);
    else if (flag === "--artifact") args.artifact = value;
    else if (flag === "--edit-set-file") args.editSetFile = value;
    else args.editSet = value;
  }
  if (!args.artifact) return "--artifact is required";
  if ((args.editSetFile === undefined) === (args.editSet === undefined)) {
    return "exactly one of --edit-set-file or --edit-set is required";
  }
  return args;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${(e as Error).message}`);
  }
}

export function run(
  argv: string[],
  io: { stdout: (s: string) => void; stderr: (s: string) => void } = {
    stdout: (s) => console.log(s),
    stderr: (s) => console.error(s),
  },
): number {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.stderr(`flow-coder-skills-check: ${args}\n${USAGE}`);
    return 2;
  }
  try {
    const artifact = parseJson(
      fs.readFileSync(args.artifact as string, "utf8"),
      `artifact ${args.artifact}`,
    );
    const editSetText =
      args.editSet ?? fs.readFileSync(args.editSetFile as string, "utf8");
    const editSet = parseJson(editSetText, "edit-set");
    if (!Array.isArray(editSet))
      throw new Error("edit-set must be a JSON array");
    io.stdout(JSON.stringify(checkSkillsRead(artifact, editSet, args.design)));
    return 0;
  } catch (e) {
    io.stderr(`flow-coder-skills-check: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
