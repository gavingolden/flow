/**
 * The single model/effort resolver for the epic manager and every later
 * executive call. Precedence: typed flag > `config.models.manager` /
 * `config.efforts.manager` > the opus/high default. `featureFallback` carries
 * ONLY the typed flags — config and the default govern the manager's own
 * model calls, never a feature's unhinted launch, so `config.models.default`
 * still applies to features.
 */

import { readEffortsConfig } from "./efforts-config";
import { defaultReadConfigFile, readPhaseModel } from "./models-config";
import type { ReadConfigFile } from "./models-config";
import type { EffortLevel, ModelAlias } from "./state";

export const MANAGER_DEFAULT_MODEL: ModelAlias = "opus";
export const MANAGER_DEFAULT_EFFORT: EffortLevel = "high";

export type ManagerModelEffort = {
  model: ModelAlias;
  effort: EffortLevel;
  featureFallback: { model?: ModelAlias; effort?: EffortLevel };
};

export function resolveManagerModelEffort(input: {
  flagModel?: ModelAlias;
  flagEffort?: EffortLevel;
  read?: ReadConfigFile;
}): ManagerModelEffort {
  const read = input.read ?? defaultReadConfigFile;
  const configEffort = readEffortsConfig(read).manager;
  return {
    model:
      input.flagModel ??
      readPhaseModel("manager", read) ??
      MANAGER_DEFAULT_MODEL,
    effort:
      input.flagEffort ??
      (typeof configEffort === "string" ? configEffort : undefined) ??
      MANAGER_DEFAULT_EFFORT,
    featureFallback: {
      ...(input.flagModel ? { model: input.flagModel } : {}),
      ...(input.flagEffort ? { effort: input.flagEffort } : {}),
    },
  };
}
