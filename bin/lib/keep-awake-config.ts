import { defaultReadConfigFile, type ReadConfigFile } from "./models-config";

export const KEEP_AWAKE_DEFAULT_MINUTES = 120;
export const KEEP_AWAKE_MIN_MINUTES = 30;
export const KEEP_AWAKE_MAX_MINUTES = 1440;

export type KeepAwakeLimit = { minutes: number; source: "config" | "built-in" };
export type KeepAwakeSettings = { enabled: boolean; maxSec: number };

function safeRead(read: ReadConfigFile): Record<string, unknown> {
  try {
    const raw = read();
    if (typeof raw !== "object" || raw === null) return {};
    const power = (raw as Record<string, unknown>).power;
    return typeof power === "object" && power !== null
      ? (power as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function limitFrom(power: Record<string, unknown>): KeepAwakeLimit {
  const n = power.keepAwakeMaxMinutes;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) {
    return {
      minutes: Math.min(
        KEEP_AWAKE_MAX_MINUTES,
        Math.max(KEEP_AWAKE_MIN_MINUTES, n),
      ),
      source: "config",
    };
  }
  return { minutes: KEEP_AWAKE_DEFAULT_MINUTES, source: "built-in" };
}

export function resolveKeepAwakeMaxMinutes(
  read: ReadConfigFile = defaultReadConfigFile,
): KeepAwakeLimit {
  return limitFrom(safeRead(read));
}

/** One read() feeds both fields so a sync sees a single config snapshot. */
export function readKeepAwakeSettings(
  read: ReadConfigFile = defaultReadConfigFile,
): KeepAwakeSettings {
  const power = safeRead(read);
  return {
    enabled: power.keepAwake !== false,
    maxSec: limitFrom(power).minutes * 60,
  };
}
