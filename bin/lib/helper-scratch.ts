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
