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

export const FLOW_SESSION = "flow";
const FLOW_SLUG_OPTION = "@flow-slug";

type SpawnResult = { stdout: string; stderr: string; exitCode: number };

function tmux(args: string[]): SpawnResult {
  try {
    const r = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
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
  const opt = tmux(["set-option", "-w", "-t", windowId, FLOW_SLUG_OPTION, slug]);
  if (opt.exitCode !== 0) {
    return {
      ok: false,
      stderr: `set-option ${FLOW_SLUG_OPTION} failed: ${opt.stderr}`,
    };
  }
  return { ok: true, stderr: "" };
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
