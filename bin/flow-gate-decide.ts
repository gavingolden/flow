#!/usr/bin/env bun
/**
 * Computes the auto-merge gate decision for a PR.
 *
 * Why: `references/auto-merge-rubric.md` is the single source of truth for
 * a four-step parse (heading-presence grep → section extract → HTML-comment
 * strip → unchecked-`- [ ]`-count) combined with a four-state matrix (PR
 * state × autoMerge opt-out × section verdict). The agent's failure mode
 * is skipping step 1 — the unchecked-count check returns the same `0` for
 * both "heading missing" (escalate) and "no unchecked items left"
 * (auto-merge); silently treating the former as the latter ships a PR the
 * user expected to be gated. This helper makes the parse mechanical.
 *
 * Usage:
 *   flow-gate-decide <PR> --slug <slug>
 *
 * Output: a single JSON object on stdout.
 *   {
 *     "decision": "auto-merge" | "gated" | "merged-externally"
 *               | "closed-no-merge" | "escalate-heading-missing"
 *               | "escalate-gh-error",
 *     "prState": "OPEN" | "MERGED" | "CLOSED",
 *     "prUrl": "https://github.com/.../pull/<n>",
 *     "validationItems": ["..."],   // present when decision == "gated"
 *     "reason": "<one-line summary>",
 *     "autoMerge": true | false
 *   }
 *
 * Exit codes:
 *   0 — decision computed (any kind, including escalations — caller branches on `decision`)
 *   2 — bad CLI args
 */

import { spawnSync } from "node:child_process";
import { readState } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";

export type Decision =
  | "auto-merge"
  | "gated"
  | "merged-externally"
  | "closed-no-merge"
  | "escalate-heading-missing"
  | "escalate-gh-error";

export type DecisionResult = {
  decision: Decision;
  prState?: "OPEN" | "MERGED" | "CLOSED";
  prUrl?: string;
  validationItems?: string[];
  reason: string;
  autoMerge: boolean;
};

export type GateInputs = {
  body: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  url: string;
  autoMerge: boolean;
};

const HEADING_RE = /^## Test Steps[ \t]*$/m;

/**
 * Pure parse of the Test Steps section.
 *
 *   - "missing"        → no `## Test Steps` heading at column 0.
 *   - "no-unchecked"   → heading present, zero unchecked `- [ ]` items after
 *                        HTML-comment strip. Includes pure-internal PRs (only
 *                        a placeholder comment), pr-review-completed sections
 *                        (only `- [x]` items + `<details>` evidence blocks),
 *                        and PRs with prose-only bodies.
 *   - "has-unchecked"  → heading present, ≥1 unchecked `- [ ]` items remain.
 *                        `uncheckedItems` lists each one (text only, marker
 *                        stripped).
 *
 * The bullet-driven contract (vs. the prior emptiness check) is required for
 * pr-review's `<details>` evidence-block injection — see auto-merge-rubric.md
 * "Why bullet-driven instead of body-emptiness".
 */
export function parseTestStepsSection(
  body: string,
):
  | { kind: "missing" }
  | { kind: "no-unchecked" }
  | { kind: "has-unchecked"; uncheckedItems: string[] } {
  if (!HEADING_RE.test(body)) return { kind: "missing" };

  // Extract from the heading line to the next `## ` heading at column 0
  // (or end-of-input). awk-equivalent: flag-loop bounded by another H2.
  const lines = body.split("\n");
  const startIdx = lines.findIndex((l) => HEADING_RE.test(l));
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  let section = lines.slice(startIdx + 1, endIdx).join("\n");

  // Strip HTML comments (multi-line, non-greedy). Same as `perl -0pe 's/<!--.*?-->//gs'`.
  // The strip is essential: the PR template's instructional comment carries no
  // `- [ ]` items, so on a pure-internal change the section has zero unchecked
  // items after the strip → auto-merge.
  section = section.replace(/<!--[\s\S]*?-->/g, "");

  // Count unchecked items only. The match anchors on `- [ ]` (with the literal
  // single space) at the start of any line, optionally indented. `- [x]` and
  // `- [X]` (ticked) do NOT count — pr-review ticks runnable items in place
  // and we should treat those as completed.
  const uncheckedItems: string[] = [];
  for (const raw of section.split("\n")) {
    const m = raw.match(/^\s*-\s+\[ \]\s+(.*\S)\s*$/);
    if (m) uncheckedItems.push(m[1]);
  }

  if (uncheckedItems.length === 0) return { kind: "no-unchecked" };
  return { kind: "has-unchecked", uncheckedItems };
}

