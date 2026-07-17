/**
 * The plain launcher backend: runs the pipeline's claude session as a
 * FOREGROUND child of `flow feature create` in the user's own terminal — no
 * tmux window, no detach/attach. Liveness is carried entirely by the
 * `pid`/`procStartedAt` file signal (`bin/lib/liveness.ts`), which `flow ls`
 * / `flow done` / the orphan reaper already consume.
 *
 * Seed delivery: claude DOES auto-run a positional prompt when launched
 * interactively in the foreground, so the seed rides as the final positional
 * argv token — there is no send-keys surface here. The idle hint below is
 * the unconditional degrade notice for claude builds where the positional
 * sits pre-filled at the prompt instead of auto-submitting.
 */

import {
  deleteState,
  readState,
  writeState,
  type PipelineState,
} from "./state";
import { FLOW_SESSION } from "./tmux";
import { livenessOf, pidStartEpoch, type LivenessDeps } from "./liveness";
import { dim } from "./color";

export const PLAIN_IDLE_HINT =
  "flow: if claude sits idle at the prompt, press Enter to start the pipeline";

export const PLAIN_RESUME_REFUSAL_NOTICE =
  "flow feature resume: this pipeline is running under the plain launcher — a plain terminal cannot be reclaimed; `flow done` it first, then resume.";

export type PlainLaunchDeps = {
  /**
   * Spawn seam. Production spawns `Bun.spawn` with inherited stdio so the
   * user's terminal IS the claude session; tests inject a fake child.
   */
  spawn?: (
    argv: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
  ) => { pid: number; exited: Promise<number> };
  isTTY?: boolean;
  pidStartEpoch?: typeof pidStartEpoch;
};

export type PlainLaunchRequest = {
  slug: string;
  repo: string;
  command: string[];
  seed: string;
  stateDir?: string;
};

export type PlainLaunchResult = {
  status: "exited" | "failed";
  exitCode: number;
  stderr: string;
};

function defaultSpawn(
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): { pid: number; exited: Promise<number> } {
  const child = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return { pid: child.pid, exited: child.exited };
}

async function runForeground(
  req: PlainLaunchRequest,
  deps: PlainLaunchDeps,
  verb: "create" | "resume",
): Promise<PlainLaunchResult> {
  const isTTY =
    deps.isTTY ??
    (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!isTTY) {
    console.error(
      `flow feature ${verb}: the plain launcher needs an interactive terminal — pass --tmux or run from a terminal`,
    );
    // Mirror the delete-on-fast-fail cleanup below: this guard fires before
    // any spawn attempt, so a `create`-verb `starting` state written by
    // runFresh would otherwise be orphaned (never reaches the fast-fail
    // branch further down since we return before spawning at all).
    if (verb === "create") {
      const preSpawnState = readState(req.slug, req.stateDir);
      if (
        preSpawnState != null &&
        preSpawnState.phase === "starting" &&
        preSpawnState.seedIngestedAt == null
      ) {
        deleteState(req.slug, req.stateDir);
      }
    }
    return { status: "failed", exitCode: 1, stderr: "not a TTY" };
  }

  // First stdout line is the machine-read contract token — raw, never
  // colorized — BEFORE the terminal is handed to claude.
  console.log(`${FLOW_SESSION}:${req.slug}`);
  console.error(dim(PLAIN_IDLE_HINT));

  const spawn = deps.spawn ?? defaultSpawn;
  let child: { pid: number; exited: Promise<number> };
  try {
    child = spawn([...req.command, req.seed], {
      cwd: req.repo,
      env: { ...process.env, FLOW_PIPELINE: "1", FLOW_SLUG: req.slug },
    });
  } catch (e) {
    console.error(
      `flow feature ${verb}: failed to launch claude — check your Claude Code install and PATH`,
    );
    if (verb === "create") {
      const preSpawnState = readState(req.slug, req.stateDir);
      if (
        preSpawnState != null &&
        preSpawnState.phase === "starting" &&
        preSpawnState.seedIngestedAt == null
      ) {
        deleteState(req.slug, req.stateDir);
      }
    }
    return { status: "failed", exitCode: 1, stderr: String(e) };
  }

  // Record the liveness file-signal immediately after spawn, folding into
  // the CURRENT on-disk state so a concurrent hook write is never clobbered.
  const getStartEpoch = deps.pidStartEpoch ?? pidStartEpoch;
  const current = readState(req.slug, req.stateDir);
  if (current != null) {
    writeState(
      {
        ...current,
        pid: child.pid,
        procStartedAt: getStartEpoch(child.pid) ?? undefined,
        launcher: "plain",
      },
      req.stateDir,
    );
  }

  const exitCode = await child.exited;

  // Delete-on-fast-fail: an exit that never got past `starting` and never
  // stamped the seed-ingested marker is a dead-on-arrival launch — leave no
  // orphaned state file behind (mirrors the tmux path's no-orphan ordering).
  const after = readState(req.slug, req.stateDir);
  if (
    verb === "create" &&
    after != null &&
    after.phase === "starting" &&
    after.seedIngestedAt == null
  ) {
    deleteState(req.slug, req.stateDir);
    return { status: "failed", exitCode, stderr: "" };
  }
  return { status: "exited", exitCode, stderr: "" };
}

