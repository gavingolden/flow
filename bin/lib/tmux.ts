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

export function sessionExists(session = FLOW_SESSION): boolean {
  return tmux(["has-session", "-t", session]).exitCode === 0;
}

/** Lists windows in the flow session. Returns [] when the session doesn't exist. */
export function listWindows(session = FLOW_SESSION): TmuxWindow[] {
  if (!sessionExists(session)) return [];
  const r = tmux(["list-windows", "-t", session, "-F", "#{window_name}\t#{window_activity}"]);
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
  const r = tmux(["new-window", "-t", session, "-n", name, "-c", cwd, "--", ...command]);
  return { ok: r.exitCode === 0, stderr: r.stderr };
}

export function killWindow(name: string, session = FLOW_SESSION): boolean {
  return tmux(["kill-window", "-t", `${session}:${name}`]).exitCode === 0;
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
