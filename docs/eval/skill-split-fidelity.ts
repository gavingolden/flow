#!/usr/bin/env bun
// Proves the flow-pipeline skill split dropped nothing: every non-blank line
// of SKILL.md at a given sha must be in the current corpus (core + phase docs
// + hard-rules detail) or in the deletion ledger. Exits 1 listing the rest.
//   bun docs/eval/skill-split-fidelity.ts --before 6acd8ee \
//     [--ledger docs/eval/skill-split/deletion-ledger.md]
// 6acd8ee is the post-merge base; the original split point 8e5c823 now
// reports the 3 lines main's #941 changed.
// A line may also be accounted for when it was re-wrapped into a longer corpus
// line (a substring of one), or cut in two across files (its head and its tail
// are each a whole corpus line).
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { readPipelineSkillCorpus } from "../../bin/lib/pipeline-skill-corpus";

const norm = (l: string) =>
  l
    .replace(/^[\s>]+/, "")
    .replace(/\s+/g, " ")
    .trim();
const words = (l: string) => l.split(" ");

export function ledgerLines(ledger: string): Set<string> {
  const out = new Set<string>();
  let block: string[] | null = null;
  for (const raw of ledger.split("\n")) {
    if (/^`{3,}\s*$/.test(raw)) {
      if (block) for (const l of block) out.add(norm(l));
      block = block ? null : [];
    } else if (block && !/^owner:/.test(raw)) block.push(raw);
  }
  return out;
}

export function unaccounted(
  before: string,
  corpus: string,
  ledger = "",
): string[] {
  const lines = new Set<string>();
  const contained: string[] = [];
  for (const raw of corpus.split("\n")) {
    const l = norm(raw);
    if (!l) continue;
    lines.add(l);
    contained.push(l);
  }
  const owned = ledgerLines(ledger);
  const missing: string[] = [];
  for (const raw of before.split("\n")) {
    const l = norm(raw);
    if (!l || lines.has(l) || owned.has(l)) continue;
    const w = words(l);
    const rewrapped = contained.some((c) => c.includes(l));
    const cut =
      rewrapped ||
      w.some(
        (_, k) =>
          k > 0 &&
          lines.has(w.slice(0, k).join(" ")) &&
          lines.has(w.slice(k).join(" ")),
      );
    if (!cut) missing.push(raw);
  }
  return missing;
}

function run(argv: string[]) {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sha = flag("--before");
  if (!sha) throw new Error("usage: --before <sha> [--ledger <path>]");
  const before = execFileSync(
    "git",
    ["show", `${sha}:skills/pipeline/flow-pipeline/SKILL.md`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const ledger = readFileSync(
    flag("--ledger") ?? "docs/eval/skill-split/deletion-ledger.md",
    "utf8",
  );
  const missing = unaccounted(before, readPipelineSkillCorpus(), ledger);
  if (missing.length) {
    console.error(
      `${missing.length} pre-split line(s) in neither the corpus nor the ledger:`,
    );
    for (const l of missing) console.error(`  ${l.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(
    `skill-split fidelity ok: every non-blank line of ${sha} is in the corpus or the ledger`,
  );
}

if (import.meta.main) run(process.argv.slice(2));
