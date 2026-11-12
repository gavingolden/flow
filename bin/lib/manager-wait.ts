/**
 * Transition detection for the global manager's waiter: a pure diff of the
 * seen store (`~/.flow/manager/waiter-seen.json`) against the current state
 * files. Only in-scope pipelines produce events; out-of-scope ones stay in the
 * store so a later scope change never replays old transitions. The one
 * exception is `new-candidate`, a names-only event for a newly seen
 * out-of-scope pipeline while a focus note says the owner is still deciding
 * what to cover.
 */

import * as fs from "node:fs";
import { OWNER_NEEDED_PHASES } from "./epic-manage-board";
import { managerFile, managerHome, writeJsonAtomic } from "./manager-home";
import type { ManagerLogEntry } from "./manager-log";
import { isWakePhase } from "./manager-phases";
import { repoNameForPath, type ScopeFile } from "./manager-scope";
import {
  FINISHED_PHASE_SET,
  phaseEnteredAt,
  type PipelineState,
} from "./state";

export type SeenEntry = {
  phase: string;
  phaseEnteredAt: string;
  repo: string;
  missingPolls?: number;
  staleProposedAt?: string;
  /** Whether the pipeline was in scope on the last poll, so `gone` stays scoped without its state file. */
  scoped?: boolean;
  /** The `phaseEnteredAt` a `checkpoint-idle` event already fired for. */
  checkpointIdleFor?: string;
  /** The PR state a `merged-out-of-band` event already fired for. */
  oobFired?: string;
};

export type SeenStore = {
  version: 1;
  baselinedAt: string;
  scopeUpdatedAt?: string;
  /** Ruling ids a `ruling-unpicked` event already fired for (newest 100), so a ruling that drops out of the list for one poll never re-fires. */
  rulingsFired?: string[];
  pipelines: Record<string, SeenEntry>;
};

export type WakeEventKind =
  | "transition"
  | "new"
  | "gone"
  | "merged-out-of-band"
  | "stale"
  | "idle"
  | "checkpoint-idle"
  | "scope-changed"
  | "new-candidate"
  | "ruling-unpicked";

export type WakeEvent = {
  kind: WakeEventKind;
  slug?: string;
  repo?: string;
  epic?: string;
  from?: string;
  to?: string;
  /** `ruling-unpicked` only: the ruling the pipeline never accepted. */
  ruling?: string;
};

export const STALE_DAYS = 7;
export const CHECKPOINT_IDLE_MS = 10 * 60_000;
export const RULING_PICKUP_MS = 15 * 60_000;
const MAX_FIRED_RULINGS = 100;
const GONE_AFTER_POLLS = 2;
const DAY_MS = 86_400_000;

function lastActivityMs(s: PipelineState): number {
  const last = s.phaseLog?.[s.phaseLog.length - 1]?.at ?? s.updatedAt;
  const t = Date.parse(last);
  return Number.isFinite(t) ? t : Date.parse(s.updatedAt) || 0;
}

/** The key the epic sequencer already logs for an owner-needed pause, so neither writer notifies twice. */
export function ownerNeededKey(s: PipelineState): string {
  return `${s.slug}:${s.phase}:${s.phaseLog?.length ?? 0}`;
}

export type UnpickedRuling = { id: string; slug: string };

/**
 * Rulings the manager wrote more than 15 minutes ago that the pipeline never
 * accepted, while it still sits in the phase the ruling was written for. A
 * ruling whose phase was re-entered since is stale, not unpicked.
 */
export function unpickedRulings(
  log: ManagerLogEntry[],
  states: PipelineState[],
  now: Date,
): UnpickedRuling[] {
  const accepted = new Set(
    log.filter((e) => e.kind === "ruling-accepted").map((e) => e.key),
  );
  const bySlug = new Map(states.map((s) => [s.slug, s]));
  const out: UnpickedRuling[] = [];
  for (const e of log) {
    if (e.kind !== "ruling-written" || !e.key || !e.slug) continue;
    if (accepted.has(e.key)) continue;
    const written = Date.parse(e.ts);
    if (
      !Number.isFinite(written) ||
      now.getTime() - written < RULING_PICKUP_MS
    ) {
      continue;
    }
    const s = bySlug.get(e.slug);
    if (
      !s ||
      FINISHED_PHASE_SET.has(s.phase) ||
      s.phase !== e.phase ||
      Date.parse(phaseEnteredAt(s)) > written
    ) {
      continue;
    }
    out.push({ id: e.key.replace(/^ruling:/, ""), slug: e.slug });
  }
  return out;
}

