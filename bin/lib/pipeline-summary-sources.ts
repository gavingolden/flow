/**
 * Per-category source parsers for `flow-pipeline-summary`'s
 * `## PIPELINE SNAPSHOT` block. Each `render*` returns the array of
 * body lines for one section (the caller indents them and prints the
 * section header). The explicit-`none` discipline lives here: an empty
 * or absent source yields `["none"]`, never a fabricated line.
 *
 * Split out of `flow-pipeline-summary.ts` to keep that file < 200 lines
 * (AGENTS.md), per the documented `bin/lib/` escape valve.
 */

import { validatePrReviewResult } from "./pr-review-result-schema";
import { collectFixApplierTolerant } from "./fix-applier-tolerant";
import {
  normalizeParsedFindings,
  validateConsolidatorResult,
} from "./agent-finding-schema";
import { formatDuration } from "./time";
import {
  formatPlainText,
  formatPlainTextEntries,
  collectForeclosedEntries,
  isEmpty,
  isTotalLensDrop,
} from "./foreclosed-paths-format";

const NONE = ["none"];

/** CHANGES: one line from the `gh pr view` JSON, or `none`. */
export function renderChanges(raw: string): string[] {
  if (!raw.trim()) return NONE;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const additions = Number(o.additions ?? 0);
    const deletions = Number(o.deletions ?? 0);
    const changedFiles = Number(o.changedFiles ?? 0);
    const commits = Number(o.commits ?? 0);
    return [
      `${commits} commits, +${additions}/-${deletions} across ${changedFiles} files`,
    ];
  } catch {
    return ["(unreadable)"];
  }
}

/**
 * PHASES: one line per phaseLog entry in order, or `none`. Each line carries
 * the time spent in that phase — the gap from its `at` to the next entry's
 * `at` — as a ` (3m12s)` suffix. The final entry (no successor) and any entry
 * whose own or adjacent `at` is unparseable, zero, or out-of-order render with
 * no suffix rather than a garbage value.
 */
