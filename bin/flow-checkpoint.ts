#!/usr/bin/env bun
/**
 * Validates checkpoint readiness for the `/flow-checkpoint` skill and the step-4
 * auto-checkpoint sub-step, and manages the one-shot `checkpoint.pending`
 * marker the `SessionStart:clear` auto-resume hook gates on.
 *
 * The `/flow-checkpoint` skill (LLM) writes the conversational-state summary to
 * `~/.flow/state/checkpoints/<slug>/checkpoint.md` (slug-keyed, worktree-
 * independent — `--path` publishes the resolved location); this helper is the
 * non-LLM half that confirms disk is current and, on a `ready` verdict, writes
 * the marker so a subsequent user-typed `/clear` auto-resumes the pipeline —
 * and, on that same `ready` verdict, records a freshness receipt
 * (`state.checkpoint`: which site armed it, at which phase, and when) so a
 * LATER probe can tell a still-fresh manual note apart from a stale or
 * already-consumed one. `--consume` retires the body outright: it archives
 * `checkpoint.md` to `checkpoint.consumed.md` (recoverable, never silently
 * deleted) and clears the freshness record. `--probe` answers "is the current
 * body still worth keeping?" without mutating anything, so the auto-checkpoint
 * sites in `flow-pipeline` can branch on a computed verdict instead of
 * restating the freshness rule in prose at each site.
 *
 * Usage:
 *   flow-checkpoint [<slug>] [--site <site>]              validate + arm (write marker + record) on ready
 *   flow-checkpoint [<slug>] --consume                    archive checkpoint.md + clear the marker/record (Resume mode)
 *   flow-checkpoint [<slug>] --probe --site <site>         read-only freshness verdict, no mutation
 *   flow-checkpoint [<slug>] --path                        print the absolute checkpoint.md path (creating its parent dir) and exit
 *
 * `<slug>` is optional when a pipeline is live: it auto-resolves from
 * `$FLOW_SLUG`. `--site` defaults to `"manual"`
 * (the `/flow-checkpoint` skill's own bare call); the auto sites in
 * `flow-pipeline/SKILL.md` pass their own `--site` explicitly.
 *
 * Output: a single JSON object on stdout.
 *   { "status": "ready",    "slug", "phase", "worktree", "checkpoint", "marker", "warning"? }
 *   { "status": "needs",    "slug", "reason", ... }
 *   { "status": "consumed", "slug", "marker", "archived"? }
 *   { "status": "noop",     "slug", "reason", "archived"? }
 *   { "status": "probe",    "slug", "site", "verdict", "reason", "record"? }
 *
 * `warning` (ready path only) fires when `/clear` will NOT auto-resume this
 * window — a terminal phase, EXCEPT `gated` (the feedback-resume carve-out)
 * and EXCEPT an `epic-run` window (which resumes regardless of phase). It
 * never blocks: `status` stays `ready` and the marker is still written.
 *
 * Exit codes (same exit-0-for-every-decision contract as flow-resume-decide /
 * flow-gate-decide — the skill captures stdout and branches on `.status`):
 *   0 — decision computed (ready / needs / consumed / noop / probe), or --path printed
 *   2 — bad CLI args, or no slug given and no FLOW_SLUG in the environment
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  autoResumesAfterClear,
  nowIso,
  readState,
  writeState,
  type PipelineKind,
} from "./lib/state";
import { FLOW_STATE_DIR } from "./lib/paths";
import { resolveKindAmbient, resolveSlugAmbient } from "./lib/session-identity";
import {
  CHECKPOINT_SITES,
  type CheckpointSite,
  checkpointBodyPath,
  checkpointDir,
  hasPhaseAdvancedSince,
  probeFreshness,
} from "./lib/checkpoint-freshness";

// Re-exported for external convenience, not because every symbol has a
// current importer: only `CHECKPOINT_SITES` is actually imported from here
// (by `skill-md-lint.test.ts`) — `flow-resume-decide.ts` and
// `flow-session-start-hook.ts` import the renamed slug-keyed forms from this
// file and pull `probeFreshness`/`isCheckpointUsable` from
// `./lib/checkpoint-freshness` directly. The freshness predicates live in
// `./lib/checkpoint-freshness` because this file is itself past the
// AGENTS.md ~200-line/file target (448 lines as of this comment), not to
// stay under it.
export {
  CHECKPOINT_SITES,
  checkpointBodyPath,
  checkpointDir,
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
  /** Ready path only: set when this phase/kind will not auto-resume after /clear. */
  warning?: string;
  archived?: string;
  site?: CheckpointSite;
  verdict?: "write" | "preserve";
  record?: { site: CheckpointSite; phase: string; armedAt: string };
};

