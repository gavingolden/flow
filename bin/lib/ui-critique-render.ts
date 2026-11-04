/**
 * Renders the marker-wrapped `## UI review` PR section, the single
 * human-sign-off `DECISION:` item for unresolved defects, and upserts both
 * into a PR body without touching any other Test Step.
 */
import { testStepsSectionBounds } from "../flow-gate-decide";
import { fencedLineMask } from "./md-block-structure";
import { isGating, type CritiqueFinding, type LoopLog } from "./ui-critique";
import {
  cell,
  residualLines,
  signoffLines,
  targetLines,
} from "./ui-critique-render-lists";
import type { SectionShot } from "./ui-driver-schema";

export const UI_REVIEW_OPEN = "<!-- flow:ui-review -->";
export const UI_REVIEW_CLOSE = "<!-- /flow:ui-review -->";
export const UI_REVIEW_DECISION_MARKER = "<!-- flow:ui-review-decision -->";
/** Only on the not-run item: ticking a residual-defects item must not waive a review that never ran. */
export const UI_REVIEW_NOT_RUN_MARKER = "<!-- flow:ui-review-not-run -->";

const MAX_PAIRS = 8;
const EVIDENCE = ".flow-tmp/ui-evidence/";

function relPath(p: string): string {
  const i = p.indexOf(EVIDENCE);
  return i >= 0 ? p.slice(i) : p;
}

function shotKey(s: SectionShot): string {
  return [s.route, s.section, s.viewport, s.part].join("\u0000");
}

const PLAIN_REASONS: Record<string, string> = {
  "headless-error": "the reviewer call failed",
  "unparseable-result": "the reviewer's reply could not be read",
  "rule-doc-missing": "a design-rule file the reviewer needs is missing",
  "no-section-shots": "the browser drive captured no section screenshots",
  "runtime-error": "the review tool hit an unexpected error",
  "bad-phase": "the review tool was called with an unknown phase",
  "resumed-mid-round": "the run restarted mid-round, so the round was undone",
  "claude-timeout": "the reviewer took too long and was stopped",
  "mcp-not-available": "the browser tools were not available",
  "claude-missing": "the reviewer is not installed on this machine",
  "disabled-by-config": "turned off in flow config",
  "no-review-target":
    "no page in the plan or the diff shows the changed screen — add a `## UI review targets` entry",
  "playwright-unavailable":
    "the browser tool was unavailable and this repo has no Playwright — run `npm i -D @playwright/test && npx playwright install chromium`",
  "playwright-browsers-missing":
    "the browser tool was unavailable and Playwright's browser is not downloaded — run `npx playwright install chromium`",
  "capture-failed": "the screenshot capture failed",
  "login-failed": "the capture could not log in with the test account",
  "credentials-unavailable": "the test-account credentials were not available",
  "no-credential-env-vars":
    "the manifest names no test-account credential variables",
  "manifest-not-committed":
    "the UI manifest is not committed, so its test account was not used",
  "manifest-not-in-worktree":
    "the UI manifest is outside this worktree, so its test account was not used",
  "no-targets": "the plan names no pages to photograph",
  "non-local-base-url": "the app or login URL is not a local address",
};

/** Skip and round reasons arrive as helper codes; the PR shows plain words. */
export function plainReason(reason: string): string {
  const known = PLAIN_REASONS[reason];
  if (known) return known;
  return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(reason)
    ? "the reviewer could not run"
    : reason;
}

