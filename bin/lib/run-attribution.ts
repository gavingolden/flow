/**
 * Synchronous collector behind the run-attribution row and `RAN ON:`: every
 * supervisor session of a pipeline and every sub-agent spawn, with model,
 * ordered model+effort runs, turns, tokens and list-price cost, plus the
 * pipeline's headless/delegated model calls from `events.jsonl`.
 *
 * Derived from Claude Code's transcripts (undocumented field names — every
 * missing field degrades to `null` / `"unknown"`). Stores no prompt or
 * completion text: a `general-purpose` spawn keeps only its Task description,
 * capped at 80 chars, as its role label. Never throws.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultProjectsRoot,
  encodeProjectSegment,
  findSessionJsonlsSync,
} from "./cost";
import { flowTelemetryLogPath } from "./paths";
import { findSubagentsDir } from "./review-telemetry";
import {
  delegatedCalls,
  readEventLines,
  sessionIdsForSlug,
} from "./run-attribution-events";
import {
  RUN_ATTRIBUTION_VERSION,
  type RunAttribution,
  type SpawnAttribution,
  type UnitAttribution,
} from "./run-attribution-types";
import { collectSpawns } from "./run-attribution-spawns";
import { attributeTurns, computeTotals } from "./run-attribution-unit";
import type { PipelineState } from "./state";
import { readTranscriptTurns, type TranscriptTurn } from "./transcript-turns";

export { roleFromMeta } from "./run-attribution-spawns";
export { RUN_ATTRIBUTION_VERSION } from "./run-attribution-types";
export type * from "./run-attribution-types";

const STALE_GRACE_MS = 5 * 60 * 1000;

function emptyAttribution(state: PipelineState): RunAttribution {
  return {
    version: RUN_ATTRIBUTION_VERSION,
    slug: state.slug,
    pr: state.pr ?? null,
    repo: state.repo,
    sessions: [],
    spawns: [],
    delegated: [],
    totals: computeTotals([], [], 0),
  };
}

export function collectRunAttribution(
  state: PipelineState,
  opts: { projectsRoot?: string; eventsLogPath?: string } = {},
): RunAttribution {
  try {
    return collect(state, opts);
  } catch {
    return emptyAttribution(state);
  }
}

function collect(
  state: PipelineState,
  opts: { projectsRoot?: string; eventsLogPath?: string },
): RunAttribution {
  const projectsRoot = opts.projectsRoot ?? defaultProjectsRoot();
  const eventLines = readEventLines(
    opts.eventsLogPath ?? flowTelemetryLogPath(),
  );
  const startedAt = Date.parse(state.phaseLog?.[0]?.at ?? "");
  const notBefore = Number.isNaN(startedAt) ? null : startedAt - STALE_GRACE_MS;

  const files = discoverSessions(
    state,
    projectsRoot,
    sessionIdsForSlug(eventLines, state.slug),
  );
  let skipped = 0;
  const sessions: { unit: UnitAttribution; firstTs: string }[] = [];
  const spawns: SpawnAttribution[] = [];
  for (const [sessionId, file] of files) {
    const turns = readTranscriptTurns(file);
    if (!turns) {
      skipped++;
      continue;
    }
    if (isStale(turns, notBefore)) continue;
    sessions.push({
      unit: attributeTurns(sessionId, turns),
      firstTs: turns[0]?.ts ?? "",
    });
    const dir = findSubagentsDir(sessionId, projectsRoot);
    if (!dir) continue;
    const found = collectSpawns(sessionId, dir);
    spawns.push(...found.spawns);
    skipped += found.skipped;
  }
  const units = sessions
    .sort((a, b) => a.firstTs.localeCompare(b.firstTs))
    .map((s) => s.unit);
  const delegated = delegatedCalls(
    eventLines,
    state.slug,
    new Set(units.map((u) => u.session_id)),
    notBefore,
  );
  return {
    version: RUN_ATTRIBUTION_VERSION,
    slug: state.slug,
    pr: state.pr ?? null,
    repo: state.repo,
    sessions: units,
    spawns,
    delegated,
    totals: computeTotals([...units, ...spawns], delegated, skipped),
  };
}

/** Session id -> JSONL path: slug-seeded logs under the repo and worktree project dirs, plus any log named by a slug-tagged event. */
function discoverSessions(
  state: PipelineState,
  projectsRoot: string,
  eventSessionIds: ReadonlySet<string>,
): Map<string, string> {
  const found = new Map<string, string>();
  const roots = [state.repo, state.worktree ?? state.reservedWorktree];
  for (const root of roots) {
    if (!root) continue;
    const dir = path.join(projectsRoot, encodeProjectSegment(root));
    for (const file of findSessionJsonlsSync(dir, state.slug)) {
      found.set(path.basename(file, ".jsonl"), file);
    }
  }
  const missing = [...eventSessionIds].filter((id) => !found.has(id));
  if (missing.length > 0) {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(projectsRoot);
    } catch {
      // no projects root: nothing to locate
    }
    for (const id of missing) {
      for (const d of dirs) {
        const file = path.join(projectsRoot, d, `${id}.jsonl`);
        if (fs.existsSync(file)) {
          found.set(id, file);
          break;
        }
      }
    }
  }
  return found;
}

/** A re-used slug must not pull in an earlier run: drop only on positive evidence. */
function isStale(turns: readonly TranscriptTurn[], notBefore: number | null) {
  if (notBefore === null) return false;
  const last = turns[turns.length - 1]?.ts;
  const lastMs = last ? Date.parse(last) : Number.NaN;
  return !Number.isNaN(lastMs) && lastMs < notBefore;
}
