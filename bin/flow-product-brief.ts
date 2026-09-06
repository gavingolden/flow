#!/usr/bin/env bun
/**
 * Resolves the repository's standing PRODUCT BRIEF — the small committed
 * markdown file that states what this repo's product manager optimizes for —
 * and prints it as one JSON line. Precedence is fixed: the repo's
 * `.flow/product.md` first, then the user-level `~/.flow/product.md`
 * fallback. Nothing else; there is no config key and no environment
 * override (see `references/consumer-repo-contract.md` "Product brief").
 *
 * Absent is a legitimate, common state, not an error. Every failure path —
 * no git repo, no file, an unreadable file, a whitespace-only file —
 * resolves to `{ found: false }` and exit 0, so NO caller needs a guard.
 * Prose call sites (the `/flow-product-planning` discovery subagent) invoke
 * this by BARE PATH NAME, because they run in the consumer/target worktree
 * where flow's own `bin/lib` does not exist; flow's own PATH helpers
 * (`bin/flow-plan-review.ts`) import `resolveProductBrief` directly. Same
 * split `bin/lib/output-lens.ts` documents.
 *
 * Tolerant-boundary-reader discipline, mirroring `bin/lib/output-lens.ts`:
 * injectable seams (`cwd` / `homeDir` / `readFile` / `repoRoot`), absent ≡
 * the `{ found: false }` arm, never throws.
 *
 * Usage:
 *   flow-product-brief          # one JSON line on stdout, always exit 0
 *
 * Envelope:
 *   {"found":true,"scope":"repo"|"user","path":"<abs>","text":"<contents>"}
 *   {"found":false}
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRepoRoot } from "./lib/repo-root";

/**
 * The resolved brief. A DISCRIMINATED UNION rather than a uniform shape
 * with nulls: a caller that forgets to branch on `found` gets a type error
 * instead of threading `null` into a prompt. Two epic manifest acceptance
 * criteria pin these exact field sets — widening them is a cross-feature
 * break for the downstream judge/critic, not a local simplification.
 */
export type ProductBrief =
  | { found: true; scope: "repo" | "user"; path: string; text: string }
  | { found: false };

/**
 * Upper bound on the brief text every consumer inherits. A brief is
 * human-authored and small today, but nothing bounds the file — and its own
 * top-ranked priority is cost, so an accidentally-large brief must not
 * silently inflate every cross-model prompt that quotes it.
 */
export const BRIEF_CHAR_CAP = 4000;

export const TRUNCATION_MARKER = `… [brief truncated at ${BRIEF_CHAR_CAP} chars]`;

/**
 * The closing delimiter a consuming prompt fences the brief with
 * (`bin/lib/plan-review-prompt.ts`). Neutralised HERE rather than at each
 * call site so every present and future consumer inherits the fix: a fence
 * is only as strong as the fenced text's inability to close it early, and
 * the brief is committed repo text sent verbatim to an external provider.
 */
const CLOSING_DELIMITER = "</product_brief>";
const NEUTRALISED_DELIMITER = "<\\/product_brief>";

type FenceState = { open: boolean; marker: string };

/**
 * Tracks markdown fenced-code state across lines so a truncation can close
 * a fence it cut through. Only the opening marker's own character (``` or
 * ~~~) closes it, matching CommonMark closely enough for a prompt block.
 */
function scanFences(text: string): FenceState {
  let open = false;
  let marker = "```";
  for (const line of text.split("\n")) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!m) continue;
    if (!open) {
      open = true;
      marker = m[1];
    } else if (m[1][0] === marker[0] && m[1].length >= marker.length) {
      open = false;
    }
  }
  return { open, marker };
}

/**
 * Caps `text` at `BRIEF_CHAR_CAP`, cutting on a NEWLINE boundary rather
 * than mid-token, then closing any code fence the cut left dangling before
 * appending the truncation marker. A cut inside an unclosed fence would
 * corrupt the prompt block the brief is embedded in — which is the whole
 * hazard the cap exists to prevent, not a cosmetic detail. Falls back to a
 * hard cut only when the very first line already exceeds the cap.
 */
function capBriefText(text: string): string {
  if (text.length <= BRIEF_CHAR_CAP) return text;
  const head = text.slice(0, BRIEF_CHAR_CAP);
  const lastNewline = head.lastIndexOf("\n");
  const cut = lastNewline > 0 ? head.slice(0, lastNewline) : head;
  const fence = scanFences(cut);
  const closed = fence.open ? `${cut}\n${fence.marker}` : cut;
  return `${closed}\n\n${TRUNCATION_MARKER}`;
}

/** Neutralise, then cap. Order matters: escaping lengthens the text. */
function normaliseBriefText(raw: string): string {
  return capBriefText(raw.split(CLOSING_DELIMITER).join(NEUTRALISED_DELIMITER));
}

export type ResolveOptions = {
  /** Directory resolution starts from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory for the user-level fallback. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** File reader seam; must throw on an unreadable path. */
  readFile?: (p: string) => string;
  /** Repo-root seam; returns null when `cwd` is not inside a git repo. */
  repoRoot?: (cwd: string) => string | null;
};

function defaultReadFile(p: string): string {
  return fs.readFileSync(p, "utf8");
}

/**
 * Resolves the product brief: the repo's `.flow/product.md`, else the
 * user-level `~/.flow/product.md`, else absent. Resolution starts from the
 * CURRENT worktree, so a `flow-new-worktree` checkout finds its own brief
 * and never the main checkout's. Never throws — an unresolvable repo root,
 * an unreadable file, or a whitespace-only file all yield `{ found: false }`.
 */
export function resolveProductBrief(opts: ResolveOptions = {}): ProductBrief {
  const cwd = opts.cwd ?? process.cwd();
  const readFile = opts.readFile ?? defaultReadFile;
  const findRepoRoot = opts.repoRoot ?? resolveRepoRoot;

  const candidates: Array<{ scope: "repo" | "user"; path: string }> = [];

  let root: string | null = null;
  try {
    root = findRepoRoot(cwd);
  } catch {
    root = null;
  }
  if (root) {
    candidates.push({
      scope: "repo",
      path: path.join(root, ".flow", "product.md"),
    });
  }

  let home: string | null = null;
  try {
    home = opts.homeDir ?? os.homedir();
  } catch {
    home = null;
  }
  if (home) {
    candidates.push({
      scope: "user",
      path: path.join(home, ".flow", "product.md"),
    });
  }

  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = readFile(candidate.path);
    } catch {
      continue;
    }
    if (typeof raw !== "string" || raw.trim() === "") continue;
    return {
      found: true,
      scope: candidate.scope,
      path: candidate.path,
      text: normaliseBriefText(raw),
    };
  }

  return { found: false };
}

/**
 * Prints the envelope as one JSON line. No flags: path injection is a
 * library seam (`resolveProductBrief`'s options), not a CLI surface.
 * Returns 0 unconditionally so no caller needs a guard.
 */
export function main(): number {
  let envelope: ProductBrief;
  try {
    envelope = resolveProductBrief();
  } catch {
    envelope = { found: false };
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
