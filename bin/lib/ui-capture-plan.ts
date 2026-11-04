/**
 * Pure planner for the deterministic UI capture: which viewports to
 * photograph and where each shot lives. The dark viewports are planned only
 * when the page probe reports a dark scheme, so an app with no dark mode gets
 * no duplicate light shots labelled dark.
 */
import * as path from "node:path";

import { MAX_REVIEW_TARGETS, type UiReviewTarget } from "./ui-review-scope";

export type CaptureViewport = {
  name: "phone" | "phone-dark" | "desktop" | "desktop-dark";
  width: number;
  height: number;
  colorScheme: "light" | "dark";
  mobile: boolean;
};

export const MAX_SECTIONS_PER_VIEW = 6;
// The driver-artifact schema's section_shots cap.
export const MAX_CAPTURE_SHOTS = 48;

const PHONE = { width: 390, height: 844, mobile: true } as const;
const DESKTOP = { width: 1280, height: 800, mobile: false } as const;

export function routeSlug(route: string): string {
  const s = route
    .replace(/[?#].*$/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s === "" ? "root" : s;
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