export type Deps = {
  stateDir?: string;
  resolveSlug?: () => string | null;
  /** Same seam discipline as `resolveSlug`: defaults to `resolveKindAmbient()`. */
  resolveKind?: () => PipelineKind | null;
};

/** Absolute path of the one-shot marker the SessionStart:clear hook gates on. */
export function checkpointMarkerPath(
  slug: string,
  dir = FLOW_STATE_DIR,
): string {
  return path.join(checkpointDir(slug, dir), "checkpoint.pending");
}

/** Absolute path of the retired-body archive `--consume` writes to. */
export function checkpointConsumedPath(
  slug: string,
  dir = FLOW_STATE_DIR,
): string {
  return path.join(checkpointDir(slug, dir), "checkpoint.consumed.md");
}

/**
 * Absolute path of the durable copy of the last-*successful* arm banner
 * (`renderArmBanner`'s output on the `armed: true` path only). Read-side
 * consumers that missed the original stderr line — a fresh session
 * resuming from a checkpoint, for instance — can recover it here. Its
 * absence is not itself a signal (the `--consume` branch unlinks this file
 * alongside the marker, so a retired checkpoint leaves no banner behind
 * either), so callers must tolerate a missing file rather than treat it as
 * "never armed".
 */
export function armBannerPath(slug: string, dir = FLOW_STATE_DIR): string {
  return path.join(checkpointDir(slug, dir), "last-arm-banner.txt");
}

/**
 * Pure formatter for the single stderr line every arm branch prints. The
 * pipeline supervisor extracts this line (anchored on
 * `^checkpointed: (true|false)`) and echoes it verbatim as the last line of
 * its assistant message — see flow-pipeline/SKILL.md's "Checkpoint arm
 * signal (echo-verbatim)" subsection. Never called from `--probe`/`--consume`/
 * `--path` paths, which must stay silent on this line.
 */
export function renderArmBanner(
  input:
    | { armed: true; site: CheckpointSite }
    | { armed: false; reason: string },
): string {
  if (input.armed) {
    return `checkpointed: true — site=${input.site} — safe to /clear`;
  }
  return `checkpointed: false — ${input.reason} — /clear will lose unsaved in-chat state`;
}

/**
 * True iff the slug's `checkpoint.md` is present and non-empty. Mirrors
 * `probePlan` in flow-resume-decide.ts — empty and missing collapse to the
 * same `false`.
 */
