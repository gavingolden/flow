/**
 * Tolerant boundary reader for `~/.flow/config.json`'s `efforts` table — the
 * per-sub-agent effort counterpart of `models-config.ts`.
 *
 * Same seam and discipline: reads through the injectable `ReadConfigFile`,
 * and collapses anything unreadable / malformed / out-of-enum to "absent".
 * The precedence chain is owned by `resolveSpawnEffort`
 * (`model-routing-table.ts`); this module only validates what the user wrote.
 *
 * Keys are per-role only (the same names as `models.*`, plus the nested
 * `reviewLenses.<lens>`). The `models.review` / `models.implement` group
 * grains are deliberately NOT read here — they are warned about as
 * unsupported so a user who knows the `models.*` shape is told why.
 *
 * `EFFORT_LEVELS` is reused from `state.ts`; do not re-declare it.
 */

import {
  collectReviewLensWarnings,
  defaultReadConfigFile,
  extractNestedTableKey,
  extractTableKey,
  REVIEW_LENS_NAMES,
  type ReadConfigFile,
} from "./models-config";
import { EFFORT_LEVELS, type EffortLevel } from "./state";

/** Validated `config.efforts` table: flat role keys plus nested `reviewLenses`. */
export type ConfigEfforts = Partial<
  Record<string, EffortLevel | Partial<Record<string, EffortLevel>>>
>;

/** Flat `efforts.<key>` role keys, named like their `models.*` counterparts. */
export const EFFORT_CONFIG_KEYS: readonly string[] = [
  "planning",
  "scout",
  "coder",
  "fixApplier",
  "uiDriver",
  "consolidator",
  "mergeResolver",
  "manager",
];

const UNSUPPORTED_GROUP_KEYS: readonly string[] = ["review", "implement"];

function asEffortLevel(v: unknown): EffortLevel | undefined {
  return typeof v === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(v)
    ? (v as EffortLevel)
    : undefined;
}

export function readEffortsConfig(
  read: ReadConfigFile = defaultReadConfigFile,
): ConfigEfforts {
  const raw = read();
  const efforts: ConfigEfforts = {};
  for (const key of EFFORT_CONFIG_KEYS) {
    const v = extractTableKey(raw, "efforts", key, asEffortLevel);
    if (v) efforts[key] = v;
  }
  const reviewLenses: Partial<Record<string, EffortLevel>> = {};
  for (const lens of REVIEW_LENS_NAMES) {
    const v = extractNestedTableKey(
      raw,
      "efforts",
      "reviewLenses",
      lens,
      asEffortLevel,
    );
    if (v) reviewLenses[lens] = v;
  }
  if (Object.keys(reviewLenses).length > 0) efforts.reviewLenses = reviewLenses;
  return efforts;
}

/**
 * Non-fatal warnings for present-but-unusable `efforts.*` values: an invalid
 * level, an unknown key, an unsupported group key (`review` / `implement`),
 * an unknown lens, or a non-object `reviewLenses`. Never throws; an
 * unreadable or malformed config yields an empty list.
 */
export function collectEffortConfigWarnings(
  read: ReadConfigFile = defaultReadConfigFile,
): string[] {
  const raw = read();
  if (typeof raw !== "object" || raw === null) return [];
  const efforts = (raw as Record<string, unknown>).efforts;
  if (efforts === undefined) return [];
  if (
    typeof efforts !== "object" ||
    efforts === null ||
    Array.isArray(efforts)
  ) {
    return [
      "efforts: expected an object mapping role to effort level; ignoring.",
    ];
  }
  const effortsObj = efforts as Record<string, unknown>;
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(effortsObj)) {
    if (value === undefined || key === "reviewLenses") continue;
    if (UNSUPPORTED_GROUP_KEYS.includes(key)) {
      warnings.push(
        `efforts.${key}: group keys are not supported; use per-role keys ` +
          `(${EFFORT_CONFIG_KEYS.join(", ")}, reviewLenses.<lens>); ignoring.`,
      );
      continue;
    }
    if (!EFFORT_CONFIG_KEYS.includes(key)) {
      warnings.push(
        `efforts.${key}: unknown key (expected one of: ` +
          `${EFFORT_CONFIG_KEYS.join(", ")}, reviewLenses); ignoring.`,
      );
      continue;
    }
    if (asEffortLevel(value) === undefined) {
      warnings.push(
        `efforts.${key}: '${String(value)}' is not a valid effort level ` +
          `(expected one of: ${EFFORT_LEVELS.join(", ")}); ignoring.`,
      );
    }
  }
  warnings.push(
    ...collectReviewLensWarnings(
      "efforts",
      effortsObj.reviewLenses,
      (v) => asEffortLevel(v) !== undefined,
      "effort level",
      EFFORT_LEVELS,
    ),
  );
  return warnings;
}
