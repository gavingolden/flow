/**
 * Pure cores for `flow-request-copilot`: the glob classifier and the
 * tri-state precedence resolver. Extracted here (no fs / no gh) so they
 * stay unit-testable and keep `flow-request-copilot.ts` under the
 * 200-line budget.
 */

import picomatch from "picomatch";
import type { CopilotGlobs } from "./copilot-config";

export type GlobClass = "always-review" | "never-alone" | "ambiguous";
export type ReviewOverride = "auto" | "always" | "never";
export type AgentDecision = "trivial" | "non-trivial";

/**
 * Pure glob classifier. Precedence:
 *   - any path matches an `alwaysReview` glob          → 'always-review'
 *   - else EVERY path matches some `neverAlone` glob    → 'never-alone'
 *   - else                                              → 'ambiguous'
 *   - EMPTY paths                                       → 'never-alone'
 * picomatch gives true glob semantics (`**`, `*`, `{a,b}`, `!`).
 */
export function classifyByGlobs(
  paths: string[],
  globs: CopilotGlobs,
): GlobClass {
  if (paths.length === 0) return "never-alone";
  const matchesAlways = picomatch(globs.alwaysReview);
  if (paths.some((p) => matchesAlways(p))) return "always-review";
  const matchesNever = picomatch(globs.neverAlone);
  if (paths.every((p) => matchesNever(p))) return "never-alone";
  return "ambiguous";
}

/**
 * Pure precedence resolver: tri-state override × glob class × inline
 * judgment → request boolean. 'always' → true, 'never' → false; 'auto'
 * (or undefined) defers to the glob class — 'always-review' → true,
 * 'never-alone' → false, 'ambiguous' → the agent's judgment ('non-trivial'
 * → true, 'trivial' → false, undefined/unknown → true, fail-open).
 */
export function resolveRequestDecision(args: {
  override?: ReviewOverride;
  globClass: GlobClass;
  agentDecision?: AgentDecision;
}): boolean {
  if (args.override === "always") return true;
  if (args.override === "never") return false;
  switch (args.globClass) {
    case "always-review":
      return true;
    case "never-alone":
      return false;
    case "ambiguous":
      if (args.agentDecision === "trivial") return false;
      return true; // 'non-trivial' OR undefined/unknown → fail-open to request
  }
}

/**
 * Discriminates the BENIGN 422 (Copilot is not a requestable collaborator on
 * this repo — e.g. the bot isn't installed / org policy disallows it) from a
 * genuine `requested_reviewers` POST failure (403, network, malformed) which
 * must stay loud and fail-open. GitHub's 422 body for the benign case carries
 * the substring "may only be requested from collaborators"; match it
 * case-insensitively and narrowly. Pure (no fs, no gh) so it stays
 * unit-testable.
 */
export function isNotRequestableCollaborator422(stderr: string): boolean {
  return stderr
    .toLowerCase()
    .includes("may only be requested from collaborators");
}
