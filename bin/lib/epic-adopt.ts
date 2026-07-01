/**
 * Externally-merged-node adoption reader for the epic reconciler.
 *
 * A feature can be merged OUTSIDE the epic run (a human merges its PR by hand,
 * or a prior run merged it and its run.json record was lost). The reconciler
 * would otherwise re-launch a duplicate pipeline for it. This module resolves
 * such nodes live per-tick from GitHub: a feature whose `flow-epic` sub-issue
 * is CLOSED (in ANY closed state — we do NOT filter on stateReason) counts as
 * merged even when absent from run.json.
 *
 * The reader is a seam (`ReadClosedSubIssues`) injected into the pure
 * `reconcile()`; the real gh + fs implementation lives here in the verb layer,
 * never in reconcile's body. It returns a `Map<featureId, issueNumber>` so the
 * board can render adopted rows with their originating sub-issue number
 * (`merged (external #<n>)`). Every failure path returns an empty Map and NEVER
 * throws, so a missing projection / gh outage / malformed JSON degrades to
 * today's run.json-only behaviour rather than crashing the tick.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_EPICS_DIR } from "./paths";
import type { GhRunner } from "../flow-create-issue";

const FLOW_EPIC_LABEL = "flow-epic";

/**
 * Returns a Map of feature id → its GitHub sub-issue number for every feature
 * whose sub-issue is CLOSED. Synchronous and total: any failure resolves to an
 * empty Map. The default injected into `reconcile()` is a no-op `() => new
 * Map()` — this real reader is wired only into the tick + judgment paths.
 */
export type ReadClosedSubIssues = (input: {
  epicSlug: string;
  featureIds: string[];
}) => Map<string, number>;

type Projection = {
  features: Record<string, { issueNumber: number; databaseId?: string }>;
  parentNumber?: number;
};

/** Read + parse `<epicsDir>/<epicSlug>/projection.json`; null on any failure. */
function readProjection(epicsDir: string, epicSlug: string): Projection | null {
  try {
    const raw = fs.readFileSync(
      path.join(epicsDir, epicSlug, "projection.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Projection;
    if (!parsed || typeof parsed !== "object" || !parsed.features) return null;
    if (typeof parsed.features !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build the real adoption reader. Fires exactly ONE batched gh call per
 * invocation (`gh issue list --label flow-epic --state closed`), maps each
 * requested feature's projection `issueNumber` through the resulting closed-set,
 * and returns a Map of the matching ids → their sub-issue number. `epicsDir`
 * defaults to the real FLOW_EPICS_DIR; it is overridable so tests exercise a
 * temp projection without touching ~/.flow.
 */
export function makeReadClosedSubIssues(
  gh: GhRunner,
  epicsDir: string = FLOW_EPICS_DIR,
): ReadClosedSubIssues {
  return ({ epicSlug, featureIds }) => {
    const adopted = new Map<string, number>();
    if (featureIds.length === 0) return adopted;

    const projection = readProjection(epicsDir, epicSlug);
    if (!projection) return adopted;

    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = gh([
        "issue",
        "list",
        "--label",
        FLOW_EPIC_LABEL,
        "--state",
        "closed",
        "--json",
        "number,stateReason",
        "--limit",
        "1000",
      ]);
    } catch {
      return adopted;
    }
    if (!result || result.exitCode !== 0) return adopted;

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return adopted;
    }
    if (!Array.isArray(parsed)) return adopted;

    // Adopt on ANY closed state — stateReason is captured but deliberately not
    // filtered (a "won't-do" close is indistinguishable from a "done" close).
    const closedNumbers = new Set<number>();
    for (const entry of parsed) {
      const num = (entry as { number?: unknown }).number;
      if (typeof num === "number") closedNumbers.add(num);
    }

    for (const id of featureIds) {
      const rec = projection.features[id];
      if (
        rec &&
        typeof rec.issueNumber === "number" &&
        closedNumbers.has(rec.issueNumber)
      ) {
        adopted.set(id, rec.issueNumber);
      }
    }
    return adopted;
  };
}
