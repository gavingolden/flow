/**
 * Tolerant boundary reader for `~/.flow/config.json`'s `launch` table.
 *
 * Structural clone of `models-config.ts`: reads the same
 * `~/.flow/config.json` off `flowConfigPath()` through an injectable
 * `ReadConfigFile` seam (so tests never touch the real file), and collapses
 * anything unreadable / malformed / wrong-typed / out-of-enum to `undefined`.
 * Never throws.
 *
 * The precedence chain is owned by the caller: explicit CLI flag `//`
 * `launch.<key>` config `//` built-in default — resolved once at launch
 * (`feature.ts` / `epic.ts`) onto `PipelineState`, never re-read at
 * point-of-use, so a mid-run config edit cannot change a running pipeline.
 */

import { EFFORT_LEVELS, type EffortLevel, type PipelineState } from "./state";
import { defaultReadConfigFile, type ReadConfigFile } from "./models-config";

export type { ReadConfigFile } from "./models-config";

export type LaunchDefaults = {
  effort?: EffortLevel;
  autoMerge?: boolean;
  waitForCopilot?: boolean;
  forceResearch?: boolean;
  interviewMode?: "force" | "skip";
};

type LaunchConfigKey = {
  key: keyof LaunchDefaults;
  stateField: keyof PipelineState & string;
  kind: "enum" | "boolean";
  values?: readonly string[];
};

export const LAUNCH_CONFIG_KEYS = [
  { key: "effort", stateField: "effort", kind: "enum", values: EFFORT_LEVELS },
  { key: "autoMerge", stateField: "autoMerge", kind: "boolean" },
  { key: "waitForCopilot", stateField: "waitForCopilot", kind: "boolean" },
  { key: "forceResearch", stateField: "forceResearch", kind: "boolean" },
  {
    key: "interviewMode",
    stateField: "interviewMode",
    kind: "enum",
    values: ["force", "skip"],
  },
] as const satisfies readonly LaunchConfigKey[];

type LaunchTableResult =
  | { present: false }
  | { present: true; valid: false }
  | { present: true; valid: true; table: Record<string, unknown> };

/**
 * Distinguishes an absent `launch` key (no warning — mirrors `models-config`
 * treating an absent `models` key as normal) from a present-but-wrong-typed
 * one (null / array / non-object — warns once).
 */
function readLaunchTable(raw: unknown): LaunchTableResult {
  if (typeof raw !== "object" || raw === null) return { present: false };
  const launch = (raw as Record<string, unknown>).launch;
  if (launch === undefined) return { present: false };
  if (typeof launch !== "object" || launch === null || Array.isArray(launch))
    return { present: true, valid: false };
  return {
    present: true,
    valid: true,
    table: launch as Record<string, unknown>,
  };
}

function extractLaunchTable(raw: unknown): Record<string, unknown> | undefined {
  const result = readLaunchTable(raw);
  return result.present && result.valid ? result.table : undefined;
}

function readValue(
  launch: Record<string, unknown>,
  entry: (typeof LAUNCH_CONFIG_KEYS)[number],
): unknown {
  const v = launch[entry.key];
  if (entry.kind === "boolean") {
    return typeof v === "boolean" ? v : undefined;
  }
  return typeof v === "string" &&
    (entry.values as readonly string[]).includes(v)
    ? v
    : undefined;
}

/**
 * Resolved `launch.<key>` defaults, one per `LAUNCH_CONFIG_KEYS` row. Calls
 * `read()` exactly once and walks the key list in memory — never re-reads
 * the config file per key (the ~10x-reread foot-gun `config-models.ts`
 * already learned from).
 */
export function readLaunchDefaults(
  read: ReadConfigFile = defaultReadConfigFile,
): LaunchDefaults {
  let raw: unknown;
  try {
    raw = read();
  } catch {
    return {};
  }
  const launch = extractLaunchTable(raw);
  if (launch === undefined) return {};
  const result: LaunchDefaults = {};
  for (const entry of LAUNCH_CONFIG_KEYS) {
    const value = readValue(launch, entry);
    if (value !== undefined) {
      (result as Record<string, unknown>)[entry.key] = value;
    }
  }
  return result;
}

/**
 * Best-effort, non-fatal warnings for any `launch.<key>` that is present but
 * not validly typed/enum-membered, plus the legacy `interview.enabled`
 * migration warning. Never throws; an unreadable or malformed config yields
 * an empty list.
 */
export function collectLaunchConfigWarnings(
  read: ReadConfigFile = defaultReadConfigFile,
): string[] {
  let raw: unknown;
  try {
    raw = read();
  } catch {
    return [];
  }
  const warnings: string[] = [];
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as Record<string, unknown>).interview === "object" &&
    (raw as Record<string, unknown>).interview !== null &&
    "enabled" in
      ((raw as Record<string, unknown>).interview as Record<string, unknown>)
  ) {
    warnings.push(
      'interview.enabled is retired; move it to launch.interviewMode: "skip"',
    );
  }
  const launchResult = readLaunchTable(raw);
  if (!launchResult.present) return warnings;
  if (!launchResult.valid) {
    warnings.push(
      "launch: expected an object mapping setting name to value; ignoring.",
    );
    return warnings;
  }
  const launch = launchResult.table;
  for (const entry of LAUNCH_CONFIG_KEYS) {
    const rawValue = launch[entry.key];
    if (rawValue === undefined) continue;
    if (readValue(launch, entry) === undefined) {
      const expected =
        entry.kind === "boolean"
          ? "a boolean"
          : `one of: ${(entry.values as readonly string[]).join(", ")}`;
      warnings.push(
        `launch.${entry.key}: '${String(rawValue)}' is not valid (expected ${expected}); ignoring.`,
      );
    }
  }
  return warnings;
}
