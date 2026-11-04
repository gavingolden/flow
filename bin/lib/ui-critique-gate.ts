/**
 * The pure gate decision for the UI critique loop: whether it runs, in which
 * mode, and (pre-drive) through which capture path. Split from
 * `ui-critique.ts`, which holds the finding and log types.
 */
import {
  PLAYWRIGHT_BROWSERS_HINT,
  PLAYWRIGHT_MISSING_HINT,
  type PlaywrightStatus,
} from "./playwright-resolve";
import type { LoopLog, RoundKind } from "./ui-critique";

export type GateReason =
  | "run"
  | "already-ran"
  | "no-ui-change"
  | "disabled-by-config"
  | "no-review-target"
  | "no-ui-pass"
  | "no-section-shots";

export type GateInput = {
  enabled: boolean;
  /** The branch diff touches a render-bearing file (`uiReviewRequired`). */
  uiRequired: boolean;
  targetCount: number;
  playwright: PlaywrightStatus["status"];
  ui: {
    ran: boolean;
    ok: boolean;
    skippedReason: string | null;
    sectionShots: number;
  } | null;
  log: LoopLog;
  demotion: { demoted: boolean; reason: string };
};

export type GateDecision = {
  run: boolean;
  mode: "fix" | "list-only";
  reason: GateReason;
  detail: string;
  openRound: { kind: RoundKind; preSha: string } | null;
  required: boolean;
  /** Pre-drive only: how the sections get photographed. */
  capture: "playwright" | "mcp" | null;
  loud: boolean;
  warning: string | null;
};

const PLAYWRIGHT_WARNINGS: Record<"missing" | "browsers-missing", string> = {
  missing: PLAYWRIGHT_MISSING_HINT,
  "browsers-missing": PLAYWRIGHT_BROWSERS_HINT,
};

/**
 * `ui: null` is the pre-drive call (`run` then means "capture the sections",
 * through Playwright when the repo has it, else the browser driver).
 * Precedence: already-ran > no-ui-change > disabled-by-config >
 * no-review-target > no-ui-pass > no-section-shots. The smoke pass being `ok`
 * does not matter: section capture runs regardless of page-check failures.
 */
export function decideGate(i: GateInput): GateDecision {
  const mode = i.demotion.demoted ? "list-only" : "fix";
  const openRound =
    i.log.round?.open === true
      ? { kind: i.log.round.kind, preSha: i.log.round.preSha }
      : null;
  const decide = (
    reason: GateReason,
    detail: string,
    extra: Partial<Pick<GateDecision, "capture" | "loud" | "warning">> = {},
  ): GateDecision => ({
    run: reason === "run",
    mode,
    reason,
    detail,
    openRound,
    required: i.uiRequired,
    capture: null,
    loud: false,
    warning: null,
    ...extra,
  });

  if (i.log.completed) {
    return decide(
      "already-ran",
      "the UI critique loop already ran for this pipeline",
    );
  }
  if (!i.uiRequired) {
    return decide("no-ui-change", "the diff changes no rendered file");
  }
  if (!i.enabled) {
    return decide("disabled-by-config", "ui.critique is set to false");
  }
  if (i.targetCount < 1) {
    return decide(
      "no-review-target",
      "no page in the plan or the diff shows the changed screen",
    );
  }
  if (i.ui !== null) {
    if (i.ui.sectionShots < 1) {
      if (!i.ui.ran) {
        return decide(
          "no-ui-pass",
          `browser checks did not run (${i.ui.skippedReason ?? "no reason recorded"})`,
        );
      }
      return decide(
        "no-section-shots",
        "the browser drive captured no section screenshots",
      );
    }
    return decide("run", i.demotion.demoted ? i.demotion.reason : "eligible");
  }
  const detail = i.demotion.demoted ? i.demotion.reason : "eligible";
  if (i.playwright === "ok")
    return decide("run", detail, { capture: "playwright" });
  return decide("run", detail, {
    capture: "mcp",
    loud: true,
    warning: PLAYWRIGHT_WARNINGS[i.playwright],
  });
}
