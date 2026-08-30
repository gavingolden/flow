import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { extractPathAnchors } from "./value-anchors";

/**
 * Pure, mechanical body-shape checker for the flow-value-rubric contract
 * (`skills/universal/flow-backlog-triage/references/value-rubric.md`).
 * Modeled on `bin/lib/conflict-markers.ts` / `bin/lib/foreclosed-paths-format.ts`:
 * string work only, no markdown/YAML parser, never throws on malformed
 * input. Consumed by `bin/flow-create-issue.ts`; must not import from
 * `bin/` (would create a `lib -> bin` dependency).
 *
 * Hard misses reject a body outright; advisory warnings never block — a
 * false rejection at the filing surface would lose the finding entirely
 * (banned phrasing and anchor-path existence are both real but noisy
 * signals, so they warn instead of reject).
 */

export const REQUIRED_LABELS = [
  "UX",
  "Problem",
  "Stability/efficiency",
  "Value rank",
  "Complexity",
  "Risk",
  "If never done",
  "Verdict",
] as const;

export const VALUE_RANKS = ["1", "2", "3", "4", "5"] as const;
export const COMPLEXITY_LEVELS = [
  "Trivial",
  "Small",
  "Medium",
  "Large",
] as const;
export const RISK_LEVELS = ["Low", "Medium", "High"] as const;

const BANNED_PHRASES = [
  "nicer",
  "cleaner",
  "could improve",
  "might",
  "best practice",
  "would be good to",
  "likely",
];

export type IssueBodyCheck = { misses: string[]; warnings: string[] };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labelValueLine(body: string, label: string): string | null {
  const re = new RegExp(`-\\s*\\*\\*${escapeRegExp(label)}:\\*\\*\\s*(.*)`);
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

function hasLabel(body: string, label: string): boolean {
  return new RegExp(`-\\s*\\*\\*${escapeRegExp(label)}:\\*\\*`).test(body);
}

function isUnanchoredOrNone(line: string | null): boolean {
  if (line === null) return true;
  if (/^none\b/i.test(line)) return true;
  return !line.includes("[anchor:");
}

function checkAnchorExistence(
  text: string,
  repoRoot: string | undefined,
  warnings: string[],
): void {
  if (!repoRoot) return;
  for (const anchor of extractPathAnchors(text)) {
    const abs = resolve(repoRoot, anchor);
    const rel = relative(repoRoot, abs);
    const inRepo = !isAbsolute(anchor) && rel !== "" && !rel.startsWith("..");
    if (!inRepo || !existsSync(abs)) {
      warnings.push(
        `anchor path does not resolve under the repo root: ${anchor}`,
      );
    }
  }
}

function checkBannedPhrasing(text: string, warnings: string[]): void {
  for (const phrase of BANNED_PHRASES) {
    const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i");
    if (re.test(text)) {
      warnings.push(`banned phrasing: '${phrase}'`);
    }
  }
}

/**
 * Checks an issue body against the flow-value-rubric contract. Never
 * throws. `opts.repoRoot`, when supplied, enables the anchor-path
 * existence warning; omitting it skips that check entirely (never a hard
 * miss either way).
 */
export function checkIssueBody(
  body: string,
  opts: { repoRoot?: string } = {},
): IssueBodyCheck {
  const misses: string[] = [];
  const warnings: string[] = [];
  const trimmed = (body ?? "").trim();

  if (!trimmed) {
    misses.push("empty-body");
    return { misses, warnings };
  }

  checkBannedPhrasing(trimmed, warnings);

  const shortFormMatch = trimmed.match(/\*\*Short form:\*\*\s*(.*)/);
  if (shortFormMatch) {
    const line = shortFormMatch[1];
    const tupleRe =
      /\[V:([1-5])\|C:(Trivial|Small|Medium|Large)\|R:(Low|Medium|High)\]/;
    if (!tupleRe.test(line)) {
      misses.push("short-form-missing-tuple");
    }
    if (!line.includes("[anchor:")) {
      misses.push("short-form-unanchored");
    }
    checkAnchorExistence(line, opts.repoRoot, warnings);
    return { misses, warnings };
  }

  let sawMissingLabel = false;
  for (const label of REQUIRED_LABELS) {
    if (!hasLabel(trimmed, label)) {
      misses.push(`missing-label:${label}`);
      sawMissingLabel = true;
    }
  }

  if (sawMissingLabel && !hasLabel(trimmed, "UX")) {
    // Neither the short form nor a recognizable full block is present.
    misses.push("missing-value-block");
  }

  const rankLine = labelValueLine(trimmed, "Value rank");
  if (rankLine !== null) {
    const rankMatch = rankLine.match(/`?([1-5])`?/);
    if (
      !rankMatch ||
      !VALUE_RANKS.includes(rankMatch[1] as (typeof VALUE_RANKS)[number])
    ) {
      misses.push("invalid-value-rank");
    } else if (!rankLine.includes("[anchor:")) {
      misses.push("invalid-value-rank");
    }
  }

  const complexityLine = labelValueLine(trimmed, "Complexity");
  if (complexityLine !== null) {
    const found = COMPLEXITY_LEVELS.find((lvl) =>
      complexityLine.startsWith(lvl),
    );
    if (!found) misses.push("invalid-complexity");
  }

  const riskLine = labelValueLine(trimmed, "Risk");
  if (riskLine !== null) {
    const found = RISK_LEVELS.find((lvl) => riskLine.startsWith(lvl));
    if (!found) misses.push("invalid-risk");
  }

  const verdictLine = labelValueLine(trimmed, "Verdict");
  if (verdictLine !== null) {
    if (!/^`?(clears bar|below bar)/i.test(verdictLine)) {
      misses.push("invalid-verdict");
    }
  }

  const uxLine = labelValueLine(trimmed, "UX");
  const problemLine = labelValueLine(trimmed, "Problem");
  const stabilityLine = labelValueLine(trimmed, "Stability/efficiency");
  if (
    isUnanchoredOrNone(uxLine) &&
    isUnanchoredOrNone(problemLine) &&
    isUnanchoredOrNone(stabilityLine)
  ) {
    misses.push("unsubstantiated");
  }

  checkAnchorExistence(trimmed, opts.repoRoot, warnings);

  return { misses, warnings };
}
