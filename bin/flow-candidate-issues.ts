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
 *   flow-candidate-issues --plan-md-file <path> --lint
 *   flow-candidate-issues --plan-md-file <path> --details
 *
 * `--json` (the default) emits the decision object on stdout:
 *   { action, candidates, untickedCount, tickedCount, rankedOrder }
 *   action ∈ "no-op" | "prompt" | "skip-already-ticked" | "overflow"
 *   candidates: [{ title, body } & CandidateMeta]  (the unticked items, in
 *     document order; CandidateMeta fields are null when the ranking table
 *     is absent or has no matching row)
 *   rankedOrder: 1-based indices into `candidates`, sorted High > Medium >
 *     Low > unknown value, tie-broken by document order
 *
 * `--tick <indices>` flips the selected UNTICKED items (1-based into the
 * `candidates` enumeration order) from `- [ ]` to `- [x]` in place and
 * emits { tickedIndices, tickedCount }.
 *
 * `--ticked` emits { ticked: [{ title, body } & CandidateMeta] } — the
 * already-`- [x]` items (empty array when the section is absent or has
 * zero ticked items).
 *
 * `--lint` is the follow-up-reference consistency guard: it scans plan.md
 * for prose that references a follow-up ("tracked as a follow-up", etc.)
 * and flags DRIFT when such a reference exists but the
 * `# Candidate follow-up issues` section is absent or empty — the exact
 * inconsistency an external reviewer caught in the econ-data run. Emits
 * { references, candidateCount, drift } and exits 1 on drift, 0 clean.
 * Advisory-only: the supervisor surfaces drift in chat, never blocks
 * planning. Tolerant — never throws on malformed input.
 *
 * `--details` prints a human-legible ranked table of the unticked
 * candidates (rank, title, value, complexity, pull, recommended marker) to
 * stdout for the supervisor to paste into chat. Always exits 0; empty
 * stdout when there are zero unticked candidates.
 *
 * Exit codes:
 *   0 — read / decision / tick / ticked / lint(no-drift) / details succeeded
 *   1 — --lint detected follow-up-reference drift
 *   2 — bad CLI args (file read failure, out-of-range tick index, etc.)
 */

import { readFileSync, writeFileSync } from "node:fs";

export type Action = "no-op" | "prompt" | "skip-already-ticked" | "overflow";

export type CandidateMeta = {
  value: string | null;
  complexity: string | null;
  rationale: string | null;
  relation: string | null;
  pull: string | null;
};

export type Candidate = { title: string; body: string } & CandidateMeta;

export type Decision = {
  action: Action;
  candidates: Candidate[];
  untickedCount: number;
  tickedCount: number;
  rankedOrder: number[];
};

const EMPTY_META: CandidateMeta = {
  value: null,
  complexity: null,
  rationale: null,
  relation: null,
  pull: null,
};

const VALUE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const HEADING_RE = /^# Candidate follow-up issues/;

/**
 * Parses the ranking table (the six-column
 * `Candidate | Value | Complexity | Rationale | Relation to current request |
 * Pull into this pipeline?` markdown table) that precedes the checkbox list.
 * Tolerant: an absent table, malformed rows (wrong column count), or a row
 * whose Candidate cell doesn't exact-match (trimmed) any checkbox title are
 * simply not added to the map — callers fall back to null metadata. Keyed by
 * the trimmed Candidate cell text.
 *
 * Scoped to the `# Candidate follow-up issues` section (same bounds as
 * `extractCandidateSection`), NOT the whole document — a six-plus-column
 * table elsewhere in the plan (PRD sections, task tables) must not pollute
 * the metadata map just because a row's first cell happens to match a
 * candidate title.
 */
export function parseRankingTable(planMd: string): Map<string, CandidateMeta> {
  const map = new Map<string, CandidateMeta>();
  const allLines = planMd.split("\n");
  const startIdx = allLines.findIndex((l) => HEADING_RE.test(l));
  if (startIdx === -1) return map;
  let endIdx = allLines.length;
  for (let i = startIdx + 1; i < allLines.length; i++) {
    if (/^# /.test(allLines[i])) {
      endIdx = i;
      break;
    }
  }
  const lines = allLines.slice(startIdx, endIdx);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 6) continue;
    // Skip header and separator rows.
    if (cells[0].toLowerCase() === "candidate") continue;
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const [title, value, complexity, rationale, relation, pull] = cells;
    if (!title) continue;
    map.set(title, {
      value: value || null,
      complexity: complexity || null,
      rationale: rationale || null,
      relation: relation || null,
      pull: pull || null,
    });
  }
  return map;
}

const UNTICKED_RE = /^- \[ \] (.*)$/;
const TICKED_RE = /^- \[[xX]\] (.*)$/;

/**
 * Splits a candidate's text on the FIRST ` — ` (space-emdash-space) into
 * { title, body }. Body is "" when there is no delimiter. Mirrors the
 * step-10 sweep's `${line%% — *}` / `${line#* — }` Bash split: only the
 * first em-dash splits, so any further ` — ` inside body is preserved.
 */
export function splitCandidate(text: string): { title: string; body: string } {
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
      rankedOrder: [],
    };
  }

  const meta = parseRankingTable(planMd);
  const untickedItems = section.items.filter((it) => !it.ticked);
  const tickedCount = section.items.length - untickedItems.length;
  const untickedCount = untickedItems.length;
  const candidates: Candidate[] = untickedItems.map((it) => {
    const c = splitCandidate(it.text);
    return { ...c, ...(meta.get(c.title.trim()) ?? EMPTY_META) };
  });

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

  const rankedOrder = rankCandidates(candidates);

  return { action, candidates, untickedCount, tickedCount, rankedOrder };
}

