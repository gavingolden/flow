/**
 * The waiter's slow poll: one aliased GitHub GraphQL query across every repo
 * that has an unfinished pipeline with a PR URL. A PR that is MERGED or CLOSED
 * while its pipeline is not finished becomes a `merged-out-of-band` event.
 * Zero model calls.
 */

import * as os from "node:os";
import { GH_TIMEOUT_MS, type ExecFn } from "./epic-manage-observe";
import type { WakeEvent } from "./manager-wait";
import { repoNameForPath } from "./manager-scope";
import { FINISHED_PHASE_SET, type PipelineState } from "./state";

export type PrTarget = { owner: string; name: string; pr: number };
export type PrState = "OPEN" | "MERGED" | "CLOSED";

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export const prKey = (t: PrTarget): string =>
  `${t.owner}/${t.name}#${t.pr}`.toLowerCase();

export function parsePrUrl(url: string | undefined): PrTarget | null {
  const m = url ? PR_URL.exec(url) : null;
  return m ? { owner: m[1], name: m[2], pr: Number(m[3]) } : null;
}

export function buildMultiRepoPrQuery(targets: PrTarget[]): string {
  const byRepo = new Map<string, PrTarget[]>();
  for (const t of targets) {
    const k = `${t.owner}/${t.name}`;
    byRepo.set(k, [...(byRepo.get(k) ?? []), t]);
  }
  const repos = [...byRepo.values()].map((ts, i) => {
    const prs = [...new Set(ts.map((t) => t.pr))]
      .map(
        (n) => `p${n}: pullRequest(number: ${Math.trunc(n)}) { number state }`,
      )
      .join(" ");
    return `r${i}: repository(owner: ${JSON.stringify(ts[0].owner)}, name: ${JSON.stringify(ts[0].name)}) { nameWithOwner ${prs} }`;
  });
  return `query { ${repos.join(" ")} }`;
}

/** Tolerant: parses `data` even when `gh` exited non-zero, since one unresolvable PR yields a null alias, not an unusable answer. */
export function parseMultiRepoPrResponse(stdout: string): Map<string, PrState> {
  const out = new Map<string, PrState>();
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return out;
  }
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (typeof data !== "object" || data === null) return out;
  for (const repo of Object.values(data)) {
    if (typeof repo !== "object" || repo === null) continue;
    const r = repo as Record<string, unknown>;
    if (typeof r.nameWithOwner !== "string") continue;
    for (const v of Object.values(r)) {
      const pr = v as { number?: unknown; state?: unknown } | null;
      if (
        typeof pr === "object" &&
        pr !== null &&
        typeof pr.number === "number" &&
        (pr.state === "OPEN" || pr.state === "MERGED" || pr.state === "CLOSED")
      ) {
        out.set(`${r.nameWithOwner}#${pr.number}`.toLowerCase(), pr.state);
      }
    }
  }
  return out;
}

/** One `gh` call for every unfinished pipeline in `states` that has a PR URL; none when there is nothing to ask. */
export async function fetchPrStates(
  states: PipelineState[],
  exec: ExecFn,
): Promise<Map<string, PrState>> {
  const targets = states.flatMap((s) => {
    const t = FINISHED_PHASE_SET.has(s.phase) ? null : parsePrUrl(s.prUrl);
    return t ? [t] : [];
  });
  if (targets.length === 0) return new Map();
  const r = await exec(
    "gh",
    ["api", "graphql", "-f", `query=${buildMultiRepoPrQuery(targets)}`],
    os.tmpdir(),
    GH_TIMEOUT_MS,
  );
  return r.timedOut ? new Map() : parseMultiRepoPrResponse(r.stdout);
}

export function mergedOutOfBand(
  states: PipelineState[],
  prStates: Map<string, PrState>,
): WakeEvent[] {
  const out: WakeEvent[] = [];
  for (const s of states) {
    const t = parsePrUrl(s.prUrl);
    const v = t ? prStates.get(prKey(t)) : undefined;
    if (!v || v === "OPEN" || FINISHED_PHASE_SET.has(s.phase)) continue;
    out.push({
      kind: "merged-out-of-band",
      slug: s.slug,
      repo: repoNameForPath(s.repo),
      to: v,
    });
  }
  return out;
}

export async function runHeartbeat(
  states: PipelineState[],
  exec: ExecFn,
): Promise<WakeEvent[]> {
  return mergedOutOfBand(states, await fetchPrStates(states, exec));
}
