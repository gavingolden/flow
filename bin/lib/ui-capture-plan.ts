/**
 * Pure planner for the deterministic UI capture: which viewports to
 * photograph and where each shot lives. The dark viewports are planned only
 * when the page probe reports a dark scheme, so an app with no dark mode gets
 * no duplicate light shots labelled dark.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

import { SECTION_SHOTS_MAX_ENTRIES } from "./ui-driver-schema";

import { MAX_REVIEW_TARGETS, type UiReviewTarget } from "./ui-review-scope";

export type CaptureViewport = {
  name: "phone" | "phone-dark" | "desktop" | "desktop-dark";
  width: number;
  height: number;
  colorScheme: "light" | "dark";
  mobile: boolean;
};

export const MAX_SECTIONS_PER_VIEW = 6;
export const MAX_CAPTURE_SHOTS = SECTION_SHOTS_MAX_ENTRIES;

const PHONE = { width: 390, height: 844, mobile: true } as const;
const DESKTOP = { width: 1280, height: 800, mobile: false } as const;

/**
 * Filename stem for a route. The stem is lossy (everything non-alphanumeric
 * collapses to `-`, `?`/`#` are dropped, long routes are cut), so whenever
 * `"/" + stem.replace(/-/g, "/")` does not give the exact route back, a short
 * hash of the full route is appended and two distinct targets never share a
 * file.
 */
export function routeSlug(route: string): string {
  const bare = route.replace(/[?#].*$/, "");
  const full = bare.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const s = full.slice(0, 40);
  const stem = s === "" ? "root" : s;
  const roundTrip = stem === "root" ? "/" : `/${stem.replace(/-/g, "/")}`;
  const ambiguous = full.length > 40 || roundTrip !== route;
  return ambiguous
    ? `${stem}-${createHash("sha1").update(route).digest("hex").slice(0, 6)}`
    : stem;
}

export function planCapture(
  targets: UiReviewTarget[],
  evidenceDir: string,
  hasDarkScheme: boolean,
): {
  viewports: CaptureViewport[];
  shotPath: (
    route: string,
    n: number,
    vp: string,
    part: "whole" | "start" | "end",
  ) => string;
  maxSectionsPerView: number;
  maxShots: number;
  /** Shots one target may take, so a later target is never starved. */
  maxShotsPerTarget: number;
} {
  const viewports: CaptureViewport[] = [
    { name: "phone", ...PHONE, colorScheme: "light" },
    ...(hasDarkScheme
      ? [{ name: "phone-dark", ...PHONE, colorScheme: "dark" } as const]
      : []),
    { name: "desktop", ...DESKTOP, colorScheme: "light" },
    ...(hasDarkScheme
      ? [{ name: "desktop-dark", ...DESKTOP, colorScheme: "dark" } as const]
      : []),
  ];
  const count = Math.max(1, Math.min(targets.length, MAX_REVIEW_TARGETS));
  return {
    viewports,
    shotPath: (route, n, vp, part) =>
      path.join(
        evidenceDir,
        `${routeSlug(route)}-${n}-${vp}${part === "whole" ? "" : `-${part}`}.png`,
      ),
    maxSectionsPerView: MAX_SECTIONS_PER_VIEW,
    maxShots: MAX_CAPTURE_SHOTS,
    maxShotsPerTarget: Math.floor(MAX_CAPTURE_SHOTS / count),
  };
}
