#!/usr/bin/env bun
/**
 * Parses and enumerates the `# Candidate follow-up issues` section in
 * plan.md for /flow-pipeline's candidate-issues workflow.
 *
 * Why: the `# Candidate follow-up issues` section drives a plan-review
 * step where the supervisor lists candidates on a chat surface and the
 * user replies inline (`pull #N into the plan`, `drop candidate #N`)
 * rather than being interrupted with a synchronous form. This helper is
 * LLM-free: it parses, enumerates, and flips checkbox state — it never
 * decides anything and never prompts. The supervisor renders `--details`
 * output, relays it in chat, and applies the user's reply via
 * `--tick`/`--untick`.
 *
 * The `--tick`/`--untick` modes perform the deterministic `- [ ]` ⇄
 * `- [x]` flip the supervisor used to hand-match with `Edit`
 * `old_string`/`new_string`, so parse + flip live in one tested place.
 * The `--ticked` mode emits the already-`- [x]` items as `{ title, body }`
 * pairs — the extractor step 10's post-merge sweep consumes instead of
 * hand-rolling its own awk + em-dash split.
 *
 * Usage:
 *   flow-candidate-issues --plan-md-file <path> [--json]
 *   flow-candidate-issues --plan-md-file <path> --tick <1-based,comma,indices>
 *   flow-candidate-issues --plan-md-file <path> --untick <1-based,comma,indices>
 *   flow-candidate-issues --plan-md-file <path> --ticked
 *   flow-candidate-issues --plan-md-file <path> --lint
 *   flow-candidate-issues --plan-md-file <path> --details
 *
 * `--json` (the default) emits the full enumeration on stdout:
 *   { candidates, untickedCount, tickedCount, rankedOrder }
 *   candidates: ALL section items, in document order, each { title, body,
 *     details, ticked } & CandidateMeta (CandidateMeta fields are null when
 *     the ranking table is absent or has no matching row; `details` is the
 *     item's indented value-prop block text, `""` when it carries none)
 *   rankedOrder: 1-based indices into `candidates`, sorted High > Medium >
 *     Low > unknown value, tie-broken by document order — ticked and
 *     unticked items interleave here; `--details` is what groups by state
 *
 * `--tick <indices>` / `--untick <indices>` flip the item at each given
 * 1-based index — into the SAME full `candidates` enumeration order
 * `--json` and `--details` use — from `- [ ]` to `- [x]` (tick) or back
 * (untick), in place. Both throw on an out-of-range index and on an
 * index whose current checkbox state already matches the requested flip.
 * `--tick` emits { tickedIndices, tickedCount }; `--untick` emits a
 * distinct { untickedIndices, untickedCount } shape — reusing the tick
 * fields on an untick would misreport the direction.
 *
 * `--ticked` emits { ticked: [{ title, body, details } & CandidateMeta] } —
 * the already-`- [x]` items (empty array when the section is absent or
 * has zero ticked items). `details` is the item's indented value-prop
 * block text (raw, common-indent-stripped), `""` when the item carries none.
 *
 * `--lint` is the follow-up-reference consistency guard: it scans plan.md
 * for prose that references a follow-up ("tracked as a follow-up", etc.)
 * and flags DRIFT when such a reference exists but the
 * `# Candidate follow-up issues` section is absent or empty — the exact
 * inconsistency an external reviewer caught in the econ-data run. It ALSO
 * checks the flow-value-rubric bar: every ticked candidate must carry a
 * value-prop block whose Verdict reads `clears bar`, and every `[anchor:
 * path]` it cites must exist relative to the repo root. It ALSO checks
 * candidate-bundling discipline via `bundlingMisses`: EVERY candidate
 * (ticked or not) whose ranking-table Rationale names none of the four
 * exclusions (`exclusion-missing`), whose only rescue for a Trivial/Small
 * + Low item is an unnamed design-session decision (`decision-unnamed`),
 * or whose only exclusion on a Trivial/Small + Low item is `large
 * refactor` (`small-low-risk`). Emits
 * { references, candidateCount, drift, barMisses, bundlingMisses } and
 * exits 1 on drift OR any barMisses entry OR any bundlingMisses entry, 0
 * clean. Advisory-only: the supervisor surfaces all three in chat, never
 * blocks planning. Tolerant — never throws on malformed input.
 *
 * `--details` prints a human-legible block of ALL candidates, grouped by
 * checkbox state, for the supervisor to paste into chat: rank, checkbox
 * state, title, value, complexity, verdict, and a recommended marker for
 * open candidates. Closes with the tick-rule note and the reply offers
 * (`pull #N into the plan`, `drop candidate #N`, `file candidate #N`).
 * Always exits 0; empty stdout when the section has zero items.
 *
 * Exit codes:
 *   0 — read / enumerate / tick / untick / ticked / lint(clean) / details succeeded
 *   1 — --lint detected follow-up-reference drift, a value-bar miss (barMisses), or a bundling miss (bundlingMisses)
 *   2 — bad CLI args (file read failure, out-of-range tick/untick index, etc.)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { extractPathAnchors, resolveAnchorRepoRoot } from "./lib/value-anchors";
import { labelValueLine } from "./lib/issue-body-rubric";

export type CandidateMeta = {
  value: string | null;
  complexity: string | null;
  rationale: string | null;
  relation: string | null;
  pull: string | null;
};

export type Candidate = {
  title: string;
  body: string;
  details: string;
  ticked: boolean;
} & CandidateMeta;

export type Decision = {
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

type SectionItem = {
  lineIdx: number;
  ticked: boolean;
  text: string;
  details: string;
};

/**
 * Captures the indented value-prop block (or any other indented
 * continuation content) that follows a checkbox item, starting at `start`
 * (the line after the checkbox) up to `end` (the section boundary).
 * Stops at the next column-0 checkbox line, the next `^#` heading, the
 * next `^\|` table row, or the first non-blank column-0 line that is not
 * a checkbox — whichever comes first. Every kept line begins with ≥1
 * space (a leading tab is treated as one space); interior blank lines are
 * skipped from the output but do not themselves stop the scan. The common
 * leading indent across kept lines is stripped before joining with "\n".
 * Returns "" when nothing is captured.
 */
