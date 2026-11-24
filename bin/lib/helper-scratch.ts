import { rmdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type HelperScratchPaths = {
  dir: string;
  prompt: string;
  schema: string;
  raw: string;
  retryRaw: string;
};

// Working files live outside the result-file namespace so a cleanup of
// results by name (e.g. agent-output-*.json) never reaches live inputs;
// keyed per output so two runs never share files.
export function helperScratchPaths(
  out: string,
  helper: "gemini-lens" | "gemini-intent-guess",
): HelperScratchPaths {
  const dir = join(dirname(out), "scratch", helper, basename(out));
  return {
    dir,
    prompt: join(dir, "prompt.txt"),
    schema: join(dir, "schema.json"),
    raw: join(dir, "agy-raw"),
    retryRaw: join(dir, "agy-raw-retry"),
  };
}

export function rmdirIfEmpty(
  dir: string,
  rmdir: (dir: string) => void = rmdirSync,
): void {
  try {
    rmdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw err;
  }
}

export function removeEmptyScratchDirs(
  paths: HelperScratchPaths,
  rmdir?: (dir: string) => void,
): void {
  rmdirIfEmpty(paths.dir, rmdir);
  rmdirIfEmpty(dirname(paths.dir), rmdir);
}

export function agyLensesScratchDir(worktree: string): string {
  return join(worktree, ".flow-tmp", "scratch", "agy-lenses");
}
