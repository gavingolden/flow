#!/usr/bin/env bun
// Proves the flow-pipeline skill split dropped nothing: every non-blank line
// of SKILL.md at a given sha must be in the current corpus (core + phase docs
// + hard-rules detail) or in the deletion ledger. Exits 1 listing the rest.
//   bun docs/eval/skill-split-fidelity.ts --before 8e5c823 \
//     [--ledger docs/eval/skill-split/deletion-ledger.md]
// A line may also be accounted for when it was cut in two across files: its
// head ends one corpus line and its tail starts another.
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
  const heads = new Set<string>();
  const tails = new Set<string>();
  for (const raw of corpus.split("\n")) {
    const l = norm(raw);
    if (!l) continue;
    lines.add(l);
    const w = words(l);
    for (let i = 0; i < w.length; i++) {
      heads.add(w.slice(0, i + 1).join(" "));
      tails.add(w.slice(i).join(" "));
    }
  }
  const owned = ledgerLines(ledger);
  const missing: string[] = [];
  for (const raw of before.split("\n")) {
    const l = norm(raw);
    if (!l || lines.has(l) || owned.has(l)) continue;
    const w = words(l);
    const cut = w.some(
      (_, k) =>
        k > 0 &&
        tails.has(w.slice(0, k).join(" ")) &&
        heads.has(w.slice(k).join(" ")),
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
