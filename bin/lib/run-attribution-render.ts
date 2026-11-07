/**
 * `RAN ON:` section for the pipeline snapshot (and its posted PR comment):
 * which model, at which effort, did each part of the run, built from the
 * ordered model+effort `runs` so a mid-run `/effort` or `/model` switch is
 * never misattributed. Dollar figures are list price, not billed amounts.
 */

import { friendlyName } from "./cost-pricing";
import type {
  RunAttribution,
  SpawnAttribution,
  UnitAttribution,
} from "./run-attribution-types";
import type { ModelEffortRun } from "./transcript-turns";

const NOT_RECORDED = "effort not recorded in the session logs";

const modelName = (m: string | null): string =>
  m ? friendlyName(m) : "unknown model";

const dollars = (v: number | null): string =>
  v === null ? "unpriced" : `$${v.toFixed(2)}`;

function mergeRuns(units: readonly UnitAttribution[]): ModelEffortRun[] {
  const out: ModelEffortRun[] = [];
  for (const [m, e, n] of units.flatMap((u) => u.runs)) {
    const last = out[out.length - 1];
    if (last && last[0] === m && last[1] === e) last[2] += n;
    else out.push([m, e, n]);
  }
  return out;
}

/** `Opus 5.5 at low (327 turns), then high (39)`; a model switch names the new model. */
function formatRuns(
  runs: readonly ModelEffortRun[],
  hideEffort: boolean,
): string {
  const parts: string[] = [];
  let prevModel: string | null | undefined;
  runs.forEach(([model, effort, turns], i) => {
    const noEffort = hideEffort || effort === "unknown";
    const at = noEffort ? "" : ` at ${effort}`;
    const count =
      i === 0 ? `${turns} turn${turns === 1 ? "" : "s"}` : `${turns}`;
    if (i === 0 || model !== prevModel) {
      const head = `${modelName(model)}${at} (${count})`;
      parts.push(i === 0 ? head : `then ${head}`);
    } else {
      parts.push(noEffort ? `(${count})` : `then ${effort} (${count})`);
    }
    prevModel = model;
  });
  return parts.join(", ");
}

/** Distinct sub-agent model/effort pairs with how many sub-agents ran on each. */
function spawnPairs(spawns: readonly SpawnAttribution[]): string[] {
  const pairs = new Map<string, number>();
  for (const s of spawns) {
    const seen = new Set<string>();
    for (const [m, e] of s.runs) {
      const key = e === "unknown" ? modelName(m) : `${modelName(m)} at ${e}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  return [...pairs].map(([key, n]) => `${key} ×${n}`);
}

function delegatedLabel(attr: RunAttribution): string | null {
  const counts = new Map<string, number>();
  for (const d of attr.delegated) {
    if (d.ran === false) continue;
    const name = modelName(d.model);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return `delegated: ${[...counts].map(([m, n]) => `${m} ×${n}`).join(", ")}`;
}

function totalLabel(attr: RunAttribution): string {
  const t = attr.totals;
  let out = `${dollars(t.cost_usd)} at list price`;
  if (t.unpriced_models.length > 0) {
    out += ` (+ unpriced: ${t.unpriced_models.map(friendlyName).join(", ")})`;
  }
  if (t.skipped_files > 0) {
    const n = t.skipped_files;
    out += ` (+ ${n} transcript${n === 1 ? "" : "s"} not read: too large or unreadable)`;
  }
  return out;
}

function allEffortUnknown(attr: RunAttribution): boolean {
  const turns = [...attr.sessions, ...attr.spawns].reduce(
    (n, u) => n + u.turns,
    0,
  );
  return turns > 0 && attr.totals.unattributed_effort_turns >= turns;
}

export function renderRanOn(
  attr: RunAttribution | null,
  lens: "pm" | "dev",
): string[] {
  if (
    !attr ||
    attr.sessions.length + attr.spawns.length + attr.delegated.length === 0
  ) {
    return ["none"];
  }
  const hide = allEffortUnknown(attr);
  const delegated = delegatedLabel(attr);
  if (lens === "pm") {
    const parts = [
      attr.sessions.length > 0
        ? formatRuns(mergeRuns(attr.sessions), hide)
        : null,
      hide ? NOT_RECORDED : null,
      attr.spawns.length > 0
        ? `sub-agents: ${spawnPairs(attr.spawns).join(", ")}`
        : null,
      delegated,
      totalLabel(attr),
    ];
    return [parts.filter((p): p is string => Boolean(p)).join("; ")];
  }
  const lines: string[] = [];
  attr.sessions.forEach((s, i) => {
    lines.push(
      `session ${i + 1} (${s.session_id.slice(0, 8)}): ${formatRuns(s.runs, hide)} — ${dollars(s.cost_usd)}`,
    );
  });
  const byRole = new Map<string, SpawnAttribution[]>();
  for (const s of attr.spawns) {
    byRole.set(s.role, [...(byRole.get(s.role) ?? []), s]);
  }
  for (const [role, group] of byRole) {
    const cost = group.some((s) => s.cost_usd !== null)
      ? group.reduce((n, s) => n + (s.cost_usd ?? 0), 0)
      : null;
    const times = group.length > 1 ? ` ×${group.length}` : "";
    lines.push(
      `${role}${times}: ${formatRuns(mergeRuns(group), hide)} — ${dollars(cost)}`,
    );
  }
  if (delegated) lines.push(delegated);
  if (hide) lines.push(NOT_RECORDED);
  lines.push(`total: ${totalLabel(attr)}`);
  return lines;
}
