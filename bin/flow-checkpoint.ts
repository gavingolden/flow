#!/usr/bin/env bun
/**
 * Validates checkpoint readiness for the `/flow-checkpoint` skill and the step-4
 * auto-checkpoint sub-step, and manages the one-shot `checkpoint.pending`
 * marker the `SessionStart:clear` auto-resume hook gates on.
 *
 * The `/flow-checkpoint` skill (LLM) writes the conversational-state summary to
 * `<worktree>/.flow-tmp/checkpoint.md`; this helper is the non-LLM half that
 * confirms disk is current and, on a `ready` verdict, writes the marker so a
 * subsequent user-typed `/clear` auto-resumes the pipeline — and, on that same
 * `ready` verdict, records a freshness receipt (`state.checkpoint`: which site
 * armed it, at which phase, and when) so a LATER probe can tell a still-fresh
 * manual note apart from a stale or already-consumed one. `--consume` retires
 * the body outright: it archives `checkpoint.md` to `checkpoint.consumed.md`
 * (recoverable, never silently deleted) and clears the freshness record.
 * `--probe` answers "is the current body still worth keeping?" without
 * mutating anything, so the four auto-checkpoint sites in `flow-pipeline`
 * can branch on a computed verdict instead of restating the freshness rule
 * in prose at each site.
 *
 * Usage:
 *   flow-checkpoint [<slug>] [--site <site>]              validate + arm (write marker + record) on ready
 *   flow-checkpoint [<slug>] --consume                    archive checkpoint.md + clear the marker/record (Resume mode)
 *   flow-checkpoint [<slug>] --probe --site <site>         read-only freshness verdict, no mutation
 *
 * `<slug>` is optional inside a flow tmux pane: it auto-resolves from
 * `$TMUX_PANE`'s `@flow-slug` window option. `--site` defaults to `"manual"`
 * (the `/flow-checkpoint` skill's own bare call); the four auto sites in
 * `flow-pipeline/SKILL.md` pass their own `--site` explicitly.
 *
 * Output: a single JSON object on stdout.
 *   { "status": "ready",    "slug", "phase", "worktree", "checkpoint", "marker" }
 *   { "status": "needs",    "slug", "reason", ... }
 *   { "status": "consumed", "slug", "marker", "archived"? }
 *   { "status": "noop",     "slug", "reason", "archived"? }
 *   { "status": "probe",    "slug", "site", "verdict", "reason", "record"? }
 *
 * Exit codes (same exit-0-for-every-decision contract as flow-resume-decide /
 * flow-gate-decide — the skill captures stdout and branches on `.status`):
 *   0 — decision computed (ready / needs / consumed / noop / probe)
 *   2 — bad CLI args, or no slug given and none resolvable from $TMUX_PANE
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { nowIso, readState, writeState } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { resolveSlugAmbient } from "./lib/session-identity";
import {
  CHECKPOINT_SITES,
  type CheckpointSite,
  checkpointPath,
  hasPhaseAdvancedSince,
  probeFreshness,
} from "./lib/checkpoint-freshness";

// Re-exported so the CLI file stays the single public import surface for
// tests and the two external consumers (flow-resume-decide.ts,
// flow-session-start-hook.ts) — the freshness predicates themselves live in
// ./lib/checkpoint-freshness to keep this file inside the AGENTS.md
// ~200-line target.
export {
  CHECKPOINT_SITES,
  checkpointPath,
  hasPhaseAdvancedSince,
  probeFreshness,
};
export type { CheckpointSite };

export type CheckpointStatus =
  | "ready"
  | "needs"
  | "consumed"
  | "noop"
  | "probe";

export type CheckpointResult = {
  status: CheckpointStatus;
  slug: string;
  phase?: string;
  worktree?: string;
  checkpoint?: string;
  marker?: string;
  reason?: string;
  archived?: string;
  site?: CheckpointSite;
  verdict?: "write" | "preserve";
  record?: { site: CheckpointSite; phase: string; armedAt: string };
};

export type Deps = {
  stateDir?: string;
  resolveSlug?: () => string | null;
};

/** Absolute path of the one-shot marker the SessionStart:clear hook gates on. */
export function markerPath(worktreePath: string): string {
  return path.join(worktreePath, ".flow-tmp", "checkpoint.pending");
}

/** Absolute path of the retired-body archive `--consume` writes to. */
export function consumedPath(worktreePath: string): string {
  return path.join(worktreePath, ".flow-tmp", "checkpoint.consumed.md");
}

/**
 * True iff `<worktree>/.flow-tmp/checkpoint.md` is present and non-empty.
 * Mirrors `probePlan` in flow-resume-decide.ts — empty and missing collapse to
 * the same `false`.
 */
