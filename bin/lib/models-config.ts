/**
 * Tolerant boundary reader for `~/.flow/config.json`'s `models` table.
 *
 * Mirrors `copilot-config.ts` / `epic-config.ts`: reads the same
 * `~/.flow/config.json` off `FLOW_CONFIG` through an injectable
 * `ReadConfigFile` seam (so tests never touch the real file), and collapses
 * anything unreadable / malformed / wrong-typed / out-of-enum to `undefined`.
 *
 * Unlike the epic readers, these return `undefined` (not a built-in default) —
 * the precedence chain is owned by the caller: `--model-<phase>` flag (state
 * field) `//` `config.models.<phase>` `//` inherited session model, with the
 * verify-`sonnet` and scout/coder fine-grain exceptions applied at their spawn
 * sites. The `default` key (whole-session default, consumed at launch by
 * `feature.ts` / `epic.ts`) is read by `readDefaultModel`.
 *
 * `MODEL_ALIASES` is reused verbatim from `state.ts` — do NOT re-declare it
 * here; a second copy would violate the single-source-of-truth the Task
 * `model:` enum depends on.
 */

import * as fs from "node:fs";
import { flowConfigPath } from "./paths";
import { MODEL_ALIASES, type ModelAlias } from "./state";

/**
 * Config-read seam. Returns the raw parsed JSON, or `undefined` when the file
 * is absent/unreadable/non-JSON. Tests override this so the real
 * `~/.flow/config.json` is never read.
 */
export type ReadConfigFile = () => unknown;

export const defaultReadConfigFile: ReadConfigFile = () => {
  try {
    return JSON.parse(fs.readFileSync(flowConfigPath(), "utf8"));
  } catch {
    return undefined;
  }
};

function asModelAlias(v: unknown): ModelAlias | undefined {
  return typeof v === "string" &&
    (MODEL_ALIASES as readonly string[]).includes(v)
    ? (v as ModelAlias)
    : undefined;
}

function extractModelsKey(raw: unknown, key: string): ModelAlias | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const models = (raw as Record<string, unknown>).models;
  if (typeof models !== "object" || models === null) return undefined;
  return asModelAlias((models as Record<string, unknown>)[key]);
}

/**
 * The configured `models.<phase>` when it is a valid alias, else `undefined`.
 * Never throws — a missing/corrupt config or any non-alias value collapses to
 * `undefined` through the boundary reader's `catch` + the enum guard. The
 * caller applies its own precedence fallback.
 */
export function readPhaseModel(
  phase: string,
  read: ReadConfigFile = defaultReadConfigFile,
): ModelAlias | undefined {
  return extractModelsKey(read(), phase);
}

/**
 * The configured whole-session default `models.default` when it is a valid
 * alias, else `undefined`. Consumed at launch by `feature.ts` / `epic.ts` as
 * the `--model` fallback (the flag, when present, wins). Never throws.
 */
export function readDefaultModel(
  read: ReadConfigFile = defaultReadConfigFile,
): ModelAlias | undefined {
  return extractModelsKey(read(), "default");
}

/**
 * Best-effort, non-fatal warnings for any `models.<key>` that is present but
 * not a valid alias (default or per-phase). Callers print these to stderr at
 * create time then fall back — a present-but-invalid config value silently
 * collapsing to `undefined` would otherwise be an easy foot-gun. Never throws;
 * an unreadable or malformed config yields an empty list.
 */
export function collectModelConfigWarnings(
  read: ReadConfigFile = defaultReadConfigFile,
): string[] {
  const raw = read();
  if (typeof raw !== "object" || raw === null) return [];
  const models = (raw as Record<string, unknown>).models;
  if (typeof models !== "object" || models === null) return [];
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(
    models as Record<string, unknown>,
  )) {
    if (value === undefined) continue;
    if (asModelAlias(value) === undefined) {
      warnings.push(
        `models.${key}: '${String(value)}' is not a valid model alias ` +
          `(expected one of: ${MODEL_ALIASES.join(", ")}); ignoring.`,
      );
    }
  }
  return warnings;
}
