#!/usr/bin/env bun
/**
 * Atomically opens a PR (via `gh`) and writes its number into
 * ~/.flow/state/<slug>.json so `flow ls` immediately shows it.
 *
 * Why: previously the supervisor ran `gh pr create` + `gh pr view --jq .number`
 * + `flow-state-update --pr` as three separate calls. A crash between the
 * first and the third left the PR open with `pr: —` in state.json. This
 * helper collapses the sequence into one idempotent step — re-running it
 * against an already-PR'd branch reads the number back via `gh pr view`
 * instead of failing on `gh pr create`'s "already exists" error.
 *
 * Usage:
 *   flow-open-pr <slug> --body-file <path>
 *                       [--title <title>] [--draft] [--base <branch>]
 */

import { spawnSync } from "node:child_process";
import { runUpdate } from "./flow-state-update";

type Args = {
  slug: string;
  bodyFile: string;
  title?: string;
  draft: boolean;
  base?: string;
};

type GhResult = { stdout: string; stderr: string; exitCode: number };

type PrInfo = { number: number; url: string };

export function parseArgs(argv: string[]): Args | { error: string } {
  if (argv.length === 0) return { error: "slug is required" };
  const [slug, ...rest] = argv;
  if (slug.startsWith("--")) return { error: "slug must be the first positional argument" };

  const out: Args = { slug, bodyFile: "", draft: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    switch (flag) {
      case "--draft":
        out.draft = true;
        continue;
      case "--body-file":
      case "--title":
      case "--base": {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("--")) {
          return { error: `${flag} requires a value` };
        }
        if (flag === "--body-file") out.bodyFile = value;
        if (flag === "--title") out.title = value;
        if (flag === "--base") out.base = value;
        i++;
        continue;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  if (!out.bodyFile) return { error: "--body-file is required" };
  return out;
}

function buildCreateArgv(args: Args): string[] {
  const out = ["pr", "create", "--body-file", args.bodyFile];
  if (args.title) out.push("--title", args.title);
  if (args.draft) out.push("--draft");
  if (args.base) out.push("--base", args.base);
  return out;
}

export type GhRunner = (argv: string[]) => GhResult;

const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

/**
 * Resolves a PR for the current branch. Used both as the post-create read
 * (idempotent — returns the same data whether `gh pr create` just succeeded
 * or returned "already exists") and as the test seam for the helper.
 */
export function readCurrentPr(gh: GhRunner): PrInfo | { error: string } {
  const r = gh(["pr", "view", "--json", "number,url"]);
  if (r.exitCode !== 0) {
    return { error: r.stderr.trim() || `gh pr view failed (${r.exitCode})` };
  }
  try {
    const parsed = JSON.parse(r.stdout) as { number?: number; url?: string };
    if (typeof parsed.number !== "number" || typeof parsed.url !== "string") {
      return { error: `gh pr view returned unexpected JSON: ${r.stdout}` };
    }
    return { number: parsed.number, url: parsed.url };
  } catch (e) {
    return { error: `gh pr view returned non-JSON: ${(e as Error).message}` };
  }
}

/**
 * The "already exists" condition is the only `gh pr create` failure that's
 * a fall-through (resume case): a previous `flow-open-pr` opened the PR but
 * crashed before writing state. Any other non-zero exit is a real failure.
 */
function isAlreadyExists(r: GhResult): boolean {
  if (r.exitCode === 0) return false;
  const text = (r.stderr + "\n" + r.stdout).toLowerCase();
  return text.includes("a pull request for branch") && text.includes("already exists");
}

export type Deps = {
  gh?: GhRunner;
  /** Test seam: pass a custom updater that mirrors `flow-state-update`'s `runUpdate` signature. */
  updater?: (argv: string[]) => number;
};

export function run(argv: string[], deps: Deps = {}): number {
  const gh = deps.gh ?? defaultGh;
  const updater = deps.updater ?? runUpdate;

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-open-pr: ${parsed.error}`);
    console.error(
      "usage: flow-open-pr <slug> --body-file <path> [--title <t>] [--draft] [--base <b>]",
    );
    return 2;
  }

  const created = gh(buildCreateArgv(parsed));
  if (created.exitCode !== 0 && !isAlreadyExists(created)) {
    if (created.stderr) process.stderr.write(created.stderr);
    if (created.stdout) process.stderr.write(created.stdout);
    return created.exitCode === -1 ? 1 : created.exitCode;
  }

  const pr = readCurrentPr(gh);
  if ("error" in pr) {
    console.error(`flow-open-pr: ${pr.error}`);
    return 1;
  }

  const updateExit = updater([parsed.slug, "--pr", String(pr.number)]);
  if (updateExit !== 0) return updateExit;

  console.log(pr.url);
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
