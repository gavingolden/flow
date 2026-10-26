/**
 * Per-viewport findings fold for `flow-ui-validate` ASSEMBLE mode, plus the
 * `--compare` keep/revert decision between two ASSEMBLE outputs. Pure
 * TypeScript over numbers and strings the driver captured — no MCP, no DOM.
 */

import { HEURISTIC_THRESHOLDS, judgeHeuristics } from "./ui-heuristics";
import type { HeuristicsCapture } from "./ui-heuristics";
import type { UiValidationManifest } from "./ui-validation-schema";

export type RouteFindings = {
  path: string;
  ok: boolean;
  consoleErrors: string[];
  failedRequests: string[];
  missingSelectors: string[];
  /**
   * Per-viewport geometry failures (off-center constrained column, horizontal
   * overflow, missing-element-at-breakpoint), each naming the offending
   * viewport. Present (possibly empty) only on the per-viewport path; absent on
   * the legacy single-capture path.
   */
  geometryIssues?: string[];
  /**
   * Page-quality probe results, present only on the per-viewport path when a
   * viewport carried `heuristics`. `heuristicIssues` are defects and fail the
   * route; `heuristicSmells`, `envSkips` and `refusedIgnores` are advisory and
   * never do. `mainTextLength` is the 1280 viewport's probe value, else the
   * widest probed one, else null.
   */
  heuristicIssues?: string[];
  heuristicSmells?: string[];
  envSkips?: string[];
  refusedIgnores?: string[];
  mainTextLength?: number | null;
};

/**
 * Per-(route × viewport) capture the driving skill writes after resizing the
 * page, driving the MCP, and reading geometry via `evaluate_script`. The
 * geometry fields (`rootGap` / `scrollWidth` / `clientWidth`) are raw NUMBERS
 * the skill measured — this helper applies pure-TypeScript tolerance/equality
 * checks to them and never drives the MCP or reads the DOM itself.
 */
export type ViewportCapture = {
  name: string;
  width: number;
  snapshotText?: string;
  consoleErrors?: string[];
  failedRequests?: string[];
  screenshotPath?: string;
  rootGap?: { left: number; right: number };
  scrollWidth?: number;
  clientWidth?: number;
  /** `window.innerWidth` after emulation, when the probe was not run. */
  innerWidth?: number;
  colorScheme?: "light" | "dark";
  heuristics?: HeuristicsCapture;
};

export type Captures = {
  // Absent means "not reported", not "failed": only an explicit `false` (or
  // absence with no captured snapshot anywhere) is a launch/login failure.
  launchOk?: boolean;
  loginOk?: boolean;
  routes: Array<{
    path: string;
    consoleErrors: string[];
    failedRequests: string[];
    snapshotText: string;
    screenshotPath?: string;
    viewports?: ViewportCapture[];
  }>;
};

/**
 * Filter benign-noise substrings out of a single capture's console/request
 * lists and compute its missing-selector list. Shared by both the legacy
 * single-capture path and the per-viewport fold. Substring (not regex)
 * filters: an entry is suppressed when ANY pattern is a substring of it.
 * Absent patterns => no filtering (the benign favicon 404 is the canonical
 * case, cleared via ignoreRequestPatterns: ["/favicon.ico"]). Filter BEFORE
 * computing ok so suppressed noise never fails a route.
 */
export function filterCapture(
  manifest: UiValidationManifest,
  path: string,
  consoleRaw: string[] | undefined,
  failedRaw: string[] | undefined,
  snapshotRaw: string | undefined,
): {
  consoleErrors: string[];
  failedRequests: string[];
  missingSelectors: string[];
} {
  const ignoreConsolePatterns = manifest.ignoreConsolePatterns ?? [];
  const ignoreRequestPatterns = manifest.ignoreRequestPatterns ?? [];
  const consoleErrors = (consoleRaw ?? []).filter(
    (e) => !ignoreConsolePatterns.some((p) => e.includes(p)),
  );
  const failedRequests = (failedRaw ?? []).filter(
    (r) => !ignoreRequestPatterns.some((p) => r.includes(p)),
  );
  const manifestRoute = manifest.routes.find((r) => r.path === path);
  const expectSelectors = manifestRoute?.expectSelectors ?? [];
  const snapshotText = snapshotRaw ?? "";
  const missingSelectors = expectSelectors.filter(
    (sel) => !snapshotText.includes(sel),
  );
  return { consoleErrors, failedRequests, missingSelectors };
}

