/**
 * The per-epic autonomy grant: `~/.flow/state/managers/<epic>/grant.json`.
 *
 * Written only by `flow epic grant --autonomy high` (an owner-typed command,
 * see epic-grant-cli.ts); read by the epic executive. The grant carries no
 * model or effort — `epic-manager-model.ts` is the single model source.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  EPIC_MANIFEST_FILENAME,
  epicDirRelative,
  validateEpicManifest,
  type EpicManifest,
} from "./epic-manifest-schema";
import { managerDir } from "./epic-manager-log";
import { withFileLockSync } from "./lock";
import { readState } from "./state";

export type GrantClass = "plan";

export type Grant = {
  version: 1;
  epic: string;
  classes: GrantClass[];
  grantedAt: string;
  grantedBy: "owner-cli";
};

function grantPath(epic: string, stateDir?: string): string {
  return path.join(managerDir(epic, stateDir), "grant.json");
}

function isGrant(v: unknown, epic: string): v is Grant {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return (
    g.version === 1 &&
    g.epic === epic &&
    Array.isArray(g.classes) &&
    g.classes.length > 0 &&
    g.classes.every((c) => c === "plan") &&
    typeof g.grantedAt === "string" &&
    g.grantedBy === "owner-cli"
  );
}

/** Tolerant: a missing file or an invalid shape reads as null. */
export function readGrant(epic: string, stateDir?: string): Grant | null {
  try {
    const v: unknown = JSON.parse(
      fs.readFileSync(grantPath(epic, stateDir), "utf8"),
    );
    return isGrant(v, epic) ? v : null;
  } catch {
    return null;
  }
}

export function writeGrant(grant: Grant, stateDir?: string): void {
  const dir = managerDir(grant.epic, stateDir);
  fs.mkdirSync(dir, { recursive: true });
  withFileLockSync(path.join(dir, "grant.lock"), () => {
    const tmp = path.join(dir, `grant.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(grant, null, 2)}\n`);
    fs.renameSync(tmp, grantPath(grant.epic, stateDir));
  });
}

export function removeGrant(epic: string, stateDir?: string): boolean {
  const dir = managerDir(epic, stateDir);
  return withFileLockSync(path.join(dir, "grant.lock"), () => {
    try {
      fs.unlinkSync(grantPath(epic, stateDir));
      return true;
    } catch {
      return false;
    }
  });
}

export type GrantScope =
  | { granted: true; epic: string; featureId: string }
  | {
      granted: false;
      reason:
        | "no-grant"
        | "not-epic"
        | "other-epic"
        | "unknown-feature"
        | "state-missing";
    };

export function loadManifestFromRepo(
  epic: string,
  repoRoot: string,
): EpicManifest | null {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, epicDirRelative(epic), EPIC_MANIFEST_FILENAME),
        "utf8",
      ),
    );
    const v = validateEpicManifest(raw);
    return v.ok ? v.value : null;
  } catch {
    return null;
  }
}

/**
 * Is `slug` a feature of an epic that has granted autonomy? `expectedEpic`,
 * when given, must match the slug's own epic binding (a grant for epic A never
 * covers an epic-B feature).
 */
export function grantScopeForSlug(
  slug: string,
  deps: {
    stateDir?: string;
    expectedEpic?: string;
    loadManifest?: (epic: string, repoRoot: string) => EpicManifest | null;
  } = {},
): GrantScope {
  const state = readState(slug, deps.stateDir);
  if (!state) return { granted: false, reason: "state-missing" };
  if (!state.epic) return { granted: false, reason: "not-epic" };
  const { slug: epic, featureId } = state.epic;
  if (deps.expectedEpic !== undefined && deps.expectedEpic !== epic) {
    return { granted: false, reason: "other-epic" };
  }
  if (!readGrant(epic, deps.stateDir)) {
    return { granted: false, reason: "no-grant" };
  }
  const load = deps.loadManifest ?? loadManifestFromRepo;
  const roots = [state.worktree, state.repo].filter(
    (r): r is string => typeof r === "string" && r !== "",
  );
  for (const root of roots) {
    const manifest = load(epic, root);
    if (manifest) {
      return manifest.features.some((f) => f.id === featureId)
        ? { granted: true, epic, featureId }
        : { granted: false, reason: "unknown-feature" };
    }
  }
  return { granted: false, reason: "unknown-feature" };
}
