#!/usr/bin/env bun
/**
 * Maintainer-only release helper. Bumps the version, commits a
 * `chore(release): vX.Y.Z`, and creates an annotated `vX.Y.Z` tag via
 * `npm version <type>` — atomically, in one call. NEVER pushes; the maintainer
 * runs `git push --follow-tags` afterwards.
 *
 * Deliberately NOT symlinked onto PATH by `flow setup` (see the MAINTAINER_ONLY
 * exclusion in bin/lib/sources.ts) — it mutates the tree and creates tags, so
 * it must not ship to every user's PATH. Run it from a clean main checkout:
 *   bun bin/flow-release <patch|minor|major>
 */

import { resolveDefaultBranch, type Spawner } from "./lib/git";
import { readFlowVersion } from "./lib/pkg-version";
import { spawnSync } from "node:child_process";

export type ReleaseType = "patch" | "minor" | "major";

const RELEASE_TYPES: readonly ReleaseType[] = ["patch", "minor", "major"];

const defaultSpawn: Spawner = (cmd, args, options) =>
  spawnSync(cmd, args, options);

export function parseArgs(
  argv: string[],
): { type: ReleaseType } | { error: string } {
  const positional = argv.filter((a) => !a.startsWith("-"));
  if (positional.length === 0) {
    return {
      error: "missing release type — expected one of patch|minor|major",
    };
  }
  const type = positional[0];
  if (!RELEASE_TYPES.includes(type as ReleaseType)) {
    return {
      error: `invalid release type '${type}' — expected patch|minor|major`,
    };
  }
  return { type: type as ReleaseType };
}

export type RunOptions = {
  type: ReleaseType;
  cwd?: string;
  spawn?: Spawner;
  log?: (s: string) => void;
};

export type RunResult = { ok: boolean; version?: string; error?: string };

export function run(opts: RunOptions): RunResult {
  const spawn = opts.spawn ?? defaultSpawn;
  const cwd = opts.cwd;
  const log = opts.log ?? ((s: string) => console.log(s));

  const status = spawn("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  });
  if ((status.stdout ?? "").trim().length > 0) {
    return { ok: false, error: "refusing to release: working tree is dirty" };
  }

  const defaultBranch = resolveDefaultBranch(cwd ?? process.cwd(), spawn);
  const head = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  const current = (head.stdout ?? "").trim();
  if (current !== defaultBranch) {
    return {
      ok: false,
      error: `refusing to release: not on default branch ${defaultBranch} (on ${current})`,
    };
  }

  const version = spawn(
    "npm",
    ["version", opts.type, "-m", "chore(release): %s"],
    { cwd, encoding: "utf8" },
  );
  if (version.status !== 0) {
    const stderr = (version.stderr ?? "").trim();
    return {
      ok: false,
      error: stderr || `npm version ${opts.type} failed`,
    };
  }

  const newVersion = readFlowVersion(cwd ?? process.cwd());
  log(`Released v${newVersion}.`);
  log(`Created tag v${newVersion}. Push it with: git push --follow-tags`);
  return { ok: true, version: newVersion };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`flow-release: ${parsed.error}`);
    process.exit(1);
  }
  const result = run({ type: parsed.type });
  if (!result.ok) {
    console.error(`flow-release: ${result.error}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
