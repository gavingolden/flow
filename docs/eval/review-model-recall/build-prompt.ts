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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LENS_HEADINGS,
  extractLensBlock,
  extractSharedBlock,
  gatherPackVars,
  loadPackTemplates,
  makeFill,
  renderLensBrief,
  type PackInputs,
} from "../../../bin/lib/review-pack";
import type { AgentName } from "../../../bin/flow-pr-agent-lens";
import { materialize } from "./materialize";

const SKILL_DIR = join(
  import.meta.dir,
  "../../../skills/pipeline/flow-pr-review",
);

const AGENT_PROMPTS_PATH = join(
  import.meta.dir,
  "../../../skills/pipeline/flow-pr-review/references/agent-prompts.md",
);

function usage(): string {
  return [
    "Usage:",
    "  build-prompt.ts <lens> <pr> [--data-dir <dir>] [--mode packed|pointer] [--max-bytes <n>]",
    "  build-prompt.ts materialize <pr> --data-dir <dir>",
    "",
    "  --mode packed   writes the lens brief under <dir>/pr-<pr>/.flow-tmp/ and emits the",
    "                  production spawn prompt (Read exactly that brief first)",
    "  --mode pointer  emits the production fallback prompt: shared block + lens section",
    "                  with variables filled, checklist paths as absolute Read targets",
    "  --max-bytes     packed-brief byte cap (default: production BRIEF_MAX_BYTES); a harness",
    "                  raises it because a merged PR's final body carries post-review evidence",
    "  materialize     writes the per-PR .flow-tmp-shaped inputs both modes read, plus",
    "                  ref-<pr>.json and ref-acted-<pr>.json (see materialize.ts)",
    "",
    `  <lens>  one of: ${Object.keys(LENS_HEADINGS).join(", ")}`,
    "  <pr>    PR number; reads <data-dir>/meta-<pr>.json and <data-dir>/diff-<pr>.patch",
    "  --data-dir  defaults to the script's own data/ subdirectory",
    "",
    "Writes the assembled review prompt to stdout.",
  ].join("\n");
}

function packInputs(
  lens: string,
  pr: string,
  dataDir: string,
  maxBytes?: number,
): PackInputs {
  return {
    lens: lens as AgentName,
    skillDir: SKILL_DIR,
    worktree: join(dataDir, `pr-${pr}`),
    base: "main",
    promptInterpretationTension: false,
    maxBytes,
    read: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    exec: () => ({ stdout: "", stderr: "", exitCode: 1 }),
  };
}

function modePrompt(
  mode: string,
  lens: string,
  pr: string,
  dataDir: string,
  maxBytes?: number,
): string {
  const i = packInputs(lens, pr, dataDir, maxBytes);
  if (mode === "packed") {
    const r = renderLensBrief(i);
    if ("error" in r) throw new Error(r.error);
    const brief = join(i.worktree, ".flow-tmp", `lens-prompt-${lens}.md`);
    writeFileSync(brief, r.text);
    return `Read exactly ${brief} first — it is your complete brief; Read/Grep further only for a finding that needs it. Return your findings JSON object as your final message.\n`;
  }
  const { shared, lensBlock } = loadPackTemplates(i);
  const fill = makeFill(gatherPackVars(i, false));
  const refs = join(SKILL_DIR, "references");
  return [
    fill(shared),
    "",
    fill(lensBlock),
    "",
    "## Input file paths",
    `- Lens checklist: ${join(refs, "checklists", `${lens}.md`)}`,
    `- Conventional comments: ${join(refs, "conventional-comments.md")}`,
    "- Return your findings JSON object as your final message.",
    "",
  ].join("\n");
}

const VALUE_FLAGS = new Set(["--data-dir", "--mode", "--max-bytes"]);

function parseCli(argv: string[]): {
  positional: string[];
  dataDir: string | undefined;
  mode: string | undefined;
  maxBytes: number | undefined;
  missing: string | null;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let missing: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) missing = a;
      else flags[a] = v;
      i++;
    } else if (!a.startsWith("--")) positional.push(a);
  }
  return {
    positional,
    dataDir: flags["--data-dir"],
    mode: flags["--mode"],
    maxBytes: flags["--max-bytes"] ? Number(flags["--max-bytes"]) : undefined,
    missing,
  };
}

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const cli = parseCli(argv);
  if (cli.missing) {
    console.error(`${cli.missing} requires a value`);
    return 2;
  }
  const [lens, pr] = cli.positional;
  if (!lens || !pr) {
    console.error(usage());
    return 2;
  }
  const dataDir = cli.dataDir ?? join(import.meta.dir, "data");
  if (lens === "materialize") {
    materialize(pr, dataDir);
    return 0;
  }
  if (cli.mode) {
    if (cli.mode !== "packed" && cli.mode !== "pointer") {
      console.error(`unknown --mode: ${cli.mode}`);
      return 2;
    }
    process.stdout.write(modePrompt(cli.mode, lens, pr, dataDir, cli.maxBytes));
    return 0;
  }

  const agentPrompts = readFileSync(AGENT_PROMPTS_PATH, "utf8");
  const shared = extractSharedBlock(agentPrompts);
  const lensBlock = extractLensBlock(agentPrompts, lens as AgentName);

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
