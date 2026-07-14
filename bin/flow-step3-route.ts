#!/usr/bin/env bun
/**
 * Routes /flow-pipeline Step 3's non-feature-intent end-condition based
 * on whether plan.md's `## Prompt interpretation` section flags a
 * prescribed-methods-vs-target tension.
 *
 * Why: skills/pipeline/flow-pipeline/SKILL.md Step 3 needs a deterministic
 * decision between "advance-to-step-5" (existing non-feature behaviour)
 * and "route-to-step-4" (new tension-aware approval checkpoint). Pinning
 * the four-value Recommended-path enum here keeps drift detectable —
 * bin/flow-step3-route.test.ts enforces the matrix on the helper side,
 * the upstream contract at
 * skills/pipeline/flow-product-planning/references/discovery-instructions.md
 * "Prompt interpretation (conditional)" enforces it on the discovery
 * subagent side. The AGENTS.md `## Output style` rule **Treat user
 * prompts as evidence of intent, not exhaustive specifications.**
 * documents the rationale; PR #170 is the canonical precedent.
 *
 * Usage:
 *   flow-step3-route --intent <intent> --plan-md-file <path>
 *
 * Allowed intents: feature | bug | refactor | docs | infra | chore.
 *
 * Output (stdout):
 *   "advance-to-step-5\n" — fall through to Step 5 (no tension OR
 *                            intent is non-feature and plan.md's
 *                            Recommended path is `methods plausibly
 *                            reach target` OR plan.md has no
 *                            Prompt-Interpretation section). NOTE: the
 *                            supervisor runs its non-feature
 *                            candidate-issues sub-step (via
 *                            `flow-candidate-issues`) on this path
 *                            BEFORE entering Step 5 — so a non-feature
 *                            pipeline with discovered follow-ups is
 *                            still offered the candidate-issues prompt;
 *                            this is NOT a straight jump to Step 5.
 *                            Surrounding backtick/bold decoration and
 *                            a trailing `. , ; :` punctuation run on
 *                            the enum value are tolerated; case
 *                            variants and trailing words are not.
 *   "route-to-step-4\n"   — emit AWAITING APPROVAL (feature intent OR
 *                            Recommended path is one of `extend scope
 *                            with named additional safe steps` /
 *                            `relax target` / `split into multiple
 *                            pipelines`).
 *
 * Exit codes:
 *   0 — decision written to stdout
 *   2 — bad CLI args / file read failure (error written to stderr)
 */

import { readFileSync } from "node:fs";

export type Decision = "advance-to-step-5" | "route-to-step-4";

export type Intent =
  | "feature"
  | "bug"
  | "refactor"
  | "docs"
  | "infra"
  | "chore";

export const ALLOWED_INTENTS: readonly Intent[] = [
  "feature",
  "bug",
  "refactor",
  "docs",
  "infra",
  "chore",
];

const ALLOWED_INTENT_SET: ReadonlySet<string> = new Set(ALLOWED_INTENTS);

/**
 * The "no tension" enum value. The other three Recommended-path values
 * (`extend scope with named additional safe steps`, `relax target`,
 * `split into multiple pipelines`) all signal tension; the helper
 * routes to Step 4 for any non-equal value. The match is exact against
 * this canonical string AFTER `extractRecommendedPath` strips
 * surrounding backtick/bold decoration and a trailing `. , ; :`
 * punctuation run: it is case-sensitive and does NOT tolerate trailing
 * words or substring variants. "methods plausibly reach target
 * eventually" must NOT match — substring-tolerance is the
 * silent-passthrough footgun this helper exists to prevent.
 *
 * Single source of truth for the four enum values:
 * skills/pipeline/flow-product-planning/references/discovery-instructions.md
 * "Prompt interpretation (conditional)".
 */
const NO_TENSION_PATH = "methods plausibly reach target";

export type RouteInputs = {
  intent: Intent;
  planMdFile: string;
};

/**
 * Pure decision function. Tests hit this directly with inline plan
 * strings to enumerate the four-cell matrix without touching disk.
 */
export function decideStep3Route(intent: Intent, planMd: string): Decision {
  if (intent === "feature") {
    return "route-to-step-4";
  }

  const recommendedPath = extractRecommendedPath(planMd);
  if (recommendedPath === null) {
    return "advance-to-step-5";
  }

  if (recommendedPath === NO_TENSION_PATH) {
    return "advance-to-step-5";
  }

  return "route-to-step-4";
}

