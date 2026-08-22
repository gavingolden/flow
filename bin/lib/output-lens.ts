/**
 * Tolerant boundary reader for `~/.flow/config.json`'s `output.lens` key —
 * the pm/dev render-verbosity switch (`docs/configuration.md` "Output
 * lens"). Mirrors `launcher-config.ts`: injectable `ReadConfigFile` seam,
 * absent ≡ `undefined`, never throws.
 *
 * Precedence for a render site: explicit `--lens` flag > the recorded
 * config value > default `pm`. Resolution happens once, in each helper's
 * `run()`; pure renderers take `lens` as an already-resolved input so they
 * stay config-free and testable (AGENTS.md "supervisors read config via
 * jq, never a bin/lib import" — this seam is for helpers on PATH only).
 */

import {
  defaultReadConfigFile,
  type ReadConfigFile,
} from "./modules-config";

export type OutputLens = "pm" | "dev";

export const OUTPUT_LENSES = ["pm", "dev"] as const;

export function isOutputLens(x: unknown): x is OutputLens {
  return x === "pm" || x === "dev";
}

/**
 * The notice printed when the recorded `output.lens` value is present but
 * malformed (wrong type or an unknown string) — the reader degrades to
 * `pm` rather than failing. An absent key is silent (not malformed).
 */
export const OUTPUT_LENS_INVALID_NOTICE =
  "flow: output.lens is set but invalid (expected 'pm' or 'dev'); falling back to 'pm'";

function extractLens(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  const output = (raw as Record<string, unknown>).output;
  if (typeof output !== "object" || output === null) return undefined;
  return (output as Record<string, unknown>).lens;
}

/**
 * Reads `output.lens` from config. Absent ⇒ silent `pm`. A present but
 * malformed value (wrong type / unknown string) ⇒ `pm` with
 * `OUTPUT_LENS_INVALID_NOTICE` printed to stderr. Never throws.
 */
export function readOutputLens(
  read: ReadConfigFile = defaultReadConfigFile,
): OutputLens {
  const raw = extractLens(read());
  if (raw === undefined) return "pm";
  if (isOutputLens(raw)) return raw;
  console.error(OUTPUT_LENS_INVALID_NOTICE);
  return "pm";
}

/**
 * Runtime resolution for a single render call: an explicit `--lens` flag
 * wins outright (still validated — an invalid flag value falls back the
 * same way an invalid config value does, without a duplicate notice, since
 * the caller's own arg-parsing is expected to have already reported a bad
 * flag). Absent flag ⇒ `readOutputLens(read)`.
 */
export function resolveLens(
  flag: string | undefined,
  read: ReadConfigFile = defaultReadConfigFile,
): OutputLens {
  if (flag !== undefined) {
    return isOutputLens(flag) ? flag : "pm";
  }
  return readOutputLens(read);
}
