/**
 * `flow migrate` — exit ramp from per-repo `flow install`.
 *
 * Discovery: parse the two managed gitignore blocks (`install-skills`,
 * `install-scripts`), enumerate the paths they list, decide what to remove.
 *
 * Safety:
 *   - Refuse to proceed when `.orchestrator/tasks/` contains non-terminal
 *     tasks (the user has in-flight work).
 *   - Only delete symlinks. A real file at a managed path means the user
 *     has replaced the symlink with their own content; warn, don't delete.
 *   - Idempotent: a second --apply run is a no-op.
 *
 * Modes:
 *   default               dry-run, print plan, exit 0.
 *   --apply               execute the plan.
 *   --include-orchestrator  also rm -rf .orchestrator/.
 *   --scan <path>         dry-run across every git repo under <path>.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseManagedBlockPaths,
  readGitignore,
  removeManagedBlock,
  writeGitignore,
} from "./gitignore";
import { argsContainHelp, printVerbHelp } from "./help";

export type MigrateOptions = {
  apply?: boolean;
  includeOrchestrator?: boolean;
  scan?: string;
};

export type MigratePlan = {
  repoRoot: string;
  symlinksToRemove: string[];
  realFilesEncountered: string[];
  hasOrchestrator: boolean;
  blockedTasks: { id: string; status: string }[];
  blocks: { tag: string; present: boolean; paths: string[] }[];
};

const MANAGED_BLOCKS = ["install-skills", "install-scripts"] as const;

/**
 * CLI shim for `bin/flow`'s `migrate` verb. Intercepts --help / -h before
 * any gitignore parse or repo scan, then parses --apply / --scan /
 * --include-orchestrator and dispatches to `runMigrate`. The previous
 * inline `runMigrateVerb` lived in `bin/flow`.
 */
export function runMigrateCli(args: string[], cwd?: string): number {
  if (argsContainHelp(args)) {
    printVerbHelp("migrate");
    return 0;
  }
  const apply = args.includes("--apply");
  const includeOrchestrator = args.includes("--include-orchestrator");
  const scanIdx = args.indexOf("--scan");
  const scan = scanIdx >= 0 ? args[scanIdx + 1] : undefined;
  if (scanIdx >= 0 && !scan) {
    console.error("flow migrate: --scan requires a path argument.");
    return 1;
  }
  return runMigrate({ apply, includeOrchestrator, scan }, cwd);
}

export function runMigrate(
  options: MigrateOptions = {},
  cwd = process.cwd(),
): number {
  if (options.scan) return runScan(options.scan, options);

  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) {
    console.error(`flow migrate: ${cwd} is not inside a git repository.`);
    return 1;
  }

  const plan = buildPlan(repoRoot);
  printPlan(plan, options);

  if (plan.blockedTasks.length > 0) {
    console.error(
      `\nflow migrate: refusing to proceed — non-terminal tasks in .orchestrator/tasks/.`,
    );
    console.error(`  resolve or abort each task first, then re-run.`);
    return 1;
  }

  if (!options.apply) {
    console.log(`\n(dry-run — pass --apply to commit)`);
    return 0;
  }

  return applyPlan(plan, options);
}

function runScan(root: string, options: MigrateOptions): number {
  if (options.apply) {
    console.error("flow migrate --scan is dry-run only. Run --apply per-repo.");
    return 1;
  }
  const repos = findGitRepos(root);
  if (repos.length === 0) {
    console.log(`no git repositories under ${root}.`);
    return 0;
  }
  for (const repo of repos) {
    const plan = buildPlan(repo);
    if (plan.symlinksToRemove.length === 0 && !plan.hasOrchestrator) continue;
    console.log(`\n--- ${repo} ---`);
    printPlan(plan, options);
  }
  return 0;
}

