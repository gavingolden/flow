#!/usr/bin/env bun
/**
 * Port of `_reference/build-judge.py` (see
 * docs/eval/review-model-recall/README.md). Builds the blinded
 * scoring-judge prompt for one cell: the PR's reference finding set plus
 * the cell's raw candidate output, asking for a strict per-reference
 * match classification plus `candidate_total` / `new_findings`.
 *
 * CRITICAL: this prompt must stay BLINDED — it never names which model
 * (sonnet/opus) produced the candidate output, only the lens. The 60000-
 * character candidate truncation and the strictness wording are kept
 * verbatim from the Python original; both affect the committed scores in
 * ../review-model-recall.json.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CANDIDATE_CHAR_LIMIT = 60000;

interface Reference {
  path: string;
  line?: number;
  body: string;
}

interface Cell {
  result?: string;
}

function usage(): string {
  return [
    "Usage: build-judge.ts <lens> <pr> <arm> <run> [--data-dir <dir>]",
    "",
    "  Reads <data-dir>/ref-<pr>.json and <data-dir>/runs/<lens>-<pr>-<arm>-r<run>.json.",
    "  Writes the blinded judge prompt to stdout.",
  ].join("\n");
}

function buildJudgePrompt(
  lens: string,
  pr: string,
  refs: Reference[],
  cell: Cell,
): string {
  const text = cell.result || "";
  const refLines = refs.map((r, idx) => {
    const body = r.body.replace(/\s+/g, " ").slice(0, 400);
    const line = r.line ?? "None";
    return `[R${idx + 1}] ${r.path}:${line} — ${body}`;
  });

  return `You are scoring one code-review run against a reference set. Output JSON only, no prose, no fences.

CONTEXT: PR #${pr} of the \`flow\` repo was reviewed once for real. The findings that SURVIVED that review and were posted as inline comments are the REFERENCE SET below. Separately, a single review lens (\`${lens}\`) was re-run over the same PR diff. Its output is the CANDIDATE OUTPUT below.

Your job: for EACH reference finding, decide whether the candidate output raised substantially the same concern about substantially the same code.

Match categories:
- "same-text": the candidate names the same defect at the same location in near-identical terms.
- "semantically-equivalent": the candidate names the same underlying defect/concern about the same code, in different words or at a nearby location.
- null: not matched.

Be STRICT. Two findings about the same FILE are not a match unless they are about the same DEFECT. Vague overlap is not a match. It is expected and correct that most reference findings are unmatched — a single lens only owns a fraction of a full six-lens review's output.

Also count how many DISTINCT concerns the candidate raised that match NO reference finding (\`new_findings\`), and how many distinct concerns it raised in total (\`candidate_total\`). If the candidate output is empty, an error message, or raised nothing, set candidate_total to 0 and every match to null.

REFERENCE SET (${refs.length} findings):
${refLines.join("\n")}

CANDIDATE OUTPUT (lens=${lens}):
<<<CANDIDATE
${text.slice(0, CANDIDATE_CHAR_LIMIT)}
CANDIDATE

Output exactly this JSON shape:
{"matches":[{"ref":1,"category":null}, ...one entry per reference finding, in order...],"candidate_total":<int>,"new_findings":<int>}
`;
}

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [lens, pr, arm, run] = positional;
  if (!lens || !pr || !arm || !run) {
    console.error(usage());
    return 2;
  }
  const dataDirFlagIdx = argv.indexOf("--data-dir");
  const dataDir =
    dataDirFlagIdx !== -1 ? argv[dataDirFlagIdx + 1] : import.meta.dir;
  if (!dataDir) {
    console.error("--data-dir requires a value");
    return 2;
  }

  const refs = JSON.parse(
    readFileSync(join(dataDir, `ref-${pr}.json`), "utf8"),
  ) as Reference[];
  const cell = JSON.parse(
    readFileSync(
      join(dataDir, "runs", `${lens}-${pr}-${arm}-r${run}.json`),
      "utf8",
    ),
  ) as Cell;

  process.stdout.write(buildJudgePrompt(lens, pr, refs, cell));
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

export { buildJudgePrompt };
