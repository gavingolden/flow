#!/usr/bin/env bun
/**
 * Validates checkpoint readiness for the `/checkpoint` skill and the step-4
 * auto-checkpoint sub-step, and manages the one-shot `checkpoint.pending`
 * marker the `SessionStart:clear` auto-resume hook gates on.
 *
 * The `/checkpoint` skill (LLM) writes the conversational-state summary to
 * `<worktree>/.flow-tmp/checkpoint.md`; this helper is the non-LLM half that
 * confirms disk is current and, on a `ready` verdict, writes the marker so a
 * subsequent user-typed `/clear` auto-resumes the pipeline.
 *
 * Usage:
 *   flow-checkpoint [<slug>]              validate + write the marker on ready
 *   flow-checkpoint [<slug>] --consume    delete an existing marker (Resume mode)
 *
 * `<slug>` is optional inside a flow tmux pane: it auto-resolves from
 * `$TMUX_PANE`'s `@flow-slug` window option.
 *
 * Output: a single JSON object on stdout.
 *   { "status": "ready",    "slug", "phase", "worktree", "checkpoint", "marker" }
 *   { "status": "needs",    "slug", "reason", ... }
 *   { "status": "consumed", "slug", "marker" }
 *   { "status": "noop",     "slug", "reason" }
 *
 * Exit codes (same exit-0-for-every-decision contract as flow-resume-decide /
 * flow-gate-decide — the skill captures stdout and branches on `.status`):
 *   0 — decision computed (ready / needs / consumed / noop)
 *   2 — bad CLI args, or no slug given and none resolvable from $TMUX_PANE
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { nowIso, readState } from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { resolveSlugFromPane } from "./lib/tmux";

export type CheckpointStatus = "ready" | "needs" | "consumed" | "noop";

export type CheckpointResult = {
  status: CheckpointStatus;
  slug: string;
  phase?: string;
  worktree?: string;
  checkpoint?: string;
  marker?: string;
  reason?: string;
};

export type Deps = {
  stateDir?: string;
  resolveSlug?: () => string | null;
};

/** Absolute path of the checkpoint body the /checkpoint skill writes. */
export function checkpointPath(worktreePath: string): string {
  return path.join(worktreePath, ".flow-tmp", "checkpoint.md");
}

/** Absolute path of the one-shot marker the SessionStart:clear hook gates on. */
export function markerPath(worktreePath: string): string {
  return path.join(worktreePath, ".flow-tmp", "checkpoint.pending");
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

export type Args = { slug?: string; consume: boolean } | { error: string };

export function parseArgs(argv: string[]): Args {
  let slug: string | undefined;
  let consume = false;
  for (const a of argv) {
    if (a === "--help" || a === "-h") return { error: "help" };
    if (a === "--consume") {
      consume = true;
      continue;
    }
    if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
    if (slug !== undefined) return { error: `unexpected extra argument: ${a}` };
    slug = a;
  }
  return { slug, consume };
}

const USAGE = "usage: flow-checkpoint [<slug>] [--consume]";

function emit(result: CheckpointResult): void {
  process.stdout.write(JSON.stringify(result) + "\n");
}

export function run(argv: string[], deps: Deps = {}): number {
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugFromPane());

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

  // --consume: delete the one-shot marker after Resume mode re-injects
  // checkpoint.md, so a later unrelated /clear in the same window does not
  // re-fire the auto-resume hook. Idempotent: a no-op when absent.
  if (parsed.consume) {
    const worktree = state?.worktree;
    if (worktree) {
      const marker = markerPath(worktree);
      if (fs.existsSync(marker)) {
        try {
          fs.unlinkSync(marker);
        } catch {
          // best-effort: a marker that can't be removed still no-ops the next
          // clear once the worktree is gone; don't fail the decision.
        }
        emit({ status: "consumed", slug, worktree, marker });
        return 0;
      }
      emit({ status: "noop", slug, worktree, reason: "no-marker" });
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
  // checkpoint.md, and writes the marker; a needs verdict writes nothing.
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
