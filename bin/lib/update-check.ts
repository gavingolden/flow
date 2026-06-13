/**
 * Read-only staleness check — a sibling of `fastForwardCanonical` in
 * `bin/lib/git.ts` that NEVER mutates the tree. `flow ls` / `flow version`
 * surface its result as a non-blocking notice when the canonical checkout
 * is behind `origin/<default>`.
 *
 * Hard contract: `checkForUpdate` MUST NEVER THROW. Every risky step (spawn,
 * parse, fs) collapses to a typed `skipped`/`current` result. A 24h cache at
 * `FLOW_UPDATE_CACHE` throttles fetches so most calls do zero spawns.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveDefaultBranch, type Spawner } from "./git";
import { resolveFlowSource, FLOW_UPDATE_CACHE, FLOW_CONFIG } from "./paths";
import { dimStderr } from "./color";
import { spawnSync } from "node:child_process";

const THROTTLE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const UPGRADE_CMD = "flow setup --upgrade";

export type UpdateCheckSkippedReason =
  | "not-a-git-repo"
  | "no-default-branch"
  | "fetch-failed"
  | "disabled"
  | "error";

export type UpdateCheckResult =
  | { status: "behind"; behind: number; upgradeCmd: string }
  | { status: "current" }
  | { status: "skipped"; reason: UpdateCheckSkippedReason };

export type UpdateCheckOptions = {
  source?: string;
  spawn?: Spawner;
  now?: number;
  cachePath?: string;
  readConfigFile?: () => unknown;
  env?: NodeJS.ProcessEnv;
};

const defaultSpawn: Spawner = (cmd, args, options) =>
  spawnSync(cmd, args, options);

const defaultReadConfigFile = (): unknown => {
  try {
    return JSON.parse(fs.readFileSync(FLOW_CONFIG, "utf8"));
  } catch {
    return undefined;
  }
};

type UpdateConfig = { checkFor: "notify" | "off"; autoUpgrade: boolean };

/**
 * Tolerant boundary reader for `~/.flow/config.json` `update.*`, modeled on
 * `copilot-config.ts`'s `extractBotsCopilot`. `autoUpgrade` is a read-but-
 * unused stub in v1 — parsed for symmetry with the README's reserved flag.
 */
function extractUpdateConfig(raw: unknown): UpdateConfig {
  const defaults: UpdateConfig = { checkFor: "notify", autoUpgrade: false };
  if (typeof raw !== "object" || raw === null) return defaults;
  const update = (raw as Record<string, unknown>).update;
  if (typeof update !== "object" || update === null) return defaults;
  const u = update as Record<string, unknown>;
  return {
    checkFor: u.checkFor === "off" ? "off" : "notify",
    autoUpgrade: typeof u.autoUpgrade === "boolean" ? u.autoUpgrade : false,
  };
}

type CacheEntry = { lastCheckedMs: number; behind: number };

function readCache(cachePath: string): CacheEntry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const lastCheckedMs = r.lastCheckedMs;
    const behind = r.behind;
    if (
      typeof lastCheckedMs !== "number" ||
      !Number.isFinite(lastCheckedMs) ||
      typeof behind !== "number" ||
      !Number.isFinite(behind)
    ) {
      return null;
    }
    return { lastCheckedMs, behind };
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, entry: CacheEntry): void {
  // Best-effort: a cache-write failure must never surface to the caller —
  // the next run simply re-fetches. Mirrors `writeManifest` in manifest.ts.
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2) + "\n");
  } catch {
    /* swallow */
  }
}

function behindResult(behind: number): UpdateCheckResult {
  return behind > 0
    ? { status: "behind", behind, upgradeCmd: UPGRADE_CMD }
    : { status: "current" };
}

export function checkForUpdate(
  opts: UpdateCheckOptions = {},
): UpdateCheckResult {
  const spawn = opts.spawn ?? defaultSpawn;
  const now = opts.now ?? Date.now();
  const cachePath = opts.cachePath ?? FLOW_UPDATE_CACHE;
  const env = opts.env ?? process.env;
  const readConfigFile = opts.readConfigFile ?? defaultReadConfigFile;

  try {
    if (env.FLOW_UPDATE_CHECK === "off") {
      return { status: "skipped", reason: "disabled" };
    }
    const config = extractUpdateConfig(readConfigFile());
    if (config.checkFor === "off") {
      return { status: "skipped", reason: "disabled" };
    }

    const cache = readCache(cachePath);
    if (cache && now - cache.lastCheckedMs < THROTTLE_MS) {
      return behindResult(cache.behind);
    }

    const source = opts.source ?? resolveFlowSource();

    const status = spawn("git", ["status", "--porcelain"], {
      cwd: source,
      encoding: "utf8",
    });
    // Read-only: a dirty tree is fine — we only count commits, never merge.
    if (status.status !== 0) {
      return { status: "skipped", reason: "not-a-git-repo" };
    }

    const defaultBranch = resolveDefaultBranch(source, spawn);
    if (!defaultBranch) {
      return { status: "skipped", reason: "no-default-branch" };
    }

    const fetch = spawn("git", ["fetch", "origin", defaultBranch], {
      cwd: source,
      encoding: "utf8",
      timeout: FETCH_TIMEOUT_MS,
    });
    // A non-zero exit OR a timeout (spawnSync sets status=null on timeout)
    // both land here. Write the throttle cache so the 24h window also
    // suppresses repeated failed/slow fetches on the hot path — without it,
    // every `flow ls`/`flow version` re-runs the blocking fetch.
    if (fetch.status !== 0) {
      writeCache(cachePath, { lastCheckedMs: now, behind: 0 });
      return { status: "skipped", reason: "fetch-failed" };
    }

    const count = spawn(
      "git",
      ["rev-list", "--count", `HEAD..origin/${defaultBranch}`],
      { cwd: source, encoding: "utf8" },
    );
    const behind = (() => {
      if (count.status !== 0) return 0;
      const n = Number((count.stdout ?? "").trim());
      return Number.isFinite(n) ? n : 0;
    })();

    writeCache(cachePath, { lastCheckedMs: now, behind });
    return behindResult(behind);
  } catch {
    // Any unanticipated throw collapses to a skipped result — the notice is
    // non-blocking, so a failed check must never break `flow ls`/`version`.
    // Distinct from the explicit "not-a-git-repo" status-exit path so callers
    // can tell a genuine non-repo apart from an unexpected internal error.
    return { status: "skipped", reason: "error" };
  }
}

export function formatUpdateNotice(result: UpdateCheckResult): string | null {
  if (result.status !== "behind") return null;
  const { behind, upgradeCmd } = result;
  return dimStderr(
    `flow: ${behind} commit${behind === 1 ? "" : "s"} behind — run \`${upgradeCmd}\` to update`,
  );
}
