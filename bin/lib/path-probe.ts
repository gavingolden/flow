import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

type ProbeRun = (argv: string[]) => { status: number | null };

// node:child_process, not Bun.spawnSync: doctor probes also run under
// vitest's Node, where the global `Bun` object does not exist.
const defaultRun: ProbeRun = (argv) => {
  const [cmd, ...args] = argv;
  const result = spawnSync(cmd, args, { stdio: "pipe" });
  return { status: result.status };
};

export function commandOnPath(
  cmd: string,
  run: ProbeRun = defaultRun,
): boolean {
  return run(["sh", "-c", `command -v ${cmd}`]).status === 0;
}

export function pathContains(
  dir: string,
  envPath: string = process.env.PATH ?? "",
): boolean {
  const real = (() => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  })();
  for (const segment of envPath.split(":")) {
    if (segment === dir || segment === real) return true;
    try {
      if (fs.realpathSync(segment) === real) return true;
    } catch {
      // ignore non-existent PATH segments
    }
  }
  return false;
}
