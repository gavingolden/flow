/**
 * Which section screenshots reach the critic. Split from `ui-critique.ts`
 * (already over the file-size target) so the selection rule lives with its
 * own tests.
 */
import type { SectionShot } from "./ui-driver-schema";

export const GALLERY_MAX_SHOTS = 24;

/**
 * Keeps whole sections (every viewport and start/end part together) and fills
 * the cap round-robin across target routes, so a target listed last is never
 * starved by an earlier one with many sections. Once a section does not fit,
 * it and every later one are dropped, so the dark shots of a kept section are
 * never cut off.
 */
export function selectGallery(
  shots: SectionShot[],
  max: number = GALLERY_MAX_SHOTS,
): { shots: SectionShot[]; omittedSections: number } {
  const byRoute = new Map<string, Map<string, SectionShot[]>>();
  for (const s of shots) {
    let sections = byRoute.get(s.route);
    if (!sections) byRoute.set(s.route, (sections = new Map()));
    const g = sections.get(s.section);
    if (g) g.push(s);
    else sections.set(s.section, [s]);
  }
  const queues = [...byRoute.values()].map((m) => [...m.values()]);
  const total = queues.reduce((n, q) => n + q.length, 0);

  const kept: SectionShot[] = [];
  let keptSections = 0;
  let full = false;
  for (let depth = 0; !full; depth++) {
    let any = false;
    for (const q of queues) {
      if (depth >= q.length) continue;
      any = true;
      if (kept.length + q[depth].length > max) {
        full = true;
        break;
      }
      kept.push(...q[depth]);
      keptSections++;
    }
    if (!any) break;
  }
  if (kept.length === 0 && shots.length > 0) {
    const first = queues[0][0];
    return { shots: first.slice(0, max), omittedSections: total - 1 };
  }
  return { shots: kept, omittedSections: total - keptSections };
}