export function diffSnapshot(
  seen: SeenStore | null,
  states: PipelineState[],
  now: Date,
  opts: {
    inScope: (s: PipelineState) => boolean;
    scope: ScopeFile | null;
    stopWhenIdle?: boolean;
    unpicked?: UnpickedRuling[];
  },
): { events: WakeEvent[]; next: SeenStore } {
  const events: WakeEvent[] = [];
  const pipelines: Record<string, SeenEntry> = {};
  const baseline = seen === null;
  const hasFocus = (opts.scope?.focus?.length ?? 0) > 0;
  const live = new Set(states.map((s) => s.slug));

  for (const s of states) {
    const prior = seen?.pipelines[s.slug];
    const entered = phaseEnteredAt(s);
    const scoped = opts.inScope(s);
    const repo = repoNameForPath(s.repo);
    const entry: SeenEntry = {
      phase: s.phase,
      phaseEnteredAt: entered,
      repo,
      scoped,
    };
    if (prior?.staleProposedAt) entry.staleProposedAt = prior.staleProposedAt;
    if (prior?.oobFired && prior.phase === s.phase) {
      entry.oobFired = prior.oobFired;
    }
    if (prior?.checkpointIdleFor === entered) {
      entry.checkpointIdleFor = entered;
    }
    pipelines[s.slug] = entry;
    if (baseline) continue;

    if (!prior) {
      if (scoped) {
        events.push({ kind: "new", slug: s.slug, repo, to: s.phase });
      } else if (hasFocus && !FINISHED_PHASE_SET.has(s.phase)) {
        events.push({
          kind: "new-candidate",
          slug: s.slug,
          repo,
          ...(s.epic ? { epic: s.epic.slug } : {}),
        });
      }
      continue;
    }
    if (!scoped) continue;

    const changed = prior.phase !== s.phase || prior.phaseEnteredAt !== entered;
    if (
      changed &&
      isWakePhase(s.phase) &&
      s.phase !== "checkpoint-pending-clear"
    ) {
      events.push({
        kind: "transition",
        slug: s.slug,
        repo,
        from: prior.phase,
        to: s.phase,
      });
    }
    if (
      s.phase === "checkpoint-pending-clear" &&
      entry.checkpointIdleFor !== entered &&
      now.getTime() - Date.parse(entered) >= CHECKPOINT_IDLE_MS
    ) {
      entry.checkpointIdleFor = entered;
      events.push({ kind: "checkpoint-idle", slug: s.slug, repo, to: s.phase });
    }
    if (
      !FINISHED_PHASE_SET.has(s.phase) &&
      !entry.staleProposedAt &&
      now.getTime() - lastActivityMs(s) >= STALE_DAYS * DAY_MS
    ) {
      entry.staleProposedAt = now.toISOString();
      events.push({ kind: "stale", slug: s.slug, repo, to: s.phase });
    }
  }

  if (seen) {
    for (const [slug, prior] of Object.entries(seen.pipelines)) {
      if (live.has(slug)) continue;
      const missing = (prior.missingPolls ?? 0) + 1;
      if (missing >= GONE_AFTER_POLLS) {
        if (prior.scoped) {
          events.push({
            kind: "gone",
            slug,
            repo: prior.repo,
            from: prior.phase,
          });
        }
        continue;
      }
      pipelines[slug] = { ...prior, missingPolls: missing };
    }
  }

  const unpicked = opts.unpicked ?? [];
  const fired = new Set(seen?.rulingsFired ?? []);
  for (const u of unpicked) {
    if (fired.has(u.id)) continue;
    fired.add(u.id);
    const s = states.find((x) => x.slug === u.slug);
    if (!baseline && s && opts.inScope(s)) {
      events.push({
        kind: "ruling-unpicked",
        slug: u.slug,
        repo: repoNameForPath(s.repo),
        ruling: u.id,
      });
    }
  }
  const rulingsFired = [...fired].slice(-MAX_FIRED_RULINGS);

  const scopeUpdatedAt = opts.scope?.updatedAt;
  if (
    !baseline &&
    opts.scope?.source === "cli" &&
    seen.scopeUpdatedAt !== undefined &&
    scopeUpdatedAt !== seen.scopeUpdatedAt
  ) {
    events.push({ kind: "scope-changed" });
  }

  if (!baseline && opts.stopWhenIdle) {
    // An empty or unmatched scope has nothing to be idle about: it never stops the manager.
    const everScoped =
      states.some((s) => opts.inScope(s)) ||
      Object.values(seen?.pipelines ?? {}).some((p) => p.scoped);
    const idle = states
      .filter((s) => opts.inScope(s) && !FINISHED_PHASE_SET.has(s.phase))
      .every((s) => OWNER_NEEDED_PHASES.has(s.phase));
    if (everScoped && idle) events.push({ kind: "idle" });
  }

  return {
    events,
    next: {
      version: 1,
      baselinedAt: seen?.baselinedAt ?? now.toISOString(),
      ...(scopeUpdatedAt ? { scopeUpdatedAt } : {}),
      ...(rulingsFired.length > 0 ? { rulingsFired } : {}),
      pipelines,
    },
  };
}

function seenPath(home: string): string {
  return managerFile("waiter-seen.json", home);
}

/** Tolerant: a missing or malformed store reads as null, which re-baselines silently. */
export function readSeen(home: string = managerHome()): SeenStore | null {
  try {
    const v = JSON.parse(fs.readFileSync(seenPath(home), "utf8")) as SeenStore;
    if (
      v?.version === 1 &&
      typeof v.baselinedAt === "string" &&
      typeof v.pipelines === "object" &&
      v.pipelines !== null
    ) {
      return v;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeSeen(
  store: SeenStore,
  home: string = managerHome(),
): void {
  writeJsonAtomic(seenPath(home), store);
}
