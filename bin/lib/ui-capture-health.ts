/**
 * The one rule for a "degraded" screenshot: taken while the app was
 * rate-limiting the page (a 429 that persisted below the request-storm
 * threshold). Such a shot shows an error state, not the page, so the judge
 * never sees it. Leaf module: type-only imports of the loop types.
 */
import type { LoopLog } from "./ui-critique";
import type { SectionShot } from "./ui-driver-schema";
import { REQUEST_STORM_MIN } from "./ui-viewport-findings";

export type DegradedSummary = {
  shots: number;
  of: number;
  unjudgedRoutes: string[];
};

type Shot = Pick<SectionShot, "failedRequests">;

export function isDegradedShot(s: Shot): boolean {
  return (s.failedRequests ?? []).some(
    (f) => f.status === 429 && f.count < REQUEST_STORM_MIN,
  );
}

export function usableShots<T extends Shot>(shots: T[]): T[] {
  return shots.filter((s) => !isDegradedShot(s));
}

export function summarizeDegraded(shots: SectionShot[]): DegradedSummary {
  const total = new Map<string, { all: number; bad: number }>();
  let shotsDegraded = 0;
  for (const s of shots) {
    const e = total.get(s.route) ?? { all: 0, bad: 0 };
    e.all++;
    if (isDegradedShot(s)) {
      e.bad++;
      shotsDegraded++;
    }
    total.set(s.route, e);
  }
  return {
    shots: shotsDegraded,
    of: shots.length,
    unjudgedRoutes: [...total]
      .filter(([, e]) => e.bad === e.all)
      .map(([route]) => route),
  };
}

export function degradedForOutcome(
  log: Pick<LoopLog, "outcome" | "captureDegraded">,
): DegradedSummary | null {
  const cd = log.captureDegraded;
  if (!cd) return null;
  if (log.outcome === "kept") return cd["post-round"] ?? null;
  return cd["round-0"] ?? null;
}

/** The accessibility snapshot is taken on the desktop page. */
export function degradedRoutesForSnapshots(shots: SectionShot[]): Set<string> {
  return new Set(
    shots
      .filter((s) => s.viewport === "desktop" && isDegradedShot(s))
      .map((s) => s.route),
  );
}