export function renderPhases(
  phaseLog: Array<{ phase: string; outcome?: string; at: string }> | null,
): string[] {
  if (!phaseLog || phaseLog.length === 0) return NONE;
  return phaseLog.map((e, i) => {
    const base =
      e.outcome !== undefined ? `${e.phase} -> ${e.outcome}` : e.phase;
    const next = phaseLog[i + 1];
    if (!next) return base;
    const start = Date.parse(e.at);
    const end = Date.parse(next.at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return base;
    const duration = formatDuration(end - start);
    return duration ? `${base} (${duration})` : base;
  });
}

/**
 * FINDINGS: review verdict + fix-applier counts + consolidator counts +
 * CI/Copilot. Any individual artifact failing its validator degrades to a
 * `(unreadable)` sub-line, not a crash. `none` only when NONE of these
 * artifacts are present.
 */
export function renderFindings(inputs: {
  prReviewRaw: string;
  fixApplierRaw: string;
  consolidatorRaw: string;
  ciWaitRaw: string;
}): string[] {
  const lines: string[] = [];
  const any =
    inputs.prReviewRaw.trim() ||
    inputs.fixApplierRaw.trim() ||
    inputs.consolidatorRaw.trim() ||
    inputs.ciWaitRaw.trim();
  if (!any) return NONE;

  if (inputs.prReviewRaw.trim()) {
    const parsed = parseJson(inputs.prReviewRaw);
    const v = parsed === undefined ? undefined : validatePrReviewResult(parsed);
    if (!v || !v.ok) lines.push("review: (unreadable)");
    else lines.push(`review: ${v.value.status} — ${v.value.summary}`);
  }

  if (inputs.fixApplierRaw.trim()) {
    const parsed = parseJson(inputs.fixApplierRaw);
    // Tolerant read: a single off-shape entry no longer nukes the valid
    // counts; only a genuinely-broken artifact (-> null) degrades to
    // (unreadable). A residual `(N unreadable)` marker surfaces dropped entries.
    const r = parsed === undefined ? null : collectFixApplierTolerant(parsed);
    if (!r) lines.push("fixes: (unreadable)");
    else {
      const residual = r.skipped > 0 ? ` (${r.skipped} unreadable)` : "";
      lines.push(
        `fixes: ${r.commits.length} fixed in-cycle, ${r.deferred.length} deferred, ${r.anti_patterns_found.length} anti-patterns noted${residual}`,
      );
    }
  }

  if (inputs.consolidatorRaw.trim()) {
    const parsed = parseJson(inputs.consolidatorRaw);
    const v =
      parsed === undefined
        ? undefined
        : validateConsolidatorResult(normalizeParsedFindings(parsed));
    if (!v || !v.ok) lines.push("consolidator: (unreadable)");
    else {
      const r = v.value;
      lines.push(
        `consolidator: ${r.consolidated_findings.length} findings, ${r.dropped_by_validation.length} dropped`,
      );
    }
  }

  if (inputs.ciWaitRaw.trim()) {
    // No schema validator exists for ci-wait-result.json — parse defensively.
    try {
      const o = JSON.parse(inputs.ciWaitRaw) as Record<string, unknown>;
      lines.push(`CI: ${String(o.decision ?? "(unknown)")}`);
      lines.push(`Copilot: ${copilotOutcome(o)}`);
    } catch {
      lines.push("CI: (unreadable)");
    }
  }

  return lines;
}

/**
 * FORECLOSED PATHS: full prose of the fix-applier + consolidator rejected
 * alternatives and anti-patterns, in plain-text mode (the PR-body section
 * shares the same core formatter). `none` when the entry set is empty; a
 * shape-invalid artifact degrades to an `(unreadable)` contribution for that
 * source rather than crashing.
 */
export function renderForeclosedPaths(inputs: {
  fixApplierRaw: string;
  consolidatorRaw: string;
  /**
   * OPTIONAL disk-fallback directory for the foreclosed-paths formatter's
   * lens negatives (dirname of the consolidator-result path, when the
   * caller has one). This is the surface that puts the total-lens-drop
   * warning in the terminal gate summary for a headless auto-merge run.
   */
  artifactDir?: string;
}): string[] {
  if (isEmpty(collectForeclosedEntries(inputs))) return NONE;
  return formatPlainText(inputs);
}

function copilotOutcome(o: Record<string, unknown>): string {
  if (o.copilotConfigured === false) return "not configured";
  if (typeof o.copilotSkipReason === "string" && o.copilotSkipReason) {
    return `skipped (${o.copilotSkipReason})`;
  }
  return "reviewed";
}

/**
 * FOLLOW-UP ISSUES: filed sweep URLs + unfiled warnings from
 * --filed-issues-file, PLUS pr-review deferrals from fix-applier-result.
 * `none` when there are no filed lines and no deferrals.
 */
export function renderFollowupIssues(
  filedIssuesRaw: string,
  fixApplierRaw: string,
): string[] {
  const lines: string[] = [];
  for (const raw of filedIssuesRaw.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // The step-10 sweep writes `filed\t<url>`, `unfiled\t<title>`, and
    // `rejected\t<title>`; a bare `http…` line is also accepted as filed
    // (resume / hand-authored files).
    if (line.startsWith("filed\t")) {
      lines.push(`filed: ${line.slice("filed\t".length)}`);
    } else if (line.startsWith("unfiled\t")) {
      lines.push(`sweep failed (unfiled): ${line.slice("unfiled\t".length)}`);
    } else if (line.startsWith("rejected\t")) {
      lines.push(`rejected (needs repair): ${line.slice("rejected\t".length)}`);
    } else if (line.startsWith("http")) {
      lines.push(`filed: ${line}`);
    }
  }
  if (fixApplierRaw.trim()) {
    const parsed = parseJson(fixApplierRaw);
    // Tolerant read (mirrors renderFindings): a sibling off-shape entry no
    // longer drops every valid deferral — only a genuinely-broken artifact
    // (-> null) contributes nothing here.
    const r = parsed === undefined ? null : collectFixApplierTolerant(parsed);
    if (r) {
      for (const d of r.deferred) {
        if (d.tracker_entry_url) {
          lines.push(`pr-review deferral: ${d.tracker_entry_url}`);
        } else {
          lines.push(`deferred (unfiled): ${d.reason || d.finding_id}`);
        }
      }
    }
  }
  return lines.length > 0 ? lines : NONE;
}

/**
 * MANUAL STEPS: the already-rendered followups block embedded verbatim
 * (preserves the ran/failed results `flow-followups run` captured), or
 * `none` when empty.
 */
export function renderManualSteps(block: string): string[] {
  const trimmed = block.replace(/\n+$/, "");
  if (!trimmed.trim()) return NONE;
  return trimmed.split("\n");
}

/**
 * INTENT: the Step 3.6 intent-mismatch resolution verdict + guessed-purpose-
 * vs-request note, plus an optional cross-model agreement line. `none` on an
 * absent artifact (most pipelines never reach a mismatch worth recording —
 * this is a graceful-skip category, not a failure). Degrades PER-FIELD
 * (matching `collectFixApplierTolerant` / `renderFindings`'s discipline)
 * rather than collapsing the whole section: a readable `verdict` with an
 * unreadable `resolution` still renders the verdict (and vice versa);
 * `(unreadable)` is reserved for non-JSON input, a non-object/null parse,
 * or BOTH primary fields unreadable. Never emits a stop-guard sentinel.
 */
export function renderIntent(raw: string): string[] {
  if (!raw.trim()) return NONE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ["(unreadable)"];
  }
  if (typeof parsed !== "object" || parsed === null) return ["(unreadable)"];
  const o = parsed as Record<string, unknown>;
  const verdictOk = typeof o.verdict === "string";
  const resolutionOk = typeof o.resolution === "string";
  let primary: string;
  if (verdictOk && resolutionOk) {
    primary = `${o.verdict}: ${o.resolution}`;
  } else if (verdictOk) {
    primary = `${o.verdict}: (resolution unreadable)`;
  } else if (resolutionOk) {
    primary = `(verdict unreadable): ${o.resolution}`;
  } else {
    return ["(unreadable)"];
  }
  const lines = [primary];
  const crossModel = o.cross_model;
  if (
    typeof crossModel === "object" &&
    crossModel !== null &&
    typeof (crossModel as Record<string, unknown>).agreement === "string"
  ) {
    lines.push(
      `cross-model: ${(crossModel as Record<string, unknown>).agreement}`,
    );
  }
  return lines;
}

