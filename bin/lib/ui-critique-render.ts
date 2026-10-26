/**
 * Renders the marker-wrapped `## UI review` PR section, the single
 * human-sign-off `DECISION:` item for unresolved defects, and upserts both
 * into a PR body without touching any other Test Step.
 */
import { testStepsSectionBounds } from "../flow-gate-decide";
import { fencedLineMask } from "./md-block-structure";
import type { CritiqueFinding, LoopLog } from "./ui-critique";
import type { SectionShot } from "./ui-driver-schema";

export const UI_REVIEW_OPEN = "<!-- flow:ui-review -->";
export const UI_REVIEW_CLOSE = "<!-- /flow:ui-review -->";
export const UI_REVIEW_DECISION_MARKER = "<!-- flow:ui-review-decision -->";

const MAX_PAIRS = 8;
const EVIDENCE = ".flow-tmp/ui-evidence/";
const SEVERITY_ORDER = ["defect", "major", "minor"] as const;

function relPath(p: string): string {
  const i = p.indexOf(EVIDENCE);
  return i >= 0 ? p.slice(i) : p;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function shotKey(s: SectionShot): string {
  return [s.route, s.section, s.viewport, s.part].join("\u0000");
}

function outcomeLine(log: LoopLog): string {
  const kind =
    log.round?.kind === "smell" ? "Smell-repair round" : "Critique round";
  const why = log.round?.reason ? `: ${log.round.reason}` : "";
  switch (log.outcome) {
    case "kept":
      return `${kind} kept${why}.`;
    case "reverted":
      return `${kind} reverted${why}. The page is unchanged from before the round.`;
    case "clean":
      return "Clean: the critique found no defect or major issue.";
    case "list-only":
      return "Findings are listed only; no automatic fix was attempted.";
    default:
      return "No critique round ran.";
  }
}

function comparison(
  before: SectionShot[],
  after: SectionShot[] | null,
): string[] {
  if (before.length === 0) return [];
  const pairs = before.slice(0, MAX_PAIRS);
  const label = (s: SectionShot, side: string) =>
    `![${cell(s.section)} ${s.viewport} ${side}](${relPath(s.path)})`;
  if (after === null) {
    return [
      "| Section | Viewport | Shot |",
      "| --- | --- | --- |",
      ...pairs.map(
        (s) => `| ${cell(s.section)} | ${s.viewport} | ${label(s, "before")} |`,
      ),
      "",
    ];
  }
  const afterByKey = new Map(after.map((s) => [shotKey(s), s]));
  return [
    "| Section | Viewport | Before | After |",
    "| --- | --- | --- | --- |",
    ...pairs.map((s) => {
      const a = afterByKey.get(shotKey(s));
      return `| ${cell(s.section)} | ${s.viewport} | ${label(s, "before")} | ${a ? label(a, "after") : "—"} |`;
    }),
    "",
  ];
}

function residualLines(residual: CritiqueFinding[]): string[] {
  const out: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    const group = residual.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push(`**Unresolved ${sev} findings:**`);
    out.push(
      ...group.map(
        (f) => `- ${cell(f.section)} @ ${f.viewport} — ${cell(f.observation)}`,
      ),
    );
    out.push("");
  }
  return out;
}

export function renderUiReview(i: {
  before: SectionShot[];
  after: SectionShot[] | null;
  log: LoopLog;
  demotion: string | null;
}): string {
  const { log } = i;
  if (log.skip) {
    return [
      UI_REVIEW_OPEN,
      "## UI review",
      "",
      `Not run: ${log.skip}`,
      UI_REVIEW_CLOSE,
    ].join("\n");
  }
  const lines = [UI_REVIEW_OPEN, "## UI review", "", outcomeLine(log), ""];
  lines.push(...comparison(i.before, i.after));
  lines.push(...residualLines(log.residual));
  if (log.persistent.length > 0) {
    lines.push(
      "**Persistent page-check defects** (unchanged through every verify attempt):",
      ...log.persistent.map((p) => `- ${cell(p)}`),
      "",
    );
  }
  if (i.demotion) lines.push(`Demoted to list-only: ${i.demotion}`, "");
  if (log.omittedSections > 0) {
    lines.push(
      `${log.omittedSections} section(s) were left out of the critique gallery to stay within its size cap.`,
      "",
    );
  }
  lines.push(`Cost: $${log.costUsd.toFixed(2)}`, UI_REVIEW_CLOSE);
  return lines.join("\n");
}

/** `null` with no defect finding and no persistent defect. */
export function residualDecisionItem(
  residual: CritiqueFinding[],
  persistent: string[],
): string | null {
  const defects = residual.filter((f) => f.severity === "defect");
  const n = defects.length + persistent.length;
  if (n === 0) return null;
  const top =
    defects.length > 0
      ? `${defects[0].section} @ ${defects[0].viewport} — ${defects[0].observation}`.slice(
          0,
          80,
        )
      : persistent[0].slice(0, 80);
  return `- [ ] DECISION: accept this UI with ${n} unresolved defect(s) listed under UI review (top: ${top}), or redirect to fix them`;
}

function findLine(
  lines: string[],
  fenced: boolean[],
  pred: (l: string) => boolean,
): number {
  return lines.findIndex((l, i) => !fenced[i] && pred(l));
}

function replaceBlock(lines: string[], block: string[]): string[] | null {
  const fenced = fencedLineMask(lines);
  const from = findLine(lines, fenced, (l) => l === UI_REVIEW_OPEN);
  if (from < 0) return null;
  let close = lines.findIndex(
    (l, i) => i > from && !fenced[i] && l === UI_REVIEW_CLOSE,
  );
  if (close < 0) close = from;
  lines.splice(from, close - from + 1, ...block);
  return lines;
}

/**
 * Replaces the marked block, or inserts it before `## Test Steps`; adds,
 * replaces or (with `decision === null`) removes the one marked DECISION line
 * at the end of the Test Steps section. No other Test Step line is touched.
 */
export function upsertUiReview(
  body: string,
  section: string,
  decision: string | null,
): string {
  let lines = body.split("\n");
  const block = section.split("\n");
  const replaced = replaceBlock(lines, block);
  if (replaced) lines = replaced;
  else {
    const bounds = testStepsSectionBounds(lines);
    if (bounds) {
      const lead =
        bounds.start > 0 && lines[bounds.start - 1].trim() !== "" ? [""] : [];
      lines.splice(bounds.start, 0, ...lead, ...block, "");
    } else lines.push("", ...block, "");
  }

  const fenced = fencedLineMask(lines);
  const at = findLine(lines, fenced, (l) =>
    l.includes(UI_REVIEW_DECISION_MARKER),
  );
  const marked =
    decision === null
      ? null
      : `${decision.trimEnd()} ${UI_REVIEW_DECISION_MARKER}`;
  if (at >= 0) {
    if (marked === null) lines.splice(at, 1);
    else lines[at] = marked;
  } else if (marked !== null) {
    const bounds = testStepsSectionBounds(lines);
    if (bounds) {
      let last = bounds.end - 1;
      while (last > bounds.start && lines[last].trim() === "") last--;
      lines.splice(last + 1, 0, marked);
    }
  }
  return lines.join("\n");
}
