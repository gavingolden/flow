#!/usr/bin/env bun
/**
 * Owns the candidate-follow-up-issues matrix DECISION for /flow-pipeline.
 *
 * Why: the `# Candidate follow-up issues` section in plan.md drives a
 * five-branch decision (no-op / prompt / skip-already-ticked / overflow)
 * that fires from TWO supervisor sub-steps — step 4's affirmative branch
 * AND step 3's non-feature `advance-to-step-5` branch. Duplicating that
 * matrix as prose across both sites left exact-prose lints as the only
 * regression signal; lifting it here makes the decision mechanical and
 * unit-tested. The supervisor stays the only `AskUserQuestion` caller:
 * this helper is LLM-free, never prompts, and never decides whether to
 * prompt — it returns the `action` and the supervisor branches.
 *
 * The `--tick` mode performs the deterministic `- [ ]` → `- [x]` flip the
 * supervisor used to hand-match with `Edit` `old_string`/`new_string`, so
 * parse + flip live in one tested place. The `--ticked` mode emits the
 * already-`- [x]` items as `{ title, body }` pairs — the extractor step
 * 10's post-merge sweep consumes instead of hand-rolling its own awk +
 * em-dash split.
 *
 * Usage:
 *   flow-candidate-issues --plan-md-file <path> [--json]
 *   flow-candidate-issues --plan-md-file <path> --tick <1-based,comma,indices>
 *   flow-candidate-issues --plan-md-file <path> --ticked
 *
 * `--json` (the default) emits the decision object on stdout:
 *   { action, candidates, untickedCount, tickedCount }
 *   action ∈ "no-op" | "prompt" | "skip-already-ticked" | "overflow"
 *   candidates: [{ title, body }]  (the unticked items, in document order)
 *
 * `--tick <indices>` flips the selected UNTICKED items (1-based into the
 * `candidates` enumeration order) from `- [ ]` to `- [x]` in place and
 * emits { tickedIndices, tickedCount }.
 *
 * `--ticked` emits { ticked: [{ title, body }] } — the already-`- [x]`
 * items (empty array when the section is absent or has zero ticked items).
 *
 * Exit codes:
 *   0 — read / decision / tick / ticked succeeded
 *   2 — bad CLI args (file read failure, out-of-range tick index, etc.)
 */

import { readFileSync, writeFileSync } from "node:fs";

export type Action = "no-op" | "prompt" | "skip-already-ticked" | "overflow";

export type Candidate = { title: string; body: string };

export type Decision = {
  action: Action;
  candidates: Candidate[];
  untickedCount: number;
  tickedCount: number;
};

const HEADING_RE = /^# Candidate follow-up issues/;
const UNTICKED_RE = /^- \[ \] (.*)$/;
const TICKED_RE = /^- \[[xX]\] (.*)$/;

/**
 * Splits a candidate's text on the FIRST ` — ` (space-emdash-space) into
 * { title, body }. Body is "" when there is no delimiter. Mirrors the
 * step-10 sweep's `${line%% — *}` / `${line#* — }` Bash split: only the
 * first em-dash splits, so any further ` — ` inside body is preserved.
 */
export function splitCandidate(text: string): Candidate {
  const idx = text.indexOf(" — ");
  if (idx === -1) return { title: text, body: "" };
  return { title: text.slice(0, idx), body: text.slice(idx + " — ".length) };
}

type SectionItem = { lineIdx: number; ticked: boolean; text: string };

/**
 * Extracts the `# Candidate follow-up issues` section's item lines,
 * bounded from the heading to the next top-level `^# ` heading or EOF
 * (matches the step-10 sweep's awk bounds). Returns null when the
 * heading is absent. `lines` is the file split on "\n" (returned so the
 * tick path can rewrite by index without re-splitting).
 */
export function extractCandidateSection(
  planMd: string,
): { lines: string[]; items: SectionItem[] } | null {
  const lines = planMd.split("\n");
  const startIdx = lines.findIndex((l) => HEADING_RE.test(l));
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^# /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const items: SectionItem[] = [];
  for (let i = startIdx + 1; i < endIdx; i++) {
    const unticked = lines[i].match(UNTICKED_RE);
    if (unticked) {
      items.push({ lineIdx: i, ticked: false, text: unticked[1] });
      continue;
    }
    const ticked = lines[i].match(TICKED_RE);
    if (ticked) {
      items.push({ lineIdx: i, ticked: true, text: ticked[1] });
    }
  }
  return { lines, items };
}

/**
 * Pure decision over the section state. Tests hit this directly.
 *
 *   - heading absent                  → "no-op"
 *   - any item already `- [x]`        → "skip-already-ticked" (user
 *                                        pre-ticked; their choice wins
 *                                        regardless of unticked count)
 *   - zero unticked items             → "no-op" (count-0 / empty section)
 *   - 1–4 unticked items              → "prompt"
 *   - 5+ unticked items               → "overflow"
 */
