/**
 * Reader and target matcher for the owner-words ledger,
 * `~/.flow/manager/owner-words.jsonl` (appended only by the manager's
 * `UserPromptSubmit` hook, see bin/flow-manager-owner-words.ts). A `source:
 * owner` ruling must cite an entry here whose text names the pipeline.
 */

import * as fs from "node:fs";
import { resolveHandle } from "./manager-handles";
import { managerFile, managerHome } from "./manager-home";
import { readProposals } from "./manager-proposals";

export type OwnerWords = { id: string; ts: string; text: string };

/** Tolerant: a missing file reads as none; torn or shapeless lines are skipped. */
export function readOwnerWords(home: string = managerHome()): OwnerWords[] {
  let raw: string;
  try {
    raw = fs.readFileSync(managerFile("owner-words.jsonl", home), "utf8");
  } catch {
    return [];
  }
  const out: OwnerWords[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as Partial<OwnerWords>;
      if (
        typeof v.id === "string" &&
        typeof v.ts === "string" &&
        typeof v.text === "string"
      ) {
        out.push({ id: v.id, ts: v.ts, text: v.text });
      }
    } catch {
      // skip a torn line
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole-token match, so slug `fix` is not named by "fix-login". */
function names(text: string, token: string): boolean {
  return new RegExp(
    `(?<![A-Za-z0-9_-])${escape(token)}(?![A-Za-z0-9_-])`,
    "i",
  ).test(text);
}

/**
 * Does the owner's text name this pipeline: its slug, an open proposal about
 * it, or the `#N` handle currently printed beside its needs-you line in this
 * phase?
 */
export function wordsNameTarget(
  text: string,
  target: { slug: string; phase: string },
  home: string = managerHome(),
): boolean {
  if (names(text, target.slug)) return true;
  for (const m of text.matchAll(/#\d+\b/g)) {
    const h = resolveHandle(m[0], home);
    if (h && h.slug === target.slug && h.phase === target.phase) return true;
  }
  return readProposals(home).some(
    (p) => p.slug === target.slug && names(text, p.id),
  );
}

/** The most recent owner prompt at or after `since` that names the target. */
export function findOwnerWords(
  target: { slug: string; phase: string },
  since: string,
  home: string = managerHome(),
): OwnerWords | null {
  const t0 = Date.parse(since);
  return (
    readOwnerWords(home)
      .filter(
        (w) => Date.parse(w.ts) >= t0 && wordsNameTarget(w.text, target, home),
      )
      .at(-1) ?? null
  );
}
