/**
 * One model source for the epic manager / executive: flag > config
 * (`models.manager`, `efforts.manager`) > `opus` / `high`.
 *
 * `featureFallback` carries ONLY the explicitly passed flags (it fills a
 * launched feature's missing manifest hint); config and the built-in default
 * never land in it. The executive reads only `model` / `effort`.
 */

import {
  readPhaseModel,
  defaultReadConfigFile,
  type ReadConfigFile,
  extractTableKey,
} from "./models-config";
import { EFFORT_LEVELS, type EffortLevel, type ModelAlias } from "./state";

export const MANAGER_DEFAULT_MODEL: ModelAlias = "opus";
export const MANAGER_DEFAULT_EFFORT: EffortLevel = "high";

function asEffort(v: unknown): EffortLevel | undefined {
  return typeof v === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(v)
    ? (v as EffortLevel)
    : undefined;
}

export function resolveManagerModelEffort(
  input: {
    flagModel?: ModelAlias;
    flagEffort?: EffortLevel;
    read?: ReadConfigFile;
  } = {},
): {
  model: ModelAlias;
  effort: EffortLevel;
  featureFallback: { model?: ModelAlias; effort?: EffortLevel };
} {
  const read = input.read ?? defaultReadConfigFile;
  const configModel = readPhaseModel("manager", read);
  const configEffort = extractTableKey(read(), "efforts", "manager", asEffort);
  const featureFallback: { model?: ModelAlias; effort?: EffortLevel } = {};
  if (input.flagModel) featureFallback.model = input.flagModel;
  if (input.flagEffort) featureFallback.effort = input.flagEffort;
  return {
    model: input.flagModel ?? configModel ?? MANAGER_DEFAULT_MODEL,
    effort: input.flagEffort ?? configEffort ?? MANAGER_DEFAULT_EFFORT,
    featureFallback,
  };
}
