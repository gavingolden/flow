/**
 * "N decisions made for you since you last looked": a count over the manager
 * decision log, limited to in-scope slugs plus slug-less lines (a budget
 * alert names no pipeline). `digest-seen.json` holds the owner's last look.
 */

import * as fs from "node:fs";
import { managerFile, managerHome, writeJsonAtomic } from "./manager-home";
import { readManagerLog } from "./manager-log";

export const DIGEST_KINDS: ReadonlySet<string> = new Set([
  "manager-decision",
  "exec-decision",
  "ruling-written",
  "budget-alert",
]);

export function readDigestSeen(home: string = managerHome()): string | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(managerFile("digest-seen.json", home), "utf8"),
    ) as { at?: unknown };
    return typeof v.at === "string" ? v.at : null;
  } catch {
    return null;
  }
}

export function digestSince(
  since: string | null,
  opts: { home?: string; inScopeSlug: (slug: string) => boolean },
): { count: number; byKind: Record<string, number> } {
  const cut = since === null ? 0 : Date.parse(since);
  const byKind: Record<string, number> = {};
  let count = 0;
  for (const e of readManagerLog({}, opts.home)) {
    if (!DIGEST_KINDS.has(e.kind)) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t <= cut) continue;
    if (e.slug !== undefined && !opts.inScopeSlug(e.slug)) continue;
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    count++;
  }
  return { count, byKind };
}

export function markSeen(now: Date, home: string = managerHome()): void {
  writeJsonAtomic(managerFile("digest-seen.json", home), {
    version: 1,
    at: now.toISOString(),
  });
}
