import { FLOW_STATE_DIR } from "./paths";
import { resolveSlugAmbient } from "./session-identity";
import { readState } from "./state";

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
      reason: `pr-not-owned: state.pr is ${state.pr ?? "unset"}, not #${pr}`,
    };
  }
  return { ok: true };
}