function extractItemDetails(
  lines: string[],
  start: number,
  end: number,
): string {
  const kept: string[] = [];
  for (let j = start; j < end; j++) {
    const raw = lines[j];
    if (raw.trim() === "") continue;
    if (UNTICKED_RE.test(raw) || TICKED_RE.test(raw)) break;
    if (/^#/.test(raw)) break;
    if (/^\|/.test(raw)) break;
    if (/^[ \t]/.test(raw)) {
      kept.push(raw.replace(/\t/g, " "));
      continue;
    }
    break;
  }
  if (kept.length === 0) return "";
  const indent = Math.min(...kept.map((l) => l.length - l.trimStart().length));
  return kept.map((l) => l.slice(indent)).join("\n");
}

/**
 * Extracts the `# Candidate follow-up issues` section's item lines,
 * bounded from the heading to the next top-level `^# ` heading or EOF
 * (matches the step-10 sweep's awk bounds). Returns null when the
 * heading is absent. `lines` is the file split on "\n" (returned so the
 * tick/untick paths can rewrite by index without re-splitting). Each item
 * also carries `details` — its indented value-prop block, captured by
 * `extractItemDetails` as a continuation run so the column-0-anchored
 * checkbox regexes never see (and never mis-match) the block's own
 * `- **UX:**`-style nested lines.
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
      items.push({
        lineIdx: i,
        ticked: false,
        text: unticked[1],
        details: extractItemDetails(lines, i + 1, endIdx),
      });
      continue;
    }
    const ticked = lines[i].match(TICKED_RE);
    if (ticked) {
      items.push({
        lineIdx: i,
        ticked: true,
        text: ticked[1],
        details: extractItemDetails(lines, i + 1, endIdx),
      });
    }
  }
  return { lines, items };
}

/**
 * Pure enumeration over the section state — no decision, no matrix.
 * Returns EVERY item in the `# Candidate follow-up issues` section, in
 * document order, each carrying its checkbox state via `Candidate.ticked`.
 * Callers (the supervisor, via `--details`) decide what to do with the
 * state; this helper only parses, joins ranking-table metadata, and
 * counts.
 *
 *   - heading absent       → empty enumeration (candidates: [])
 *   - present, zero items  → empty enumeration
 *   - present, N items     → N candidates, ticked flag per item,
 *     `rankedOrder` computed over the FULL set (ticked and unticked
 *     interleave by rank; `renderDetails` is what groups by state)
 */
export function enumerateCandidates(planMd: string): Decision {
  const section = extractCandidateSection(planMd);
  if (!section) {
    return {
      candidates: [],
      untickedCount: 0,
      tickedCount: 0,
      rankedOrder: [],
    };
  }

  const meta = parseRankingTable(planMd);
  const candidates: Candidate[] = section.items.map((it) => {
    const c = splitCandidate(it.text);
    return {
      ...c,
      details: it.details,
      ticked: it.ticked,
      ...(meta.get(c.title.trim()) ?? EMPTY_META),
    };
  });
  const tickedCount = candidates.filter((c) => c.ticked).length;
  const untickedCount = candidates.length - tickedCount;
  const rankedOrder = rankCandidates(candidates);

  return { candidates, untickedCount, tickedCount, rankedOrder };
}

/**
 * Returns 1-based indices into `candidates` sorted High > Medium > Low >
 * unknown, tie-broken by document order (stable sort preserves original
 * relative order for equal ranks). Operates on whatever `candidates` it is
 * given — it does not itself filter by ticked state.
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
 * Pure extraction of the already-`- [x]` items as
 * { title, body, details } & CandidateMeta entries, reusing the same
 * section parse + first-` — `-split + ranking-table join. Empty when the
 * section is absent or has zero ticked items. Return type is deliberately
 * NOT `Candidate[]` — this is the step-10 post-merge issue-filing
 * contract's own shape and must not gain a `ticked` field just because
 * `Candidate` did. `details` is the item's indented value-prop block —
 * the step-10 sweep folds it into the filed issue body.
 */
export function extractTicked(
  planMd: string,
): ({ title: string; body: string; details: string } & CandidateMeta)[] {
  const section = extractCandidateSection(planMd);
  if (!section) return [];
  const meta = parseRankingTable(planMd);
  return section.items
    .filter((it) => it.ticked)
    .map((it) => {
      const c = splitCandidate(it.text);
      return {
        ...c,
        details: it.details,
        ...(meta.get(c.title.trim()) ?? EMPTY_META),
      };
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
  barMisses: {
    index: number;
    title: string;
    reason: "no-verdict" | "anchor-missing";
    anchor?: string;
  }[];
  bundlingMisses: {
    index: number;
    title: string;
    reason: "exclusion-missing" | "decision-unnamed" | "small-low-risk";
  }[];
};

/**
 * The four named exclusion phrases the `Objective-item triage (bundle by
 * default)` rule in discovery-instructions.md requires a candidate's
 * ranking-table Rationale to name. No `g` flag — each is tested once per
 * candidate via `.test()`, never iterated statefully.
 */
export const EXCLUSION_RES = {
  novel: /genuinely novel/i,
  design:
    /own design\/decision session|design\/decision session|design session|decision session/i,
  refactor: /large refactor/i,
  foreclosed: /user-foreclosed/i,
};

/**
 * Phrases that count as "naming the decision" when a design-session
 * exclusion is claimed on a Trivial/Small + Low item — the Small/Low rule
 * in discovery-instructions.md requires the Rationale to say what the
 * open decision actually is, not just that one exists.
 */
export const DECISION_CLAUSE_RES: RegExp[] = [
  /open decision/i,
  /decision is/i,
  /specifically/i,
  /the (?:specific )?decision/i,
];

/**
 * Pure classifier for the `bundlingMisses` lint class. Rules apply in
 * order, first match wins; returns null when the candidate clears the
 * bundling bar. `meta.complexity`/Risk fall back to `labelValueLine` over
 * `details` when the ranking-table row is absent or blank, since a
 * candidate's own checkbox body sometimes carries `**Complexity:**` /
 * `**Risk:**` lines the table row omits.
 */
export function classifyBundling(
  meta: CandidateMeta,
  details: string,
): "exclusion-missing" | "decision-unnamed" | "small-low-risk" | null {
  const rationale = meta.rationale ?? "";
  const novel = EXCLUSION_RES.novel.test(rationale);
  const design = EXCLUSION_RES.design.test(rationale);
  const refactor = EXCLUSION_RES.refactor.test(rationale);
  const foreclosed = EXCLUSION_RES.foreclosed.test(rationale);

  if (!meta.rationale || (!novel && !design && !refactor && !foreclosed)) {
    return "exclusion-missing";
  }

  const complexity = (
    meta.complexity ??
    labelValueLine(details, "Complexity") ??
    ""
  ).toLowerCase();
  const risk = (labelValueLine(details, "Risk") ?? "").toLowerCase();
  const isSmallLow =
    (complexity === "trivial" || complexity === "small") && risk === "low";

  if (design && !novel && !foreclosed && isSmallLow) {
    const named = DECISION_CLAUSE_RES.some((re) => re.test(rationale));
    if (!named) return "decision-unnamed";
  }

  if (isSmallLow && refactor && !novel && !design && !foreclosed) {
    return "small-low-risk";
  }

  return null;
}

/**
 * Extracts the value after `**Verdict:**` on its own line inside a
 * candidate's `details` block, trimmed. `null` when no such line is
 * present, or when the value is empty.
 */
export function extractVerdict(details: string): string | null {
  const m = details.match(/\*\*Verdict:\*\*\s*(.+)/);
  if (!m) return null;
  const v = m[1].trim().replace(/^`/, "");
  return v || null;
}

/**
 * Pure follow-up-reference consistency check PLUS the flow-value-rubric
 * bar check. Scans plan.md line-by-line for any `FOLLOWUP_REFERENCE_RES`
 * phrase (one reference recorded per matching line, 1-based), counts
 * candidate items via the same `extractCandidateSection` parser the
 * enumeration path uses, and reports DRIFT when a reference exists but no
 * candidate items do. Presence-check only (not a semantic match of each
 * reference to a specific candidate); `drift` fires ONLY when
 * `candidateCount === 0`, so a reference phrase that appears inside a
 * populated candidate section never trips it.
 *
 * `barMisses` covers every TICKED candidate: one entry with
 * `reason: "no-verdict"` when its value-prop block's Verdict does not
 * start with `clears bar` (case-insensitive) — anchors are not checked in
 * that case, one dominant miss per item — otherwise one
 * `reason: "anchor-missing"` entry per `[anchor: …]` file path that does
 * not exist relative to the repo root (resolved via `planMdFile`, see
 * `resolveAnchorRepoRoot`).
 *
 * `bundlingMisses` covers EVERY candidate (ticked or not) via
 * `classifyBundling`: a candidate whose ranking-table Rationale names
 * none of the four `EXCLUSION_RES` exclusions is `exclusion-missing`; a
 * Trivial/Small + Low item rescued only by a design-session exclusion
 * with no named decision (no `DECISION_CLAUSE_RES` match) is
 * `decision-unnamed`; a Trivial/Small + Low item whose only exclusion is
 * `large refactor` is `small-low-risk`. `--lint` exits 1 on drift OR any
 * `barMisses` entry OR any `bundlingMisses` entry.
 * Tolerant by construction — pure string/filesystem-existence work, never
 * throws, and performs no `gh` call or LLM judgement (the anchor check is
 * a deterministic existence check only).
 */
export function lintFollowUpReferences(
  planMd: string,
  planMdFile?: string,
): LintReport {
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

  const barMisses: LintReport["barMisses"] = [];
  if (section) {
    const repoRoot = resolveAnchorRepoRoot(planMdFile);
    section.items.forEach((it, i) => {
      if (!it.ticked) return;
      const c = splitCandidate(it.text);
      const verdict = extractVerdict(it.details);
      if (!verdict || !/^clears bar/i.test(verdict)) {
        barMisses.push({ index: i + 1, title: c.title, reason: "no-verdict" });
        return;
      }
      for (const anchor of extractPathAnchors(it.details)) {
        const abs = resolve(repoRoot, anchor);
        const rel = relative(repoRoot, abs);
        const inRepo =
          !isAbsolute(anchor) && rel !== "" && !rel.startsWith("..");
        if (!inRepo || !existsSync(abs)) {
          barMisses.push({
            index: i + 1,
            title: c.title,
            reason: "anchor-missing",
            anchor,
          });
        }
      }
    });
  }

  const bundlingMisses: LintReport["bundlingMisses"] = [];
  if (section) {
    const meta = parseRankingTable(planMd);
    section.items.forEach((it, i) => {
      const c = splitCandidate(it.text);
      const reason = classifyBundling(
        meta.get(c.title) ?? EMPTY_META,
        it.details,
      );
      if (reason) {
        bundlingMisses.push({ index: i + 1, title: c.title, reason });
      }
    });
  }

  return { references, candidateCount, drift, barMisses, bundlingMisses };
}

export type TickResult = { tickedIndices: number[]; tickedCount: number };
export type UntickResult = { untickedIndices: number[]; untickedCount: number };

/**
 * Flips the item at each given 1-based index — into the FULL `candidates`
 * enumeration order (the same index space `--details`/`enumerateCandidates`
 * use, NOT a ticked/unticked sub-enumeration) — from `- [ ]` to `- [x]`.
 * Pure: returns the rewritten file text. Throws on a non-integer or
 * out-of-range index, and on an index that is already ticked (never
 * double-writes).
 */
export function tickCandidates(
  planMd: string,
  indices: number[],
): { text: string; result: TickResult } {
  const section = extractCandidateSection(planMd);
  const items = section ? section.items : [];

  for (const idx of indices) {
    if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
      throw new Error(
        `tick index out of range: ${idx} (have ${items.length} candidate(s))`,
      );
    }
    if (items[idx - 1].ticked) {
      throw new Error(`tick index ${idx} is already ticked`);
    }
  }

  const lines = section ? section.lines : planMd.split("\n");
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  for (const idx of sorted) {
    const item = items[idx - 1];
    lines[item.lineIdx] = lines[item.lineIdx].replace("- [ ] ", "- [x] ");
  }

  return {
    text: lines.join("\n"),
    result: { tickedIndices: sorted, tickedCount: sorted.length },
  };
}

/**
 * Flips the item at each given 1-based index — same full `candidates`
 * index space as `tickCandidates` — from `- [x]`/`- [X]` back to `- [ ]`.
 * Pure: returns the rewritten file text. Throws on a non-integer or
 * out-of-range index, and on an index that is already unticked (never
 * double-writes).
 */
export function untickCandidates(
  planMd: string,
  indices: number[],
): { text: string; result: UntickResult } {
  const section = extractCandidateSection(planMd);
  const items = section ? section.items : [];

  for (const idx of indices) {
    if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
      throw new Error(
        `untick index out of range: ${idx} (have ${items.length} candidate(s))`,
      );
    }
    if (!items[idx - 1].ticked) {
      throw new Error(`untick index ${idx} is already unticked`);
    }
  }

  const lines = section ? section.lines : planMd.split("\n");
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  for (const idx of sorted) {
    const item = items[idx - 1];
    lines[item.lineIdx] = lines[item.lineIdx].replace(/^- \[[xX]\] /, "- [ ] ");
  }

  return {
    text: lines.join("\n"),
    result: { untickedIndices: sorted, untickedCount: sorted.length },
  };
}

const OFFER_LINE =
  "To fold a candidate into the current work instead of filing it, reply `pull #N into the plan`.";
const DROP_OFFER_LINE =
  "To drop a candidate instead of filing it as an issue, reply `drop candidate #N`.";
const TICK_RULE_NOTE =
  "Ticked items file as issues post-merge unless dropped; unticked items are listed here and file only on request (see below).";
const FILE_OFFER_LINE =
  "To file an unticked candidate as an issue post-merge, reply `file candidate #N`.";

/**
 * Renders the `--details` plain-text block: every candidate in
 * `rankedOrder` order, GROUPED BY STATE — ticked group, then unticked
 * group — rather than printed in raw rank order. `rankedOrder` ranks
 * across BOTH states, so printing it flat would interleave items the
 * user already decided on with open ones; the grouping here is
 * deliberate, not inherited from `rankCandidates`. Each item also prints
 * its value-prop block's `verdict:` line (`(no value-prop block)` when
 * absent), so a reader can see at a glance which ticked items actually
 * clear the bar. Closes with the tick-rule note and all three reply
 * offers. Quiet no-op (empty string) when the section has zero items at
 * all.
 */
export function renderDetails(decision: Decision): string {
  if (decision.candidates.length === 0) return "";

  const tickedIdx = decision.rankedOrder.filter(
    (i) => decision.candidates[i - 1].ticked,
  );
  const untickedIdx = decision.rankedOrder.filter(
    (i) => !decision.candidates[i - 1].ticked,
  );

  const lines: string[] = [];

  const renderGroup = (indices: number[]) => {
    for (const idx of indices) {
      const c = decision.candidates[idx - 1];
      const value = c.value ?? "unknown";
      const complexity = c.complexity ?? "unknown";
      const box = c.ticked ? "[x]" : "[ ]";
      lines.push(`#${idx} ${box} ${c.title} — ${value}/${complexity}`);
      lines.push(`  rationale: ${c.rationale ?? "(none)"}`);
      lines.push(`  relation: ${c.relation ?? "(none)"}`);
      lines.push(
        `  verdict: ${extractVerdict(c.details) ?? "(no value-prop block)"}`,
      );
      if (!c.ticked) {
        const pull = (c.pull ?? "").toLowerCase();
        const recommended =
          pull === "yes" ||
          ((c.value ?? "").toLowerCase() === "high" &&
            ["trivial", "small"].includes((c.complexity ?? "").toLowerCase()));
        if (recommended) {
          lines.push("  recommended: pull into this plan");
        }
      }
    }
  };

  if (tickedIdx.length > 0) {
    lines.push("Already ticked (will file post-merge unless dropped):");
    renderGroup(tickedIdx);
  }
  if (untickedIdx.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Open candidates:");
    renderGroup(untickedIdx);
  }

  lines.push("");
  lines.push(TICK_RULE_NOTE);
  lines.push(OFFER_LINE);
  lines.push(DROP_OFFER_LINE);
  lines.push(FILE_OFFER_LINE);
  return lines.join("\n");
}

// --- CLI -------------------------------------------------------------------

type Mode = "json" | "tick" | "untick" | "ticked" | "lint" | "details";

type Args = {
  planMdFile: string;
  mode: Mode;
  tickIndices?: number[];
  untickIndices?: number[];
};

function parseIndices(v: string): number[] | { error: string } {
  const parts = v.split(",").map((s) => s.trim());
  const parsed: number[] = [];
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (!Number.isInteger(n) || String(n) !== p) {
      return { error: `index must be an integer, got '${p}'` };
    }
    parsed.push(n);
  }
  return parsed;
}

export function parseArgs(argv: string[]): Args | { error: string } {
  let planMdFile: string | undefined;
  let mode: Mode = "json";
  let tickIndices: number[] | undefined;
  let untickIndices: number[] | undefined;

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
      const parsed = parseIndices(v);
      if ("error" in parsed) {
        return { error: `--tick ${parsed.error}` };
      }
      mode = "tick";
      tickIndices = parsed;
      i++;
    } else if (flag === "--untick") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--"))
        return { error: "--untick requires comma-separated 1-based indices" };
      const parsed = parseIndices(v);
      if ("error" in parsed) {
        return { error: `--untick ${parsed.error}` };
      }
      mode = "untick";
      untickIndices = parsed;
      i++;
    } else {
      return { error: `unknown flag: ${flag}` };
    }
  }

  if (!planMdFile) return { error: "--plan-md-file is required" };
  return { planMdFile, mode, tickIndices, untickIndices };
}

export function run(argv: string[]): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-candidate-issues: ${parsed.error}`);
    console.error(
      "usage: flow-candidate-issues --plan-md-file <path> [--json | --tick <indices> | --untick <indices> | --ticked | --lint | --details]",
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
    const report = lintFollowUpReferences(planMd, parsed.planMdFile);
    process.stdout.write(JSON.stringify(report) + "\n");
    return report.drift ||
      report.barMisses.length > 0 ||
      report.bundlingMisses.length > 0
      ? 1
      : 0;
  }

  if (parsed.mode === "details") {
    const decision = enumerateCandidates(planMd);
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

  if (parsed.mode === "untick") {
    let out: { text: string; result: UntickResult };
    try {
      out = untickCandidates(planMd, parsed.untickIndices ?? []);
    } catch (e) {
      console.error(`flow-candidate-issues: ${(e as Error).message}`);
      return 2;
    }
    writeFileSync(parsed.planMdFile, out.text);
    process.stdout.write(JSON.stringify(out.result) + "\n");
    return 0;
  }

  process.stdout.write(JSON.stringify(enumerateCandidates(planMd)) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
