/**
 * Builds the validated `ConfigModels` table `resolveRouting` consumes from
 * `~/.flow/config.json`. One implementation shared by `flow config models`,
 * `flow-review-model`, `flow-agy-lenses` and `flow-spawn-effort` so the flat
 * `CONFIG_KEYS` grains and the nested `reviewLenses` grain are folded the
 * same way everywhere.
 *
 * Lives beside (not inside) `models-config.ts`: it needs `CONFIG_KEYS` from
 * `model-routing-table.ts`, which itself imports `models-config.ts` — putting
 * it in `models-config.ts` would create an import cycle.
 */

import {
  cachedConfigRead,
  defaultReadConfigFile,
  readPhaseModel,
  readReviewLensModel,
  REVIEW_LENS_NAMES,
  type ReadConfigFile,
} from "./models-config";
import { CONFIG_KEYS, type ConfigModels } from "./model-routing-table";
import type { ModelAlias } from "./state";

export function readConfigModels(
  read: ReadConfigFile = defaultReadConfigFile,
): ConfigModels {
  // One parse of the config file across every grain read below.
  const cached = cachedConfigRead(read);
  const config: ConfigModels = {};
  for (const key of CONFIG_KEYS) {
    config[key] = readPhaseModel(key, cached);
  }
  // Nested grain, kept out of CONFIG_KEYS (see model-routing-table.ts's
  // `fineGrainAbove` doc comment) — read one lens at a time.
  const reviewLenses: Partial<Record<string, ModelAlias>> = {};
  for (const lens of REVIEW_LENS_NAMES) {
    const v = readReviewLensModel(lens, cached);
    if (v) reviewLenses[lens] = v;
  }
  config.reviewLenses = reviewLenses;
  return config;
}