function outcomeLine(log: LoopLog): string {
  const kind =
    log.round?.kind === "smell" ? "Layout repair round" : "Critique round";
  const why = log.round?.reason ? `: ${plainReason(log.round.reason)}` : "";
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
    `![${cell(s.section).replace(/[[\]]/g, " ")} ${s.viewport} ${side}](${encodeURI(relPath(s.path))})`;
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

const warning = (text: string): string[] => ["> [!WARNING]", `> ${text}`, ""];

/** A review the diff required but that never ran, with the review still on. */
function notRun(log: LoopLog): boolean {
  return (
    log.required === true &&
    typeof log.skip === "string" &&
    log.skip !== "disabled-by-config"
  );
}

export function renderUiReview(i: {
  before: SectionShot[];
  after: SectionShot[] | null;
  log: LoopLog;
  demotion: string | null;
}): string {
  const { log } = i;
  const lines = [UI_REVIEW_OPEN, "## UI review", ""];
  if (log.playwrightWarning) lines.push(...warning(log.playwrightWarning));
  if (log.skip === "disabled-by-config") {
    lines.push(`Off: ${plainReason(log.skip)}.`, "");
  } else if (notRun(log)) {
    lines.push(...warning(`UI review did not run: ${plainReason(log.skip!)}`));
  } else if (log.skip) {
    lines.push(`Not run: ${plainReason(log.skip)}`, "");
  } else {
    lines.push(outcomeLine(log), "");
    if (log.completed && log.headSha) {
      lines.push(`Judged commit: \`${log.headSha.slice(0, 7)}\``, "");
    }
    lines.push(...targetLines(log.targets ?? []));
    lines.push(...comparison(i.before, i.after));
    lines.push(...residualLines(log.residual));
  }
  lines.push(...signoffLines(log.signoff));
  if (log.persistent.length > 0) {
    lines.push(
      "**Persistent page-check defects** (unchanged through every verify attempt):",
      ...log.persistent.map((p) => `- ${cell(p)}`),
      "",
    );
  }
  if (i.demotion && !log.skip) {
    lines.push(`Demoted to list-only: ${i.demotion}`, "");
  }
  if (log.omittedSections > 0 && !log.skip) {
    lines.push(
      `${log.omittedSections} section(s) were left out of the critique gallery to stay within its size cap.`,
      "",
    );
  }
  if (!log.skip) lines.push(`Cost: $${log.costUsd.toFixed(2)}`);
  lines.push(UI_REVIEW_CLOSE);
  return lines.join("\n");
}

/**
 * `null` with no gating defect finding and no persistent defect. Pre-existing
 * (not introduced) defects are listed in the section but never gate.
 */
export function residualDecisionItem(
  residual: CritiqueFinding[],
  persistent: string[],
): string | null {
  const defects = residual.filter(
    (f) => f.severity === "defect" && isGating(f),
  );
  const n = defects.length + persistent.length;
  if (n === 0) return null;
  const top = cell(
    defects.length > 0
      ? `${defects[0].section} @ ${defects[0].viewport} — ${defects[0].observation}`
      : persistent[0],
  ).slice(0, 80);
  return `- [ ] DECISION: accept this UI with ${n} unresolved defect(s) listed under UI review (top: ${top}), or redirect to fix them`;
}

/**
 * The one human-only item a review leaves: unresolved defects take precedence,
 * else a review the diff required but that could not run asks the owner to
 * accept merging without it.
 */
export function uiReviewDecisionItem(log: LoopLog): string | null {
  const defects = residualDecisionItem(
    log.skip ? [] : log.residual,
    log.persistent,
  );
  if (defects !== null) return defects;
  if (!notRun(log)) return null;
  return `- [ ] DECISION: the UI review did not run (${cell(plainReason(log.skip!))}) — merge without a design review of the changed screens, or redirect to fix the cause ${UI_REVIEW_NOT_RUN_MARKER}`;
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

const CHECKBOX = /^(\s*[-*] )\[[ xX]\] /;

/** A human-ticked DECISION stays ticked while its text is unchanged. */
function isSameTickedDecision(existing: string, next: string): boolean {
  return (
    /^\s*[-*] \[[xX]\] /.test(existing) &&
    existing.replace(CHECKBOX, "").trim() === next.replace(CHECKBOX, "").trim()
  );
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
    else if (!isSameTickedDecision(lines[at], marked)) lines[at] = marked;
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
