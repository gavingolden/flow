/**
 * Thin wrappers around the tmux CLI. The `flow` session is the single
 * container for every pipeline window.
 *
 * Identity vs display: every window flow creates carries a `@flow-slug`
 * tmux user option. That option is the canonical pipeline identifier;
 * the `window_name` is purely the user-visible title and may change
 * (the user can `tmux ,` rename it; the supervisor sets a descriptive
 * title during triage). Every helper resolves a slug → `window_id`
 * once, then issues the follow-up tmux command by id, so renames don't
 * unreachable-ify the pipeline. Pre-upgrade windows that don't have
 * the option set fall back to name-matching.
 */

import * as path from "node:path";
import { shortPhase } from "./state";

export const FLOW_SESSION = "flow";
const FLOW_SLUG_OPTION = "@flow-slug";
/**
 * Window option mirroring the pipeline's current phase. Additive and
 * opt-in: flow only ever *publishes* the value onto its own windows — it
 * never writes `~/.tmux.conf` and ships no theme. A user opts in by binding
 * `#{@flow-phase}` into their own status-bar format. `flow ls` stays the
 * canonical status surface; this is a convenience mirror, not a replacement.
 * Hyphenated to match `@flow-slug`.
 */
export const FLOW_PHASE_OPTION = "@flow-phase";
/**
 * Window option holding the basename of the pipeline's root repo (the repo
 * resolved at `flow new`, matching the REPO column in `flow ls`). Same
 * additive/opt-in/publish-only contract as `@flow-phase`: flow sets it on its
 * own windows so a status-bar format can bind `#{@flow-repo}` into a compact
 * `[repo phase]` badge, never writing the user's tmux config. Best-effort — a
 * non-zero `set-option` exit is swallowed and never blocks window creation.
 */
export const FLOW_REPO_OPTION = "@flow-repo";
/**
 * Window option mirroring the current phase in compact form — the
 * `shortPhase()` abbreviation of `@flow-phase` (see `PHASE_SHORT` in `./state`,
 * the single source of truth). Same additive/opt-in/publish-only/best-effort
 * contract as `@flow-phase`, which keeps emitting the raw phase string
 * unchanged; `@flow-phase-short` is strictly additive.
 */
export const FLOW_PHASE_SHORT_OPTION = "@flow-phase-short";
/**
 * The phase seeded at window creation, before the first
 * `flow-state-update --phase` lands. Must match the initial phase `flow new`
 * writes to `~/.flow/state/<slug>.json` (`STEP_PHASES[0]` in `./state`), so a
 * status bar bound to `@flow-phase` never renders empty for a live pipeline.
 */
const INITIAL_PHASE = "starting";

export type ResolveSlugDeps = {
  env?: NodeJS.ProcessEnv;
  spawnTmux?: (args: string[]) => SpawnResult;
};

/**
 * Resolves the supervisor's pipeline slug from the current tmux pane's
 * `@flow-slug` window option. Helpers that take a slug positionally or
 * via `--slug` use this as a fallback when the caller omits the arg —
 * the supervisor's per-call shell loses any `SLUG=…` between Bash tool
 * calls, but `$TMUX_PANE` and the `@flow-slug` option set by
 * `createWindow()` are immutable for the life of the window.
 *
 * Returns `null` when:
 *   - `$TMUX_PANE` is unset (helper invoked outside tmux),
 *   - `tmux show-options` fails (option unset on the window, which
 *     `-v` reports via non-zero exit, e.g. for non-flow windows), or
 *   - the resolved value is empty / whitespace.
 */
export function resolveSlugFromPane(deps: ResolveSlugDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const spawn = deps.spawnTmux ?? tmux;
  const pane = env.TMUX_PANE;
  if (!pane) return null;
  const r = spawn(["show-options", "-t", pane, "-v", "-w", FLOW_SLUG_OPTION]);
  if (r.exitCode !== 0) return null;
  const slug = r.stdout.trim();
  return slug.length > 0 ? slug : null;
}

