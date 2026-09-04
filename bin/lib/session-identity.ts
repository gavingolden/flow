/**
 * Ambient pipeline-slug resolution, env-only: `FLOW_SLUG` (set in the launch
 * env by both launcher backends) is the sole carrier. Per `AGENTS.md`'s
 * signal order, `~/.flow/state/<slug>.json` and on-disk `.flow-tmp/*`
 * artifacts remain the rungs for pipeline *facts* once the slug is known —
 * they are not alternate slug sources.
 */

import { resolveKindFromPane, type ResolveSlugDeps } from "./tmux";
import { isValidSlug } from "./slug";
import type { PipelineKind } from "./state";

/**
 * The slug from `FLOW_SLUG`, or null unless the value passes `isValidSlug`
 * (shape-validated: a malformed/injected value must not name a state file).
 */
export function resolveSlugFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const slug = env.FLOW_SLUG;
  if (slug === undefined || !isValidSlug(slug)) return null;
  return slug;
}

/**
 * Env-only ambient resolution: `FLOW_SLUG` when valid, else null.
 */
export function resolveSlugAmbient(
  deps: { env?: NodeJS.ProcessEnv } = {},
): string | null {
  return resolveSlugFromEnv(deps.env ?? process.env);
}

/**
 * Ambient window-kind resolution: a thin pass-through to
 * `resolveKindFromPane`, deliberately WITHOUT an env-var arm. Unlike the
 * slug, the kind must stay per-pane: the epic launch argv exports
 * `FLOW_SLUG` (`bin/lib/epic.ts:2122`), so any shell the user `cd`s into
 * from that pane inherits it — a parallel `FLOW_KIND` env var would combine
 * with that inherited slug to make an arbitrary descendant shell look like a
 * live epic supervisor to the `SessionStart:clear` hook.
 *
 * This pane-only signal is safe TODAY only because epic orchestration is
 * itself tmux-only: `runCreate` explicitly refuses a non-tmux launcher
 * backend (the `backend.id !== "tmux"` guard in `bin/lib/epic.ts`), and
 * `spawnEpicRunSupervisor` carries no separate check because it launches
 * through the same tmux-only `createWindowVerified` unconditionally — so a
 * live epic window always has the `@flow-kind` pane option set. A `null`
 * return degrades to the `"feature"` default at the call site
 * (`resolveKind() ?? "feature"` in `bin/flow-checkpoint.ts`), so a bare
 * plain-shell feature pipeline — which never sets the option at all —
 * resolves correctly by construction, not by luck.
 *
 * Forward-compat warning: if epic orchestration ever supports the plain
 * launcher, this function becomes SILENTLY wrong (a live epic pipeline
 * would read `null` and misresolve to `"feature"`), and the kind signal
 * must move to a backend-agnostic carrier BEFORE that happens. The carrier
 * choice is deliberately left open here — an env var is ruled out for the
 * leak reason above. `PipelineState.kind` now EXISTS as an optional DISPLAY
 * carrier (`bin/lib/state.ts`, read by `flow ls`'s KIND column) — but this
 * function deliberately still does NOT read it: the display use is safe
 * because an absent value there degrades to a correctly-derived fallback
 * cell, while the identity use here is NOT — an absent value could
 * silently misresolve and let the `SessionStart:clear` hook drive a live
 * epic supervisor with a feature seed. If epic orchestration ever supports
 * the plain launcher, `state.kind` plus the `isEpicPhase` fallback is the
 * carrier to move to.
 *
 * Producing-site note (AGENTS.md's both-sites rule): `@flow-kind` is now
 * published on feature windows too (`bin/lib/feature.ts`), not just epic
 * windows — this function's pane-only read is unaffected, since every
 * live window of every kind now carries the option.
 */
export function resolveKindAmbient(
  deps: ResolveSlugDeps = {},
): PipelineKind | null {
  return resolveKindFromPane(deps);
}