/**
 * `REVIEW:` body for the `pm`-lens snapshot/comment: the verdict + count
 * line (`<status> — N findings fixed, M deferred` — Q8 dropped the
 * `behavior_changed` self-attestation; a fix that changed behavior belongs
 * under DEVIATIONS instead, never a "none changed behavior" clause here)
 * plus the CI/Copilot line. Bare body lines (no `REVIEW:` label) — the
 * caller prepends the header + 2-space indent, same convention as every
 * other `render*` in this module. `none` only when NONE of prReviewRaw /
 * fixApplierRaw / ciWaitRaw carry data (mirrors `renderFindings`'s gate).
 */
export function renderReviewCounts(inputs: {
  prReviewRaw: string;
  fixApplierRaw: string;
  ciWaitRaw: string;
}): string[] {
  const any =
    inputs.prReviewRaw.trim() ||
    inputs.fixApplierRaw.trim() ||
    inputs.ciWaitRaw.trim();
  if (!any) return NONE;

  let status = "(unknown)";
  if (inputs.prReviewRaw.trim()) {
    const parsed = parseJson(inputs.prReviewRaw);
    const v = parsed === undefined ? undefined : validatePrReviewResult(parsed);
    status = v && v.ok ? v.value.status : "(unreadable)";
  }

  const { fixed, deferred } = fixApplierCounts(inputs.fixApplierRaw);
  const lines = [`${status} — ${fixed} findings fixed, ${deferred} deferred`];

  if (inputs.ciWaitRaw.trim()) {
    try {
      const o = JSON.parse(inputs.ciWaitRaw) as Record<string, unknown>;
      lines.push(
        `CI: ${String(o.decision ?? "(unknown)")} · Copilot: ${copilotOutcome(o)}`,
      );
    } catch {
      lines.push("CI: (unreadable)");
    }
  }
  return lines;
}

