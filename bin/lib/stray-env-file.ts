/**
 * Pure, warn-only detector for a stray `.env.local` (or sibling env-override
 * file) inside a flow-managed worktree. flow never writes such a file — a
 * hand-authored one can silently override the port/URL config a UI-smoke or
 * UI-validation pass injects inline, re-pointing a later manual `npm run dev`
 * at a stale port with no visible cause. Gated on the `.flow-branch` marker
 * (only present in a flow-managed worktree) so a plain `flow install`
 * consumer repo — which never has the marker — never sees the advisory.
 *
 * Detection only: nothing here ever deletes a file. See AGENTS.md
 * `## Don'ts` "Don't write test-time port or URL overrides to a file." for
 * the upstream rule this warns a violation of.
 */

import * as path from "node:path";
import { BRANCH_MARKER_FILENAME } from "./worktree-marker";

export const STRAY_ENV_FILENAMES: readonly string[] = [
  ".env.local",
  ".env.development.local",
  ".env.test.local",
  ".env.production.local",
];

export type StrayEnvDeps = {
  exists: (p: string) => boolean;
};

/**
 * Returns the absolute paths of every `STRAY_ENV_FILENAMES` entry present in
 * `worktreeDir`, but ONLY when `worktreeDir` carries the `.flow-branch`
 * marker (a flow-managed worktree) — otherwise returns `[]` unconditionally,
 * since a stray env file in an ordinary consumer repo is none of flow's
 * business.
 */
export function detectStrayEnvFiles(
  worktreeDir: string,
  deps: StrayEnvDeps,
): string[] {
  const markerPath = path.join(worktreeDir, BRANCH_MARKER_FILENAME);
  if (!deps.exists(markerPath)) return [];

  return STRAY_ENV_FILENAMES.map((name) => path.join(worktreeDir, name)).filter(
    (p) => deps.exists(p),
  );
}

/**
 * Renders the advisory for a non-empty `detectStrayEnvFiles` result. Returns
 * `""` for an empty list (no advisory to show).
 */
export function strayEnvWarning(paths: string[]): string {
  if (paths.length === 0) return "";
  const list = paths.map((p) => `  - ${p}`).join("\n");
  return (
    `warning: stray env-override file(s) detected in this flow-managed worktree:\n${list}\n` +
    `flow never writes these files — a hand-authored one can silently override ` +
    `dev ports/URLs for a later manual run with no visible cause. Remove it, or ` +
    `express the override as an 'env' entry / a '{{PORT_<NAME>}}' sentinel in ` +
    `.flow/ui-validation.json instead.`
  );
}