export function decideCandidateIssues(planMd: string): Decision {
  const section = extractCandidateSection(planMd);
  if (!section) {
    return {
      action: "no-op",
      candidates: [],
      untickedCount: 0,
      tickedCount: 0,
    };
  }

  const untickedItems = section.items.filter((it) => !it.ticked);
  const tickedCount = section.items.length - untickedItems.length;
  const untickedCount = untickedItems.length;
  const candidates = untickedItems.map((it) => splitCandidate(it.text));

  let action: Action;
  if (tickedCount >= 1) {
    action = "skip-already-ticked";
  } else if (untickedCount === 0) {
    action = "no-op";
  } else if (untickedCount <= 4) {
    action = "prompt";
  } else {
    action = "overflow";
  }

  return { action, candidates, untickedCount, tickedCount };
}

/**
 * Pure extraction of the already-`- [x]` items as { title, body } pairs,
 * reusing the same section parse + first-` — `-split. Empty when the
 * section is absent or has zero ticked items.
 */
export function extractTicked(planMd: string): Candidate[] {
  const section = extractCandidateSection(planMd);
  if (!section) return [];
  return section.items
    .filter((it) => it.ticked)
    .map((it) => splitCandidate(it.text));
}

export type TickResult = { tickedIndices: number[]; tickedCount: number };

/**
 * Flips the UNTICKED items at the given 1-based indices (into the
 * `candidates` enumeration order) from `- [ ]` to `- [x]`. Pure: returns
 * the rewritten file text. Idempotent — re-running with the same indices
 * (now `- [x]`) is a no-op because those lines no longer count as
 * unticked. Throws on a non-integer or out-of-range index.
 */
export function tickCandidates(
  planMd: string,
  indices: number[],
): { text: string; result: TickResult } {
  const section = extractCandidateSection(planMd);
  const untickedItems = section ? section.items.filter((it) => !it.ticked) : [];

  for (const idx of indices) {
    if (!Number.isInteger(idx) || idx < 1 || idx > untickedItems.length) {
      throw new Error(
        `tick index out of range: ${idx} (have ${untickedItems.length} unticked candidate(s))`,
      );
    }
  }

  const lines = section ? section.lines : planMd.split("\n");
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  for (const idx of sorted) {
    const item = untickedItems[idx - 1];
    lines[item.lineIdx] = lines[item.lineIdx].replace("- [ ] ", "- [x] ");
  }

  return {
    text: lines.join("\n"),
    result: { tickedIndices: sorted, tickedCount: sorted.length },
  };
}

// --- CLI -------------------------------------------------------------------

type Mode = "json" | "tick" | "ticked";

type Args = {
  planMdFile: string;
  mode: Mode;
  tickIndices?: number[];
};

export function parseArgs(argv: string[]): Args | { error: string } {
  let planMdFile: string | undefined;
  let mode: Mode = "json";
  let tickIndices: number[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--plan-md-file") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--"))
        return { error: "--plan-md-file requires a value" };
      planMdFile = v;
      i++;
    } else if (flag === "--json") {
      mode = "json";
    } else if (flag === "--ticked") {
      mode = "ticked";
    } else if (flag === "--tick") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--"))
        return { error: "--tick requires comma-separated 1-based indices" };
      const parts = v.split(",").map((s) => s.trim());
      const parsed: number[] = [];
      for (const p of parts) {
        const n = Number.parseInt(p, 10);
        if (!Number.isInteger(n) || String(n) !== p) {
          return { error: `--tick index must be an integer, got '${p}'` };
        }
        parsed.push(n);
      }
      mode = "tick";
      tickIndices = parsed;
      i++;
    } else {
      return { error: `unknown flag: ${flag}` };
    }
  }

  if (!planMdFile) return { error: "--plan-md-file is required" };
  return { planMdFile, mode, tickIndices };
}

export function run(argv: string[]): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-candidate-issues: ${parsed.error}`);
    console.error(
      "usage: flow-candidate-issues --plan-md-file <path> [--json | --tick <indices> | --ticked]",
    );
    return 2;
  }

  let planMd: string;
  try {
    planMd = readFileSync(parsed.planMdFile, "utf8");
  } catch (e) {
    console.error(
      `flow-candidate-issues: cannot read ${parsed.planMdFile}: ${(e as Error).message}`,
    );
    return 2;
  }

  if (parsed.mode === "ticked") {
    process.stdout.write(
      JSON.stringify({ ticked: extractTicked(planMd) }) + "\n",
    );
    return 0;
  }

  if (parsed.mode === "tick") {
    let out: { text: string; result: TickResult };
    try {
      out = tickCandidates(planMd, parsed.tickIndices ?? []);
    } catch (e) {
      console.error(`flow-candidate-issues: ${(e as Error).message}`);
      return 2;
    }
    writeFileSync(parsed.planMdFile, out.text);
    process.stdout.write(JSON.stringify(out.result) + "\n");
    return 0;
  }

  process.stdout.write(JSON.stringify(decideCandidateIssues(planMd)) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
