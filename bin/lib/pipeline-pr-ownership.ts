import { FLOW_STATE_DIR } from "./paths";
import { resolveSlugAmbient } from "./session-identity";
import { readState } from "./state";

export function prNotOwnedReason(
  statePr: number | null | undefined,
  pr: number,
): string {
  const own = statePr == null ? " has no PR yet" : `'s PR is #${statePr}`;
  return `pr-not-owned: this pipeline${own}, not #${pr}`;
}

/**
 * Inside a live pipeline (an ambient slug resolves), the comment helpers may
 * act only on that pipeline's own PR. With no ambient slug there is no
 * pipeline to bind to, so the check does not apply.
 */
export function checkOwnPipelinePr(
  pr: number,
  deps: { env?: NodeJS.ProcessEnv; stateDir?: string } = {},
): { ok: true } | { ok: false; reason: string } {
  const slug = resolveSlugAmbient({ env: deps.env });
  if (slug === null) return { ok: true };
  const state = readState(slug, deps.stateDir ?? FLOW_STATE_DIR);
  if (state === null)
    return { ok: false, reason: `no-pipeline-state: ${slug}` };
  if (state.pr !== pr) {
    return {
      ok: false,
      reason: prNotOwnedReason(state.pr, pr),
    };
  }
  return { ok: true };
}
