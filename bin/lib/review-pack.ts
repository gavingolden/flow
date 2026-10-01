/**
 * Pure renderer for the per-lens review brief: one self-contained Markdown
 * prompt per lens, built from `agent-prompts.md` plus the `.flow-tmp/`
 * artifacts `flow-review-prep` already wrote, so a lens starts from one
 * file instead of reading its inputs one by one. Imported in-process by
 * `review-prep.ts` — there is deliberately no PATH helper for it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { route, type AgentName } from "../flow-pr-agent-lens";
import type { ReviewScope } from "../flow-review-scope";
import type { ReadConfigFile } from "./models-config";
import type { ExecFn } from "./review-prep";

export const BRIEF_MAX_BYTES = 80_000;

export const LENS_HEADINGS: Record<AgentName, string> = {
  "bug-detection": "## Bug Detection Agent",
  security: "## Security Agent",
  "pattern-consistency": "## Pattern & Consistency Agent",
  performance: "## Performance Agent",
  "supply-chain": "## Supply-Chain Agent",
  "test-coverage": "## Test Coverage Agent",
  product: "## Product Agent",
};

export type PackInputs = {
  lens: AgentName;
  skillDir: string;
  worktree: string;
  base: string;
  productBriefPath?: string;
  promptInterpretationTension: boolean;
  /** Byte cap override for measurement harnesses; production keeps BRIEF_MAX_BYTES. */
  maxBytes?: number;
  read: (absPath: string) => string | null;
  exec: ExecFn;
};

export function extractSharedBlock(md: string): string {
  const lines = md.split("\n");
  const headingIdx = lines.findIndex(
    (l) => l.trim() === "## Shared Context Block",
  );
  if (headingIdx === -1) {
    throw new Error(
      "agent-prompts.md: '## Shared Context Block' heading not found",
    );
  }
  const fenceStart = lines.findIndex(
    (l, i) => i > headingIdx && l.trim() === "```",
  );
  if (fenceStart === -1) {
    throw new Error(
      "agent-prompts.md: opening fence for shared context block not found",
    );
  }
  const fenceEnd = lines.findIndex(
    (l, i) => i > fenceStart && l.trim() === "```",
  );
  if (fenceEnd === -1) {
    throw new Error(
      "agent-prompts.md: closing fence for shared context block not found",
    );
  }
  return lines.slice(fenceStart + 1, fenceEnd).join("\n");
}

export function extractLensBlock(md: string, lens: AgentName): string {
  const heading = LENS_HEADINGS[lens];
  if (!heading) throw new Error(`unknown lens '${lens}'`);
  const lines = md.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) {
    throw new Error(`agent-prompts.md: '${heading}' heading not found`);
  }
  let next = lines.findIndex((l, i) => i > headingIdx && /^## /.test(l));
  if (next === -1) next = lines.length;
  const body = lines.slice(headingIdx, next);
  while (
    body.length > 0 &&
    ["", "---"].includes(body[body.length - 1]!.trim())
  ) {
    body.pop();
  }
  return body.join("\n");
}

function parseFetch(md: string): {
  number: string;
  title: string;
  description: string;
} {
  const head = /^# PR #(\d+): (.*)$/m.exec(md);
  if (!head)
    throw new Error(
      "pr-review-fetch.md: '# PR #<n>: <title>' header not found",
    );
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l === "## Description");
  let description = "(none)";
  if (start !== -1) {
    let end = lines.findIndex(
      (l, i) =>
        i > start &&
        /^## (Changed Files|Review Summaries|Inline Comments \(\d+\))$/.test(l),
    );
    if (end === -1) end = lines.length;
    description =
      lines
        .slice(start + 1, end)
        .join("\n")
        .trim() || "(none)";
  }
  return { number: head[1]!, title: head[2]!, description };
}

function reviewScopeText(scope: ReviewScope): string {
  if (scope.scope !== "delta") return "Full PR diff.";
  return (
    `Delta re-entry: the diff below covers only ${scope.base_sha}..${scope.head_sha} ` +
    `(${scope.delta_files.length} files). Read every listed file in full; findings ` +
    "must still cite PR-touched lines. If a delta hunk changes a contract used by " +
    "unchanged PR files, report it as a finding — do not assume the earlier review " +
    "covered it.\n" +
    scope.delta_files.map((f) => `- \`${f}\``).join("\n")
  );
}

