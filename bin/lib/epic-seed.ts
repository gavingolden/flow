/**
 * The epic seed builders — extracted out of `bin/lib/epic.ts` so the
 * `SessionStart:clear` hook (`bin/flow-session-start-hook.ts`) can build an
 * epic resume seed without pulling in the epic CLI's whole module graph
 * (`epic-reconcile`, `epic-launch`, `epic-render`, `flow-epic-dag`,
 * `epic-run-state`, `epic-config`, `lock`, `confirm`, `models-config`,
 * `launcher-config`). The hook blocks session start on EVERY `/clear`
 * machine-wide, so this module imports only `node:path` and `./paths`.
 *
 * The seed text is defined ONCE in these helpers and delivered ONLY via
 * send-keys by the verified launcher (no positional argv copy), so there is
 * no second definition to drift from. The literal EPIC_DIR is embedded (R1)
 * so the /flow-epic-create supervisor + the MODE: epic designer consume it
 * directly rather than re-deriving the path via a bin/lib import they can't
 * reach in a consumer worktree.
 */

import * as path from "node:path";
import { resolveFlowSource } from "./paths";

/**
 * Resolved absolute path to the product-planning skill, embedded (R1) in
 * both epic seeds so the spawned `/flow-epic-create` supervisor can pass a
 * concrete `SKILL_DIR` into its Task-spawned `MODE: epic` designer. The
 * supervisor runs cwd'd in a consumer worktree without `bin/lib`, so it
 * cannot resolve this itself — the CLI / hook (flow's own installed code)
 * resolves it symlink-aware via `resolveFlowSource()` and threads it through.
 */
export function productPlanningSkillDir(): string {
  return path.join(
    resolveFlowSource(),
    "skills",
    "pipeline",
    "flow-product-planning",
  );
}

export function epicCreateSeed(
  prompt: string,
  epicDir: string,
  skillDir: string,
): string {
  return `Use the /flow-epic-create skill for: ${prompt}\n\nEPIC_DIR: ${epicDir}\n\nSKILL_DIR: ${skillDir}`;
}

export function epicResumeSeed(
  slug: string,
  epicDir: string,
  skillDir: string,
): string {
  // The supervisor parses this prefix to detect resume mode and walk its
  // `# Resume mode` decision via flow-epic-resume-decide.
  return `Use the /flow-epic-create skill in --resume mode for: ${slug}\n\nEPIC_DIR: ${epicDir}\n\nSKILL_DIR: ${skillDir}`;
}

// The /flow-epic-run supervisor's seed. Mirrors epicCreateSeed: the slug after
// `for:` + the literal EPIC_DIR (R1) on its own line, so the spawned window
// (cwd'd in a consumer worktree without bin/lib) consumes them directly. The
// SKILL parses this prefix to enter the playbook. No AUTO_REDIRECT / MODEL_JUDGE
// lines — the playbook has no tick loop, no judgment sub-agent, and no
// autonomous redirect to gate.
export function epicRunSeed(slug: string, epicDir: string): string {
  return `Use the /flow-epic-run skill for: ${slug}\n\nEPIC_DIR: ${epicDir}`;
}