/**
 * Extract the Recommended-path enum value from plan.md.
 *
 * Returns null when the `## Prompt interpretation` heading is absent
 * (the omit-when-no-tension contract from discovery-instructions.md).
 * Returns the trimmed enum string when present; the caller decides
 * how to react to non-`methods plausibly reach target` values.
 *
 * Section shape (per discovery-instructions.md):
 *
 *   ## Prompt interpretation
 *
 *   - **Reading of prescribed methods:** ...
 *   - **Plausibility estimate:** ...
 *   - **Recommended path:** <enum value>
 *
 * Heading-level detection is strict: only level-2 (`## `) counts.
 * Level-3 (`### `) is intentionally not recognised — the contract
 * specifies a top-level section, and a level-3 nested heading is
 * either a stale formatting choice or a different concept entirely.
 *
 * Section bound: the next level-1 or level-2 heading (whichever
 * appears first). A nested level-3 sub-heading inside the section
 * does NOT bound it.
 *
 * Value parsing tolerates bullet prefix (`- `), bolded label
 * (`**Recommended path:**`), surrounding markdown decoration
 * (any interleaving of bolding and backticks around the value
 * itself), and a trailing run of `. , ; :` punctuation. It does NOT
 * tolerate case variants or a trailing WORD (`...target eventually`)
 * — exact-string match against the canonical enum is the contract,
 * and a trailing word is a paraphrase, not decoration.
 *
 * Two label shapes are accepted:
 *   1. Canonical colon-same-line — `- **Recommended path:** <value>` —
 *      with the value on the same line as the colon.
 *   2. Drifted bold-period/next-line — a label line of the form
 *      `- **Recommended path.**` (bold, trailing period, NO colon, NO
 *      same-line value) whose value is the next NON-BLANK line. This
 *      tolerates the period-form drift the discovery subagent can emit
 *      when copying the prose label punctuation as output.
 * Both shapes feed the same decoration-stripping normalisation loop, so
 * the case/substring/trailing-word guards apply identically. Drifted-form
 * detection is bounded by the same section slice, so the next-line reader
 * never bleeds past the section boundary and never mis-fires on the
 * sibling `Reading of prescribed methods` / `Plausibility estimate`
 * bullets (those carry their own value on-line and are not period-form
 * Recommended-path labels).
 */
export function extractRecommendedPath(planMd: string): string | null {
  const sectionMatch = planMd.match(/^## Prompt interpretation\s*$/m);
  if (!sectionMatch) {
    return null;
  }

  const afterHeading = (sectionMatch.index ?? 0) + sectionMatch[0].length;
  const rest = planMd.slice(afterHeading);
  const nextSection = rest.search(/^#{1,2} /m);
  const sectionBody = nextSection === -1 ? rest : rest.slice(0, nextSection);

  // Decoration around "Recommended path" can be bolding (**), backticks (`),
  // or a mix on either side of the colon. The `[*\x60]*` class consumes any
  // mix and the colon is required (the contract is `**Recommended path:**`,
  // not `**Recommended path**` with no separator).
  const pathMatch = sectionBody.match(
    /^[\s-]*[*`]*Recommended path[*`]*:[*`]*\s*(.+?)\s*$/m,
  );

  let raw: string;
  if (pathMatch) {
    raw = pathMatch[1].trim();
  } else {
    // Drifted shape: a bold-period label (`- **Recommended path.**`) with
    // NO colon and NO same-line value; the value is the next non-blank
    // line within the section. The label match is anchored to the line and
    // forbids a colon, so it cannot collide with the colon-form above.
    const driftMatch = sectionBody.match(
      /^[ \t-]*[*`]*Recommended path[*`]*\.[*`]*[ \t]*$([\s\S]*)/m,
    );
    if (!driftMatch) {
      return null;
    }
    const nextLineMatch = driftMatch[1].match(/^\s*([^\s].*?)\s*$/m);
    if (!nextLineMatch) {
      return null;
    }
    raw = nextLineMatch[1].trim();
  }

  // Normalise interleaved decoration to the bare enum string. Each
  // pass strips ONE surrounding `**...**` pair, ONE surrounding
  // `` `...` `` pair, OR a trailing `. , ; :` punctuation run, then
  // loops; this collapses any ordering (e.g. backticks outside bold)
  // and any trailing punctuation. Only decoration chars (* and
  // backtick) and trailing `. , ; :` are stripped — never
  // alphanumerics, never case-normalised, so a trailing word survives.
  let value = raw;
  for (;;) {
    let changed = false;
    if (value.startsWith("**") && value.endsWith("**") && value.length > 4) {
      value = value.slice(2, -2).trim();
      changed = true;
    } else if (
      value.startsWith("`") &&
      value.endsWith("`") &&
      value.length > 2
    ) {
      value = value.slice(1, -1).trim();
      changed = true;
    } else {
      const detrailed = value.replace(/[.,;:\s]+$/, "");
      if (detrailed !== value) {
        value = detrailed;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return value;
}

export function parseArgs(argv: string[]): RouteInputs | { error: string } {
  let intent: string | undefined;
  let planMdFile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--intent": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          return { error: "--intent requires a value" };
        }
        intent = value;
        i++;
        continue;
      }
      case "--plan-md-file": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          return { error: "--plan-md-file requires a value" };
        }
        planMdFile = value;
        i++;
        continue;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }

  if (intent === undefined) return { error: "missing required flag: --intent" };
  if (planMdFile === undefined) {
    return { error: "missing required flag: --plan-md-file" };
  }
  if (!ALLOWED_INTENT_SET.has(intent)) {
    return {
      error:
        `unknown --intent '${intent}'; allowed: ` + ALLOWED_INTENTS.join(", "),
    };
  }

  return { intent: intent as Intent, planMdFile };
}

export function run(argv: string[]): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`flow-step3-route: ${parsed.error}\n`);
    process.stderr.write(
      "usage: flow-step3-route --intent <intent> --plan-md-file <path>\n",
    );
    return 2;
  }

  let planMd: string;
  try {
    planMd = readFileSync(parsed.planMdFile, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `flow-step3-route: failed to read --plan-md-file '${parsed.planMdFile}': ${msg}\n`,
    );
    return 2;
  }

  process.stdout.write(decideStep3Route(parsed.intent, planMd) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