/**
 * Returns 1-based indices into `candidates` sorted High > Medium > Low >
 * unknown, tie-broken by document order (stable sort preserves original
 * relative order for equal ranks).
 */
function rankCandidates(candidates: CandidateMeta[]): number[] {
  return candidates
    .map((c, i) => ({
      i,
      rank: VALUE_RANK[(c.value ?? "").toLowerCase()] ?? 3,
    }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.i + 1);
}

/**
 * Pure extraction of the already-`- [x]` items as { title, body } & CandidateMeta
 * entries, reusing the same section parse + first-` — `-split + ranking-table
 * join. Empty when the section is absent or has zero ticked items.
 */
export function extractTicked(planMd: string): Candidate[] {
  const section = extractCandidateSection(planMd);
  if (!section) return [];
  const meta = parseRankingTable(planMd);
  return section.items
    .filter((it) => it.ticked)
    .map((it) => {
      const c = splitCandidate(it.text);
      return { ...c, ...(meta.get(c.title.trim()) ?? EMPTY_META) };
    });
}

/**
 * The follow-up-reference phrase set the `--lint` consistency guard scans
 * for. Seeded from the phrasings observed in the econ-data run PLUS the
 * broader set the AGY cross-model review flagged (a static regex that
 * misses a real phrasing is a silent false-negative — the plan's named
 * dominant ship-and-fail). Kept as ONE named exported constant so it is
 * cheap to extend; every entry is covered by a per-phrase test. Match is
 * case-insensitive and stateless (no `g` flag, so `.test()` is reentrant).
 * Overlap between the specific (`listed as a follow-up`) and the generic
 * (`as a follow-up`) entries is intentional and harmless — a line matches
 * at most one reference regardless.
 */
export const FOLLOWUP_REFERENCE_RES: RegExp[] = [
  /listed as a follow-up/i,
  /tracked as a follow-up/i,
  /as a (?:candidate )?follow-up/i,
  /deferred to a follow-up/i,
  /deferred to a future/i,
  /will be addressed in a future PR/i,
  /added to the backlog/i,
  /candidate for (?:a )?future iteration/i,
];

export type LintReport = {
  references: { line: number; text: string }[];
  candidateCount: number;
  drift: boolean;
};

/**
 * Pure follow-up-reference consistency check. Scans plan.md line-by-line
 * for any `FOLLOWUP_REFERENCE_RES` phrase (one reference recorded per
 * matching line, 1-based), counts candidate items via the same
 * `extractCandidateSection` parser the decision path uses, and reports
 * DRIFT when a reference exists but no candidate items do. Presence-check
 * only (not a semantic match of each reference to a specific candidate);
 * `drift` fires ONLY when `candidateCount === 0`, so a reference phrase
 * that appears inside a populated candidate section never trips it.
 * Tolerant by construction — pure string work, never throws.
 */
export function lintFollowUpReferences(planMd: string): LintReport {
  const lines = planMd.split("\n");
  const references: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (FOLLOWUP_REFERENCE_RES.some((re) => re.test(lines[i]))) {
      references.push({ line: i + 1, text: lines[i].trim() });
    }
  }
  const section = extractCandidateSection(planMd);
  const candidateCount = section ? section.items.length : 0;
  const drift = references.length > 0 && candidateCount === 0;
  return { references, candidateCount, drift };
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

const OFFER_LINE =
  "To fold a candidate into the current work instead of filing it, reply `pull #N into the plan`.";

/**
 * Renders the `--details` plain-text ranked block: one entry per candidate
 * in `rankedOrder` order, followed by the verbatim redirect-offer line.
 * Quiet no-op (empty string) when there are zero unticked candidates — the
 * caller should skip printing/echoing entirely in that case.
 */
export function renderDetails(decision: Decision): string {
  if (decision.candidates.length === 0) return "";

  const lines: string[] = [];
  for (const idx of decision.rankedOrder) {
    const c = decision.candidates[idx - 1];
    const value = c.value ?? "unknown";
    const complexity = c.complexity ?? "unknown";
    lines.push(`#${idx} ${c.title} — ${value}/${complexity}`);
    lines.push(`  rationale: ${c.rationale ?? "(none)"}`);
    lines.push(`  relation: ${c.relation ?? "(none)"}`);
    const pull = (c.pull ?? "").toLowerCase();
    const recommended =
      pull === "yes" ||
      ((c.value ?? "").toLowerCase() === "high" &&
        ["trivial", "small"].includes((c.complexity ?? "").toLowerCase()));
    if (recommended) {
      lines.push("  recommended: pull into this plan");
    }
  }
  lines.push("");
  lines.push(OFFER_LINE);
  return lines.join("\n");
}

// --- CLI -------------------------------------------------------------------

type Mode = "json" | "tick" | "ticked" | "lint" | "details";

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
    } else if (flag === "--lint") {
      mode = "lint";
    } else if (flag === "--details") {
      mode = "details";
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
      "usage: flow-candidate-issues --plan-md-file <path> [--json | --tick <indices> | --ticked | --lint | --details]",
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

  if (parsed.mode === "lint") {
    const report = lintFollowUpReferences(planMd);
    process.stdout.write(JSON.stringify(report) + "\n");
    return report.drift ? 1 : 0;
  }

  if (parsed.mode === "details") {
    const decision = decideCandidateIssues(planMd);
    const rendered = renderDetails(decision);
    if (rendered) process.stdout.write(rendered + "\n");
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
