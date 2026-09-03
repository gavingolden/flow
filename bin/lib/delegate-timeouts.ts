/**
 * Tolerant per-surface resolver for `~/.flow/config.json`'s
 * `delegate.timeouts` table, mirroring `delegate-models.ts`'s shape.
 *
 * A sync delegate call (`flow-gemini-lens`, `flow-gemini-intent-guess`)
 * runs inside a Bash tool call that itself pins a 600000ms/10m timeout
 * (`skills/pipeline/flow-pr-review/SKILL.md`,
 * `skills/pipeline/flow-pr-review/references/intent-mismatch-resolution.md`).
 * A configured `agy --print-timeout` at or above that ceiling means the
 * Bash tool kills the helper first and the caller never sees an envelope
 * at all — a worse misclassification than the one this module exists to
 * fix. `SYNC_DELEGATE_CEILING` ("9m") leaves a minute of slack for bun
 * startup + the agy spawn itself, and `resolveDelegateTimeout` always
 * warns before silently clamping down to it.
 *
 * Reuses `models-config.ts`'s `ReadConfigFile` / `defaultReadConfigFile`
 * seam (tolerant boundary read, injectable for tests) — same precedent as
 * `delegate-models.ts`.
 *
 * `godurToSec` here is the SINGLE owner of Go-duration-string parsing:
 * `bin/flow-plan-review.ts` imports it rather than keeping its own
 * narrower (m/s-only) copy, per the plan's Task 2 correction — a
 * `bin/lib/*` module must never import back from a top-level `bin/*.ts`
 * helper, so the reverse direction was not an option.
 */

import { defaultReadConfigFile, type ReadConfigFile } from "./models-config";

export type DelegateTimeoutSurface = "reviewLens" | "intentGuess";

export const DELEGATE_TIMEOUT_DEFAULTS: Record<DelegateTimeoutSurface, string> =
  {
    reviewLens: "8m",
    intentGuess: "5m",
  };

export const SYNC_DELEGATE_CEILING = "9m";

// Go-duration grammar: one or more `<number><unit>` pairs, unit one of
// ns/us/µs/ms/s/m/h (e.g. "3m", "90s", "2m30s", "1.5h"). No unit repeats
// validation beyond the regex itself — callers only ever feed short
// hand-authored strings, not machine-generated durations.
const GO_DURATION = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

export function isGoDuration(value: string): boolean {
  return GO_DURATION.test(value.trim());
}

const UNIT_SECONDS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  µs: 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
};

const GO_DURATION_TERM = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;

// Throws on anything that fails `isGoDuration` — this module is the single
// owner of Go-duration parsing (see module docstring); every caller either
// pre-validates with `isGoDuration` or, like `flow-plan-review.ts`'s
// existing call sites, only ever feeds it its own hardcoded constants, so a
// throw here is a programmer error, not a runtime input-validation path.
export function godurToSec(value: string): number {
  const trimmed = value.trim();
  if (!isGoDuration(trimmed)) {
    throw new Error(`invalid duration: "${value}"`);
  }
  let total = 0;
  GO_DURATION_TERM.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GO_DURATION_TERM.exec(trimmed))) {
    total += parseFloat(match[1]) * UNIT_SECONDS[match[2]]!;
  }
  return total;
}

// Fires at most once per surface per process, one set per warning kind —
// same "warn once, not once per call" discipline as delegate-models.ts's
// warnedOverrideSurfaces/warnedTypeSurfaces.
const warnedInvalidSurfaces = new Set<DelegateTimeoutSurface>();
const warnedOverrideSurfaces = new Set<DelegateTimeoutSurface>();
const warnedClampSurfaces = new Set<DelegateTimeoutSurface>();

function extractDelegateTimeoutsKey(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  const delegate = (raw as Record<string, unknown>).delegate;
  if (typeof delegate !== "object" || delegate === null) return undefined;
  const timeouts = (delegate as Record<string, unknown>).timeouts;
  if (typeof timeouts !== "object" || timeouts === null) return undefined;
  return (timeouts as Record<string, unknown>)[key];
}

/**
 * Resolves the `--print-timeout`-shaped godur string for a given delegate
 * surface: `delegate.timeouts.<surface>` from `~/.flow/config.json` when
 * present and a well-formed Go duration, else the seeded default. A
 * resolved value at or above `SYNC_DELEGATE_CEILING` is clamped down to it
 * (warn-and-clamp, never warn-and-pass — see module docstring). Never
 * throws — a missing file, malformed JSON, absent key, or non-godur value
 * all collapse to the default (warning on stderr once per surface).
 */
export function resolveDelegateTimeout(
  surface: DelegateTimeoutSurface,
  readConfigFile: ReadConfigFile = defaultReadConfigFile,
): string {
  const defaultValue = DELEGATE_TIMEOUT_DEFAULTS[surface];
  const raw = readConfigFile();
  const value = extractDelegateTimeoutsKey(raw, surface);

  if (value === undefined) return defaultValue;

  if (typeof value !== "string" || !isGoDuration(value)) {
    if (!warnedInvalidSurfaces.has(surface)) {
      warnedInvalidSurfaces.add(surface);
      console.error(
        `delegate.timeouts.${surface}: '${String(value)}' is not a valid Go-duration string; ignoring and using the default.`,
      );
    }
    return defaultValue;
  }

  const trimmed = value.trim();
  if (godurToSec(trimmed) > godurToSec(SYNC_DELEGATE_CEILING)) {
    if (!warnedClampSurfaces.has(surface)) {
      warnedClampSurfaces.add(surface);
      console.error(
        `delegate.timeouts.${surface}: '${trimmed}' exceeds the ${SYNC_DELEGATE_CEILING} sync ceiling (the Bash tool calls that run this surface pin a 600000ms timeout); clamping to ${SYNC_DELEGATE_CEILING}.`,
      );
    }
    return SYNC_DELEGATE_CEILING;
  }

  if (trimmed !== defaultValue && !warnedOverrideSurfaces.has(surface)) {
    warnedOverrideSurfaces.add(surface);
    console.error(
      `delegate.timeouts.${surface}: config override active -> ${trimmed}`,
    );
  }

  return trimmed;
}
