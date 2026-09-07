/**
 * Producer/consumer parity for stage A's escalation reasons: every value
 * `workflows/core/flow-stage-a.workflow.js` can pass to
 * `flow-gate-summary --reason` must have a `NEXT_ACTION_BY_REASON` entry,
 * or the NEEDS HUMAN block prints `DEFAULT_NEXT_ACTION`'s generic text
 * instead of a recovery command.
 *
 * A grep over string literals would ship a false green: three of the
 * script's `needsHuman()` calls pass an EXPRESSION, not a literal. So the
 * extractor classifies every call site — a double-quoted literal is STATIC
 * and must be a renderer key; anything else is DYNAMIC and must match one
 * of a small allowlist of expression texts, each mapped to the runtime set
 * of values it can produce. An unrecognised dynamic expression is a HARD
 * FAILURE, never a skip, so a future dynamic form cannot be absorbed
 * silently. The extraction count is asserted against the raw
 * `needsHuman(` occurrence count for the same reason: a regex that skipped
 * a multi-line or template-literal argument would otherwise pass.
 *
 * Scope is stage A only. Stage B's `.outcome` values are remapped onto
 * already-covered tags by `## Stage B launch`'s outcome table before any
 * render call, so it emits no raw reason of its own.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEXT_ACTION_BY_REASON } from "./flow-gate-summary";
import { CI_DECISIONS } from "./lib/ci-decision";
import { PR_REVIEW_ESCALATION_TAGS } from "./lib/pr-review-result-schema";

const ROOT = join(import.meta.dirname, "..");
const STAGE_A = readFileSync(
  join(ROOT, "workflows/core/flow-stage-a.workflow.js"),
  "utf8",
);

/**
 * The two `Decision` members that can never reach a `needsHuman()` call:
 * the post-review-fix site returns early unless `check.decision` is one of
 * them (`check.decision !== "proceed-to-review" && check.decision !==
 * "proceed-to-review-no-bot"` guards the escalation), and the CI-outcome
 * site is reached only on a non-proceed decision.
 */
const UNREACHABLE_AT_SITE: readonly string[] = [
  "proceed-to-review",
  "proceed-to-review-no-bot",
];

/**
 * Dynamic reason expressions, keyed by their VERBATIM source text, mapped
 * to every value each can evaluate to. Adding a new dynamic `needsHuman()`
 * argument to the script means adding its expression here — the test fails
 * loudly until then.
 */
const DYNAMIC_REASON_SETS: Record<string, readonly string[]> = {
  ciOutcome: CI_DECISIONS,
  'check.decision || "ci-failed"': [...CI_DECISIONS, "ci-failed"],
  'readBack.escalation_tag || "review-escalated"': [
    ...PR_REVIEW_ESCALATION_TAGS,
    "review-escalated",
  ],
  // The terminal catch re-throws anything that is not an AgentUnavailable,
  // whose message is always `agent-unavailable: <label>`; the renderer
  // splits on the first ':' and looks up the head.
  "err.message": ["agent-unavailable"],
  // The two review fan-out sites: a lens that died on BOTH attempts is not
  // droppable (every per-lens artifact is mandatory consolidator input), so
  // it escalates with the dead lens's label after the ':'.
  "`agent-unavailable: ${deadLens}`": ["agent-unavailable"],
  "`agent-unavailable: ${deadWidened}`": ["agent-unavailable"],
};

/** Balanced-paren scan for the FIRST argument of every `needsHuman(` call
 * (the function's own definition header excluded), one entry per call site
 * — never a `continue`, so an unparseable argument surfaces as an empty
 * string that fails classification rather than vanishing. */
export function extractNeedsHumanArgs(source: string): string[] {
  const out: string[] = [];
  const re = /\bneedsHuman\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const before = source.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s*$/.test(before)) continue;
    const openIdx = m.index + m[0].length - 1;
    let depth = 0;
    let quote: string | null = null;
    let arg = "";
    let done = false;
    for (let i = openIdx; i < source.length && !done; i++) {
      const c = source[i];
      if (quote) {
        arg += c;
        if (c === "\\") arg += source[++i] ?? "";
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        arg += c;
        continue;
      }
      if (c === "(") {
        depth++;
        if (depth === 1) continue; // the opening paren itself
      } else if (c === ")") {
        depth--;
        if (depth === 0) done = true;
      }
      if (!done && c === "," && depth === 1) done = true;
      else if (!done) arg += c;
    }
    out.push(arg.trim());
  }
  return out;
}

/** Every non-definition `needsHuman(` occurrence — the independent count
 * the extractor is checked against. */