export type SpawnResult = { stdout: string; stderr: string; exitCode: number };

function tmux(args: string[]): SpawnResult {
  try {
    const r = Bun.spawnSync(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: r.stdout.toString().trim(),
      stderr: r.stderr.toString().trim(),
      exitCode: r.exitCode ?? 1,
    };
  } catch (e: unknown) {
    // tmux not installed at all → spawn throws ENOENT. Surface it cleanly.
    const msg = e instanceof Error ? e.message : String(e);
    return { stdout: "", stderr: msg, exitCode: 127 };
  }
}

export type TmuxWindow = {
  /** Stable tmux window id (e.g. `@7`) — survives renames *and* index shifts. */
  id: string;
  /** User-visible display name. May differ from `slug` after a rename. */
  name: string;
  /** Pipeline slug from the `@flow-slug` user option. Empty for non-flow windows. */
  slug: string;
  /** Unix epoch seconds of last activity in any pane of the window. */
  activity: number;
};

// A bare `-t flow` can resolve against the current *window* depending on
// tmux config and command — `new-window -t flow` then tries to create at
// the active window's index, failing with "index N in use" when N is
// occupied. `flow:` (trailing colon) forces session-target semantics.
const sessionTarget = (s: string) => `${s}:`;

export function sessionExists(session = FLOW_SESSION): boolean {
  return tmux(["has-session", "-t", sessionTarget(session)]).exitCode === 0;
}

const LIST_WINDOWS_FORMAT = `#{window_id}\t#{window_name}\t#{${FLOW_SLUG_OPTION}}\t#{window_activity}`;

/** Lists windows in the flow session. Returns [] when the session doesn't exist. */
export function listWindows(session = FLOW_SESSION): TmuxWindow[] {
  if (!sessionExists(session)) return [];
  const r = tmux([
    "list-windows",
    "-t",
    sessionTarget(session),
    "-F",
    LIST_WINDOWS_FORMAT,
  ]);
  if (r.exitCode !== 0) return [];
  return parseWindowList(r.stdout);
}

export function parseWindowList(stdout: string): TmuxWindow[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [id, name, slug, activityStr] = line.split("\t");
      return {
        id: id ?? "",
        name: name ?? "",
        slug: slug ?? "",
        activity: Number(activityStr) || 0,
      };
    });
}

/**
 * Resolves a slug to the window that owns it. First match wins; the
 * slug-keyed pass runs before the name fallback so a renamed window's
 * old display name can't accidentally shadow a different pipeline.
 */
export function findWindowBySlug(
  windows: TmuxWindow[],
  slug: string,
): TmuxWindow | undefined {
  return (
    windows.find((w) => w.slug && w.slug === slug) ??
    windows.find((w) => !w.slug && w.name === slug)
  );
}

export function windowExists(slug: string, session = FLOW_SESSION): boolean {
  return findWindowBySlug(listWindows(session), slug) !== undefined;
}

/**
 * Creates the named window inside the flow session, creating the session if
 * needed. The window starts with the given command running in its first pane,
 * and carries the `@flow-slug` user option so subsequent lookups survive a
 * display-name rename.
 */
export function createWindow(
  slug: string,
  cwd: string,
  command: string[],
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  const args = sessionExists(session)
    ? buildNewWindowArgs(session, slug, cwd, command)
    : buildNewSessionArgs(session, slug, cwd, command);
  const r = tmux(args);
  if (r.exitCode !== 0) return { ok: false, stderr: r.stderr };
  // Output of `-P -F '#{window_id}'` is the new window's id (e.g. `@7`).
  const windowId = r.stdout.trim();
  if (!windowId) {
    return {
      ok: false,
      stderr: `tmux ${args[0]} succeeded but printed no window id`,
    };
  }
  return seedWindowOptions(windowId, slug, cwd);
}

