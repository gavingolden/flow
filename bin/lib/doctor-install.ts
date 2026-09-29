/**
 * `flow doctor` install checks: link drift, never-installed registered
 * artifacts, and missing runtime packages. Read-only — every reused helper
 * gets its paths from `deps`, never from a `paths.ts` default.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DoctorCheck, DoctorDeps } from "./doctor";
import { capped } from "./doctor-util";
import {
  checkInstallDrift,
  type DriftEntry,
  type InstallDriftOptions,
  type InstallDriftResult,
} from "./install-drift";
import { readManifest, type Manifest } from "./manifest";
import { isRegistryKnownArtifact } from "./modules";
import { resolveModuleActivity } from "./module-status";
import {
  deriveSelectionFromManifest,
  readConfigFileAt,
  readModuleSelection,
  resolveModuleSelection,
} from "./modules-config";
import { findMissingRuntimeDeps } from "./setup-deps";
import { discoverSelected } from "./sources";
import { inspectFlowRoot } from "./worktree-source";

/** `flow install --upgrade`, spelled through the canonical checkout when the
 * running flow source is a worktree (the wrapper would otherwise re-pin to it). */
function upgradeCommand(
  deps: DoctorDeps,
  inspect: typeof inspectFlowRoot,
): string {
  const info = inspect(deps.flowSource);
  return info.isWorktree && info.canonicalRoot
    ? `bun ${path.join(info.canonicalRoot, "bin", "flow")} install --upgrade`
    : "flow install --upgrade";
}

function describeDrift(e: DriftEntry): string {
  const where = e.detail ? path.join(e.target, e.detail) : e.target;
  return `${e.kind}: ${e.displayName} at ${where}`;
}

export function checkInstallLinks(
  deps: DoctorDeps,
  checkDrift: (
    opts: InstallDriftOptions,
  ) => InstallDriftResult = checkInstallDrift,
  inspect: typeof inspectFlowRoot = inspectFlowRoot,
): DoctorCheck[] {
  const base = {
    id: "install-links",
    section: "install" as const,
    title: "Installed links",
  };
  const result = checkDrift({
    flowSource: deps.flowSource,
    installRoot: deps.installRoot,
    targets: deps.targets,
    manifestPath: deps.manifestPath,
  });
  if (result.status === "clean") {
    return [
      {
        ...base,
        status: "pass",
        summary: "every installed link matches the install record",
        details: [],
      },
    ];
  }
  const counts = new Map<string, number>();
  for (const e of result.entries)
    counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const broken = ["missing", "dangling", "stale"].some((k) => counts.has(k));
  return [
    {
      ...base,
      status: broken ? "fail" : "warn",
      summary: [...counts].map(([k, n]) => `${n} ${k}`).join(", "),
      details: capped(result.entries.map(describeDrift)),
      fix: upgradeCommand(deps, inspect),
    },
  ];
}

function linkPresent(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

export async function checkInstalledModules(
  deps: DoctorDeps,
  io: {
    readManifest?: () => Manifest;
    readSelection?: () => string[] | undefined;
    discover?: typeof discoverSelected;
    inspect?: typeof inspectFlowRoot;
  } = {},
): Promise<DoctorCheck[]> {
  const base = {
    id: "install-modules",
    section: "install" as const,
    title: "Installed modules",
  };
  const manifest = (
    io.readManifest ?? (() => readManifest(deps.manifestPath))
  )();
  const readSelection =
    io.readSelection ??
    (() => readModuleSelection(() => readConfigFileAt(deps.configPath)));
  const recorded = readSelection();
  const selection = resolveModuleSelection({
    manifestIds: deriveSelectionFromManifest(manifest),
    isTTY: false,
    confirm: () => false,
    read: () => ({ modules: recorded }),
  });
  const discover = io.discover ?? discoverSelected;
  // The canonical root is both content source and install root, so a helper
  // still under development in a worktree is never reported missing.
  const entries = await discover(
    deps.installRoot,
    deps.installRoot,
    selection.ids,
    deps.targets,
  );
  const recordedTargets = new Set(manifest.symlinks.map((r) => r.target));
  const neverInstalled = entries.filter(
    (e) =>
      (e.kind === "agent" ||
        ((e.kind === "skill" || e.kind === "bin") &&
          isRegistryKnownArtifact(e.displayName))) &&
      !linkPresent(e.target) &&
      !recordedTargets.has(e.target),
  );
  if (neverInstalled.length > 0) {
    const names = neverInstalled.map((e) => e.displayName);
    return [
      {
        ...base,
        status: "fail",
        summary: `${names.length} registered artifact(s) never installed: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` (+${names.length - 3} more)` : ""}`,
        details: capped(
          neverInstalled.map((e) => `${e.displayName} expected at ${e.target}`),
        ),
        fix: `${upgradeCommand(deps, io.inspect ?? inspectFlowRoot)} (then re-run flow doctor)`,
      },
    ];
  }
  const activity = resolveModuleActivity({
    readManifest: () => manifest,
    readSelection,
  });
  const names = (active: boolean) =>
    activity.filter((m) => m.active === active).map((m) => m.id);
  const inactive = names(false);
  return [
    {
      ...base,
      status: "pass",
      summary: `active: ${names(true).join(", ")}${inactive.length > 0 ? `; inactive: ${inactive.join(", ")}` : ""}`,
      details: [
        `checked against the flow checkout at ${deps.installRoot} (not origin)`,
      ],
    },
  ];
}

export function checkRuntimePackages(
  deps: DoctorDeps,
  findMissing: typeof findMissingRuntimeDeps = findMissingRuntimeDeps,
): DoctorCheck[] {
  const base = {
    id: "install-packages",
    section: "install" as const,
    title: "Runtime packages",
  };
  const { missing } = findMissing(deps.installRoot);
  if (missing.length === 0) {
    return [
      {
        ...base,
        status: "pass",
        summary: "every runtime package resolves",
        details: [],
      },
    ];
  }
  return [
    {
      ...base,
      status: "fail",
      summary: `missing: ${missing.join(", ")}`,
      details: [`node_modules at ${deps.installRoot} is missing or stale`],
      fix: `cd ${deps.installRoot} && npm install`,
    },
  ];
}
