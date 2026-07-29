/**
 * Ambient pipeline-slug resolution, env-first: the `FLOW_SLUG` env var (set
 * in the launch env by both launcher backends) wins over the tmux pane's
 * `@flow-slug` window option (`resolveSlugFromPane`, which stays exported
 * from `tmux.ts` for tmux-specific callers). Env-first because the env var
 * is backend-agnostic and immutable for the life of the session, while the
 * pane option only exists under the tmux launcher.
 */

import {
  resolveKindFromPane,
  resolveSlugFromPane,
  type ResolveSlugDeps,
} from "./tmux";
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
 * Env-first ambient resolution: `FLOW_SLUG` when valid, else the tmux pane's
 * `@flow-slug` option, else null.
 */
export function resolveSlugAmbient(
  deps: ResolveSlugDeps & { env?: NodeJS.ProcessEnv } = {},
): string | null {
  const fromEnv = resolveSlugFromEnv(deps.env ?? process.env);
  if (fromEnv !== null) return fromEnv;
  return resolveSlugFromPane(deps);
}

/**
 * Ambient window-kind resolution: a thin pass-through to
 * `resolveKindFromPane`, deliberately WITHOUT an env-var arm. Unlike the
 * slug, the kind must stay per-pane: once the epic launch argv exports
 * `FLOW_SLUG` (Task 9), any shell the user `cd`s into from that pane
 * inherits it — a parallel `FLOW_KIND` env var would combine with that
 * inherited slug to make an arbitrary descendant shell look like a live
 * epic supervisor to the `SessionStart:clear` hook.
 */
export function resolveKindAmbient(
  deps: ResolveSlugDeps = {},
): PipelineKind | null {
  return resolveKindFromPane(deps);
}