/**
 * Per-viewport fold: compute console/request/missing-selector findings from
 * each viewport's own fields PLUS the three mechanical geometry assertions,
 * naming the offending viewport(s). Pure TypeScript over captured numbers —
 * no MCP, no DOM read.
 */
export function computeViewportFindings(
  manifest: UiValidationManifest,
  capture: Captures["routes"][number],
  viewports: ViewportCapture[],
): RouteFindings {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const missingSelectors: string[] = [];
  const geometryIssues: string[] = [];
  const heuristicIssues: string[] = [];
  const heuristicSmells: string[] = [];
  const envSkips: string[] = [];
  const refused = new Set<string>();

  for (const vp of viewports) {
    const filtered = filterCapture(
      manifest,
      capture.path,
      vp.consoleErrors,
      vp.failedRequests,
      vp.snapshotText,
    );
    for (const e of filtered.consoleErrors)
      consoleErrors.push(`[${vp.name}] ${e}`);
    for (const r of filtered.failedRequests)
      failedRequests.push(`[${vp.name}] ${r}`);
    // Only a viewport that actually captured a snapshot participates in the
    // missing-selector check; mirrors the withSnapshot guard on the
    // breakpoint axis below so a no-snapshot capture (filterCapture coerces
    // undefined snapshotText to "") never spuriously flags every selector.
    if (vp.snapshotText !== undefined) {
      for (const s of filtered.missingSelectors)
        missingSelectors.push(`[${vp.name}] ${s}`);
    }

    if (vp.heuristics) {
      const judged = judgeHeuristics(
        vp.heuristics,
        { name: vp.name, width: vp.width, colorScheme: vp.colorScheme },
        manifest.ignoreHeuristicPatterns ?? [],
      );
      heuristicIssues.push(...judged.defects);
      heuristicSmells.push(...judged.smells);
      envSkips.push(...judged.envSkips);
      for (const p of judged.refusedIgnores) refused.add(p);
    } else if (
      typeof vp.innerWidth === "number" &&
      Math.abs(vp.innerWidth - vp.width) >
        HEURISTIC_THRESHOLDS.viewportMismatchPx
    ) {
      envSkips.push(
        `[${vp.name}] viewport-mismatch: innerWidth ${vp.innerWidth} vs requested ${vp.width}`,
      );
    }

    // (a) Off-center constrained column: asymmetric left/right gaps beyond a
    // small absolute floor plus a relative band, so intentional sidebars and
    // sub-pixel rounding don't false-positive.
    if (vp.rootGap) {
      const tolerance = Math.max(16, 0.05 * vp.width);
      if (Math.abs(vp.rootGap.left - vp.rootGap.right) > tolerance) {
        geometryIssues.push(
          `[${vp.name}] off-center constrained column: rootGap left=${vp.rootGap.left} right=${vp.rootGap.right} (tolerance ${tolerance})`,
        );
      }
    }

    // (b) Horizontal overflow at this viewport.
    if (
      typeof vp.scrollWidth === "number" &&
      typeof vp.clientWidth === "number" &&
      vp.scrollWidth > vp.clientWidth
    ) {
      geometryIssues.push(
        `[${vp.name}] horizontal overflow: scrollWidth=${vp.scrollWidth} > clientWidth=${vp.clientWidth}`,
      );
    }
  }

  // (c) Missing-element-at-breakpoint: a route-declared selector present in
  // SOME viewports' snapshotText but absent in another's. Only viewports that
  // actually captured a snapshot participate, so a viewport with no snapshot
  // never spuriously triggers the breakpoint mismatch.
  const manifestRoute = manifest.routes.find((r) => r.path === capture.path);
  const expectSelectors = manifestRoute?.expectSelectors ?? [];
  const withSnapshot = viewports.filter((vp) => vp.snapshotText !== undefined);
  for (const sel of expectSelectors) {
    const present = withSnapshot.filter((vp) =>
      (vp.snapshotText ?? "").includes(sel),
    );
    if (present.length > 0 && present.length < withSnapshot.length) {
      const absent = withSnapshot
        .filter((vp) => !(vp.snapshotText ?? "").includes(sel))
        .map((vp) => vp.name);
      geometryIssues.push(
        `missing-at-breakpoint: '${sel}' present at some viewports but absent at ${absent.join(", ")}`,
      );
    }
  }

  const ok =
    consoleErrors.length === 0 &&
    failedRequests.length === 0 &&
    missingSelectors.length === 0 &&
    geometryIssues.length === 0 &&
    heuristicIssues.length === 0;
  const probed = viewports.filter((vp) => vp.heuristics);
  const widest =
    probed.find((vp) => vp.width === 1280) ??
    probed.reduce<ViewportCapture | undefined>(
      (best, vp) => (best && best.width >= vp.width ? best : vp),
      undefined,
    );
  return {
    path: capture.path,
    ok,
    consoleErrors,
    failedRequests,
    missingSelectors,
    geometryIssues,
    heuristicIssues,
    heuristicSmells,
    envSkips,
    refusedIgnores: [...refused],
    mainTextLength: widest?.heuristics?.mainTextLength ?? null,
  };
}

