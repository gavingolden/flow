/**
 * Resolves a pipeline slug to the epic feature it implements. Two sources
 * bind a pipeline: the state file's `epic` tag (set by `flow feature create
 * --epic`) and a `~/.flow/epics/<epic>/run.json` feature record whose current
 * `slug` equals it (a hand-bound pipeline has only the latter). Disagreement
 * between them, or two matching records, is reported as a conflict instead of
 * guessing — a wrong binding would write another feature's board row.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { listEpicRunStates } from "./epic-run-state";
import { FLOW_EPICS_DIR, FLOW_STATE_DIR } from "./paths";
import { readState } from "./state";

export type EpicBinding =
  | { kind: "none" }
  | {
      kind: "bound";
      epicSlug: string;
      featureId: string;
      source: "state" | "run-json";
    }
  | { kind: "conflict"; detail: string };

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export function resolveEpicBinding(input: {
  slug: string;
  stateDir?: string;
  epicsDir?: string;
}): EpicBinding {
  const stateDir = input.stateDir ?? FLOW_STATE_DIR;
  const epicsDir =
    input.epicsDir ??
    (input.stateDir
      ? path.join(path.dirname(input.stateDir), "epics")
      : FLOW_EPICS_DIR);
  const state = readState(input.slug, stateDir);
  const stateRepo = state?.repo ? realpathOrSelf(state.repo) : undefined;

  const matches: { epicSlug: string; featureId: string }[] = [];
  for (const run of listEpicRunStates(epicsDir)) {
    if (stateRepo && run.repo && realpathOrSelf(run.repo) !== stateRepo) {
      continue;
    }
    for (const [featureId, rec] of Object.entries(run.features)) {
      if (rec.external || rec.slug !== input.slug) continue;
      matches.push({ epicSlug: run.epicSlug, featureId });
    }
  }

  if (matches.length > 1) {
    const names = matches.map((m) => `${m.epicSlug}/${m.featureId}`).join(", ");
    return {
      kind: "conflict",
      detail: `slug ${input.slug} is recorded by more than one launch record: ${names}`,
    };
  }
  const tag = state?.epic;
  const rec = matches[0];
  if (tag && rec) {
    if (tag.slug !== rec.epicSlug || tag.featureId !== rec.featureId) {
      return {
        kind: "conflict",
        detail: `state tags ${tag.slug}/${tag.featureId} but run.json binds ${rec.epicSlug}/${rec.featureId}`,
      };
    }
    return {
      kind: "bound",
      epicSlug: tag.slug,
      featureId: tag.featureId,
      source: "state",
    };
  }
  if (tag) {
    return {
      kind: "bound",
      epicSlug: tag.slug,
      featureId: tag.featureId,
      source: "state",
    };
  }
  if (rec) return { kind: "bound", ...rec, source: "run-json" };
  return { kind: "none" };
}
