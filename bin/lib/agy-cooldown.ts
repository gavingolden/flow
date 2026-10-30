/**
 * Cooldown marker for the Google-plan (agy) delegation path. When EVERY
 * agy-routed lens in one delegated wave fails for a reason that spent quota
 * (the signature of exhausted or throttled quota), the marker holds all
 * delegated review lenses and the delegated scout on Claude for
 * AGY_COOLDOWN_MINUTES, so a dry quota window costs one failed attempt, not
 * one per review. When agy's quota error names its reset ("Resets in
 * 4h44m12s" — Ultra windows are five hours), the marker holds until then
 * instead, so a dry window is not retried, and failed, every hour.
 *
 * A content-filter refusal proves the Google plan answered, so it is never a
 * quota signal: it is ignored when deciding, arms only next to a real
 * quota-exhausted or rate-limited sibling, and a wave that is nothing but
 * refusals (or refusals plus timeout/unknown/empty-artifact) never arms.
 *
 * The marker lives in `FLOW_CACHE_DIR`, NOT `~/.flow/state/`: that directory
 * is the pipeline-state store, and a `<slug>.json` there is read as a
 * pipeline named `agy-cooldown`. Concurrent pipelines share it, so the write
 * is atomic (sibling temp file + rename) and an unparseable or absent marker
 * reads as not-live.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_CACHE_DIR } from "./paths";

export const AGY_COOLDOWN_MINUTES = 60;

// Just over agy's five-hour Ultra window: a malformed or hostile "Resets in
// 99999h" string must not disable delegation indefinitely.
export const AGY_COOLDOWN_MAX_MS = 6 * 3_600_000;

// Dispatched failure classes (bin/lib/agy-failure-class.ts) that may have
// spent quota. Environment skips (agy-not-found, model-unavailable, auth,
// spawn-failed, canceled) never arm: a "Google plan cooling down" message
// would misreport them.
export const COOLDOWN_ARMING_CLASSES: readonly string[] = [
  "quota-exhausted",
  "rate-limited",
  "timeout",
  "empty-artifact",
  "unknown",
];

export const defaultCooldownFile = (): string =>
  path.join(FLOW_CACHE_DIR, "agy-cooldown.json");

export function readCooldown(
  now: Date = new Date(),
  file: string = defaultCooldownFile(),
): { live: boolean; until?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      until?: unknown;
    };
    if (typeof parsed.until !== "string") return { live: false };
    const untilMs = Date.parse(parsed.until);
    if (Number.isNaN(untilMs) || untilMs <= now.getTime()) {
      return { live: false };
    }
    return { live: true, until: parsed.until };
  } catch {
    return { live: false };
  }
}

export function shouldArmCooldown(classes: string[]): boolean {
  const rest = classes.filter((c) => c !== "content-filtered");
  if (
    rest.length === 0 ||
    !rest.every((c) => COOLDOWN_ARMING_CLASSES.includes(c))
  ) {
    return false;
  }
  return (
    rest.length === classes.length ||
    rest.some((c) => c === "quota-exhausted" || c === "rate-limited")
  );
}

// Longest "Resets in [Nh][Nm][Ns]" across agy failure texts, in ms; null
// when none names a reset.
export function quotaResetMs(texts: Array<string | undefined>): number | null {
  let best: number | null = null;
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(/Resets in ((?:\d+[hms])+)/g)) {
      let ms = 0;
      for (const [, n, u] of m[1]!.matchAll(/(\d+)([hms])/g)) {
        ms += Number(n) * (u === "h" ? 3_600_000 : u === "m" ? 60_000 : 1_000);
      }
      if (ms > 0 && (best === null || ms > best)) best = ms;
    }
  }
  return best === null ? null : Math.min(best, AGY_COOLDOWN_MAX_MS);
}

export function armCooldown(
  classes: string[],
  now: Date = new Date(),
  file: string = defaultCooldownFile(),
  resetMs: number | null = null,
): void {
  const until = new Date(
    now.getTime() + (resetMs ?? AGY_COOLDOWN_MINUTES * 60_000),
  );
  // Never shorten a hold: a concurrent pipeline's default window must not
  // replace another's longer quota-reset hold. The longer record is kept as-is.
  try {
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as {
      until?: unknown;
    };
    const existingMs =
      typeof existing.until === "string" ? Date.parse(existing.until) : NaN;
    if (!Number.isNaN(existingMs) && existingMs >= until.getTime()) return;
  } catch {
    // missing or unparseable marker: arm normally
  }
  const record = {
    armed_at: now.toISOString(),
    until: until.toISOString(),
    classes,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