// --- --compare -------------------------------------------------------------

export const TEXT_DROP_MAX = 0.15;

export type CompareVerdict = {
  decision: "keep" | "revert";
  regressed: boolean;
  newDefects: string[];
  smellsBefore: number;
  smellsAfter: number;
  textDrops: { route: string; before: number; after: number }[];
};

type AssembleOutput = { routes?: RouteFindings[] };

function defectKeys(out: AssembleOutput): string[] {
  return (out.routes ?? []).flatMap((r) =>
    [
      ...r.consoleErrors,
      ...r.failedRequests,
      ...r.missingSelectors,
      ...(r.geometryIssues ?? []),
      ...(r.heuristicIssues ?? []),
    ].map((d) => `${r.path} ${d}`),
  );
}

function smellCount(out: AssembleOutput): number {
  return (out.routes ?? []).reduce(
    (n, r) => n + (r.heuristicSmells?.length ?? 0),
    0,
  );
}

/**
 * Decide whether a fix round improved the page. `regressed` is the
 * no-regression signal (a new defect, more smells, or a route whose main text
 * shrank by more than TEXT_DROP_MAX — the guard against "fixing" by deleting
 * content); `keep` additionally needs strictly fewer smells.
 */
export function compareFindings(
  before: AssembleOutput,
  after: AssembleOutput,
): CompareVerdict {
  const seen = new Set(defectKeys(before));
  const newDefects = defectKeys(after).filter((d) => !seen.has(d));
  const smellsBefore = smellCount(before);
  const smellsAfter = smellCount(after);
  const beforeLen = new Map(
    (before.routes ?? []).map((r) => [r.path, r.mainTextLength ?? null]),
  );
  const textDrops: CompareVerdict["textDrops"] = [];
  for (const r of after.routes ?? []) {
    const b = beforeLen.get(r.path);
    const a = r.mainTextLength;
    if (typeof b === "number" && typeof a === "number" && b > 0) {
      if ((b - a) / b > TEXT_DROP_MAX) {
        textDrops.push({ route: r.path, before: b, after: a });
      }
    }
  }
  const regressed =
    newDefects.length > 0 || smellsAfter > smellsBefore || textDrops.length > 0;
  return {
    decision: !regressed && smellsAfter < smellsBefore ? "keep" : "revert",
    regressed,
    newDefects,
    smellsBefore,
    smellsAfter,
    textDrops,
  };
}
