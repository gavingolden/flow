import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

export async function findGitRoot(cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], {
      cwd,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

// Returns the *primary* (main) worktree path when called from the primary or
// any secondary worktree of a standard repo. `--git-common-dir` resolves to
// `<main>/.git` (the per-worktree subdir's parent for child worktrees);
// stripping the trailing `.git` gives the main worktree.
//
// Fallback: in non-standard layouts (bare repos where the common dir is
// `<name>.git` next to the working trees, custom GIT_DIR, or git invocation
// failures), this falls back to `findGitRoot`, which returns the *current*
// worktree's toplevel — i.e. the caller's worktree, not necessarily the
// primary one. Flow callers operate on plain working repos so the primary
// path is what's exercised in practice; the fallback exists to keep `flow
// start` working in unusual layouts at the cost of the canonical-root
// guarantee. Returns null only when the cwd isn't inside any git repo.
export async function findCanonicalRoot(
  cwd?: string,
): Promise<string | null> {
  try {
    const { stdout } = await execa(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd },
    );
    const commonDir = stdout.trim();
    if (commonDir.endsWith(`${path.sep}.git`) || commonDir.endsWith("/.git")) {
      return path.dirname(commonDir);
    }
    // Bare repos / custom GIT_DIR — fall back to the current worktree
    // toplevel. Documented limitation; see header comment.
    return findGitRoot(cwd);
  } catch {
    return findGitRoot(cwd);
  }
}

export async function findTaskFile(
  taskId: string,
  repoRoot: string,
): Promise<string | null> {
  const candidates = [
    path.join(repoRoot, ".orchestrator", "tasks", `${taskId}.md`),
    path.join(repoRoot, ".orchestrator", "tasks", "archive", `${taskId}.md`),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

export type ResolvedTaskInput =
  | { kind: "ok"; path: string }
  | { kind: "not-found"; input: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "invalid"; reason: string };

// Classifies `input` and resolves it to a canonical task `.md` path under
// `<repoRoot>/.orchestrator/tasks/`. The four-case discriminated union lets
// the CLI surface distinct error wording for each failure mode without
// re-running the path classification itself.
//
// Path normalization uses `path.resolve` only; we deliberately do not
// `realpath` the input so a symlinked task tree does not produce a
// surprising "outside the tasks dir" failure when `findGitRoot` itself
// did not realpath the repo root.
export async function resolveTaskInput(
  input: string,
  repoRoot: string,
  cwd?: string,
): Promise<ResolvedTaskInput> {
  const tasksDir = path.join(repoRoot, ".orchestrator", "tasks");
  const isPathLike =
    path.isAbsolute(input) ||
    input.startsWith("~") ||
    input.startsWith(".") ||
    input.includes("/");

  if (!isPathLike) {
    const found = await findTaskFile(input, repoRoot);
    return found ? { kind: "ok", path: found } : { kind: "not-found", input };
  }

  const expanded =
    input === "~" || input.startsWith("~/")
      ? path.join(os.homedir(), input.slice(1))
      : input;
  const abs = path.resolve(cwd ?? process.cwd(), expanded);

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return { kind: "not-found", input };
  }

  if (stat.isFile()) {
    if (path.extname(abs) !== ".md") {
      return { kind: "invalid", reason: `expected a .md task file: ${abs}` };
    }
    const rel = path.relative(tasksDir, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        kind: "invalid",
        reason: `task file must live under ${tasksDir}: ${abs}`,
      };
    }
    const segments = rel.split(path.sep);
    const inTopLevel = segments.length === 1;
    const inArchive = segments.length === 2 && segments[0] === "archive";
    if (!inTopLevel && !inArchive) {
      return {
        kind: "invalid",
        reason:
          "only top-level task .md files in tasks/ or tasks/archive/ are accepted",
      };
    }
    return { kind: "ok", path: abs };
  }

  if (stat.isDirectory()) {
    const rel = path.relative(tasksDir, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        kind: "invalid",
        reason: `directory must be under ${tasksDir}: ${abs}`,
      };
    }
    const segments = rel.split(path.sep);
    if (segments.length !== 1) {
      return {
        kind: "invalid",
        reason: "directory must be a direct child of .orchestrator/tasks/",
      };
    }
    const basename = segments[0]!;
    let entries: string[];
    try {
      entries = await fs.readdir(tasksDir);
    } catch {
      return { kind: "not-found", input };
    }
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const stem = entry.slice(0, -3);
      if (stem === basename || basename.startsWith(`${stem}-`)) {
        candidates.push(path.join(tasksDir, entry));
      }
    }
    if (candidates.length === 0) return { kind: "not-found", input };
    if (candidates.length === 1) return { kind: "ok", path: candidates[0]! };
    return { kind: "ambiguous", candidates };
  }

  return { kind: "invalid", reason: `unsupported file type: ${abs}` };
}