/**
 * Liveness-poll budget for `createWindowVerified`. `claude` launched in a
 * fresh pane can pass the create call (tmux forks the shell, exit 0) yet die
 * milliseconds later (bad install, missing binary), so we re-probe the pane a
 * few times and require it alive at the END of the budget — a single early
 * "alive" reading is not enough to catch the alive-then-dies race. NOTE: the
 * total ~600ms budget (5 × 120ms) is a first cut; it MUST be validated against
 * a real `claude` cold-launch — too short and a slow-starting healthy claude is
 * killed as a false orphan. Tune both constants if dogfooding shows otherwise.
 */
const LIVENESS_POLL_ATTEMPTS = 5;
const LIVENESS_POLL_INTERVAL_MS = 120;

function livenessSleepSync(ms: number): void {
  // Atomics.wait on a SharedArrayBuffer view is a spawn-free sync sleep, the
  // same idiom lock.ts uses for its poll backoff. createWindowVerified is a
  // synchronous fn (its callers runFresh/runResume return a number, not a
  // Promise), so setTimeout / Bun.sleep / await are not options here.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

export type CreateWindowVerifiedDeps = {
  /**
   * Window-create seam. Defaults to the real `createWindow`. Injectable
   * because `createWindow` shells out via the module-private `tmux` spawn
   * (no spawn seam of its own, and the edit must not mutate it), so a unit
   * test stubs the create result here rather than standing up a tmux server.
   */
  create?: (
    slug: string,
    cwd: string,
    command: string[],
    session?: string,
  ) => { ok: boolean; stderr: string };
  /**
   * Liveness probe seam. Defaults to the real `isPaneAlive`, which shells out
   * to tmux unconditionally and so is not unit-testable; tests inject a stub.
   */
  isAlive?: (slug: string, session?: string) => boolean;
  /** Window-kill seam (defaults to `killWindow`) for the not-alive cleanup. */
  kill?: (slug: string, session?: string) => boolean;
  /**
   * Inter-probe delay seam (ms → void). Defaults to the spawn-free
   * `livenessSleepSync`; unit tests inject a no-op so the bounded poll runs
   * instantly instead of consuming the real ~480ms budget.
   */
  sleep?: (ms: number) => void;
};

/**
 * Creates the window via `createWindow`, then runs a bounded liveness poll to
 * confirm the launched process actually stayed up. tmux's `new-window` exit
 * code only proves the shell forked — a `claude` that exits immediately leaves
 * a half-created window that the caller would otherwise persist state for (the
 * intermittent `flow new` orphan). On not-alive-at-end we kill the half-created
 * window and return `{ ok: false }` so the caller never writes state for it.
 */
export function createWindowVerified(
  slug: string,
  cwd: string,
  command: string[],
  deps: CreateWindowVerifiedDeps = {},
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  const create = deps.create ?? createWindow;
  const isAlive = deps.isAlive ?? isPaneAlive;
  const kill = deps.kill ?? killWindow;
  const sleep = deps.sleep ?? livenessSleepSync;

  const created = create(slug, cwd, command, session);
  if (!created.ok) return created;

  // Require the pane to be alive at the END of the budget. Probe between
  // sleeps; the last probe is the verdict so an alive-then-dies launch fails.
  let alive = false;
  for (let attempt = 0; attempt < LIVENESS_POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) sleep(LIVENESS_POLL_INTERVAL_MS);
    alive = isAlive(slug, session);
  }
  if (!alive) {
    kill(slug, session);
    return {
      ok: false,
      stderr:
        "tmux window created but its process exited immediately (pane not alive after launch)",
    };
  }
  return { ok: true, stderr: "" };
}