function fixApplierCounts(fixApplierRaw: string): {
  fixed: number;
  deferred: number;
} {
  if (!fixApplierRaw.trim()) return { fixed: 0, deferred: 0 };
  const parsed = parseJson(fixApplierRaw);
  const r = parsed === undefined ? null : collectFixApplierTolerant(parsed);
  return r
    ? { fixed: r.commits.length, deferred: r.deferred.length }
    : { fixed: 0, deferred: 0 };
}

/**
 * The single composed count line `--counts-line` prints (and the
 * supervisor threads into `flow-gate-summary --counts-line`) — bare `N
 * findings fixed, M deferred`, no status prefix, no behavior clause (Q8).
 */
export function composeCountsLine(fixApplierRaw: string): string {
  const { fixed, deferred } = fixApplierCounts(fixApplierRaw);
  return `${fixed} findings fixed, ${deferred} deferred`;
}

/**
 * `LENSES:` body (dev) / `lenses:` one-liner (pm) from
 * `review-telemetry.json` — dev gets one line per lens plus a leading
 * `scope:` line; pm gets a single summary line. `none` when raw is
 * empty/absent, `(unreadable)` when present but not parseable JSON —
 * same explicit-none discipline as `renderReviewCounts`.
 */
export function renderLenses(raw: string | undefined): {
  dev: string[];
  pm: string;
} {
  if (!raw || !raw.trim()) return { dev: NONE, pm: "lenses: none" };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { dev: ["(unreadable)"], pm: "lenses: (unreadable)" };
  }
  const scope = parsed.scope as
    | { kind?: string; delta_files?: number }
    | undefined;
  const widened = parsed.widened as
    | { value?: boolean; reason?: string }
    | undefined;
  const lenses = parsed.lenses as
    | Record<
        string,
        {
          ran?: boolean;
          skip_reason?: string;
          tokens?: { total?: number } | null;
          findings_emitted?: number;
          findings_survived?: number;
          findings_acted?: number;
        }
      >
    | undefined;
  if (
    !scope ||
    typeof scope !== "object" ||
    !lenses ||
    typeof lenses !== "object"
  ) {
    return { dev: ["(unreadable)"], pm: "lenses: (unreadable)" };
  }

  const kind = typeof scope.kind === "string" ? scope.kind : "unknown";
  const n = typeof scope.delta_files === "number" ? scope.delta_files : 0;
  const widenedSuffix =
    widened && widened.value ? `, widened: ${widened.reason ?? "unknown"}` : "";
  const devLines = [`scope: ${kind} (${n} files${widenedSuffix})`];

  let ranCount = 0;
  let totalCount = 0;
  let tokenTotal = 0;
  let anyTokens = false;
  for (const [lens, l] of Object.entries(lenses)) {
    if (lens === "gemini" && l.skip_reason === "no artifact") {
      // gemini is optional-by-default (review.gemini off), not a gated lens
      // like the six mandatory ones — "not run" keeps it out of the ran/total
      // ratio instead of masquerading as a real gate verdict.
      devLines.push(`${lens}: not run`);
      continue;
    }
    totalCount++;
    if (l.ran) {
      ranCount++;
      const tokStr =
        l.tokens && typeof l.tokens.total === "number"
          ? String(l.tokens.total)
          : "n/a";
      if (l.tokens && typeof l.tokens.total === "number") {
        tokenTotal += l.tokens.total;
        anyTokens = true;
      }
      devLines.push(
        `${lens}: ran · ${tokStr} tok · ${l.findings_emitted ?? 0}→${l.findings_survived ?? 0}→${l.findings_acted ?? 0}`,
      );
    } else {
      devLines.push(`${lens}: gated (${l.skip_reason ?? "unknown"})`);
    }
  }

  const pmLine = `lenses: ${ranCount}/${totalCount} ran, scope ${kind}, ~${anyTokens ? tokenTotal : "n/a"} tokens`;
  return { dev: devLines, pm: pmLine };
}

