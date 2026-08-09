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
import {
  FLOW_MANIFEST,
  configuredFlowSource,
  resolveFlowSource,
} from "./paths";
import { inspectFlowRoot } from "./worktree-source";
import { readManifest as readManifestFile, type Manifest } from "./manifest";
import {
  discoverAll,
  effectiveLinkSource,
  DEFAULT_TARGETS,
  type InstallTargets,
  type SourceEntry,
} from "./sources";
import { isRegistryKnownArtifact } from "./modules";
import { scanPluginRoots as scanPluginRootsReal } from "./plugin-root";
import { unexpectedPluginRootEntries } from "./plugin-root-audit";

export type DriftKind = "missing" | "dangling" | "stale" | "unexpected";

export type DriftEntry = {
  kind: DriftKind;
  displayName: string;
  target: string;
  /** Set on the plugin-root-audit-derived kinds ("unexpected" and the
   * dangling-`bin/`-symlink flavor of "dangling") — the offending path
   * relative to the plugin root. Absent on the manifest-symlink-derived
   * kinds ("missing"/"stale"/the rest of "dangling"), which have no
   * plugin-root-relative path to report. */
  detail?: string;
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
  /** Plugin-root scanner seam, mirroring `discover`'s injection discipline:
   * defaults to the real `scanPluginRoots`, tests override so a fixture
   * never scans the developer's real `~/.flow/claude-home`. MUST stay
   * synchronous, same as `discover`. */
  scanPluginRoots?: (skillsDir: string) => string[];
  /** Injectable for tests; defaults to the real `inspectFlowRoot`
   * (`worktree-source.ts`). Used only to derive the DEFAULT `installRoot`
   * below, mirroring `setup.ts`'s own worktree-repoint decision — never
   * applies when `opts.installRoot` is explicitly set. */
  inspectRoot?: typeof inspectFlowRoot;
  /** Injectable for tests; defaults to the real `configuredFlowSource`
   * (`paths.ts`), same rationale as `inspectRoot` above. */
  configuredSource?: (homeDir?: string) => string | null;
};

/**
 * Default `installRoot`, mirroring `setup.ts:326-337`'s own worktree-repoint
 * decision: when `flowSource` resolves to a git worktree (not the canonical
 * checkout) and no `config.source` is configured, the installer links every
 * `bin/` symlink against the canonical checkout instead — so the drift
 * check's ownership pair must do the same, or a worktree-vantage `flow ls` /
 * `flow version` reports every one of flow's own live plugin `bin/`
 * symlinks as foreign (they resolve to canonical, not the worktree).
 * `inspectFlowRoot` already fails open (`{ isWorktree: false, canonicalRoot:
 * null }` on any error), so this degrades to the pre-existing `flowSource`
 * default on any failure — never a new throw path.
 */