export async function plainLaunch(
  req: PlainLaunchRequest,
  deps: PlainLaunchDeps = {},
): Promise<PlainLaunchResult> {
  return runForeground(req, deps, "create");
}

/**
 * Foreground resume. Refuses when the recorded process is still alive —
 * including under `--force`: unlike a tmux pane, a plain foreground terminal
 * belongs to whatever shell launched it and cannot be reclaimed from here.
 */
export async function plainResume(
  req: PlainLaunchRequest,
  deps: PlainLaunchDeps & { force?: boolean; liveness?: LivenessDeps } = {},
): Promise<PlainLaunchResult> {
  const state = readState(req.slug, req.stateDir);
  if (state != null && livenessOf(state, deps.liveness) === "alive") {
    if (deps.force) {
      console.error(PLAIN_RESUME_REFUSAL_NOTICE);
    } else {
      console.error(
        `flow feature resume: pipeline '${req.slug}' is still running.`,
      );
      console.error(PLAIN_RESUME_REFUSAL_NOTICE);
    }
    return { status: "failed", exitCode: 1, stderr: "still running" };
  }
  return runForeground(req, deps, "resume");
}

/**
 * SIGTERMs the recorded process ONLY on an `alive` liveness verdict — a
 * recycled PID (`dead`), an exited process (`stale`), or a legacy state with
 * no pid signal (`unknown`) is never signalled.
 */
export function plainTerminate(
  state: PipelineState,
  deps: {
    kill?: (pid: number, sig: string) => void;
    liveness?: LivenessDeps;
  } = {},
): { terminated: boolean; reason?: string } {
  const verdict = livenessOf(state, deps.liveness);
  if (verdict !== "alive") {
    return { terminated: false, reason: `liveness: ${verdict}` };
  }
  const kill =
    deps.kill ??
    ((pid: number, sig: string) => process.kill(pid, sig as NodeJS.Signals));
  try {
    kill(state.pid!, "SIGTERM");
    return { terminated: true };
  } catch (e) {
    return {
      terminated: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** The hint `flow attach` prints for a plain-launched pipeline (attach is a
 * tmux-launcher feature; a plain session lives in its own terminal). */
export function plainAttachHint(state: PipelineState): string {
  const pid = state.pid != null ? ` (pid ${state.pid})` : "";
  return (
    `flow attach: pipeline '${state.slug}' runs under the plain launcher${pid} — ` +
    "attach is a tmux-launcher feature. The session lives in the terminal that launched it; " +
    `resume a crashed one with \`flow feature resume ${state.slug}\`.`
  );
}
