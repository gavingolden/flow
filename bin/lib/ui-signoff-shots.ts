/**
 * Adapts the review-time driver's `capture` item results to the section-shot
 * shape the critic pipeline (`selectGallery`, `buildCritiquePrompt`,
 * `validateFindings`) already keys on. The item results only carry bare
 * screenshot paths, so the missing fields come from naming conventions: the
 * section is the sign-off item's text, the viewport follows the `-390` /
 * `-1280` filename suffix, and the route comes from the matching
 * `fix_context` entry.
 */
import {
  isEvidencePath,
  type SectionShot,
  type UiDriverItemResult,
} from "./ui-driver-schema";

export const SIGNOFF_ROUTE = "(sign-off)";

function viewportOf(shotPath: string): SectionShot["viewport"] {
  return /-390\.[a-z]+$/i.test(shotPath) ? "phone" : "desktop";
}

export function itemCapturesToShots(
  itemResults: UiDriverItemResult[],
  fixContext: { item?: string; route: string }[] = [],
): SectionShot[] {
  const out: SectionShot[] = [];
  for (const r of itemResults) {
    if (r.kind !== "capture" || r.verdict !== "captured") continue;
    const route =
      fixContext.find((c) => c.item === r.item)?.route ?? SIGNOFF_ROUTE;
    for (const p of r.screenshots) {
      if (!isEvidencePath(p)) continue;
      out.push({
        route,
        section: r.item,
        viewport: viewportOf(p),
        part: "whole",
        path: p,
      });
    }
  }
  return out;
}
