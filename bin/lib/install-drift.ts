/**
 * Read-only install-drift detector — a sibling of `update-check.ts`'s
 * staleness check, but for symlink health rather than commit staleness.
 * `flow ls` / `flow version` surface its result as a non-blocking notice
 * (the same channel `checkForUpdate` already uses); `flow install` surfaces
 * a residual-drift line AFTER its own repair pass, as a bug signal (see
 * `setup.ts`).
 *
 * Hard contract: `checkInstallDrift` MUST NEVER THROW — every risky step
 * (fs read, JSON parse) collapses to a `{ status: "clean" }` result, mirroring
 * `update-check.ts:7`'s contract. Warn-only: no exit-code semantics, no
 * auto-repair (that's `flow install`'s job, via `ensureSymlink`).
 *
 * `discover` deliberately defaults to the SYNCHRONOUS `discoverAll`
 * (`sources.ts`), not the module-selection-aware `discoverSelected` (which
 * is `async`) — the `checkDrift: () => InstallDriftResult` seam `ls.ts` /
 * `version.ts` inject this behind must stay synchronous. The
 * module-selection gate `discoverSelected` would have applied is
 * reimplemented below via `manifestTargets`: an entry only counts as
 * in-scope when the manifest already records installing it (module
 * PRESENCE), OR the registry doesn't recognise the artifact at all (the
 * same gh#435 pass-through `discoverSelected` applies) — never via
 * `resolveModuleActivity`'s strict-all verdict, which would report phantom
 * drift for every optional-module artifact a core-only install never
 * linked in the first place.
 *
 * The drift check must measure against the installer's own link target
 * (`effectiveLinkSource`), never the raw discovery source: on a `flow
 * install --source <worktree>` run, `flowSource` (the worktree) and
 * `installRoot` (canonical) diverge BY DESIGN — the installer deliberately
 * links against canonical when a canonical copy already exists — so
 * comparing the live symlink against raw `entry.source` (still
 * worktree-pointed) reports every artifact stale.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FLOW_MANIFEST, resolveFlowSource } from "./paths";
import { readManifest as readManifestFile, type Manifest } from "./manifest";
import {
  discoverAll,
  effectiveLinkSource,
  DEFAULT_TARGETS,
  type InstallTargets,
  type SourceEntry,
} from "./sources";
import { isRegistryKnownArtifact } from "./modules";

export type DriftKind = "missing" | "dangling" | "stale";

export type DriftEntry = {
  kind: DriftKind;
  displayName: string;
  target: string;
};

export type InstallDriftResult =
  | { status: "drifted"; entries: DriftEntry[] }
  | { status: "clean" };

export type InstallDriftOptions = {
  /** Content source (test-only override; defaults to `resolveFlowSource()`). */
  flowSource?: string;
  /** Canonical install root (test-only override; defaults to `flowSource`). */
  installRoot?: string;
  targets?: InstallTargets;
  manifestPath?: string;
  /** Injectable for tests; defaults to the real `readManifest`. */
  readManifest?: (manifestPath?: string) => Manifest;
  /** Injectable for tests; MUST stay synchronous — defaults to `discoverAll`. */
  discover?: (
    flowSource: string,
    installRoot: string,
    targets?: InstallTargets,
  ) => SourceEntry[];
};

/** `fs.readlinkSync`, returning `null` instead of throwing on any error
 * (missing path, not-a-symlink). Mirrors `symlink.ts`'s `readSymlink`. */
function readSymlinkSafe(target: string): string | null {
  try {
    return fs.readlinkSync(target);
  } catch {
    return null;
  }
}

