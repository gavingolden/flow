/**
 * Ambient pipeline-slug resolution, env-first: the `FLOW_SLUG` env var (set
 * in the launch env by both launcher backends) wins over the tmux pane's
 * `@flow-slug` window option (`resolveSlugFromPane`, which stays exported
 * from `tmux.ts` for tmux-specific callers). Env-first because the env var
 * is backend-agnostic and immutable for the life of the session, while the
 * pane option only exists under the tmux launcher.
 */

import { resolveSlugFromPane, type ResolveSlugDeps } from "./tmux";
import { isValidSlug } from "./slug";

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
