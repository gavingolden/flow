/**
 * Pure rules for the design review: does a changed-files list need one, and
 * which pages should it photograph. The requirement is by file kind with no
 * size threshold — a 15-line change to one component is exactly what the
 * review exists for.
 *
 * Targets never come from a generic manifest-route fallback: that photographs
 * the right page in the wrong state. They are the plan's own
 * `## UI review targets`, then pages the diff's route files name.
 */
import { deriveRoutePatterns, deriveRoutes } from "./ui-route-infer";

export type UiReviewTarget = {
  route: string;
  state: string | null;
  source: "plan" | "route-file" | "manifest-match";
};

export const MAX_REVIEW_TARGETS = 3;

export const RENDER_EXTENSIONS = [
  ".svelte",
  ".tsx",
  ".jsx",
  ".vue",
  ".css",
  ".scss",
  ".sass",
  ".less",
];

// Svelte runes modules and route loaders change what renders without being
// component files, so each counts on its own.
const RUNES_SUFFIXES = [".svelte.ts", ".svelte.js"];
const LOADER_BASENAMES = new Set(
  ["+page", "+page.server", "+layout", "+layout.server"].flatMap((b) => [
    `${b}.ts`,
    `${b}.js`,
  ]),
);

// Paths that carry a render-bearing extension without rendering anything.
const EXCLUDED_MARKERS = [
  ".test.",
  ".spec.",
  ".stories.",
  "__tests__/",
  "__stubs__/",
  "__mocks__/",
  ".d.ts",
];

export function isExcludedFromUiReview(path: string): boolean {
  const lower = path.toLowerCase();
  return EXCLUDED_MARKERS.some((m) => lower.includes(m));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isRenderBearing(path: string): boolean {
  if (isExcludedFromUiReview(path)) return false;
  const lower = path.toLowerCase();
  const base = basename(lower);
  return (
    RENDER_EXTENSIONS.some((e) => lower.endsWith(e)) ||
    RUNES_SUFFIXES.some((e) => lower.endsWith(e)) ||
    LOADER_BASENAMES.has(base) ||
    base.startsWith("tailwind.config.")
  );
}

export function uiReviewRequired(changedFiles: string[]): {
  required: boolean;
  uiFiles: string[];
  ignored: string[];
} {
  const uiFiles = changedFiles.filter(isRenderBearing);
  return {
    required: uiFiles.length > 0,
    uiFiles,
    ignored: changedFiles.filter((f) => !isRenderBearing(f)),
  };
}

const TARGETS_HEADING = /^(#{1,6})\s+UI review targets\s*$/i;
const TARGET_LINE = /^\s*[-*]\s+`([^`]+)`\s*(?:[—–]|--?)?\s*(.*?)\s*$/;

export function hasUiReviewTargetsSection(planMd: string): boolean {
  return planMd.split("\n").some((l) => TARGETS_HEADING.test(l));
}

/** A same-origin path: `//host` and `/\host` would resolve to another host. */
export function isSafeRoute(route: string): boolean {
  return (
    route.startsWith("/") && !route.startsWith("//") && !route.includes("\\")
  );
}

// Plan lines name a path, but an absolute origin is tolerated and reduced to
// its path: base URLs carry per-run ports, so only the path is stable.
function normalizeRoute(raw: string): string | null {
  let route = raw.trim();
  if (/^https?:\/\//i.test(route)) {
    try {
      const u = new URL(route);
      route = u.pathname + u.search;
    } catch {
      return null;
    }
  }
  return isSafeRoute(route) ? route : null;
}

export function parseUiReviewTargets(planMd: string): UiReviewTarget[] {
  const lines = planMd.split("\n");
  const out: UiReviewTarget[] = [];
  let level = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s/.exec(line);
    if (level === 0) {
      const m = TARGETS_HEADING.exec(line);
      if (m) level = m[1].length;
      continue;
    }
    if (heading && heading[1].length <= level) break;
    const m = TARGET_LINE.exec(line);
    if (!m) continue;
    const route = normalizeRoute(m[1]);
    if (route === null) continue;
    out.push({ route, state: m[2] === "" ? null : m[2], source: "plan" });
  }
  return out;
}

export function deriveReviewTargets(i: {
  changedFiles: string[];
  planTargets: UiReviewTarget[];
  manifestRoutes: string[];
}): UiReviewTarget[] {
  const matchers = deriveRoutePatterns(i.changedFiles);
  const candidates: UiReviewTarget[] = [
    ...i.planTargets,
    ...deriveRoutes(i.changedFiles).map(
      (route): UiReviewTarget => ({ route, state: null, source: "route-file" }),
    ),
    ...i.manifestRoutes
      .filter((route) => matchers.some((m) => m(route)))
      .map(
        (route): UiReviewTarget => ({
          route,
          state: null,
          source: "manifest-match",
        }),
      ),
  ];
  const seen = new Set<string>();
  const out: UiReviewTarget[] = [];
  for (const t of candidates) {
    if (seen.has(t.route)) continue;
    seen.add(t.route);
    out.push(t);
    if (out.length === MAX_REVIEW_TARGETS) break;
  }
  return out;
}
