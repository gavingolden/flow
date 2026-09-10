#!/usr/bin/env bun
/**
 * Port of `_reference/build-prompt.py` (see docs/eval/review-model-recall/README.md).
 * Assembles one review-lens prompt: the shared context block plus the
 * per-lens section, both extracted live from
 * `skills/pipeline/flow-pr-review/references/agent-prompts.md` (rather
 * than the Python original's manually-materialized `shared-block.md` /
 * `lens-<lens>.md` sibling files — extracting straight from the source
 * of truth means the harness can never silently drift from the real
 * review prompts), plus a PR's metadata and diff, with the `{{...}}`
 * context variables substituted.
 *
 * Three of those substitutions are honest placeholders this harness
 * cannot supply for real — `{{STATIC_ANALYSIS_FACTS}}`,
 * `{{COMMIT_MESSAGES}}`, `{{EXISTING_INTENT_COMMENTS}}` — see
 * review-model-recall.md's "What was deliberately not measured" /
 * measurement-limits framing. Do not silently change their wording.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_PROMPTS_PATH = join(
  import.meta.dir,
  "../../../skills/pipeline/flow-pr-review/references/agent-prompts.md",
);

const LENS_HEADINGS: Record<string, string> = {
  "bug-detection": "## Bug Detection Agent",
  "pattern-consistency": "## Pattern & Consistency Agent",
  "test-coverage": "## Test Coverage Agent",
};

function usage(): string {
  return [
    "Usage: build-prompt.ts <lens> <pr> [--data-dir <dir>]",
    "",
    `  <lens>  one of: ${Object.keys(LENS_HEADINGS).join(", ")}`,
    "  <pr>    PR number; reads <data-dir>/meta-<pr>.json and <data-dir>/diff-<pr>.patch",
    "  --data-dir  defaults to the script's own data/ subdirectory",
    "",
    "Writes the assembled review prompt to stdout.",
  ].join("\n");
}

function extractSharedBlock(md: string): string {
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

function extractLensBlock(md: string, lens: string): string {
  const heading = LENS_HEADINGS[lens];
  if (!heading) {
    throw new Error(
      `unknown lens '${lens}' — expected one of: ${Object.keys(LENS_HEADINGS).join(", ")}`,
    );
  }
  const lines = md.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) {
    throw new Error(`agent-prompts.md: '${heading}' heading not found`);
  }
  let nextHeadingIdx = lines.findIndex(
    (l, i) => i > headingIdx && /^## /.test(l),
  );
  if (nextHeadingIdx === -1) nextHeadingIdx = lines.length;
  const body = lines.slice(headingIdx, nextHeadingIdx);
  while (
    body.length > 0 &&
    (body[body.length - 1]!.trim() === "" ||
      body[body.length - 1]!.trim() === "---")
  ) {
    body.pop();
  }
  return body.join("\n");
}

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [lens, pr] = positional;
  if (!lens || !pr) {
    console.error(usage());
    return 2;
  }
  const dataDirFlagIdx = argv.indexOf("--data-dir");
  const dataDir =
    dataDirFlagIdx !== -1
      ? argv[dataDirFlagIdx + 1]
      : join(import.meta.dir, "data");
  if (!dataDir) {
    console.error("--data-dir requires a value");
    return 2;
  }

  const agentPrompts = readFileSync(AGENT_PROMPTS_PATH, "utf8");
  const shared = extractSharedBlock(agentPrompts);
  const lensBlock = extractLensBlock(agentPrompts, lens);

  const meta = JSON.parse(
    readFileSync(join(dataDir, `meta-${pr}.json`), "utf8"),
  ) as {
    title: string;
    body: string | null;
  };
  const diff = readFileSync(join(dataDir, `diff-${pr}.patch`), "utf8");
  const files = diff
    .split("\n")
    .filter((l) => l.startsWith("+++ b/"))
    .map((l) => l.slice("+++ b/".length).trim());

  const sub: Record<string, string> = {
    "{{PR_NUMBER}}": pr,
    "{{PR_TITLE}}": meta.title,
    "{{PR_DESCRIPTION}}": meta.body || "(none)",
    "{{COMMIT_MESSAGES}}":
      "- Commit messages: (not supplied in this measurement harness)",
    "{{CHANGED_FILES_LIST}}": files.join(", "),
    "{{EXISTING_INTENT_COMMENTS}}":
      "(none — author posted no intent annotations)",
    "{{REVIEW_SCOPE}}": "Full PR diff.",
    "{{STATIC_ANALYSIS_FACTS}}":
      "(not supplied in this measurement harness — reason from the diff alone)",
    "{{PROMPT_INTERPRETATION_TENSION}}": "false",
    "{{DIFF}}": diff,
  };

  let out = `${shared}\n\n${lensBlock}`;
  for (const [k, v] of Object.entries(sub)) {
    out = out.split(k).join(v);
  }
  process.stdout.write(out);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

export { extractSharedBlock, extractLensBlock, LENS_HEADINGS };
