/**
 * The epic seed builders — extracted out of `bin/lib/epic.ts` so the
 * `SessionStart:clear` hook (`bin/flow-session-start-hook.ts`) can build an
 * epic resume seed without pulling in the epic CLI's whole module graph
 * (`epic-reconcile`, `epic-launch`, `epic-render`, `flow-epic-dag`,
 * `epic-run-state`, `epic-config`, `lock`, `confirm`, `models-config`,
 * `launcher-config`). The hook blocks session start on EVERY `/clear`
 * machine-wide, so this module imports only `node:path`, `./paths`, and the
 * dependency-light `./seed-delivery` (itself zero-import) for
 * `sanitizeSeedLine` — deliberately NOT `./state`, whose transitive graph
 * this module exists to avoid.
 *
 * The seed text is defined ONCE in these helpers and delivered ONLY via
 * send-keys by the verified launcher (no positional argv copy), so there is
 * no second definition to drift from. The literal EPIC_DIR is embedded (R1)
 * so the /flow-epic-create supervisor + the MODE: epic designer consume it
 * directly rather than re-deriving the path via a bin/lib import they can't
 * reach in a consumer worktree. Every seed built here is a SINGLE
 * control-char-free line — `epicCreateSeed`'s prompt no longer rides the
 * seed at all; the caller (epic.ts) writes it to a request file first and
 * passes the resolved path in as `requestFile`.
 */

import * as path from "node:path";
import { resolveFlowSource } from "./paths";
import { sanitizeSeedLine } from "./seed-delivery";

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
  requestFile: string,
): string {
  // Single control-char-free line, capture-verified against a visible-pane-only
  // `capture-pane -p` (see seed-delivery.ts). The prompt itself no longer
  // rides the seed — it is written to `requestFile` (state.ts:writeRequestFile)
  // by the caller BEFORE the launcher dispatch, and only its path travels
  // here. Sanitize the COMPOSED line, mirroring feature.ts's flowPipelineSeed —
  // structural, not per-argument, so a future call site that inlines free-form
  // text back into this template inherits the same guarantee.
  return sanitizeSeedLine(
    `Use the /flow-epic-create skill. REQUEST_FILE: ${requestFile} EPIC_DIR: ${epicDir} SKILL_DIR: ${skillDir}`,
  );
}

export function epicResumeSeed(
  slug: string,
  epicDir: string,
  skillDir: string,
): string {
  // The supervisor parses this prefix to detect resume mode and walk its
  // `# Resume mode` decision via flow-epic-resume-decide. Sanitize the
  // COMPOSED line, mirroring epicCreateSeed above — structural, not
  // per-argument, so this stays a single control-char-free line even if a
  // future call site inlines free-form text back into the template.
  return sanitizeSeedLine(
    `Use the /flow-epic-create skill in --resume mode for: ${slug} EPIC_DIR: ${epicDir} SKILL_DIR: ${skillDir}`,
  );
}

// The /flow-epic-run supervisor's seed. Mirrors epicCreateSeed: the slug after
// `for:` + the literal EPIC_DIR (R1), so the spawned window (cwd'd in a
// consumer worktree without bin/lib) consumes them directly. The SKILL
// parses this prefix to enter the playbook. No AUTO_REDIRECT / MODEL_JUDGE
// lines — the playbook has no tick loop, no judgment sub-agent, and no
// autonomous redirect to gate.
export function epicRunSeed(slug: string, epicDir: string): string {
  // Sanitize the COMPOSED line, same discipline as epicCreateSeed /
  // epicResumeSeed above — structural, not per-argument.
  return sanitizeSeedLine(
    `Use the /flow-epic-run skill for: ${slug} EPIC_DIR: ${epicDir}`,
  );
}
