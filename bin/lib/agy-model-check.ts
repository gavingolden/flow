/**
 * Pure helpers for `flow doctor`'s check that every agy model flow is
 * configured to use is still offered by `agy models`.
 */

import {
  DELEGATE_MODEL_DEFAULTS,
  extractDelegateModelsKey,
  type DelegateSurface,
} from "./delegate-models";

export type ConfiguredModel = { surface: string; model: string };

const nonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

// Resolves without `resolveDelegateModel` so a doctor run never emits its
// once-per-process "config override active" stderr notice.
export function configuredAgyModels(raw: unknown): ConfiguredModel[] {
  const out: ConfiguredModel[] = [];
  for (const surface of Object.keys(DELEGATE_MODEL_DEFAULTS)) {
    const override = extractDelegateModelsKey(raw, surface);
    const model = nonEmptyString(override)
      ? override
      : DELEGATE_MODEL_DEFAULTS[surface as DelegateSurface];
    if (model !== null) out.push({ surface, model });
  }
  const research =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>).research
      : undefined;
  if (typeof research === "object" && research !== null) {
    for (const key of ["model", "refuteModel"] as const) {
      const value = (research as Record<string, unknown>)[key];
      if (nonEmptyString(value)) {
        out.push({ surface: `research.${key}`, model: value });
      }
    }
  }
  return out;
}

// `agy models` prints a progress line, then one `<slug>\t<Display Name>` row
// per model (same row shape as doctor-agy's countModelRows).
export function parseAgyModelNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!/^[\w.-]+\t\S/.test(line)) continue;
    names.add(line.slice(line.indexOf("\t") + 1).trim());
  }
  return names;
}

export function missingAgyModels(
  configured: ConfiguredModel[],
  listed: Set<string>,
): ConfiguredModel[] {
  return configured.filter((c) => !listed.has(c.model));
}
