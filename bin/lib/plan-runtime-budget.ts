/**
 * Advisory flow-plan-lint check: an `inline` row in '### Runtime design' whose
 * estimated p99 is over the 10 s interactive budget. An eval planner argued
 * past the written budget and kept a ~65 s five-call fan-out inline, and the
 * plan's own p99 column states the breach.
 */
import { findPrdSectionEnd } from "./plan-runtime-surface";

const BUDGET_S = 10;
const DURATION_RE =
  /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i;

function toSeconds(m: RegExpMatchArray): number {
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === "ms" || u.startsWith("milli")) return n / 1000;
  if (u === "m" || u.startsWith("min")) return n * 60;
  return n;
}

const OFF_REQUEST_RE =
  /\b(?:worker|consumer|job|workflow|cron|background|queued|batch)\b/i;

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function runtimeDesignBody(planText: string): string | null {
  const prd = planText.match(/^# PRD\s*$/m);
  if (!prd) return null;
  const afterPrd = (prd.index ?? 0) + prd[0].length;
  const body = planText
    .slice(afterPrd, findPrdSectionEnd(planText, afterPrd))
    .replace(/<!--[\s\S]*?-->/g, "");
  const h = body.match(/^### Runtime design\s*$/m);
  if (!h) return null;
  const rest = body.slice((h.index ?? 0) + h[0].length);
  const next = rest.search(/^#{1,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function checkInlineBudget(planText: string, misses: string[]): void {
  const body = runtimeDesignBody(planText);
  if (body === null) return;
  const rows = body.split("\n").filter((l) => l.trim().startsWith("|"));
  if (rows.length < 2) return;
  const header = cells(rows[0]).map((c) => c.toLowerCase());
  const opIdx = header.indexOf("operation");
  const p99Idx = header.indexOf("est. p99");
  const execIdx = header.indexOf("execution model");
  const missing = [
    opIdx < 0 ? "Operation" : "",
    p99Idx < 0 ? "Est. p99" : "",
    execIdx < 0 ? "Execution model" : "",
  ].filter(Boolean);
  if (missing.length > 0) {
    misses.push(
      `'### Runtime design' table is missing the ${missing.map((m) => `'${m}'`).join(", ")} column${missing.length > 1 ? "s" : ""} — the inline-budget check cannot run without them; add them so each operation states its p99 and execution model`,
    );
    return;
  }
  for (const row of rows.slice(1)) {
    const c = cells(row);
    if (c.every((x) => /^:?-+:?$/.test(x))) continue;
    const exec = (c[execIdx] ?? "").replace(/[`*]/g, "").trimStart();
    if (!/^inline\b/i.test(exec) || OFF_REQUEST_RE.test(exec)) continue;
    const dur =
      (c[p99Idx] ?? "").match(DURATION_RE) ??
      exec.slice("inline".length).match(DURATION_RE);
    const op = (c[opIdx] ?? "").replace(/`/g, "").trim();
    if (!dur) {
      misses.push(
        `'### Runtime design' row '${op}' runs inline with no numeric p99 — write an estimate such as '~800 ms' or '~12 s' so the ${BUDGET_S} s interactive budget can be checked`,
      );
      continue;
    }
    const secs = toSeconds(dur);
    if (secs <= BUDGET_S) continue;
    misses.push(
      `'### Runtime design' row '${op}' runs inline with an estimated p99 of ${secs} s, over the ${BUDGET_S} s interactive budget — queue it and return 202 plus a status resource, or bring the p99 under ${BUDGET_S} s; a **Proportionality:** note cannot waive the ${BUDGET_S} s interactive budget`,
    );
  }
}
