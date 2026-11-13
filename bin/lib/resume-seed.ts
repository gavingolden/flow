/**
 * The byte-exact resume seed per window kind. Lives in a lib module so the
 * history loader can name the exact resume line without importing the
 * `SessionStart:clear` hook entry point (which dynamically imports the
 * loader). `bin/flow-session-start-hook.ts` re-exports it unchanged.
 */

import { epicDirRelative } from "./epic-manifest-schema";
import {
  epicResumeSeed,
  epicRunSeed,
  productPlanningSkillDir,
} from "./epic-seed";
import { flowPipelineResumeSeed } from "./feature";
import type { PipelineKind } from "./state";

/**
 * Picks the byte-exact resume seed for `kind`, reusing (never re-authoring)
 * each launcher's own seed builder. Exhaustive `switch`, no `default`
 * fallthrough — a future kind fails typecheck here rather than silently
 * sending the feature seed.
 */
export function resumeSeedFor(slug: string, kind: PipelineKind): string {
  switch (kind) {
    case "epic-design":
      return epicResumeSeed(
        slug,
        epicDirRelative(slug),
        productPlanningSkillDir(),
      );
    case "epic-run":
      return epicRunSeed(slug, epicDirRelative(slug));
    case "feature":
      return flowPipelineResumeSeed(slug);
    case "manager":
      return "/flow-manage --resume";
  }
}
