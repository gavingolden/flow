/**
 * Mechanical preconditions the epic executive checks BEFORE any model spend.
 * Each failure is named, so a deferral says exactly why the owner is being
 * asked. Pure apart from injectable file probes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { computeDecisionHash, readPriorHash } from "../flow-plan-review";
import { lintPlan } from "../flow-plan-lint";
import {
  extractVettingVerdict,
  parseVettingVerdict,
} from "../flow-step3-route";
import { MIN_LENSES_ENGAGED } from "./plan-review-engagement";
import { ANCHOR_RE } from "./value-anchors";

export type PreconditionId =
  | "cross-model-unavailable"
  | "cross-model-not-engaged"
  | "cross-model-stale"
  | "anchor-unresolved"
  | "plan-lint"
  | "needs-user-input"
  | "stakes-confidence"
  | "plan-deviates-from-request"
  | "one-way-action";

export type PreconditionResult =
  | { ok: true }
  | { ok: false; failed: PreconditionId; detail: string };

/**
 * Actions the executive may never wave through: irreversible, production,
 * shared-resource, or paid. Case-insensitive, and an ambiguous match counts as
 * a match — a false deferral costs the owner one interruption; a false pass
 * can cost a production incident.
 */
export const ONE_WAY_ACTION_PATTERNS: readonly RegExp[] = [
  /\bdb[\s:_-]+(reset|push|drop|seed)\b/i,
  /\bmigrat(e|ion)s?[\s:_-]+reset\b/i,
  /--linked\b/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i,
  /\bTRUNCATE\b/i,
  /\b(npm|bun|yarn|pnpm)\s+publish\b/i,
  /\b(vercel|netlify|fly|wrangler|firebase)\s+(deploy|publish)\b/i,
  /\b(deploy|publish|release)\w*\b.{0,40}\bprod(uction)?\b/i,
  /\bprod(uction)?\b.{0,40}\b(deploy|publish|migrat)\w*/i,
  /\b(usage[- ]counter|quota)s?\b.{0,40}\b(reset|write|update|increment|set|clear)\w*/i,
  /\b(reset|increment|clear)\w*\b.{0,40}\b(usage[- ]counter|quota)s?\b/i,
  /\bshared\b.{0,30}\b(reset|wipe|drop|purge)\w*/i,
  /\b(reset|wipe|drop|purge)\w*\b.{0,30}\bshared\b/i,
  /--record-override\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bflow-merge-guard\s+merge\b/i,
  /\bFLOW_LIVE_[A-Z_]+=1\b/,
  /\bflow\s+eval\b/i,
  /\bnpm\s+run\s+eval\b/i,
  /--max-budget-usd\b/i,
  /\b(billing|purchase|subscription)\b/i,
];

type Probes = {
  fileExists?: (p: string) => boolean;
  lineCount?: (p: string) => number;
  lint?: (planText: string) => string[];
};