const headersOnly = {
  commits: (s: string) =>
    s
      .split("\n")
      .filter((l) => /^[0-9a-f]{7,40} /.test(l))
      .join("\n"),
  intent: (s: string) =>
    s
      .split("\n")
      .map((l) => l.replace(/ → .*$/, " →"))
      .join("\n"),
};

export function loadPackTemplates(i: PackInputs): {
  shared: string;
  lensBlock: string;
} {
  const p = path.join(i.skillDir, "references", "agent-prompts.md");
  const md = i.read(p);
  if (md === null) throw new Error(`agent-prompts.md missing (${p})`);
  return {
    shared: extractSharedBlock(md),
    lensBlock: extractLensBlock(md, i.lens),
  };
}

function needFile(i: PackInputs, p: string, label: string): string {
  const v = i.read(p);
  if (v === null) throw new Error(`${label} missing (${p})`);
  return v;
}

export function gatherPackVars(
  i: PackInputs,
  shrink: boolean,
): Record<string, string> {
  const dir = path.join(i.worktree, ".flow-tmp");
  const fetch = parseFetch(
    needFile(i, path.join(dir, "pr-review-fetch.md"), "pr-review-fetch.md"),
  );
  const diff = needFile(i, path.join(dir, "diff.txt"), "diff.txt");
  const scope = JSON.parse(
    needFile(i, path.join(dir, "review-scope.json"), "review-scope.json"),
  ) as ReviewScope;
  let commits = i.read(path.join(dir, "pr-commits.md"))?.trim() || "(none)";
  let intent =
    i.read(path.join(dir, "intent-comments.md"))?.trim() ||
    "(none — author posted no intent annotations)";
  if (shrink) {
    commits = headersOnly.commits(commits) || "(none)";
    intent = headersOnly.intent(intent);
  }
  let facts: unknown;
  try {
    facts = route(
      JSON.parse(
        needFile(
          i,
          path.join(dir, "static-analysis.json"),
          "static-analysis.json",
        ),
      ),
      i.lens,
    );
  } catch {
    facts = {
      findings: [],
      meta: {
        ran: false,
        skipped_reason: "static-analysis.json unavailable",
        duration_ms: 0,
      },
    };
  }
  return {
    PR_NUMBER: fetch.number,
    PR_TITLE: fetch.title,
    PR_DESCRIPTION: fetch.description,
    COMMIT_MESSAGES: commits,
    CHANGED_FILES_LIST: scope.pr_files.join(", "),
    EXISTING_INTENT_COMMENTS: intent,
    REVIEW_SCOPE: reviewScopeText(scope),
    STATIC_ANALYSIS_FACTS: JSON.stringify(facts),
    DIFF: diff,
    PROMPT_INTERPRETATION_TENSION: String(i.promptInterpretationTension),
    PRODUCT_BRIEF_PATH: i.productBriefPath ?? "(no product brief found)",
  };
}

const BULKY = new Set([
  "PR_DESCRIPTION",
  "COMMIT_MESSAGES",
  "EXISTING_INTENT_COMMENTS",
  "STATIC_ANALYSIS_FACTS",
  "DIFF",
]);

/** Single-pass fill: substituted values are never rescanned, and a bulky
 * variable's repeat mentions in prose collapse to a back-reference. */
export function makeFill(vars: Record<string, string>): (t: string) => string {
  const seen = new Set<string>();
  return (tpl) =>
    tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => {
      if (!(k in vars)) return m;
      if (!BULKY.has(k)) return vars[k]!;
      if (seen.has(k)) return `the ${k.toLowerCase().replace(/_/g, " ")} above`;
      seen.add(k);
      return vars[k]!;
    });
}

function assemble(i: PackInputs, shrink: boolean): string {
  const { shared, lensBlock } = loadPackTemplates(i);
  const fill = makeFill(gatherPackVars(i, shrink));
  const sharedFilled = fill(shared);
  const lensFilled = fill(lensBlock);
  const checklist = path.join(
    i.skillDir,
    "references",
    "checklists",
    `${i.lens}.md`,
  );
  const extras: string[] = [
    "## Inputs supplied in this brief",
    "",
    "The lens checklist, the conventional-comments format and the base-branch " +
      "`.flow/review-checklist.md` (when present) are appended below — you do not " +
      "need to Read them. Read or Grep further files only for a finding that needs them.",
    "",
    `### Lens checklist (${i.lens})`,
    fill(needFile(i, checklist, `checklists/${i.lens}.md`).trim()),
    "",
    "### Conventional comments",
    needFile(
      i,
      path.join(i.skillDir, "references", "conventional-comments.md"),
      "conventional-comments.md",
    ).trim(),
  ];
  const baseChecklist = i.exec(
    ["git", "show", `origin/${i.base}:.flow/review-checklist.md`],
    { cwd: i.worktree },
  );
  if (baseChecklist.exitCode === 0 && baseChecklist.stdout.trim()) {
    extras.push(
      "",
      "### Project review checklist (base branch)",
      baseChecklist.stdout.trim(),
    );
  }
  return `${sharedFilled}\n\n${extras.join("\n")}\n\n${lensFilled}\n`;
}