export function checkInstallDrift(
  opts: InstallDriftOptions = {},
): InstallDriftResult {
  try {
    const flowSource = opts.flowSource ?? resolveFlowSource();
    const installRoot = opts.installRoot ?? flowSource;
    const targets = opts.targets ?? DEFAULT_TARGETS;
    const discover = opts.discover ?? discoverAll;
    const readManifestFn = opts.readManifest ?? readManifestFile;
    const manifestPath = opts.manifestPath ?? FLOW_MANIFEST;

    const manifest = readManifestFn(manifestPath);
    if (manifest.symlinks.length === 0) {
      // Nothing recorded yet (fresh machine, or a genuinely empty install)
      // — nothing to compare against, so there is no drift to report.
      return { status: "clean" };
    }
    const manifestTargets = new Set(manifest.symlinks.map((r) => r.target));

    // Plugin roots are gated out of THIS discovery-output filter, not just
    // the manifest — the in-scope filter below is
    // `manifestTargets.has(e.target) || !isRegistryKnownArtifact(e.displayName)`,
    // and `moduleForArtifactName('flow-module-core')` (and every other root
    // name) returns undefined, so `isRegistryKnownArtifact` is false and
    // EVERY root would unconditionally pass the in-scope filter regardless
    // of selection. Filtering the manifest side alone is not sufficient —
    // the filter runs on DISCOVERY output — so the skip must happen here.
    // (An already-materialized root is separately skipped incidentally:
    // `readlink` on a real directory throws, `readSymlinkSafe` returns
    // `null`, and `fs.existsSync(entry.target)` is true, so it never reports
    // "missing" either way. The real hazard this filter prevents is the
    // false-`missing` report for a DESELECTED module's root.)
    const discovered = discover(flowSource, installRoot, targets).filter(
      (e) => e.kind !== "plugin",
    );
    const inScope = discovered.filter(
      (e) =>
        manifestTargets.has(e.target) ||
        !isRegistryKnownArtifact(e.displayName),
    );

    const entries: DriftEntry[] = [];
    for (const entry of inScope) {
      const link = readSymlinkSafe(entry.target);
      if (link === null) {
        // No symlink at the target. A real (non-symlink) file there is
        // user-owned, not drift — only a genuinely absent target counts.
        if (!fs.existsSync(entry.target)) {
          entries.push({
            kind: "missing",
            displayName: entry.displayName,
            target: entry.target,
          });
        }
        continue;
      }

      // realpath BOTH sides before comparing: `ensureSymlink` always writes
      // a realpath'd link target, but a foreign symlink (or a test fixture)
      // might not — and on macOS, /var is itself a symlink to /private/var,
      // so comparing an un-realpath'd link text against a realpath'd source
      // produces a false "stale" positive purely from OS path
      // canonicalization, independent of any real drift.
      //
      // Compare against `effectiveLinkSource`, not the raw `entry.source`:
      // the installer itself links the live symlink at the canonical path
      // when one exists (see `setup.ts`), so under `--source <worktree>`
      // the raw discovery source is not what a healthy install actually
      // points at.
      const expectedSource = effectiveLinkSource(
        entry.source,
        flowSource,
        installRoot,
      );
      const resolvedLink = path.resolve(path.dirname(entry.target), link);
      let resolvedLinkReal: string | null = null;
      try {
        resolvedLinkReal = fs.realpathSync(resolvedLink);
      } catch {
        resolvedLinkReal = null;
      }
      let sourceReal: string | null = null;
      try {
        sourceReal = fs.realpathSync(expectedSource);
      } catch {
        sourceReal = null;
      }

      if (sourceReal === null || resolvedLinkReal === null) {
        entries.push({
          kind: "dangling",
          displayName: entry.displayName,
          target: entry.target,
        });
        continue;
      }

      if (resolvedLinkReal !== sourceReal) {
        entries.push({
          kind: "stale",
          displayName: entry.displayName,
          target: entry.target,
        });
      }
    }

    return entries.length > 0
      ? { status: "drifted", entries }
      : { status: "clean" };
  } catch {
    // Never throw — a failed check is a non-blocking notice, not a crash.
    return { status: "clean" };
  }
}

/** Formats a one-line, dimmed-by-caller drift notice, or `null` when clean.
 * Mirrors `update-check.ts`'s `formatUpdateNotice` shape. */
export function formatDriftNotice(result: InstallDriftResult): string | null {
  if (result.status !== "drifted") return null;
  const byKind = { missing: 0, dangling: 0, stale: 0 };
  for (const e of result.entries) byKind[e.kind]++;
  const parts = (["missing", "dangling", "stale"] as const)
    .filter((k) => byKind[k] > 0)
    .map((k) => `${byKind[k]} ${k}`);
  return `flow: ${result.entries.length} symlink drift issue${
    result.entries.length === 1 ? "" : "s"
  } (${parts.join(", ")}) — run \`flow install --upgrade\` to repair`;
}