/**
 * `PLAN-DEVIATION:` bullets under scout.md's `## open_questions` heading —
 * binding contract adjustments the scout agent found between the plan and
 * the actual code (`AGENTS.md`/coder-instructions discipline: these
 * override the plan where they conflict). Returns the bullet text with the
 * leading `- ` and `PLAN-DEVIATION: ` markers stripped; other bullets
 * under the same heading (`Assumption:` etc.) are not deviations and are
 * excluded.
 */
export function parsePlanDeviations(scoutMd: string): string[] {
  const lines = scoutMd.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === "## open_questions");
  if (headingIdx === -1) return [];
  const out: string[] = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    const m = line.match(/^-\s*PLAN-DEVIATION:\s*(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * `DEVIATIONS:` body: the intent-resolution verdict when non-`match`, fix-
 * applier deferrals that carry a `tracker_entry_url`, and scout
 * `PLAN-DEVIATION:` bullets — the only three mechanical deviation sources
 * (Cut list: no machine-parsed "meaningful deviation" classifier). `none`
 * when all three are empty. An absent `scoutRaw` (no scout file — the
 * ≤3-affected-file path never spawns one) degrades silently to no
 * contribution from that source, not `(unreadable)` — that marker is
 * reserved for a present-but-unparseable scout.md, which this function
 * never produces (scout.md is prose, not JSON, so there is no parse step
 * to fail).
 */
export function renderDeviations(inputs: {
  intentResolutionRaw: string;
  fixApplierRaw: string;
  scoutRaw: string;
}): string[] {
  const lines: string[] = [];
  if (inputs.intentResolutionRaw.trim()) {
    try {
      const o = JSON.parse(inputs.intentResolutionRaw) as Record<
        string,
        unknown
      >;
      if (typeof o.verdict === "string" && o.verdict !== "match") {
        const resolution =
          typeof o.resolution === "string"
            ? ` — ${o.resolution}`
            : " — (resolution unreadable)";
        lines.push(`intent: ${o.verdict}${resolution}`);
      }
    } catch {
      /* unparseable intent-resolution contributes nothing here */
    }
  }
  if (inputs.fixApplierRaw.trim()) {
    const parsed = parseJson(inputs.fixApplierRaw);
    const r = parsed === undefined ? null : collectFixApplierTolerant(parsed);
    if (r) {
      for (const d of r.deferred) {
        if (d.tracker_entry_url) {
          lines.push(
            `deferred → ${d.tracker_entry_url} (${d.reason || d.finding_id})`,
          );
        }
      }
    }
  }
  if (inputs.scoutRaw.trim()) {
    for (const d of parsePlanDeviations(inputs.scoutRaw)) lines.push(d);
  }
  return lines.length > 0 ? lines : NONE;
}

/**
 * Rejected decisions for the slim PR comment's DECISIONS section: the
 * `rejected_alternatives[]` from BOTH the fix-applier artifact (objects with
 * `finding_id` / `considered_approach` / `why_rejected`) AND the consolidator
 * artifact (plain strings), PLUS the consolidator's pass-through
 * `lens_rejected_alternatives[]` (code-scoped, tagged with the source lens).
 * `artifactDir` mirrors `antiPatternDecisionLines`'s sibling disk-fallback
 * parameter: when the consolidator artifact carries no lens negatives and
 * `artifactDir` is supplied, `collectLensNegativesFromDirSync` rescues them
 * from the raw `agent-output-<lens>.json` files — without this, a
 * disk-rescued anti-pattern could render beside a `rejected: none` even
 * though the same rescue would have surfaced a rejected-alternative too.
 * `none` when none of the three carries any.
 */
function rejectedDecisionLines(
  fixApplierRaw: string,
  consolidatorRaw: string,
  artifactDir?: string,
): string[] {
  const lines: string[] = [];
  if (fixApplierRaw.trim()) {
    const parsed = parseJson(fixApplierRaw);
    // Tolerant read (mirrors renderFindings): a sibling off-shape entry no
    // longer drops every valid rejected alternative.
    const r = parsed === undefined ? null : collectFixApplierTolerant(parsed);
    if (r) {
      for (const ra of r.rejected_alternatives) {
        lines.push(
          `${ra.finding_id}: ${ra.considered_approach} — ${ra.why_rejected}`,
        );
      }
    }
  }
  if (consolidatorRaw.trim()) {
    const parsed = parseJson(consolidatorRaw);
    const v =
      parsed === undefined
        ? undefined
        : validateConsolidatorResult(normalizeParsedFindings(parsed));
    if (v && v.ok) {
      for (const r of v.value.rejected_alternatives) lines.push(r);
      // Optional pass-through key — absent contributes nothing. Falls back
      // to the shared disk-rescue collector (via collectForeclosedEntries)
      // when the artifact itself carries no lens negatives, mirroring the
      // anti-pattern sub-part below.
      const lensRejected =
        v.value.lens_rejected_alternatives &&
        v.value.lens_rejected_alternatives.length > 0
          ? v.value.lens_rejected_alternatives
          : collectForeclosedEntries({
              fixApplierRaw: "",
              consolidatorRaw,
              artifactDir,
            })
              .filter(
                (e) =>
                  e.source === "lens" &&
                  e.category === "rejected-alternative" &&
                  e.rawEntry === undefined,
              )
              .map((e) => ({
                lens: e.lens ?? "",
                considered_approach: e.considered_approach ?? "",
                why_rejected: e.why_rejected ?? "",
              }));
      for (const r of lensRejected) {
        lines.push(
          `lens(${r.lens}): ${r.considered_approach} - ${r.why_rejected}`,
        );
      }
    }
  }
  return lines.length > 0 ? lines : NONE;
}

/**
 * Anti-pattern decisions for the slim PR comment's DECISIONS section,
 * sourced from the shared `collectForeclosedEntries` collector (the same
 * core the `## Foreclosed Paths` PR-body section and the `FORECLOSED PATHS`
 * terminal snapshot render from) filtered to `category === "anti-pattern"`,
 * plus any whole-source `unreadable` degradation marker (those are tagged
 * `category: "rejected-alternative"` by the collector, so they need an
 * explicit `|| e.unreadable` or a broken artifact would silently render
 * `none` instead of `(unreadable)`, unlike its sibling surfaces).
 *
 * `isTotalLensDrop` is evaluated over the FULL (unfiltered) entry set, not
 * this sub-part's anti-pattern-only filtered subset: `missing_lenses`
 * survives the filter (tagged `category: "anti-pattern"`) while a live lens
 * rejected-alternative does not (it renders in the sibling `rejected:`
 * sub-part instead), so filtering first would make an all-anti-pattern-lens
 * view look like a total drop even when `rejected:` just rendered lens
 * entries above it — the exact false alarm the warning exists to prevent.
 * `none` when the filtered set is empty.
 */
function antiPatternDecisionLines(
  fixApplierRaw: string,
  consolidatorRaw: string,
  artifactDir?: string,
): string[] {
  const allEntries = collectForeclosedEntries({
    fixApplierRaw,
    consolidatorRaw,
    artifactDir,
  });
  const genuineTotalDrop = isTotalLensDrop(allEntries);
  const filtered = allEntries.filter((e) =>
    e.category === "anti-pattern" || e.unreadable
      ? // Suppress the `missing_lenses` marker entry itself when this
        // isn't a genuine total drop — some other lens category (e.g.
        // rejected-alternatives) DID populate, so the marker would be
        // misleading standalone here.
        e.missing_lenses === undefined || genuineTotalDrop
      : false,
  );
  const lines = formatPlainTextEntries(filtered);
  return lines.length > 0 ? lines : NONE;
}

/**
 * Slimmed, un-fenced PR-comment block (NOT the scrollback block). A plain
 * `PIPELINE SNAPSHOT` title line (no `##`) over three 2-space-indented
 * labeled sections: CHANGES (the one-line diff summary, reusing
 * renderChanges), REVIEW (the review/findings disposition, reusing
 * renderFindings), and DECISIONS (deferred + rejected + anti-patterns), plus a conditional
 * INTENT section emitted only when the intent-resolution artifact is
 * present AND its verdict is non-`match` (an unparseable artifact drops the
 * section entirely rather than rendering `(unreadable)`, unlike `render()`).
 * PHASES and MANUAL STEPS are intentionally dropped. Pure over already-read
 * inputs — mirrors render(); never reads files.
 */
export type RenderCommentInputs = {
  prChangesRaw: string;
  prReviewRaw: string;
  fixApplierRaw: string;
  consolidatorRaw: string;
  ciWaitRaw: string;
  filedIssuesRaw: string;
  intentResolutionRaw?: string;
  /** pm-lens only: scout.md raw text for PLAN-DEVIATION: bullets. */
  scoutRaw?: string;
  /** pm-lens only: pre-rendered `flow-untracked render --format markdown --unfiled-only` lines. */
  untrackedBlock?: string;
  /** OPTIONAL disk-fallback directory for the anti-pattern DECISIONS section's lens negatives. */
  artifactDir?: string;
  /** review-telemetry.json raw text, for the LENSES (dev) / lenses: (pm) sections. */
  reviewTelemetryRaw?: string;
};

function renderCommentDev(inputs: RenderCommentInputs): string {
  const lines: string[] = ["PIPELINE SNAPSHOT"];
  lines.push("CHANGES:");
  for (const ln of renderChanges(inputs.prChangesRaw)) lines.push(`  ${ln}`);
  lines.push("REVIEW:");
  for (const ln of renderFindings({
    prReviewRaw: inputs.prReviewRaw,
    fixApplierRaw: inputs.fixApplierRaw,
    consolidatorRaw: inputs.consolidatorRaw,
    ciWaitRaw: inputs.ciWaitRaw,
  })) {
    lines.push(`  ${ln}`);
  }
  lines.push("LENSES:");
  for (const ln of renderLenses(inputs.reviewTelemetryRaw).dev) {
    lines.push(`  ${ln}`);
  }
  // INTENT only appears in the comment variant when the artifact is present
  // AND its verdict is non-match — a clean match adds nothing worth
  // persisting to the PR comment.
  // NOTE: only the GATE below is snapshot-only, not the rendered body. The
  // PR-comment variant deliberately still requires a readable STRING
  // `verdict` to even open an INTENT section — a resolution-only artifact
  // (unreadable verdict) still yields NO INTENT section in the comment,
  // even though render() (the snapshot) would now show "(verdict
  // unreadable): <resolution>". That half of the asymmetry is intentional:
  // the gate exists to avoid persisting a section whose headline field
  // couldn't be read. But once the gate opens, the BODY is delegated
  // verbatim to renderIntent's per-field degradation, so a verdict-present /
  // resolution-missing artifact (e.g. `{"verdict":"scope-drift"}`) now
  // persists "scope-drift: (resolution unreadable)" to the PR comment where
  // it previously persisted "(unreadable)" — that half of the comment
  // surface DID change with this PR.
  if (inputs.intentResolutionRaw && inputs.intentResolutionRaw.trim()) {
    let verdict: string | undefined;
    try {
      const o = JSON.parse(inputs.intentResolutionRaw) as Record<
        string,
        unknown
      >;
      if (typeof o.verdict === "string") verdict = o.verdict;
    } catch {
      /* leave undefined — degrades to no INTENT section, not (unreadable) */
    }
    if (verdict && verdict !== "match") {
      lines.push("INTENT:");
      for (const ln of renderIntent(inputs.intentResolutionRaw)) {
        lines.push(`  ${ln}`);
      }
    }
  }
  lines.push("DECISIONS:");
  lines.push("  deferred:");
  for (const ln of renderFollowupIssues(
    inputs.filedIssuesRaw,
    inputs.fixApplierRaw,
  )) {
    lines.push(`    ${ln}`);
  }
  lines.push("  rejected:");
  for (const ln of rejectedDecisionLines(
    inputs.fixApplierRaw,
    inputs.consolidatorRaw,
    inputs.artifactDir,
  )) {
    lines.push(`    ${ln}`);
  }
  lines.push("  anti-patterns:");
  for (const ln of antiPatternDecisionLines(
    inputs.fixApplierRaw,
    inputs.consolidatorRaw,
    inputs.artifactDir,
  )) {
    lines.push(`    ${ln}`);
  }
  return lines.join("\n");
}

/**
 * pm-lens PR-comment block: `CHANGES` / `REVIEW` (verdict + count line,
 * never the `review:` narrative) / `DEVIATIONS` / `UNTRACKED` only — the
 * developer detail (full review summary, `consolidator:` line, `rejected:` /
 * `anti-patterns:` reasoning) moves to `dev`, rendered inside a `<details>`
 * wrapper by `buildCommentBody`.
 */
function renderCommentPm(inputs: RenderCommentInputs): string {
  const lines: string[] = ["PIPELINE SNAPSHOT"];
  lines.push("CHANGES:");
  for (const ln of renderChanges(inputs.prChangesRaw)) lines.push(`  ${ln}`);
  lines.push("REVIEW:");
  for (const ln of renderReviewCounts({
    prReviewRaw: inputs.prReviewRaw,
    fixApplierRaw: inputs.fixApplierRaw,
    ciWaitRaw: inputs.ciWaitRaw,
  })) {
    lines.push(`  ${ln}`);
  }
  lines.push(`  ${renderLenses(inputs.reviewTelemetryRaw).pm}`);
  lines.push("DEVIATIONS:");
  for (const ln of renderDeviations({
    intentResolutionRaw: inputs.intentResolutionRaw ?? "",
    fixApplierRaw: inputs.fixApplierRaw,
    scoutRaw: inputs.scoutRaw ?? "",
  })) {
    lines.push(`  ${ln}`);
  }
  lines.push("UNTRACKED:");
  for (const ln of renderManualSteps(inputs.untrackedBlock ?? "")) {
    lines.push(`  ${ln}`);
  }
  return lines.join("\n");
}

/**
 * Slimmed, un-fenced PR-comment block (NOT the scrollback block) — both
 * lenses: `pm` (CHANGES / REVIEW counts / DEVIATIONS / UNTRACKED, the
 * top-level fenced block) and `dev` (today's CHANGES / REVIEW narrative /
 * optional INTENT / DECISIONS, the `<details>`-collapsed developer block —
 * `buildCommentBody` composes the two). Pure over already-read inputs;
 * never reads files.
 */
export function renderComment(inputs: RenderCommentInputs): {
  pm: string;
  dev: string;
} {
  return { pm: renderCommentPm(inputs), dev: renderCommentDev(inputs) };
}

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