function defaultInstallRoot(
  flowSource: string,
  inspectRoot: typeof inspectFlowRoot,
  configuredSource: (homeDir?: string) => string | null,
): string {
  const rootInfo = inspectRoot(flowSource);
  if (
    rootInfo.isWorktree &&
    rootInfo.canonicalRoot &&
    configuredSource() === null
  ) {
    return rootInfo.canonicalRoot;
  }
  return flowSource;
}

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
    const inspectRoot = opts.inspectRoot ?? inspectFlowRoot;
    const configuredSource = opts.configuredSource ?? configuredFlowSource;
    const installRoot =
      opts.installRoot ??
      defaultInstallRoot(flowSource, inspectRoot, configuredSource);
    const targets = opts.targets ?? DEFAULT_TARGETS;
    const discover = opts.discover ?? discoverAll;
    const readManifestFn = opts.readManifest ?? readManifestFile;
    const manifestPath = opts.manifestPath ?? FLOW_MANIFEST;
    const scanPluginRoots = opts.scanPluginRoots ?? scanPluginRootsReal;

    const entries: DriftEntry[] = [];

    // ADDITIVE plugin pass, run BEFORE the manifest-symlinks early return
    // below — this scan is manifest-INDEPENDENT by design (mirroring
    // `scanPluginRoots`'s own OQ-7 manifest-independent discovery), so it
    // must never be short-circuited by an empty manifest. Placement here is
    // load-bearing: a machine with an empty manifest and a junk-filled
    // orphaned plugin root must still report that drift, not report clean.
    for (const root of scanPluginRoots(targets.skillsDir)) {
      for (const issue of unexpectedPluginRootEntries(root, {
        flowSource,
        installRoot,
      })) {
        // A dangling `bin/`/`skills/`/`agents/` symlink is genuinely
        // repaired by `flow install --upgrade` (see `classifyEntry` in
        // `plugin-root-audit.ts`), so it gets the "dangling" kind and that
        // kind's self-healing remediation. Everything else — including a
        // foreign live `bin/` symlink — gets "unexpected": `listManagedSymlinks`
        // (`plugin-root.ts`) filters purely on `isSymbolicLink()` with no
        // ownership check, so the prune loop in `plugin-root.ts` WOULD
        // silently remove a foreign live `bin/` symlink on the next
        // `flow install --upgrade` — it is not actually protected from
        // pruning. "unexpected" is chosen anyway because it is the only
        // kind `formatDriftNotice` enumerates BY NAME, and naming the path
        // is what matters for an entry that is currently winning PATH
        // lookup, not merely a repairable dangling link.
        entries.push({
          kind: issue.reason === "dangling-symlink" ? "dangling" : "unexpected",
          displayName: path.basename(root),
          target: root,
          detail: issue.relPath,
        });
      }
    }

    const manifest = readManifestFn(manifestPath);
    if (manifest.symlinks.length === 0) {
      // Nothing recorded yet (fresh machine, or a genuinely empty install)
      // — nothing to compare the SYMLINK-drift kinds against, but the
      // plugin-root pass above is independent of the manifest, so its
      // findings (if any) still count.
      return entries.length > 0
        ? { status: "drifted", entries }
        : { status: "clean" };
    }
    const manifestTargets = new Set(manifest.symlinks.map((r) => r.target));

    // Plugin roots are STILL gated out of THIS discovery-output filter, not
    // just the manifest — that discovery-side skip stays correct on its own
    // terms: the in-scope filter below is
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
    // false-`missing` report for a DESELECTED module's root.) A root's
    // CONTENTS drift is not left uncovered by this skip — that's the
    // `unexpectedPluginRootEntries` pass above, which runs independently of
    // both the manifest and this `discoverAll` output.
    const discovered = discover(flowSource, installRoot, targets).filter(
      (e) => e.kind !== "plugin",
    );
    const inScope = discovered.filter(
      (e) =>
        manifestTargets.has(e.target) ||
        !isRegistryKnownArtifact(e.displayName),
    );

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

/** Cap on how many `unexpected` entries `formatDriftNotice` names inline —
 * the notice is a one-line dimmed message on an interactive path, so an
 * unbounded enumeration would blow past that budget on a badly-drifted
 * root; name the first few and fold the rest into a `(+N more)` tail. */
const MAX_ENUMERATED_UNEXPECTED = 3;

/** Formats a one-line, dimmed-by-caller drift notice, or `null` when clean.
 * Mirrors `update-check.ts`'s `formatUpdateNotice` shape. */
export function formatDriftNotice(result: InstallDriftResult): string | null {
  if (result.status !== "drifted") return null;
  const byKind = { missing: 0, dangling: 0, stale: 0, unexpected: 0 };
  for (const e of result.entries) byKind[e.kind]++;
  const parts = (["missing", "dangling", "stale", "unexpected"] as const)
    .filter((k) => byKind[k] > 0)
    .map((k) => `${byKind[k]} ${k}`);
  // Two remediation branches, not three: `flow install --upgrade` repairs
  // every symlink kind unconditionally (it's a no-op when there is nothing
  // to repair), while an `unexpected` entry has no automated remedy and must
  // be removed by hand. `unexpected` covers two distinct cases: a real file
  // or directory inside a flow-managed plugin root (flow never deletes a
  // real file it did not write — genuinely no automated remedy), and a
  // foreign live `bin/` symlink resolving outside the flow tree (the prune
  // loop in `plugin-root.ts` has no ownership check, so it WOULD silently
  // remove this on the next `flow install --upgrade` — this notice exists
  // so the user sees it named before that happens). Unlike the other three kinds,
  // `unexpected` must NAME the offending entries rather than report an
  // anonymous count — otherwise the user is told to hand-remove something
  // the tool refuses to name.
  const repair = "run `flow install --upgrade` to repair";
  const unexpectedEntries = result.entries.filter(
    (e) => e.kind === "unexpected" && e.detail,
  );
  let handRemoval = "";
  if (byKind.unexpected > 0) {
    const named = unexpectedEntries
      .slice(0, MAX_ENUMERATED_UNEXPECTED)
      .map((e) => `${e.displayName} → ${e.detail}`);
    const remaining = unexpectedEntries.length - named.length;
    const list =
      named.join(", ") + (remaining > 0 ? ` (+${remaining} more)` : "");
    handRemoval = list
      ? `; must be removed by hand: ${list}`
      : "; unexpected entries inside a flow-managed plugin root must be removed by hand";
  }
  return `flow: ${result.entries.length} install drift issue${
    result.entries.length === 1 ? "" : "s"
  } (${parts.join(", ")}) — ${repair}${handRemoval}`;
}