function sectionBody(text: string, heading: RegExp): string | null {
  const m = heading.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^#{1,2} /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

type OqBlock = { checked: boolean; block: string };

function openQuestionBlocks(planText: string): OqBlock[] {
  const body = sectionBody(planText, /^## Open Questions\s*$/m);
  if (body === null) return [];
  const starts = [...body.matchAll(/^- \[([ xX])\]/gm)];
  return starts.map((m, i) => {
    const from = m.index ?? 0;
    const rest = body.slice(from + m[0].length);
    const stop = rest.search(/^(?:- |#{1,6} )/m);
    return {
      checked: m[1] !== " ",
      block: m[0] + (stop === -1 ? rest : rest.slice(0, stop)),
    };
  });
}

function checkCrossModel(
  planText: string,
  runRecordText: string | null,
): PreconditionResult {
  if (runRecordText === null) {
    return {
      ok: false,
      failed: "cross-model-unavailable",
      detail: "no plan-review run record — the cross-model review never ran",
    };
  }
  let record: unknown;
  try {
    record = JSON.parse(runRecordText);
  } catch {
    return {
      ok: false,
      failed: "cross-model-unavailable",
      detail: "the plan-review run record is not valid JSON",
    };
  }
  const reviewers = Array.isArray(
    (record as { reviewers?: unknown })?.reviewers,
  )
    ? ((record as { reviewers: unknown[] }).reviewers as Array<
        Record<string, unknown>
      >)
    : [];
  const engaged = reviewers.some(
    (r) =>
      r?.ran === true &&
      typeof r.model === "string" &&
      !/claude/i.test(r.model) &&
      typeof r.lensesEngaged === "number" &&
      r.lensesEngaged >= MIN_LENSES_ENGAGED,
  );
  if (!engaged) {
    const why = (record as { skipReason?: unknown })?.skipReason;
    return {
      ok: false,
      failed: "cross-model-not-engaged",
      detail: `no non-Claude reviewer engaged ${MIN_LENSES_ENGAGED}+ lenses${typeof why === "string" ? ` (skipReason: ${why})` : ""}`,
    };
  }
  const embedded = readPriorHash(planText);
  if (embedded === null || embedded !== computeDecisionHash(planText)) {
    return {
      ok: false,
      failed: "cross-model-stale",
      detail:
        "the plan changed a reviewed decision since the cross-model review (hash mismatch)",
    };
  }
  return { ok: true };
}

function checkAnchors(
  planText: string,
  worktree: string,
  probes: Probes,
): PreconditionResult {
  const exists = probes.fileExists ?? ((p) => fs.existsSync(p));
  const lines =
    probes.lineCount ?? ((p) => fs.readFileSync(p, "utf8").split("\n").length);
  for (const m of planText.matchAll(new RegExp(ANCHOR_RE.source, "g"))) {
    const rel = m[1];
    if (rel.startsWith("~/") || rel === "~") continue;
    const abs = path.resolve(worktree, rel);
    const within = path.relative(worktree, abs);
    if (within.startsWith("..") || path.isAbsolute(within)) {
      return {
        ok: false,
        failed: "anchor-unresolved",
        detail: `anchor ${rel} escapes the worktree`,
      };
    }
    if (!exists(abs)) {
      return {
        ok: false,
        failed: "anchor-unresolved",
        detail: `anchor ${rel} does not exist`,
      };
    }
    const cited = /:(\d+(?:,\d+)*)$/.exec(m[0]);
    if (cited) {
      let max: number;
      try {
        max = lines(abs);
      } catch {
        return {
          ok: false,
          failed: "anchor-unresolved",
          detail: `anchor ${rel} is not a readable file`,
        };
      }
      for (const n of cited[1].split(",").map(Number)) {
        if (n > max) {
          return {
            ok: false,
            failed: "anchor-unresolved",
            detail: `anchor ${rel}:${n} is past the end of the file (${max} lines)`,
          };
        }
      }
    }
  }
  return { ok: true };
}

function defaultLint(planText: string, worktree: string): string[] {
  let excludedPathsJson: string | undefined;
  try {
    excludedPathsJson = fs.readFileSync(
      path.join(worktree, ".flow-tmp", "excluded-paths.json"),
      "utf8",
    );
  } catch {
    excludedPathsJson = undefined;
  }
  return lintPlan(planText, {
    excludedPathsJson,
    surveyRan: false,
    planMdFile: path.join(worktree, ".flow-tmp", "plan.md"),
  }).misses;
}

function checkOpenQuestions(planText: string): PreconditionResult {
  for (const { checked, block } of openQuestionBlocks(planText)) {
    if (checked) continue;
    const head = block.split("\n", 1)[0].slice(0, 80);
    if (/\*\*Needs user input:\*\*/.test(block)) {
      return {
        ok: false,
        failed: "needs-user-input",
        detail: `unresolved owner question: ${head}`,
      };
    }
    const stakes = /\*\*Stakes:\*\*\s*(user|both)\b/i.exec(block);
    if (stakes) {
      const rec = block.split("\n").find((l) => l.includes("**Recommended:**"));
      if (!rec || !/\[confidence:\s*high\]/i.test(rec)) {
        return {
          ok: false,
          failed: "stakes-confidence",
          detail: `a ${stakes[1].toLowerCase()}-stakes question lacks a high-confidence recommendation: ${head}`,
        };
      }
    }
  }
  return { ok: true };
}

function checkRequestFit(planText: string): PreconditionResult {
  const rec = sectionBody(planText, /^## Recommendation\s*$/m);
  if (rec === null || !/^\s*\*\*Proceed\*\*/.test(rec)) {
    return {
      ok: false,
      failed: "plan-deviates-from-request",
      detail: "the plan's recommendation is not Proceed",
    };
  }
  const raw = extractVettingVerdict(planText);
  const verdict = raw ? parseVettingVerdict(raw) : null;
  if (!verdict || verdict.kind === "push back") {
    return {
      ok: false,
      failed: "plan-deviates-from-request",
      detail: verdict
        ? "the request-vetting verdict is push back"
        : "the request-vetting verdict is missing or unreadable",
    };
  }
  return { ok: true };
}

function contractAndAcceptanceLines(planText: string): string[] {
  const out: string[] = [];
  const tasks = planText.split(/^# Task breakdown\s*$/m)[1];
  if (tasks) {
    const body = tasks.split(/^# /m)[0];
    let inContract = false;
    for (const line of body.split("\n")) {
      if (/^- \*\*(Contract|Acceptance criteria):\*\*/.test(line))
        inContract = true;
      else if (/^- \*\*/.test(line) || /^#{1,3} /.test(line))
        inContract = false;
      if (inContract) out.push(line);
    }
  }
  const steps = sectionBody(planText, /^## Test Steps\s*$/m);
  if (steps) {
    out.push(...steps.split("\n").filter((l) => /^\s*- \[[ xX]\]/.test(l)));
  }
  return out;
}

function checkOneWay(planText: string): PreconditionResult {
  for (const line of contractAndAcceptanceLines(planText)) {
    const hit = ONE_WAY_ACTION_PATTERNS.find((re) => re.test(line));
    if (hit) {
      return {
        ok: false,
        failed: "one-way-action",
        detail: `a task contract, acceptance command, or test step names a one-way action (${hit.source}): ${line.trim().slice(0, 140)}`,
      };
    }
  }
  return { ok: true };
}

export function checkPlanPreconditions(
  input: { planText: string; runRecordText: string | null; worktree: string },
  deps: Probes = {},
): PreconditionResult {
  const { planText, runRecordText, worktree } = input;
  const crossModel = checkCrossModel(planText, runRecordText);
  if (!crossModel.ok) return crossModel;

  const anchors = checkAnchors(planText, worktree, deps);
  if (!anchors.ok) return anchors;

  const misses = (deps.lint ?? ((t) => defaultLint(t, worktree)))(planText);
  if (misses.length > 0) {
    return {
      ok: false,
      failed: "plan-lint",
      detail: `flow-plan-lint reports ${misses.length} miss(es): ${misses[0].slice(0, 160)}`,
    };
  }

  for (const check of [
    () => checkOpenQuestions(planText),
    () => checkRequestFit(planText),
    () => checkOneWay(planText),
  ]) {
    const r = check();
    if (!r.ok) return r;
  }
  return { ok: true };
}
