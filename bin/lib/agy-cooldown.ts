/**
 * Cooldown marker for the Google-plan (agy) delegation path. When EVERY
 * agy-routed lens in one delegated wave fails for a reason that spent quota
 * (the signature of exhausted or throttled quota), the marker holds all
 * delegated review lenses and the delegated scout on Claude for
 * AGY_COOLDOWN_MINUTES, so a dry quota window costs one failed attempt, not
 * one per review.
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
  return (
    classes.length > 0 &&
    classes.every((c) => COOLDOWN_ARMING_CLASSES.includes(c))
  );
}

export function armCooldown(
  classes: string[],
  now: Date = new Date(),
  file: string = defaultCooldownFile(),
): void {
  const until = new Date(now.getTime() + AGY_COOLDOWN_MINUTES * 60_000);
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
