/** Test-only fixtures for the doctor probe suites: an all-explicit
 * `DoctorDeps` rooted in a caller-supplied sandbox, with a scripted `run`. */
import * as path from "node:path";
import type { DoctorDeps, RunResult } from "./doctor";

export function runResult(over: Partial<RunResult> = {}): RunResult {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    notFound: false,
    timedOut: false,
    ...over,
  };
}

export type RunCall = { cmd: string; args: string[] };

/** A `run` that answers from `script(cmd, args)` and records every call. */
export function scriptedRun(
  script: (cmd: string, args: string[]) => Partial<RunResult> | undefined,
  calls: RunCall[] = [],
): DoctorDeps["run"] {
  return (cmd, args) => {
    calls.push({ cmd, args });
    return runResult(script(cmd, args) ?? { notFound: true, status: null });
  };
}

export function makeDeps(
  root: string,
  over: Partial<DoctorDeps> = {},
): DoctorDeps {
  const flow = path.join(root, "flow-checkout");
  return {
    env: { PATH: `${path.join(root, "home", ".local", "bin")}:/usr/bin` },
    run: scriptedRun(() => undefined),
    homeDir: path.join(root, "home"),
    cwd: path.join(root, "cwd"),
    stateDir: path.join(root, "home", ".flow", "state"),
    manifestPath: path.join(root, "home", ".flow", "installed.json"),
    configPath: path.join(root, "home", ".flow", "config.json"),
    targets: {
      skillsDir: path.join(
        root,
        "home",
        ".flow",
        "claude-home",
        ".claude",
        "skills",
      ),
      agentsDir: path.join(root, "home", ".claude", "agents"),
      binDir: path.join(root, "home", ".local", "bin"),
      completionsDir: path.join(root, "home", ".flow", "completions"),
    },
    flowSource: flow,
    installRoot: flow,
    nowMs: () => 1_700_000_000_000,
    platform: "darwin",
    reapBaseDir: path.join(root, "home", ".flow", "proc-registry"),
    ...over,
  };
}