export function probeCheckpoint(worktreePath: string): boolean {
  try {
    const stat = fs.statSync(checkpointPath(worktreePath));
    if (!stat.isFile()) return false;
    return stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Retires the checkpoint body on `--consume`: renames `checkpoint.md` to
 * `checkpoint.consumed.md` (overwriting any prior archive), so a stale body
 * can never be re-read as current while the prose stays recoverable. Returns
 * the archive path, or `null` when there was nothing to archive (absent or
 * empty body). NEVER throws: a rename failure (permissions/lock) degrades to
 * a direct unlink of the source — retiring the stale state matters more than
 * the forensic copy. Independent of marker presence: called unconditionally
 * from the `--consume` branch, not gated on the marker existing.
 */
export function archiveCheckpoint(worktreePath: string): string | null {
  const src = checkpointPath(worktreePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(src);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const dest = consumedPath(worktreePath);
  try {
    fs.renameSync(src, dest);
    return dest;
  } catch {
    try {
      fs.unlinkSync(src);
    } catch {
      // best-effort: an unremovable body still shouldn't fail the decision.
    }
    return null;
  }
}

export type Args =
  | { slug?: string; consume: boolean; probe: boolean; site: CheckpointSite }
  | { error: string };

export function parseArgs(argv: string[]): Args {
  let slug: string | undefined;
  let consume = false;
  let probe = false;
  let site: CheckpointSite = "manual";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { error: "help" };
    if (a === "--consume") {
      consume = true;
      continue;
    }
    if (a === "--probe") {
      probe = true;
      continue;
    }
    if (a === "--site") {
      const v = argv[++i];
      if (!v || !(CHECKPOINT_SITES as readonly string[]).includes(v)) {
        return { error: `unknown --site value: ${v ?? "<missing>"}` };
      }
      site = v as CheckpointSite;
      continue;
    }
    if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
    if (slug !== undefined) return { error: `unexpected extra argument: ${a}` };
    slug = a;
  }
  if (probe && consume) {
    return { error: "--probe and --consume are mutually exclusive" };
  }
  return { slug, consume, probe, site };
}

const USAGE =
  "usage: flow-checkpoint [<slug>] [--consume | --probe] [--site manual|plan-review|plan-approval|gate]";

function emit(result: CheckpointResult): void {
  process.stdout.write(JSON.stringify(result) + "\n");
}

export function run(argv: string[], deps: Deps = {}): number {
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugAmbient());

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log(USAGE);
      return 0;
    }
    console.error(`flow-checkpoint: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }

  const slug = parsed.slug ?? resolveSlug();
  if (!slug) {
    console.error(
      "flow-checkpoint: no slug given and could not resolve from $TMUX_PANE's @flow-slug option.\n" +
        "  pass <slug> explicitly, or run inside a tmux window created by `flow feature create`.",
    );
    return 2;
  }

  const state = readState(slug, stateDir);

  // --probe: read-only freshness verdict, checked before any consume/arm
  // mutation logic below. Fails open (verdict "write") on any unresolvable
  // precondition — no state, no worktree.
  if (parsed.probe) {
    if (!state) {
      emit({
        status: "probe",
        slug,
        site: parsed.site,
        verdict: "write",
        reason: "state-missing",
      });
      return 0;
    }
    if (!state.worktree) {
      emit({
        status: "probe",
        slug,
        phase: state.phase,
        site: parsed.site,
        verdict: "write",
        reason: "no-worktree",
      });
      return 0;
    }
    const result = probeFreshness(state, state.worktree, parsed.site);
    emit({
      status: "probe",
      slug,
      phase: state.phase,
      worktree: state.worktree,
      site: parsed.site,
      verdict: result.verdict,
      reason: result.reason,
      record: state.checkpoint,
    });
    return 0;
  }

  // --consume: retire the checkpoint body (archive + clear the freshness
  // record) after Resume mode re-injects checkpoint.md, and delete the
  // one-shot marker so a later unrelated /clear in the same window does not
  // re-fire the auto-resume hook. Idempotent: a no-op when there is nothing
  // to retire. Archiving/record-clearing run unconditionally — independent
  // of whether the marker itself is present.
  if (parsed.consume) {
    const worktree = state?.worktree;
    if (worktree) {
      const marker = markerPath(worktree);
      const archived = archiveCheckpoint(worktree) ?? undefined;
      if (state?.checkpoint) {
        try {
          writeState({ ...state, checkpoint: undefined }, stateDir);
        } catch {
          // best-effort: a failed record clear does not block the decision.
        }
      }
      if (fs.existsSync(marker)) {
        try {
          fs.unlinkSync(marker);
        } catch {
          // best-effort: a marker that can't be removed still no-ops the next
          // clear once the worktree is gone; don't fail the decision.
        }
        emit({ status: "consumed", slug, worktree, marker, archived });
        return 0;
      }
      emit({ status: "noop", slug, worktree, reason: "no-marker", archived });
      return 0;
    }
    emit({
      status: "noop",
      slug,
      reason: state ? "no-worktree" : "state-missing",
    });
    return 0;
  }

  // Ready/needs: a ready verdict requires state.json + a non-empty
  // checkpoint.md, and writes the marker (plus a freshness record for the
  // armed site); a needs verdict writes nothing.
  if (!state) {
    emit({ status: "needs", slug, reason: "state-missing" });
    return 0;
  }
  if (!state.worktree) {
    emit({ status: "needs", slug, phase: state.phase, reason: "no-worktree" });
    return 0;
  }
  if (!probeCheckpoint(state.worktree)) {
    emit({
      status: "needs",
      slug,
      phase: state.phase,
      worktree: state.worktree,
      reason: "checkpoint-missing",
    });
    return 0;
  }

  const marker = markerPath(state.worktree);
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${slug}\n${nowIso()}\n`);
  } catch (err) {
    emit({
      status: "needs",
      slug,
      phase: state.phase,
      worktree: state.worktree,
      reason: `marker-write-failed: ${String(err)}`,
    });
    return 0;
  }

  try {
    writeState(
      {
        ...state,
        checkpoint: {
          site: parsed.site,
          phase: state.phase,
          armedAt: nowIso(),
        },
      },
      stateDir,
    );
  } catch {
    // best-effort: the marker (the load-bearing resume signal) is already
    // written; a failed record write only degrades a future --probe to the
    // mtime fallback, it doesn't block this ready verdict.
  }

  emit({
    status: "ready",
    slug,
    phase: state.phase,
    worktree: state.worktree,
    checkpoint: checkpointPath(state.worktree),
    marker,
  });
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