/**
 * `respawnWindow` + the same bounded liveness poll as `createWindowVerified`.
 * `respawn-window`'s exit code only proves tmux relaunched the pane; a claude
 * that dies on launch would otherwise let `flow new --resume` report a false
 * "resumed" success over a dead window. Unlike the create path we do NOT kill
 * the window on failure — it pre-existed the resume and the user may want to
 * inspect its scrollback; we only report `{ ok: false }`.
 */
export function respawnWindowVerified(
  slug: string,
  cwd: string,
  command: string[],
  deps: CreateWindowVerifiedDeps = {},
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  const isAlive = deps.isAlive ?? isPaneAlive;
  const sleep = deps.sleep ?? livenessSleepSync;
  const respawned = respawnWindow(slug, cwd, command, session);
  if (!respawned.ok) return respawned;
  let alive = false;
  for (let attempt = 0; attempt < LIVENESS_POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) sleep(LIVENESS_POLL_INTERVAL_MS);
    alive = isAlive(slug, session);
  }
  if (!alive) {
    return {
      ok: false,
      stderr:
        "tmux window respawned but its process exited immediately (pane not alive after launch)",
    };
  }
  return { ok: true, stderr: "" };
}

/** Builds the `set-option -w` argv for a window-scoped user option. */
export function buildSetOptionArgs(
  windowId: string,
  option: string,
  value: string,
): string[] {
  return ["set-option", "-w", "-t", windowId, option, value];
}

/**
 * Seeds a freshly created window's user options: `@flow-slug` (the canonical
 * identifier, load-bearing for every later lookup — its failure fails creation),
 * plus three additive, best-effort mirrors whose failures are swallowed and
 * never block creation (state.json stays the source of truth): `@flow-repo`
 * (the repo basename, from `repoRoot`), `@flow-phase` (the raw phase mirror
 * seeded to `starting`), and `@flow-phase-short` (its compact abbreviation).
 * The windowId is already in hand from `createWindow`, so no extra
 * `listWindows` round-trip.
 */
export function seedWindowOptions(
  windowId: string,
  slug: string,
  repoRoot: string,
  spawnFn: (args: string[]) => SpawnResult = tmux,
): { ok: boolean; stderr: string } {
  const slugSet = spawnFn(buildSetOptionArgs(windowId, FLOW_SLUG_OPTION, slug));
  if (slugSet.exitCode !== 0) {
    return {
      ok: false,
      stderr: `set-option ${FLOW_SLUG_OPTION} failed: ${slugSet.stderr}`,
    };
  }
  // Additive, best-effort mirrors — only @flow-slug above is load-bearing, so a
  // non-zero exit on any of these is swallowed and never fails creation.
  spawnFn(
    buildSetOptionArgs(windowId, FLOW_REPO_OPTION, path.basename(repoRoot)),
  );
  spawnFn(buildSetOptionArgs(windowId, FLOW_PHASE_OPTION, INITIAL_PHASE));
  spawnFn(
    buildSetOptionArgs(
      windowId,
      FLOW_PHASE_SHORT_OPTION,
      shortPhase(INITIAL_PHASE),
    ),
  );
  return { ok: true, stderr: "" };
}

export type SetWindowPhaseDeps = {
  spawnTmux?: (args: string[]) => SpawnResult;
  listWindowsFn?: (session?: string) => TmuxWindow[];
  session?: string;
};

/**
 * Mirrors `phase` onto the window's `@flow-phase` user option (and its compact
 * `@flow-phase-short` abbreviation), resolving the target window by `@flow-slug`
 * (not display name) so a renamed window still receives the update. Best-effort:
 * a missing window or a non-zero `set-option` exit is a soft failure returned as
 * `{ ok: false }`, never a throw — callers (notably `flow-state-update`) ignore
 * the result so a tmux hiccup can never block a state write. The raw `@flow-phase`
 * set drives the returned `ok`; the additive `@flow-phase-short` set is swallowed.
 */
