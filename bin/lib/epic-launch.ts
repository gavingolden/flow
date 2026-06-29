/**
 * Launching a feature = spawning the EXISTING `flow new`, never reimplementing
 * tmux/worktree/supervisor machinery. `buildFlowNewArgs` maps a feature's
 * `flowNewHints` to `flow new` flags; `launchFeature` spawns `flow` and parses
 * the authoritative slug from its `flow:<slug>` stdout first line.
 *
 * Slug authority (the plan's #1 failure mode): `flow new` may auto-suffix the
 * worktree slug on collision, so the orchestrator MUST record the slug `flow
 * new` actually minted — parsed from stdout — and fall back to
 * `slugify(description)` only when that line is absent. A re-derived slug that
 * drifts from the real one silently stalls the watch loop forever.
 */

import { spawnSync as nodeSpawnSync } from "node:child_process";
import type { Feature } from "./epic-manifest-schema";
import { slugify } from "./slug";
import { FLOW_SESSION } from "./tmux";

/**
 * Pure: the `flow new` argv for a feature. `["new", <description>, ...flags]`.
 * `flowNewHints` mapping: `autoMerge === false` → `--no-auto-merge` (absent or
 * `true` ⇒ no flag, since auto-merge is the default); `copilotReview` →
 * `--copilot-review <value>`; `effort` → `--effort <value>`.
 */
export function buildFlowNewArgs(feature: Feature): string[] {
  const args = ["new", feature.description];
  const hints = feature.flowNewHints ?? {};
  if (hints.autoMerge === false) args.push("--no-auto-merge");
  if (hints.copilotReview) args.push("--copilot-review", hints.copilotReview);
  if (hints.effort) args.push("--effort", hints.effort);
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
 * undefined in the vitest worker — same rationale as epic.ts/new.ts). Invokes
 * the bare `flow` (the `flow setup` PATH symlink), never the wrapper source.
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

/** Parse the `flow:<slug>` contract token from `flow new`'s stdout first line. */
function parseMintedSlug(stdout: string): string | null {
  const firstLine = stdout.split("\n", 1)[0]?.trim() ?? "";
  const prefix = `${FLOW_SESSION}:`;
  if (!firstLine.startsWith(prefix)) return null;
  const slug = firstLine.slice(prefix.length).trim();
  return slug.length > 0 ? slug : null;
}

/**
 * Spawn `flow new` for a feature and return the minted slug. A non-zero exit
 * (a `windowExists` collision, a launch failure) is SURFACED as
 * `{ ok: false, error }` — never swallowed — so the watch loop can report it
 * rather than silently dropping the feature. On success the slug comes from the
 * `flow:<slug>` stdout line; `slugify(description)` is the fallback only when
 * that line is absent (a non-standard `flow new` build).
 */
export function launchFeature(
  feature: Feature,
  opts: { spawn?: SpawnFn } = {},
): LaunchResult {
  const spawn = opts.spawn ?? defaultSpawn;
  const args = buildFlowNewArgs(feature);
  const r = spawn("flow", args);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").trim();
    return {
      ok: false,
      error: `flow new exited ${r.status ?? "null"}${detail ? `: ${detail}` : ""}`,
    };
  }
  const slug = parseMintedSlug(r.stdout) ?? slugify(feature.description);
  return { ok: true, slug };
}
