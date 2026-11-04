/**
 * `flow-ui-critique gate`: decide whether the design review runs for this
 * diff, and on the pre-drive call persist what the capture needs (the branch
 * diff, the review targets) and what the auto-merge backstop reads later
 * (`required`, `targets`, the Playwright warning) into the loop log.
 */
import * as path from "node:path";

import { decideGate } from "./ui-critique-gate";
import { readUiCritiqueEnabled } from "./ui-critique-config";
import {
  critDir,
  demotion,
  readDriver,
  readJson,
  readLog,
  writeLog,
  type Flags,
  type OpResult,
  type OpsDeps,
} from "./ui-critique-ops";
import {
  deriveReviewTargets,
  parseUiReviewTargets,
  uiReviewRequired,
  type UiReviewTarget,
} from "./ui-review-scope";

const str = (v: string | boolean | undefined): string =>
  typeof v === "string" ? v : "";

function lines(raw: string | null): string[] | null {
  return raw === null ? null : raw.split("\n").filter((l) => l.length > 0);
}

function manifestRoutes(deps: OpsDeps, p: string): string[] {
  const m = p ? readJson(deps, p) : null;
  const routes = (m as { routes?: unknown } | null)?.routes;
  if (!Array.isArray(routes)) return [];
  return routes.flatMap((r) =>
    typeof (r as { path?: unknown } | null)?.path === "string"
      ? [(r as { path: string }).path]
      : [],
  );
}

function readTargets(deps: OpsDeps, w: string): UiReviewTarget[] | null {
  const t = readJson(deps, path.join(critDir(w), "targets.json"));
  return Array.isArray(t) ? (t as UiReviewTarget[]) : null;
}

export function opGate(f: Flags, deps: OpsDeps): OpResult {
  const w = str(f.worktree);
  // Kept required so every caller and `render` share one body-file contract,
  // even though the gate itself no longer reads the body.
  if (deps.readFile(str(f["body-file"])) === null) {
    return { ran: false, skipReason: "body-unreadable" };
  }
  const log = readLog(deps, w);
  const preDrive = typeof f["driver-result"] !== "string";

  const changed =
    (f["changed-files"]
      ? lines(deps.readFile(str(f["changed-files"])))
      : null) ?? deps.changedFiles(w);
  const required =
    changed !== null
      ? uiReviewRequired(changed).required
      : (log.required ?? false);

  const targets =
    (preDrive ? null : readTargets(deps, w)) ??
    deriveReviewTargets({
      changedFiles: changed ?? [],
      planTargets: parseUiReviewTargets(deps.readFile(str(f.plan)) ?? ""),
      manifestRoutes: manifestRoutes(deps, str(f.manifest)),
    });

  const enabled = readUiCritiqueEnabled(() =>
    deps.readFile(path.join(deps.home, ".flow", "config.json")),
  );
  let ui = null;
  if (!preDrive) {
    const d = readDriver(deps, str(f["driver-result"]));
    ui = {
      ran: d?.ran === true,
      ok: d?.ok === true,
      skippedReason: d ? (d.skipped_reason ?? null) : "driver-no-artifact",
      sectionShots: d?.section_shots?.length ?? 0,
    };
  }
  const decision = decideGate({
    enabled,
    uiRequired: required,
    targetCount: targets.length,
    playwright: preDrive ? deps.resolvePlaywright(w).status : "ok",
    ui,
    log,
    demotion: demotion(deps),
  });

  if (preDrive && !log.completed) {
    deps.mkdirp(critDir(w));
    deps.writeFile(
      path.join(critDir(w), "changed-files.txt"),
      (changed ?? []).join("\n") + "\n",
    );
    deps.writeFile(
      path.join(critDir(w), "targets.json"),
      JSON.stringify(targets, null, 2) + "\n",
    );
    const { playwrightWarning: _stale, ...rest } = log;
    writeLog(deps, w, {
      ...rest,
      required,
      targets,
      ...(decision.warning ? { playwrightWarning: decision.warning } : {}),
    });
  }
  return {
    ...decision,
    detail:
      changed === null && !log.required
        ? `${decision.detail} (ui-review-check: diff unreadable)`
        : decision.detail,
  };
}