export function buildPlan(repoRoot: string): MigratePlan {
  const gitignore = readGitignore(repoRoot) ?? "";
  const blocks = MANAGED_BLOCKS.map((tag) => {
    const paths = parseManagedBlockPaths(gitignore, tag);
    return { tag, present: paths.length > 0, paths };
  });

  const symlinksToRemove: string[] = [];
  const realFilesEncountered: string[] = [];

  for (const block of blocks) {
    for (const rawPath of block.paths) {
      const rel = rawPath.replace(/^\//, "");
      const abs = path.join(repoRoot, rel);
      const stat = lstatOrNull(abs);
      if (!stat) continue; // already gone
      if (stat.isSymbolicLink()) symlinksToRemove.push(abs);
      else realFilesEncountered.push(abs);
    }
  }

  const hasOrchestrator =
    lstatOrNull(path.join(repoRoot, ".orchestrator")) !== null;
  const blockedTasks = scanNonTerminalTasks(
    path.join(repoRoot, ".orchestrator", "tasks"),
  );

  return {
    repoRoot,
    symlinksToRemove,
    realFilesEncountered,
    hasOrchestrator,
    blockedTasks,
    blocks,
  };
}

function applyPlan(plan: MigratePlan, options: MigrateOptions): number {
  let removed = 0;
  for (const link of plan.symlinksToRemove) {
    try {
      fs.unlinkSync(link);
      removed++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  ! could not remove ${link}: ${msg}`);
    }
  }

  // Strip the managed gitignore blocks (whether or not they had any
  // surviving paths — they're being retired).
  const before = readGitignore(plan.repoRoot);
  if (before !== null) {
    let next = before;
    for (const block of MANAGED_BLOCKS) next = removeManagedBlock(next, block);
    if (next !== before) {
      writeGitignore(plan.repoRoot, next);
      console.log(`  ~ stripped managed gitignore blocks`);
    }
  }

  if (options.includeOrchestrator && plan.hasOrchestrator) {
    fs.rmSync(path.join(plan.repoRoot, ".orchestrator"), {
      recursive: true,
      force: true,
    });
    console.log(`  - removed .orchestrator/`);
  }

  console.log(`\nflow migrate: applied. removed ${removed} symlink(s).`);
  return 0;
}

function printPlan(plan: MigratePlan, options: MigrateOptions): void {
  console.log(`flow migrate: ${plan.repoRoot}`);

  if (plan.blocks.every((b) => !b.present) && !plan.hasOrchestrator) {
    console.log(`  nothing to migrate. no managed gitignore blocks found.`);
    return;
  }

  for (const block of plan.blocks) {
    if (!block.present) continue;
    console.log(
      `  block '${block.tag}': ${block.paths.length} path(s) tracked`,
    );
  }

  for (const link of plan.symlinksToRemove) {
    console.log(
      `  - ${path.relative(plan.repoRoot, link)}  (symlink — will be removed)`,
    );
  }

  for (const file of plan.realFilesEncountered) {
    console.log(
      `  ! ${path.relative(plan.repoRoot, file)}  (real file — left untouched)`,
    );
  }

  if (plan.hasOrchestrator) {
    if (options.includeOrchestrator) {
      console.log(
        `  - .orchestrator/  (will be removed; --include-orchestrator)`,
      );
    } else {
      console.log(
        `  . .orchestrator/  (kept; pass --include-orchestrator to delete)`,
      );
    }
  }

  if (plan.blockedTasks.length > 0) {
    console.log(
      `  blocked: ${plan.blockedTasks.length} non-terminal task(s) in .orchestrator/tasks/`,
    );
    for (const t of plan.blockedTasks)
      console.log(`    - ${t.id} (${t.status})`);
  }
}

function scanNonTerminalTasks(
  tasksDir: string,
): { id: string; status: string }[] {
  if (!existsDir(tasksDir)) return [];
  const blocked: { id: string; status: string }[] = [];
  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const content = fs.readFileSync(path.join(tasksDir, entry.name), "utf8");
    const match = content.match(/^status:\s*([\w-]+)/m);
    if (!match) continue;
    const status = match[1];
    if (isTerminalStatus(status)) continue;
    blocked.push({ id: entry.name.replace(/\.md$/, ""), status });
  }
  return blocked;
}

function isTerminalStatus(status: string): boolean {
  // Conservative list. False positives here just delay migration;
  // false negatives would let migrate proceed with in-flight work.
  // `merged` and `aborted` are the canonical terminal statuses per
  // docs/task-schema.md; `cancelled`, `abandoned`, `done` are kept as
  // legacy/synonym safety nets in case older tasks predate the schema.
  return ["merged", "aborted", "cancelled", "abandoned", "done"].includes(
    status,
  );
}

function findGitRepos(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isDirectory() && e.name === ".git")) {
      out.push(dir);
      return; // don't descend into a repo
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(path.resolve(root), 0);
  return out;
}

function resolveRepoRoot(cwd: string): string | null {
  // node:child_process.spawnSync (not Bun.spawnSync) so vitest tests, which
  // run on Node, can exercise this path. Bun runs this happily too.
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out || null;
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}
