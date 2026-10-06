/**
 * `flow doctor` agy check. The subprocess goes through `deps.run`, and agy's
 * output is never echoed — only exit status, a model count, or the names of
 * configured models agy no longer lists.
 */

import type { DoctorCheck, DoctorDeps } from "./doctor";
import {
  configuredAgyModels,
  missingAgyModels,
  parseAgyModelNames,
} from "./agy-model-check";
import { looksUnauthenticated } from "./agy-output";
import { readManifest } from "./manifest";
import { isModuleActive } from "./module-status";
import {
  deriveSelectionFromManifest,
  readConfigFileAt,
  readModuleSelection,
} from "./modules-config";

const AGY_TIMEOUT_MS = 15_000;

export const TOOLS_AGY_META = {
  id: "tools-agy",
  section: "tools",
  title: "agy",
} as const;

// `agy models` prints a progress line, then one `<slug>\t<Display Name>` row
// per model; only tab-separated rows count as models.
function countModelRows(stdout: string): number {
  return stdout.split("\n").filter((l) => /^[\w.-]+\t\S/.test(l)).length;
}

export function checkAgy(
  deps: DoctorDeps,
  io: { researchActive?: () => boolean } = {},
): DoctorCheck[] {
  const base = TOOLS_AGY_META;
  const readSelection = () =>
    readModuleSelection(() => readConfigFileAt(deps.configPath));
  const researchActive =
    io.researchActive ??
    (() =>
      isModuleActive("research", {
        readManifest: () => readManifest(deps.manifestPath),
        readSelection,
      }));
  if (!researchActive()) {
    return [
      {
        ...base,
        status: "skip",
        summary: "the research module is not installed",
        details: [],
      },
    ];
  }
  const r = deps.run("agy", ["models"], { timeoutMs: AGY_TIMEOUT_MS });
  if (r.notFound) {
    const current =
      readSelection() ??
      deriveSelectionFromManifest(readManifest(deps.manifestPath));
    const without = current.filter((id) => id !== "research");
    return [
      {
        ...base,
        status: "warn",
        summary: "agy is not on PATH; research steps will be skipped",
        details: ["install agy, or drop the research module"],
        fix: `flow install --modules ${without.join(",")}`,
      },
    ];
  }
  if (r.status === 0 && countModelRows(r.stdout) >= 1) {
    const missing = missingAgyModels(
      configuredAgyModels(readConfigFileAt(deps.configPath)),
      parseAgyModelNames(r.stdout),
    );
    if (missing.length > 0) {
      return [
        {
          ...base,
          status: "warn",
          summary: `agy no longer offers ${missing.length} configured model(s); those checks will be skipped`,
          details: missing.map((m) => `"${m.model}" (used by ${m.surface})`),
          fix: `set ${[...new Set(missing.map((m) => (m.surface.startsWith("research.") ? m.surface : `delegate.models.${m.surface}`)))].join(", ")} in ~/.flow/config.json to a model 'agy models' lists, or upgrade flow`,
        },
      ];
    }
    return [
      {
        ...base,
        status: "pass",
        summary: "agy responds and lists models; quota not checked",
        details: [],
      },
    ];
  }
  const signedOut = looksUnauthenticated(`${r.stdout}\n${r.stderr}`);
  return [
    {
      ...base,
      status: "warn",
      summary: signedOut
        ? "agy is not signed in; research steps will be skipped"
        : "could not confirm agy works; research steps may be skipped",
      details: ["run it in a terminal and sign in if prompted"],
      fix: "agy models",
    },
  ];
}
