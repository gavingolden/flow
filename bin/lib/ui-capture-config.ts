/**
 * Builds the config the generated capture script reads: the viewport lists
 * (with and without the dark ones, picked by the page probe at run time), the
 * caps, and a table of every screenshot path the plan can name, so the script
 * needs no copy of the naming rule.
 */
import * as path from "node:path";

import { planCapture, routeSlug } from "./ui-capture-plan";
import { nameKey, type CaptureConfig } from "./ui-capture-script";
import type { Target } from "./ui-capture-args";

export function buildCaptureConfig(i: {
  worktree: string;
  baseUrl: string;
  login: CaptureConfig["login"];
  targets: Target[];
}): CaptureConfig {
  const evidenceDir = path.join(
    i.worktree,
    ".flow-tmp",
    "ui-evidence",
    "critique",
  );
  const asTargets = i.targets.map((t) => ({ ...t, source: "plan" as const }));
  const withDark = planCapture(asTargets, evidenceDir, true);
  const light = planCapture(asTargets, evidenceDir, false);
  const names: Record<string, string> = {};
  for (const t of i.targets) {
    for (let n = 1; n <= withDark.maxSectionsPerView; n++) {
      for (const vp of withDark.viewports) {
        for (const part of ["whole", "start", "end"] as const) {
          names[nameKey(t.route, n, vp.name, part)] = withDark.shotPath(
            t.route,
            n,
            vp.name,
            part,
          );
        }
      }
    }
  }
  return {
    baseUrl: i.baseUrl,
    login: i.login,
    targets: i.targets.map((t) => ({
      route: t.route,
      signedOut: t.session === "signed-out",
      snapshotPath: path.join(
        evidenceDir,
        `${routeSlug(t.route)}.snapshot.txt`,
      ),
    })),
    viewportsLight: light.viewports,
    viewportsDark: withDark.viewports,
    maxSectionsPerView: withDark.maxSectionsPerView,
    maxShotsPerTarget: withDark.maxShotsPerTarget,
    names,
  };
}
