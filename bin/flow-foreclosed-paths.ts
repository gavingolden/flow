#!/usr/bin/env bun
/**
 * Foreclosed paths: persist the rejected-alternatives and anti-patterns the
 * /flow-pr-review Fix-Applier and Consolidator subagents recorded into a durable,
 * reviewer-visible `## Foreclosed Paths` section of the PR body.
 *
 * The full prose lives in `<worktree>/.flow-tmp/fix-applier-result.json` and
 * `consolidator-result.json` but today only reaches the terminal snapshot as
 * counts. This helper upserts it (idempotently) onto the GitHub PR page so it
 * survives squash-merge on the PR page and is visible to reviewers.
 *
 * Persistence caveat: the PR BODY is GitHub-page + reviewer-visible and
 * survives squash-merge on the PR page, but does NOT reach `git log` /
 * `git blame` — gh builds the squash commit from concatenated commit messages,
 * not the PR description. Git-history persistence would be a separate change.
 *
 * Usage:
 *   flow-foreclosed-paths pr-body-upsert <PR>
 *       [--fix-applier-result <path>] [--consolidator-result <path>]
 *
 * Exit codes:
 *   0 — success (including the no-op case: an empty entry set or absent
 *       artifacts; no `gh pr edit` fires).
 *   1 — gh / filesystem error during pr-body-upsert.
 *   2 — bad CLI args or missing required flags.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readState } from "./lib/state";
import { resolveSlugFromPane } from "./lib/tmux";
import { upsertPrBodySection } from "./lib/pr-body-upsert";
import {
  formatMarkdown,
  collectForeclosedEntries,
  isEmpty,
  FORECLOSED_HEADING,
} from "./lib/foreclosed-paths-format";

export type GhRunner = (argv: string[]) => {
  stdout: string;
  stderr: string;
  exitCode: number;
};

// --- Path resolution (mirrors flow-followups / flow-pipeline-summary) ---

export type ResolveDeps = {
  resolveSlug?: () => string | null;
  readStateFn?: typeof readState;
  cwd?: () => string;
};

/**
 * Resolves the worktree's `.flow-tmp` directory. Order: tmux pane → slug →
 * state.json `.worktree`, else cwd-relative (sub-skills cd into the worktree).
 */
function resolveFlowTmpDir(deps: ResolveDeps = {}): string {
  const resolveSlug = deps.resolveSlug ?? resolveSlugFromPane;
  const readSt = deps.readStateFn ?? readState;
  const slug = resolveSlug();
  if (slug) {
    const state = readSt(slug);
    if (state?.worktree) return path.join(state.worktree, ".flow-tmp");
  }
  const getCwd = deps.cwd ?? (() => process.cwd());
  return path.join(getCwd(), ".flow-tmp");
}

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

// --- CLI arg parsing ---

export type UpsertArgs = {
  pr: number;
  fixApplierResult?: string;
  consolidatorResult?: string;
};

export function parseUpsertArgs(
  argv: string[],
): UpsertArgs | { error: string } {
  if (argv.length === 0) return { error: "PR number is required" };
  const first = argv[0];
  const pr = Number.parseInt(first, 10);
  if (!Number.isFinite(pr) || pr <= 0 || String(pr) !== first) {
    return { error: `PR must be a positive integer, got '${first}'` };
  }
  const out: UpsertArgs = { pr };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    switch (flag) {
      case "--fix-applier-result":
        out.fixApplierResult = value;
        break;
      case "--consolidator-result":
        out.consolidatorResult = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  return out;
}

// --- Subcommand runner ---

export type UpsertDeps = {
  gh?: GhRunner;
  tmpDirFactory?: () => string;
  resolve?: ResolveDeps;
};

const defaultGh: GhRunner = (argv) => {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? -1,
  };
};

export function runUpsert(argv: string[], deps: UpsertDeps = {}): number {
  const parsed = parseUpsertArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-foreclosed-paths: ${parsed.error}`);
    console.error(
      "usage: flow-foreclosed-paths pr-body-upsert <PR>\n" +
        "                             [--fix-applier-result <path>] [--consolidator-result <path>]",
    );
    return 2;
  }

  const tmpDir = resolveFlowTmpDir(deps.resolve);
  const fixApplierPath =
    parsed.fixApplierResult ?? path.join(tmpDir, "fix-applier-result.json");
  const consolidatorPath =
    parsed.consolidatorResult ?? path.join(tmpDir, "consolidator-result.json");

  const fixApplierRaw = readFileOrEmpty(fixApplierPath);
  const consolidatorRaw = readFileOrEmpty(consolidatorPath);

  // No-op contract: nothing to surface → exit 0 without touching the PR.
  if (isEmpty(collectForeclosedEntries({ fixApplierRaw, consolidatorRaw }))) {
    return 0;
  }

  const gh = deps.gh ?? defaultGh;
  const view = gh([
    "pr",
    "view",
    String(parsed.pr),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
  if (view.exitCode !== 0) {
    console.error(
      `flow-foreclosed-paths: gh pr view failed: ${view.stderr.trim()}`,
    );
    return 1;
  }

  const currentBody = view.stdout;
  const section = formatMarkdown({ fixApplierRaw, consolidatorRaw }).join("\n");
  const newBody = upsertPrBodySection(currentBody, FORECLOSED_HEADING, section);
  if (newBody === currentBody) return 0;

  const tmpDirFactory =
    deps.tmpDirFactory ??
    (() => fs.mkdtempSync(path.join(os.tmpdir(), "flow-foreclosed-")));
  const scratch = tmpDirFactory();
  const tmpFile = path.join(scratch, "body.md");
  fs.writeFileSync(tmpFile, newBody);
  try {
    const edit = gh(["pr", "edit", String(parsed.pr), "--body-file", tmpFile]);
    if (edit.exitCode !== 0) {
      console.error(
        `flow-foreclosed-paths: gh pr edit failed: ${edit.stderr.trim()}`,
      );
      return 1;
    }
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  return 0;
}

// --- Top-level dispatcher ---

export function run(argv: string[]): number {
  if (argv.length === 0) {
    console.error(
      "flow-foreclosed-paths: subcommand is required (pr-body-upsert)",
    );
    return 2;
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case "pr-body-upsert":
      return runUpsert(rest);
    default:
      console.error(`flow-foreclosed-paths: unknown subcommand '${sub}'`);
      return 2;
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
