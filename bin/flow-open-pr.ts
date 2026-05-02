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
 * Result of probing for the current branch's PR.
 *   - "found": a PR exists; carries number + url.
 *   - "none":  no PR exists for this branch (gh's no-pr exit; happy path
 *              for a fresh-create).
 *   - "error": gh failed for some other reason; carries stderr.
 *
 * Why a discriminated union: the previous design used `gh pr create` first
 * and parsed its stderr text for "already exists" to detect resume cases.
 * That coupled correctness to gh's English error wording. The probe-first
 * design checks for the PR up front via `gh pr view`, so the resume vs
 * fresh-create branch is decided on a structured signal, not a string match.
 */
type ProbeResult =
  | { kind: "found"; number: number; url: string }
  | { kind: "none" }
  | { kind: "error"; message: string };

/**
 * Resolves the PR for the current branch (or determines that none exists).
 * Used both as the resume probe (called before `gh pr create`) and the
 * post-create read (called after a fresh create succeeds).
 *
 * `gh pr view` exits non-zero when no PR is associated with the current
 * branch. We distinguish that "expected absence" from a real gh failure by
 * scanning stderr for the canonical "no pull requests found" message —
 * absent that, we treat any non-zero exit as a real error rather than
 * silently returning "none".
 */
export function probePr(gh: GhRunner): ProbeResult {
  const r = gh(["pr", "view", "--json", "number,url"]);
  if (r.exitCode !== 0) {
    if (/no pull requests? found|no pull request associated/i.test(r.stderr)) {
      return { kind: "none" };
    }
    return { kind: "error", message: r.stderr.trim() || `gh pr view failed (${r.exitCode})` };
  }
  try {
    const parsed = JSON.parse(r.stdout) as { number?: number; url?: string };
    if (typeof parsed.number !== "number" || typeof parsed.url !== "string") {
      return { kind: "error", message: `gh pr view returned unexpected JSON: ${r.stdout}` };
    }
    return { kind: "found", number: parsed.number, url: parsed.url };
  } catch (e) {
    return { kind: "error", message: `gh pr view returned non-JSON: ${(e as Error).message}` };
  }
}

/**
 * Back-compat shape used by tests: `{ number, url } | { error }`. Adapts
 * `probePr` for callers that only care about the "PR exists" path.
 */
export function readCurrentPr(gh: GhRunner): PrInfo | { error: string } {
  const probe = probePr(gh);
  if (probe.kind === "found") return { number: probe.number, url: probe.url };
  if (probe.kind === "none") return { error: "no PR exists for the current branch" };
  return { error: probe.message };
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

  // Probe first: if a PR already exists for this branch (resume case), skip
  // `gh pr create` entirely. Avoids parsing gh's "already exists" stderr
  // message — the structured `pr view` signal is what we branch on.
  const probe = probePr(gh);
  let pr: PrInfo;
  if (probe.kind === "found") {
    pr = { number: probe.number, url: probe.url };
  } else if (probe.kind === "none") {
    const created = gh(buildCreateArgv(parsed));
    if (created.exitCode !== 0) {
      if (created.stderr) process.stderr.write(created.stderr);
      if (created.stdout) process.stderr.write(created.stdout);
      return created.exitCode === -1 ? 1 : created.exitCode;
    }
    // Re-probe to capture the number + url for the freshly-created PR.
    const after = probePr(gh);
    if (after.kind !== "found") {
      console.error(
        `flow-open-pr: gh pr create succeeded but no PR resolves for the current branch ` +
          `(${after.kind === "error" ? after.message : "no PR found"})`,
      );
      return 1;
    }
    pr = { number: after.number, url: after.url };
  } else {
    console.error(`flow-open-pr: ${probe.message}`);
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