export function probeCheckpointBody(
  slug: string,
  dir = FLOW_STATE_DIR,
): boolean {
  try {
    const stat = fs.statSync(checkpointBodyPath(slug, dir));
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
export function archiveCheckpointBody(
  slug: string,
  dir = FLOW_STATE_DIR,
): string | null {
  const src = checkpointBodyPath(slug, dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(src);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const dest = checkpointConsumedPath(slug, dir);
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
  | {
      slug?: string;
      consume: boolean;
      probe: boolean;
      path: boolean;
      site: CheckpointSite;
    }
  | { error: string };

export function parseArgs(argv: string[]): Args {
  let slug: string | undefined;
  let consume = false;
  let probe = false;
  let pathFlag = false;
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
    if (a === "--path") {
      pathFlag = true;
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
  if (pathFlag && (consume || probe)) {
    return { error: "--path is mutually exclusive with --consume/--probe" };
  }
  return { slug, consume, probe, path: pathFlag, site };
}

const USAGE =
  "usage: flow-checkpoint [<slug>] [--consume | --probe | --path] [--site manual|plan-review|plan-approval|gate|terminal]";

function emit(result: CheckpointResult): void {
  process.stdout.write(JSON.stringify(result) + "\n");
}

export function run(argv: string[], deps: Deps = {}): number {
  const stateDir = deps.stateDir ?? FLOW_STATE_DIR;
  const resolveSlug = deps.resolveSlug ?? (() => resolveSlugAmbient());
  const resolveKind = deps.resolveKind ?? resolveKindAmbient;

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log(USAGE);
      return 0;
    }
    console.error(`flow-checkpoint: ${parsed.error}`);
    console.error(USAGE);
    // Bad args could be a malformed --probe/--consume/--path call too (e.g.
    // an unknown --site value on a --probe invocation) — parseArgs can't
    // tell which flag family was intended once it's failed to parse, so we
    // can't gate this one on "is this an arm" the way the no-slug branch
    // below can. Fall back to scanning the raw argv for the read-only flags;
    // renderArmBanner's own "never called from --probe/--consume/--path"
    // invariant still holds for every dispatch-reachable call site.
    const isReadOnlyIntent = argv.some(
      (a) => a === "--probe" || a === "--consume" || a === "--path",
    );
    if (!isReadOnlyIntent) {
      process.stderr.write(
        renderArmBanner({ armed: false, reason: "bad-args" }) + "\n",
      );
    }
    return 2;
  }

  const slug = parsed.slug ?? resolveSlug();
  if (!slug) {
    console.error(
      "flow-checkpoint: no slug given and no FLOW_SLUG in the environment.\n" +
        "  pass <slug> explicitly, or run inside a pipeline launched by `flow feature create`.",
    );
    if (!parsed.probe && !parsed.consume && !parsed.path) {
      process.stderr.write(
        renderArmBanner({ armed: false, reason: "no-slug" }) + "\n",
      );
    }
    return 2;
  }

  const state = readState(slug, stateDir);

  // --path: print the resolved checkpoint body path and exit. Derives from
  // the slug alone, so it never requires state.json and never fails for an
  // unknown slug — it is a pure path lookup, not a decision.
  //
  // The parent directory is created here because `--path` is the *write-target*
  // resolver: every caller redirects into it (`echo … > "$(flow-checkpoint
  // --path)"` at the three terminal auto-checkpoint sites, and the
  // `/flow-checkpoint` skill's step 1). `checkpointDir` itself stays a pure
  // path.join, so the read-side probes never materialize a directory — but a
  // resolver whose result cannot be written to is useless, and without this the
  // terminal site silently no-ops for exactly the never-checkpointed pipelines
  // it exists to serve (the redirect fails, then the arm reports
  // `checkpoint-missing`). mkdir is idempotent and the directory is empty until
  // something writes, so a read-only caller pays only an empty dir.
  if (parsed.path) {
    const bodyPath = checkpointBodyPath(slug, stateDir);
    try {
      fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
    } catch {
      // Best-effort: still print the path. A caller that only wanted to read
      // is unaffected, and a writer surfaces the real error on its redirect.
    }
    process.stdout.write(bodyPath + "\n");
    return 0;
  }

  // --probe: read-only freshness verdict, checked before any consume/arm
  // mutation logic below. Fails open (verdict "write") on any unresolvable
  // precondition — no state.
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
    const result = probeFreshness(state, parsed.site, stateDir);
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
  // to retire. Archiving/record-clearing run unconditionally, independent of
  // both marker presence and `state.worktree` — the body is slug-keyed, not
  // worktree-keyed.
  if (parsed.consume) {
    if (!state) {
      emit({ status: "noop", slug, reason: "state-missing" });
      return 0;
    }
    const marker = checkpointMarkerPath(slug, stateDir);
    const archived = archiveCheckpointBody(slug, stateDir) ?? undefined;
    if (state.checkpoint) {
      try {
        writeState({ ...state, checkpoint: undefined }, stateDir);
      } catch {
        // best-effort: a failed record clear does not block the decision.
      }
    }
    try {
      fs.unlinkSync(armBannerPath(slug, stateDir));
    } catch {
      // best-effort: no banner to retire (never armed, or already
      // consumed) is not an error — see checkpointDir contract above.
    }
    if (fs.existsSync(marker)) {
      try {
        fs.unlinkSync(marker);
      } catch {
        // best-effort: a marker that can't be removed still no-ops the next
        // clear once the worktree is gone; don't fail the decision.
      }
      emit({
        status: "consumed",
        slug,
        worktree: state.worktree,
        marker,
        archived,
      });
      return 0;
    }
    emit({
      status: "noop",
      slug,
      worktree: state.worktree,
      reason: "no-marker",
      archived,
    });
    return 0;
  }

  // Ready/needs: a ready verdict requires state.json + a non-empty
  // checkpoint.md, and writes the marker (plus a freshness record for the
  // armed site); a needs verdict writes nothing. No worktree requirement —
  // the checkpoint location is slug-keyed.
  if (!state) {
    process.stderr.write(
      renderArmBanner({ armed: false, reason: "state-missing" }) + "\n",
    );
    emit({ status: "needs", slug, reason: "state-missing" });
    return 0;
  }
  if (!probeCheckpointBody(slug, stateDir)) {
    process.stderr.write(
      renderArmBanner({ armed: false, reason: "checkpoint-missing" }) + "\n",
    );
    emit({
      status: "needs",
      slug,
      phase: state.phase,
      worktree: state.worktree,
      reason: "checkpoint-missing",
    });
    return 0;
  }

  const marker = checkpointMarkerPath(slug, stateDir);
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${slug}\n${nowIso()}\n`);
  } catch (err) {
    const reason = `marker-write-failed: ${String(err)
      .replace(/\n/g, " ")
      .slice(0, 200)}`;
    process.stderr.write(renderArmBanner({ armed: false, reason }) + "\n");
    emit({
      status: "needs",
      slug,
      phase: state.phase,
      worktree: state.worktree,
      reason,
    });
    return 0;
  }

  // Only relabel the freshness record when THIS site's own probe verdict was
  // "write" — i.e. this site was the one that (would have) produced the
  // current body. On "preserve" (e.g. a fresh manual note outranking a
  // no-phase-change auto site), the arm must leave the existing record
  // alone: relabelling it to `parsed.site` would destroy the provenance
  // (`site: "manual"`) the preserve decision itself rested on, silently
  // demoting a note that should keep outranking auto sites with no phase
  // change since it was left.
  const verdict = probeFreshness(state, parsed.site, stateDir).verdict;
  if (verdict === "write" || !state.checkpoint) {
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
  }

  // Non-blocking terminal-phase warning: the marker is already written above
  // (never gated on this — the `gated`-feedback resume path depends on
  // flow-checkpoint arming the marker at a terminal phase). Kind-aware
  // (revision 1): an `epic-run` window resumes regardless of phase, so
  // warning there would be a false alarm in exactly the window Task 3 fixed.
  //
  // Suppressed for `--site terminal`: that site exists precisely to arm AT a
  // terminal render, so "this phase is terminal" tells its caller nothing it
  // did not already know — and the warning would land in the user's terminal
  // right beside the MERGED / NEEDS HUMAN gate block, reading as a problem
  // when it is the designed path. Every other site keeps the warning, which is
  // where it is actually news.
  const kind = resolveKind() ?? "feature";
  let warning: string | undefined;
  if (parsed.site !== "terminal" && !autoResumesAfterClear(state.phase, kind)) {
    warning = `phase '${state.phase}' is terminal — your notes are still carried over into the fresh session after /clear, but the pipeline itself will not auto-resume (there is nothing left to resume). In a tmux window the notes arrive alongside a short orientation turn that summarises them and then waits for your questions, so the pane does not sit blank.`;
    process.stderr.write(`flow-checkpoint: warning: ${warning}\n`);
  }

  const banner = renderArmBanner({ armed: true, site: parsed.site });
  try {
    fs.mkdirSync(path.dirname(armBannerPath(slug, stateDir)), {
      recursive: true,
    });
    fs.writeFileSync(armBannerPath(slug, stateDir), banner + "\n");
  } catch {
    // best-effort: the durable copy is a convenience for a later reader that
    // missed the stderr line; a failed write must never change the exit
    // code, the JSON, or the stderr banner below.
  }
  process.stderr.write(banner + "\n");

  emit({
    status: "ready",
    slug,
    phase: state.phase,
    worktree: state.worktree,
    checkpoint: checkpointBodyPath(slug, stateDir),
    marker,
    ...(warning ? { warning } : {}),
  });
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
