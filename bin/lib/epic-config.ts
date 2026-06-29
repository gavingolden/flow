/**
 * Tolerant boundary reader for `~/.flow/config.json` `epic.maxParallel`.
 *
 * Mirrors `copilot-config.ts`: reads the same `~/.flow/config.json` off
 * `FLOW_CONFIG` through an injectable `ReadConfigFile` seam (so tests never
 * touch the real file), and collapses anything unreadable/malformed/wrong-typed
 * to the built-in default. `paths.ts`'s private `FlowConfig` type only knows
 * `source?`, so this is a net-new key reader, not an extension of `readConfig`.
 *
 * Consumed by `epic.ts`'s run arm as the `--max-parallel` fallback (the flag,
 * when present, overrides this).
 */

import * as fs from "node:fs";
import { FLOW_CONFIG } from "./paths";

/** Concurrency cap default when `epic.maxParallel` is unset/invalid. */
export const DEFAULT_MAX_PARALLEL = 3;

/**
 * Config-read seam. Returns the raw parsed JSON, or `undefined` when the file
 * is absent/unreadable/non-JSON. Tests override this so the real
 * `~/.flow/config.json` is never read.
 */
export type ReadConfigFile = () => unknown;

const defaultReadConfigFile: ReadConfigFile = () => {
  try {
    return JSON.parse(fs.readFileSync(FLOW_CONFIG, "utf8"));
  } catch {
    return undefined;
  }
};

function extractEpicMaxParallel(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const epic = (raw as Record<string, unknown>).epic;
  if (typeof epic !== "object" || epic === null) return undefined;
  const n = (epic as Record<string, unknown>).maxParallel;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The configured `epic.maxParallel` when it is a positive integer, else the
 * default 3. Never throws — a missing/corrupt config collapses to the default
 * through the boundary reader's `catch`.
 */
export function readEpicMaxParallel(
  read: ReadConfigFile = defaultReadConfigFile,
): number {
  return extractEpicMaxParallel(read()) ?? DEFAULT_MAX_PARALLEL;
}
