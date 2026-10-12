/**
 * Matches each open `Browser:` Test Step to the attempt evidence a review or
 * verify drive left behind, so the merge gate can tell "nobody tried" from
 * "a human must judge this" (`flow-gate-decide` → `browser-retry`).
 *
 * Evidence lives in `<worktree>/.flow-tmp/`: `ui-driver-result.json` (the
 * UI-Driver's artifact) and `ui-preflight.json` (`flow-ui-preflight`'s
 * readiness envelope). A file only counts when its `headSha` equals the
 * current local HEAD (a missing stamp counts as absent), and the driver file
 * additionally only when `caller === "review-8c"` — verify writes the same
 * path. An `item_results` entry matches an item by its 1-based `index`
 * ONLY: review rewrites item text, so there is no text fallback.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { parseTestSteps } from "./test-steps-parse";
import type { UiDriverSkippedReason } from "./ui-driver-schema";

export type BrowserItemStatus =
  | "passed-unticked"
  | "failed"
  | "not-drivable"
  | "env-blocked"
  | "not-attempted";

export type OpenBrowserItem = {
  index: number;
  text: string;
  status: BrowserItemStatus;
  reason?: string;
};

type Deps = { readFile?: (p: string) => string | null };

// The driver could not run at all because the environment (browser tooling)
// was unavailable — retryable without any code change.
const ENV_DRIVER_REASONS: readonly UiDriverSkippedReason[] = [
  "mcp-not-available",
  "browser-profile-busy",
  "driver-no-artifact",
  "headless-binaries-missing",
];
// A launch/login failure is environmental only while the preflight shows the
// dependencies down; with dependencies ready it is a defect in the app.
const DEPENDENCY_DRIVER_REASONS: readonly UiDriverSkippedReason[] = [
  "app-launch-failed",
  "login-failed",
  "dependency-unready",
];

type Evidence = {
  driver: Record<string, unknown> | null;
  preflight: Record<string, unknown> | null;
};

function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readFresh(
  file: string,
  headSha: string | null,
  readFile: (p: string) => string | null,
): Record<string, unknown> | null {
  if (!headSha) return null;
  const raw = readFile(file);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  return o.headSha === headSha ? o : null;
}

function loadEvidence(
  worktree: string | null,
  headSha: string | null,
  deps: Deps,
): Evidence {
  if (!worktree) return { driver: null, preflight: null };
  const readFile = deps.readFile ?? defaultReadFile;
  const dir = path.join(worktree, ".flow-tmp");
  const driver = readFresh(
    path.join(dir, "ui-driver-result.json"),
    headSha,
    readFile,
  );
  return {
    driver: driver?.caller === "review-8c" ? driver : null,
    preflight: readFresh(
      path.join(dir, "ui-preflight.json"),
      headSha,
      readFile,
    ),
  };
}

function driverVerdict(
  driver: Record<string, unknown> | null,
  index: number,
): string | null {
  const results = driver?.item_results;
  if (!Array.isArray(results)) return null;
  for (const r of results) {
    if (typeof r === "object" && r !== null) {
      const e = r as Record<string, unknown>;
      if (e.index === index && typeof e.verdict === "string") return e.verdict;
    }
  }
  return null;
}

function driverSkip(driver: Record<string, unknown> | null): string | null {
  if (driver?.ran !== false) return null;
  return typeof driver.skipped_reason === "string"
    ? driver.skipped_reason
    : null;
}

function classifyOne(
  ev: Evidence,
  index: number,
): { status: BrowserItemStatus; reason?: string } {
  const verdict = driverVerdict(ev.driver, index);
  if (verdict === "pass") {
    return { status: "passed-unticked", reason: "driver verdict: pass" };
  }
  if (verdict === "fail") {
    return { status: "failed", reason: "driver verdict: fail" };
  }
  if (verdict === "not-drivable") {
    return { status: "not-drivable", reason: "driver verdict: not-drivable" };
  }
  if (ev.preflight?.ready === false) {
    return {
      status: "env-blocked",
      reason: "ui-preflight: a declared dependency never became ready",
    };
  }
  const skip = driverSkip(ev.driver);
  if (skip && (ENV_DRIVER_REASONS as readonly string[]).includes(skip)) {
    return { status: "env-blocked", reason: `driver skipped: ${skip}` };
  }
  if (
    (skip === "app-launch-failed" || skip === "login-failed") &&
    ev.preflight?.ready === true
  ) {
    return {
      status: "failed",
      reason: `driver skipped: ${skip} with dependencies ready (a defect, not the environment)`,
    };
  }
  if (skip && (DEPENDENCY_DRIVER_REASONS as readonly string[]).includes(skip)) {
    return {
      status: "not-attempted",
      reason: `driver claimed ${skip} but no ui-preflight.json shows ready:false`,
    };
  }
  return {
    status: "not-attempted",
    reason: "no attempt evidence for this head",
  };
}

export function classifyOpenBrowserItems(
  body: string,
  worktree: string | null,
  headSha: string | null,
  deps: Deps = {},
): OpenBrowserItem[] {
  const ev = loadEvidence(worktree, headSha, deps);
  const out: OpenBrowserItem[] = [];
  parseTestSteps(body).steps.forEach((step, i) => {
    if (step.checked || step.kind !== "browser") return;
    out.push({ index: i + 1, text: step.text, ...classifyOne(ev, i + 1) });
  });
  return out;
}

export function browserUnavailableBacked(
  worktree: string,
  headSha: string | null,
  deps: Deps = {},
): { backed: boolean; source?: "preflight" | "driver"; reason?: string } {
  const ev = loadEvidence(worktree, headSha, deps);
  if (ev.preflight?.ready === false) {
    return {
      backed: true,
      source: "preflight",
      reason: "ui-preflight.json shows a dependency never became ready",
    };
  }
  const skip = driverSkip(ev.driver);
  if (skip && (ENV_DRIVER_REASONS as readonly string[]).includes(skip)) {
    return {
      backed: true,
      source: "driver",
      reason: `ui-driver-result.json skipped_reason: ${skip}`,
    };
  }
  return { backed: false };
}
