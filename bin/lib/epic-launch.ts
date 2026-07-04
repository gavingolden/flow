/**
 * Launching a feature = spawning the EXISTING `flow feature create`, never
 * reimplementing tmux/worktree/supervisor machinery. `buildFeatureCreateArgs`
 * maps a feature's `flowNewHints` to `flow feature create` flags;
 * `launchFeature` spawns `flow` and parses the authoritative slug from its
 * `flow:<slug>` stdout first line.
 *
 * Slug authority (the plan's #1 failure mode): the orchestrator passes
 * `--slug slugify(feature.id)` (a DAG-node id is unique within a manifest), so
 * the slug `flow feature create` mints equals `slugify(feature.id)`. The
 * orchestrator still records the slug parsed from the `flow:<slug>` stdout line
 * as authoritative, falling back to `slugify(feature.id)` only when that line is
 * absent (a non-standard build). Note: `flow feature create`'s auto-suffix on
 * collision applies only to its no-`--slug` derived-slug path, NOT the epic
 * path — an explicit `--slug` collision hard-fails rather than drifting the slug
 * away from the id the reconciler expects. A re-derived slug that drifts from
 * the real one silently stalls the watch loop forever.
 */

import { spawnSync as nodeSpawnSync } from "node:child_process";
import type { Feature } from "./epic-manifest-schema";
import { slugify } from "./slug";
import { FLOW_SESSION } from "./tmux";

/**
 * Pure: the `flow feature create` argv for a feature.
 * `["feature", "create", <description>, ...flags, "--slug", slugify(id)]`.
 * `flowNewHints` mapping: `autoMerge === false` → `--no-auto-merge` (absent or
 * `true` ⇒ no flag, since auto-merge is the default); `copilotReview` →
 * `--copilot-review <value>`; `effort` → `--effort <value>`. A trailing
 * `--slug slugify(feature.id)` always pins the slug to the unique DAG-node id.
 */
export function buildFeatureCreateArgs(feature: Feature): string[] {
  const args = ["feature", "create", feature.description];
  const hints = feature.flowNewHints ?? {};
  if (hints.autoMerge === false) args.push("--no-auto-merge");
  if (hints.copilotReview) args.push("--copilot-review", hints.copilotReview);
  if (hints.effort) args.push("--effort", hints.effort);
  // A DAG-node id is unique within a manifest, so an id-derived slug is
  // collision-free by construction — pass it explicitly to skip the
  // description-derived slug (whose token cap can collide across sibling ids).
  args.push("--slug", slugify(feature.id));
  return args;
}

export type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/** Spawn seam — production spawns the bare `flow` on PATH; tests stub it. */
export type SpawnFn = (command: string, args: string[]) => SpawnResult;

/**
 * Default spawn: `node:child_process` spawnSync (NOT `Bun.spawnSync`, which is
 * undefined in the vitest worker — same rationale as epic.ts/feature.ts).
 * Invokes the bare `flow` (the `flow install` PATH symlink), never the wrapper
 * source.
 */
const defaultSpawn: SpawnFn = (command, args) => {
  const r = nodeSpawnSync(command, args, { encoding: "utf8" });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

export type LaunchResult =
  | { ok: true; slug: string }
  | { ok: false; error: string };

/** Parse the `flow:<slug>` contract token from `flow feature create`'s stdout first line. */
function parseMintedSlug(stdout: string): string | null {
  const firstLine = stdout.split("\n", 1)[0]?.trim() ?? "";
  const prefix = `${FLOW_SESSION}:`;
  if (!firstLine.startsWith(prefix)) return null;
  const slug = firstLine.slice(prefix.length).trim();
  return slug.length > 0 ? slug : null;
}

/**
 * Spawn `flow feature create` for a feature and return the minted slug. A
 * non-zero exit (a `windowExists` collision, a launch failure) is SURFACED as
 * `{ ok: false, error }` — never swallowed — so the watch loop can report it
 * rather than silently dropping the feature. On success the slug comes from the
 * `flow:<slug>` stdout line; `slugify(feature.id)` is the fallback only when
 * that line is absent (a non-standard `flow feature create` build) — matching
 * the id-derived slug `--slug` actually requested, not the description.
 */
export function launchFeature(
  feature: Feature,
  opts: { spawn?: SpawnFn } = {},
): LaunchResult {
  const spawn = opts.spawn ?? defaultSpawn;
  const args = buildFeatureCreateArgs(feature);
  const r = spawn("flow", args);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").trim();
    return {
      ok: false,
      error: `flow feature create exited ${r.status ?? "null"}${detail ? `: ${detail}` : ""}`,
    };
  }
  const slug = parseMintedSlug(r.stdout) ?? slugify(feature.id);
  return { ok: true, slug };
}