export function renderLensBrief(
  i: PackInputs,
): { text: string } | { error: string } {
  const cap = i.maxBytes ?? BRIEF_MAX_BYTES;
  try {
    let text = assemble(i, false);
    if (Buffer.byteLength(text) > cap) text = assemble(i, true);
    const bytes = Buffer.byteLength(text);
    if (bytes > cap) {
      return {
        error: `${i.lens} brief is ${bytes} bytes, over the ${cap}-byte cap even with commit bodies and intent comments cut to headers`,
      };
    }
    return { text };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function renderAllBriefs(
  i: Omit<PackInputs, "lens"> & {
    scope: ReviewScope;
    write?: (p: string, content: string) => void;
  },
): {
  lens_prompts: Record<string, string>;
  skipped: { lens: AgentName; reason: string }[];
} {
  const write =
    i.write ??
    ((p: string, c: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, c);
    });
  const lens_prompts: Record<string, string> = {};
  const skipped: { lens: AgentName; reason: string }[] = [];
  for (const lens of Object.keys(LENS_HEADINGS) as AgentName[]) {
    if (i.scope.gates?.[lens]?.run !== true) continue;
    const productBriefPath =
      i.productBriefPath ??
      (i.scope.product_brief?.found ? i.scope.product_brief.path : undefined);
    const r = renderLensBrief({ ...i, lens, productBriefPath });
    if ("error" in r) {
      skipped.push({ lens, reason: r.error });
      continue;
    }
    const out = path.join(i.worktree, ".flow-tmp", `lens-prompt-${lens}.md`);
    write(out, r.text);
    lens_prompts[lens] = out;
  }
  return { lens_prompts, skipped };
}

export function isLensPackEnabled(readConfig: ReadConfigFile): boolean {
  let raw: unknown;
  try {
    raw = readConfig();
  } catch {
    return false;
  }
  const review = (raw as { review?: unknown } | null | undefined)?.review;
  if (typeof review !== "object" || review === null) return false;
  return (review as Record<string, unknown>).lensPack === true;
}

export type LensPackStep = {
  lens_prompts: Record<string, string>;
  notice: string | null;
};

export function runLensPackStep(o: {
  pr: number;
  worktree: string;
  skillDir?: string;
  readConfig: ReadConfigFile;
  promptInterpretationTension: boolean;
  read: (p: string) => string | null;
  exec: ExecFn;
  write?: (p: string, content: string) => void;
}): LensPackStep {
  const off = (reason: string): LensPackStep => ({
    lens_prompts: {},
    notice: `NOTICE — lens-pack: ${reason}; using pointer prompts`,
  });
  for (const lens of Object.keys(LENS_HEADINGS)) {
    fs.rmSync(path.join(o.worktree, ".flow-tmp", `lens-prompt-${lens}.md`), {
      force: true,
    });
  }
  if (!o.skillDir) return off("no --skill-dir passed");
  if (!isLensPackEnabled(o.readConfig)) return off("review.lensPack is off");
  const raw = o.read(path.join(o.worktree, ".flow-tmp", "review-scope.json"));
  if (raw === null) return off("review-scope.json unavailable");
  const base = o.exec([
    "gh",
    "pr",
    "view",
    String(o.pr),
    "--json",
    "baseRefName",
    "-q",
    ".baseRefName",
  ]);
  const { lens_prompts, skipped } = renderAllBriefs({
    skillDir: o.skillDir,
    worktree: o.worktree,
    base: base.exitCode === 0 ? base.stdout.trim() : "main",
    promptInterpretationTension: o.promptInterpretationTension,
    read: o.read,
    exec: o.exec,
    write: o.write,
    scope: JSON.parse(raw) as ReviewScope,
  });
  if (skipped.length > 0) {
    return {
      lens_prompts,
      notice: `NOTICE — lens-pack: ${skipped.map((s) => `${s.lens}: ${s.reason}`).join("; ")}; those lenses spawn with the pointer prompt`,
    };
  }
  return { lens_prompts, notice: null };
}
