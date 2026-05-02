/**
 * Thin wrappers around the tmux CLI. The `flow` session is the single
 * container for every pipeline window; window names are slugs.
 */

export const FLOW_SESSION = "flow";

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
  name: string;
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

/** Lists windows in the flow session. Returns [] when the session doesn't exist. */
export function listWindows(session = FLOW_SESSION): TmuxWindow[] {
  if (!sessionExists(session)) return [];
  const r = tmux([
    "list-windows",
    "-t",
    sessionTarget(session),
    "-F",
    "#{window_name}\t#{window_activity}",
  ]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, activityStr] = line.split("\t");
      return { name: name ?? "", activity: Number(activityStr) || 0 };
    });
}

export function windowExists(name: string, session = FLOW_SESSION): boolean {
  return listWindows(session).some((w) => w.name === name);
}

/**
 * Creates the named window inside the flow session, creating the session if
 * needed. The window starts with the given command running in its first pane.
 */
export function createWindow(
  name: string,
  cwd: string,
  command: string[],
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  if (!sessionExists(session)) {
    const r = tmux([
      "new-session",
      "-d",
      "-s",
      session,
      "-n",
      name,
      "-c",
      cwd,
      "--",
      ...command,
    ]);
    return { ok: r.exitCode === 0, stderr: r.stderr };
  }
  const r = tmux(buildNewWindowArgs(session, name, cwd, command));
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
    "--",
    ...command,
  ];
}

export function killWindow(name: string, session = FLOW_SESSION): boolean {
  return tmux(["kill-window", "-t", `${session}:${name}`]).exitCode === 0;
}

/**
 * Reruns `command` inside the named window's first pane, replacing whatever
 * was there. Used by `flow new --resume` when the window survived the crash —
 * preserves the pane id so the user's tmux scrollback addressing stays valid.
 */
export function respawnWindow(
  name: string,
  cwd: string,
  command: string[],
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  const r = tmux([
    "respawn-window",
    "-k",
    "-t",
    `${session}:${name}`,
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
export function isPaneAlive(name: string, session = FLOW_SESSION): boolean {
  if (!windowExists(name, session)) return false;
  const r = tmux([
    "list-panes",
    "-t",
    `${session}:${name}`,
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
export function execAttach(name: string, session = FLOW_SESSION): never {
  // execvp via Bun.spawn doesn't replace the parent process, so use the
  // shell to hand the foreground over and exit cleanly. Stdio inherited so
  // tmux owns the terminal until the user detaches.
  const r = Bun.spawnSync(["tmux", "attach", "-t", `${session}:${name}`], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(r.exitCode ?? 1);
}