export function decide(inputs: GateInputs): DecisionResult {
  const { body, state, url, autoMerge } = inputs;

  if (state === "MERGED") {
    return {
      decision: "merged-externally",
      prState: state,
      prUrl: url,
      reason: "PR was merged externally; supervisor cleans up worktree only",
      autoMerge,
    };
  }
  if (state === "CLOSED") {
    return {
      decision: "closed-no-merge",
      prState: state,
      prUrl: url,
      reason: "PR closed without merge; needs human inspection",
      autoMerge,
    };
  }

  // OPEN: parse the section.
  const section = parseTestStepsSection(body);
  if (section.kind === "missing") {
    return {
      decision: "escalate-heading-missing",
      prState: state,
      prUrl: url,
      reason: "test-steps-section-missing",
      autoMerge,
    };
  }
  if (section.kind === "no-unchecked") {
    if (!autoMerge) {
      return {
        decision: "gated",
        prState: state,
        prUrl: url,
        validationItems: [],
        reason: "auto-merge opted out (--no-auto-merge)",
        autoMerge,
      };
    }
    return {
      decision: "auto-merge",
      prState: state,
      prUrl: url,
      reason: "no unchecked test steps; auto-merge",
      autoMerge,
    };
  }
  // has-unchecked → gated
  return {
    decision: "gated",
    prState: state,
    prUrl: url,
    validationItems: section.uncheckedItems,
    reason: section.uncheckedItems[0] ?? "test steps remaining",
    autoMerge,
  };
}

// --- gh + state.json wiring ------------------------------------------------

type GhResult = { stdout: string; stderr: string; exitCode: number };
export type GhRunner = (argv: string[]) => GhResult;

const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

type FetchResult =
  | { kind: "ok"; body: string; state: "OPEN" | "MERGED" | "CLOSED"; url: string }
  | { kind: "error"; message: string };

export function fetchPrInputs(prNumber: number, gh: GhRunner): FetchResult {
  const r = gh(["pr", "view", String(prNumber), "--json", "body,state,url"]);
  if (r.exitCode !== 0) {
    return {
      kind: "error",
      message: r.stderr.trim() || `gh pr view failed (${r.exitCode})`,
    };
  }
  let parsed: { body?: string; state?: string; url?: string };
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return { kind: "error", message: `gh pr view returned non-JSON: ${(e as Error).message}` };
  }
  if (
    typeof parsed.body !== "string" ||
    typeof parsed.url !== "string" ||
    (parsed.state !== "OPEN" && parsed.state !== "MERGED" && parsed.state !== "CLOSED")
  ) {
    return { kind: "error", message: `gh pr view returned unexpected JSON: ${r.stdout}` };
  }
  return { kind: "ok", body: parsed.body, state: parsed.state, url: parsed.url };
}

// --- CLI -------------------------------------------------------------------

type Args = { pr: number; slug: string };

export function parseArgs(argv: string[]): Args | { error: string } {
  if (argv.length === 0) return { error: "PR number is required" };
  const [first, ...rest] = argv;
  if (first.startsWith("--")) return { error: "PR number must be the first positional argument" };
  const pr = Number.parseInt(first, 10);
  if (!Number.isFinite(pr) || pr <= 0 || String(pr) !== first) {
    return { error: `PR must be a positive integer, got '${first}'` };
  }
  let slug: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--slug") {
      const v = rest[i + 1];
      if (!v || v.startsWith("--")) return { error: "--slug requires a value" };
      slug = v;
      i++;
      continue;
    }
    return { error: `unknown flag: ${flag}` };
  }
  if (!slug) return { error: "--slug is required" };
  return { pr, slug };
}

export type Deps = {
  gh?: GhRunner;
  stateDir?: string;
};

export function run(argv: string[], deps: Deps = {}): number {
  const gh = deps.gh ?? defaultGh;
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-gate-decide: ${parsed.error}`);
    console.error("usage: flow-gate-decide <PR> --slug <slug>");
    return 2;
  }

  // Read autoMerge from state.json. Absent state file → fall back to default
  // true (matches the documented happy-path default in lib/state.ts).
  const state = readState(parsed.slug, stateDir);
  const autoMerge = state?.autoMerge ?? true;

  const fetched = fetchPrInputs(parsed.pr, gh);
  if (fetched.kind === "error") {
    const result: DecisionResult = {
      decision: "escalate-gh-error",
      reason: fetched.message,
      autoMerge,
    };
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  }

  const result = decide({
    body: fetched.body,
    state: fetched.state,
    url: fetched.url,
    autoMerge,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