export function setWindowPhase(
  slug: string,
  phase: string,
  deps: SetWindowPhaseDeps = {},
): { ok: boolean; stderr: string } {
  const spawn = deps.spawnTmux ?? tmux;
  const list = deps.listWindowsFn ?? listWindows;
  const window = findWindowBySlug(list(deps.session), slug);
  if (!window) {
    return {
      ok: false,
      stderr: `setWindowPhase: no window for slug '${slug}'`,
    };
  }
  const r = spawn(buildSetOptionArgs(window.id, FLOW_PHASE_OPTION, phase));
  // Additive best-effort mirror — swallowed so it can't change the soft-fail
  // contract above (callers gate on the raw @flow-phase set only).
  spawn(
    buildSetOptionArgs(window.id, FLOW_PHASE_SHORT_OPTION, shortPhase(phase)),
  );
  return { ok: r.exitCode === 0, stderr: r.stderr };
}

export function buildNewWindowArgs(
  session: string,
  name: string,
  cwd: string,
  command: string[],
): string[] {
  return [
    "new-window",
    "-t",
    sessionTarget(session),
    "-n",
    name,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{window_id}",
    "--",
    ...command,
  ];
}

export function buildNewSessionArgs(
  session: string,
  name: string,
  cwd: string,
  command: string[],
): string[] {
  return [
    "new-session",
    "-d",
    "-s",
    session,
    "-n",
    name,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{window_id}",
    "--",
    ...command,
  ];
}

export function killWindow(slug: string, session = FLOW_SESSION): boolean {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) return false;
  return tmux(["kill-window", "-t", window.id]).exitCode === 0;
}

/**
 * Reruns `command` inside the named window's first pane, replacing whatever
 * was there. Used by `flow new --resume` when the window survived the crash —
 * preserves the pane id so the user's tmux scrollback addressing stays valid.
 */
export function respawnWindow(
  slug: string,
  cwd: string,
  command: string[],
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) {
    return { ok: false, stderr: `window not found for slug '${slug}'` };
  }
  const r = tmux([
    "respawn-window",
    "-k",
    "-t",
    window.id,
    "-c",
    cwd,
    "--",
    ...command,
  ]);
  return { ok: r.exitCode === 0, stderr: r.stderr };
}

/**
 * `true` when the window's first pane has a live foreground process. The
 * caller uses this to refuse `--resume` over a still-running supervisor.
 *
 * `pane_dead` flips to 1 only when tmux has `remain-on-exit on`; otherwise
 * the window disappears on exit, so we also probe the pid directly.
 */
export function isPaneAlive(slug: string, session = FLOW_SESSION): boolean {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) return false;
  const r = tmux([
    "list-panes",
    "-t",
    window.id,
    "-F",
    "#{pane_dead} #{pane_pid}",
  ]);
  if (r.exitCode !== 0) return false;
  return parseAliveStatus(r.stdout, pidIsAlive);
}

export function parseAliveStatus(
  stdout: string,
  pidProbe: (pid: number) => boolean,
): boolean {
  const line = stdout.split("\n").find((l) => l.length > 0);
  if (!line) return false;
  const [deadStr, pidStr] = line.split(/\s+/);
  if (deadStr !== "0") return false;
  const pid = Number(pidStr);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  return pidProbe(pid);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Replaces the current process with `tmux attach`. Never returns on success. */
export function execAttach(slug: string, session = FLOW_SESSION): never {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) {
    console.error(`flow attach: window for slug '${slug}' not found.`);
    process.exit(1);
  }
  // Focus the right window before attaching — tmux operates on the server,
  // so select-window works even with no client attached. Then hand the
  // foreground over via attach. stdio inherited so tmux owns the terminal.
  Bun.spawnSync(["tmux", "select-window", "-t", window.id], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const r = Bun.spawnSync(["tmux", "attach", "-t", sessionTarget(session)], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(r.exitCode ?? 1);
}

export function buildRenameArgs(windowId: string, title: string): string[] {
  return ["rename-window", "-t", windowId, title];
}