export function countNeedsHumanCalls(source: string): number {
  const total = (source.match(/\bneedsHuman\(/g) ?? []).length;
  const defs = (source.match(/function\s+needsHuman\(/g) ?? []).length;
  return total - defs;
}

export type CoverageReport = {
  /** Reason values with no `NEXT_ACTION_BY_REASON` entry. */
  unmapped: string[];
  /** Dynamic expressions the allowlist above does not recognise. */
  unknownDynamic: string[];
  /** Every reason value the script can emit, resolved. */
  resolved: string[];
};

export function classifyReasons(
  source: string,
  keys: readonly string[],
): CoverageReport {
  const known = new Set(keys);
  const unmapped: string[] = [];
  const unknownDynamic: string[] = [];
  const resolved: string[] = [];
  for (const arg of extractNeedsHumanArgs(source)) {
    const literal = arg.match(/^"([^"]*)"$/);
    if (literal) {
      const head = literal[1].split(":")[0].trim();
      resolved.push(head);
      if (!known.has(head)) unmapped.push(head);
      continue;
    }
    const values = DYNAMIC_REASON_SETS[arg];
    if (!values) {
      unknownDynamic.push(arg);
      continue;
    }
    for (const v of values) {
      if (UNREACHABLE_AT_SITE.includes(v)) continue;
      const head = v.split(":")[0];
      resolved.push(head);
      if (!known.has(head)) unmapped.push(head);
    }
  }
  return { unmapped, unknownDynamic, resolved };
}

const RENDERER_KEYS = Object.keys(NEXT_ACTION_BY_REASON);

describe("stage A reason coverage — extraction", () => {
  it("extracts one argument per needsHuman() call site, count-parity with the raw occurrences", () => {
    const args = extractNeedsHumanArgs(STAGE_A);
    expect(args.length).toBe(countNeedsHumanCalls(STAGE_A));
    expect(args.length).toBeGreaterThanOrEqual(8);
    expect(args.every((a) => a.length > 0)).toBe(true);
  });

  it("finds every dynamic reason expression, verbatim", () => {
    const args = new Set(extractNeedsHumanArgs(STAGE_A));
    for (const expr of Object.keys(DYNAMIC_REASON_SETS)) {
      expect(args.has(expr), `dynamic expression not found: ${expr}`).toBe(
        true,
      );
    }
  });

  it("[negative] a skipped call site would break count parity", () => {
    const doctored = `${STAGE_A}\nif (false) needsHuman(brandNewExpr, "x", ctx);\n`;
    const skipping = extractNeedsHumanArgs(doctored).filter(
      (a) => a !== "brandNewExpr",
    );
    expect(skipping.length).not.toBe(countNeedsHumanCalls(doctored));
  });
});

describe("stage A reason coverage — renderer parity", () => {
  it("every reason stage A can emit has a NEXT_ACTION_BY_REASON entry", () => {
    const report = classifyReasons(STAGE_A, RENDERER_KEYS);
    expect(
      report.unknownDynamic,
      `unrecognised dynamic reason expression(s) — add each to ` +
        `DYNAMIC_REASON_SETS in this file, mapped to the runtime set of ` +
        `values it can produce: ${JSON.stringify(report.unknownDynamic)}`,
    ).toEqual([]);
    expect(
      report.unmapped,
      `stage A can emit these reasons with no NEXT_ACTION_BY_REASON entry, ` +
        `so they render DEFAULT_NEXT_ACTION's generic text: ` +
        `${JSON.stringify([...new Set(report.unmapped)])}`,
    ).toEqual([]);
  });

  it("covers the tags the issue named, plus the dynamic families", () => {
    const resolved = new Set(classifyReasons(STAGE_A, RENDERER_KEYS).resolved);
    for (const tag of [
      "ci-failed",
      "pr-closed",
      "pr-conflicted",
      "merged-externally",
      "ci-wait-undecided",
      "review-escalated",
      "consolidator-schema-failure",
      "consolidator-missing-artifact",
      "intent-drift",
      "agent-unavailable",
    ]) {
      expect(resolved.has(tag), `not reachable from stage A: ${tag}`).toBe(
        true,
      );
    }
  });

  it("every escalation_tag in escalation-recipes.md is a PR_REVIEW_ESCALATION_TAGS member", () => {
    // The array's doc comment rejects scraping the SKILL.md table so a
    // reformat cannot turn a lint red — that covers the false-RED direction
    // only. This is the false-GREEN one: /flow-pr-review gains a sixth tag,
    // stage A forwards it verbatim via readBack.escalation_tag, and the
    // user gets DEFAULT_NEXT_ACTION again. Keyed on the JSON field, which a
    // reflow or a column-width change cannot move.
    const md = readFileSync(
      join(
        ROOT,
        "skills/pipeline/flow-pr-review/references/escalation-recipes.md",
      ),
      "utf8",
    );
    const documented = [...md.matchAll(/"escalation_tag":\s*"([^"]+)"/g)].map(
      (m) => m[1].split(":")[0].trim(),
    );
    expect(documented.length).toBeGreaterThan(0);
    expect(
      [...new Set(documented)].filter(
        (t) => !(PR_REVIEW_ESCALATION_TAGS as readonly string[]).includes(t),
      ),
    ).toEqual([]);
  });

  it("[negative] an unknown static tag fails the STATIC branch", () => {
    const doctored = `${STAGE_A}\nreturn needsHuman("made-up-tag", "x", ctx);\n`;
    const report = classifyReasons(doctored, RENDERER_KEYS);
    expect(report.unmapped).toContain("made-up-tag");
  });

  it("[negative] an unrecognised dynamic expression fails the allowlist", () => {
    const doctored = `${STAGE_A}\nreturn needsHuman(someNewExpr, "x", ctx);\n`;
    const report = classifyReasons(doctored, RENDERER_KEYS);
    expect(report.unknownDynamic).toEqual(["someNewExpr"]);
  });

  it("[negative] dropping a CI decision from the renderer fails coverage", () => {
    const thinned = RENDERER_KEYS.filter((k) => k !== "pr-closed");
    const report = classifyReasons(STAGE_A, thinned);
    expect(report.unmapped).toContain("pr-closed");
  });
});
