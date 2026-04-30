#!/usr/bin/env bun
/**
 * Bootstrap helper for the `/flow add` skill.
 *
 * Writes `.orchestrator/tasks/<id>.md` from the triage results gathered in
 * the user's chat session, then spawns `flow run <id> --detach` so the
 * pipeline runs as a detached process tree and the chat is freed
 * immediately. The skill conducts triage prose; this helper handles the
 * mechanical bits (canonical-root resolution, id generation/collision,
 * task.md write, detached spawn) so the SKILL.md stays thin.
 *
 * Usage:
 *   ./scripts/flow-add.ts <prompt>
 *                         --intent <feature|bug|refactor|docs|infra|chore>
 *                         --summary "<one-sentence summary>"
 *                         [--slug <kebab-slug>]
 *                         [--clarification "<bullet>"]…
 *                         [--constraint "<bullet>"]…
 *                         [--open-question "<bullet>"]…
 *
 * Exit codes:
 *   0 — task.md written, `flow run --detach` spawned
 *   1 — unexpected error (filesystem, spawn)
 *   2 — `flow` CLI not found on PATH
 *   3 — not inside a git repository
 *   4 — id collision (every numeric suffix taken; refine the prompt)
 *   5 — required argv missing or malformed
 */

import { readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";

// --- Types ---

export type Intent =
  | "feature"
  | "bug"
  | "refactor"
  | "docs"
  | "infra"
  | "chore";

export type ParsedArgs = {
  prompt: string;
  intent: Intent;
  summary: string;
  slug?: string;
  clarifications: string[];
  constraints: string[];
  openQuestions: string[];
};

const INTENTS: ReadonlySet<Intent> = new Set([
  "feature",
  "bug",
  "refactor",
  "docs",
  "infra",
  "chore",
]);

export type SpawnedDetach = { ok: true } | { ok: false; reason: "enoent" } | {
  ok: false;
  reason: "exit";
  code: number | null;
  stderr: string;
};

export type SpawnDetachFn = (args: {
  argv: string[];
  cwd: string;
}) => SpawnedDetach;

export type WriteSink = { write(chunk: string): void };

export type MainDeps = {
  cwd?: string;
  nowIso?: () => string;
  todayUtcDate?: () => string;
  readExistingIds?: (tasksRoot: string) => string[];
  /**
   * Path-only injection for happy-path tests that don't care about
   * the git-missing vs not-a-repo distinction. Maps to a `kind: "ok"`
   * or `kind: "not-a-repo"` result internally.
   */
  findCanonicalRoot?: (cwd: string) => string | null;
  /**
   * Richer injection for tests that need to drive the git-missing
   * branch separately from the not-a-repo branch. When provided,
   * `findCanonicalRoot` is ignored.
   */
  findCanonicalRootResult?: (cwd: string) => CanonicalRootResult;
  spawnDetach?: SpawnDetachFn;
  stdout?: WriteSink;
  stderr?: WriteSink;
};

// --- Pure helpers (exported for tests) ---

const KEBAB_FILLER = "task";

/**
 * Lowercases the prompt, strips non-alphanumeric chars (keeping hyphens
 * so "off-by-one"-style compound terms survive as a single word),
 * splits on whitespace, truncates to `max` (default 5) words, then
 * joins with hyphens and collapses double hyphens. Falls back to
 * `KEBAB_FILLER` when the result is empty so id generation never
 * produces a date-only filename.
 */
export function slugify(prompt: string, max = 5): string {
  const normalized = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .trim();
  if (!normalized) return KEBAB_FILLER;
  const words = normalized.split(/\s+/).filter(Boolean).slice(0, max);
  const slug = words
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || KEBAB_FILLER;
}

export function buildTaskId(date: string, slug: string): string {
  return `${date}-${slug}`;
}

const MAX_COLLISION_SUFFIX = 9;

/**
 * Returns the first available id walking `base`, `base-2`, …, `base-9`.
 * Throws "exhausted" when every suffix is taken — surfaces in main as
 * exit code 4 with the colliding ids listed so the user can rephrase.
 */
export function nextAvailableId(
  existingIds: ReadonlySet<string>,
  baseId: string,
): string {
  if (!existingIds.has(baseId)) return baseId;
  for (let i = 2; i <= MAX_COLLISION_SUFFIX; i++) {
    const candidate = `${baseId}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new Error(`id-collision-exhausted:${baseId}`);
}

export type BuildTaskMdInput = {
  id: string;
  prompt: string;
  intent: Intent;
  summary: string;
  clarifications: string[];
  constraints: string[];
  openQuestions: string[];
  repoRoot: string;
  nowIso: string;
};

const NOTHING_FLAGGED = "nothing flagged";
const NONE_OPEN = "none";

export function buildTaskMd(input: BuildTaskMdInput): string {
  const constraintsBody = input.constraints.length
    ? input.constraints.map(toBullet).join("\n")
    : `- ${NOTHING_FLAGGED}`;
  const openQuestionsBody = input.openQuestions.length
    ? input.openQuestions.map(toBullet).join("\n")
    : `- ${NONE_OPEN}`;
  const clarificationsBody = input.clarifications.length
    ? input.clarifications.map(toBullet).join("\n")
    : "(none captured)";
  return `---
id: ${input.id}
status: triaged
created: ${input.nowIso}
updated: ${input.nowIso}
target_repo: ${input.repoRoot}
worktree: null
branch: null
pr: null
manual_validation: null
merge_commit: null
---

## User prompt

${input.prompt.trimEnd()}

## Triage

- intent: ${input.intent}
- summary: ${input.summary}

## Clarifications

${clarificationsBody}

## Constraints / out of scope

${constraintsBody}

## Open questions

${openQuestionsBody}

## Progress

- [x] triage
- [ ] plan
- [ ] worktree
- [ ] implement
- [ ] verify
- [ ] ci
- [ ] review
- [ ] gate
- [ ] merge

## Phase log

- ${input.nowIso} triage complete

## Phase outputs

(empty — pipeline phases will populate)
`;
}

function toBullet(line: string): string {
  const trimmed = line.trim();
  return trimmed.startsWith("- ") ? trimmed : `- ${trimmed}`;
}

// --- Argv parsing ---

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new ArgError("missing required positional argument: <prompt>");
  }
  let prompt: string | undefined;
  let intent: Intent | undefined;
  let summary: string | undefined;
  let slug: string | undefined;
  const clarifications: string[] = [];
  const constraints: string[] = [];
  const openQuestions: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--intent") {
      const v = argv[++i];
      if (v === undefined) throw new ArgError("--intent requires a value");
      if (!INTENTS.has(v as Intent)) {
        throw new ArgError(
          `--intent must be one of feature|bug|refactor|docs|infra|chore (got ${JSON.stringify(v)})`,
        );
      }
      intent = v as Intent;
    } else if (a === "--summary") {
      summary = required(argv[++i], "--summary");
    } else if (a === "--slug") {
      slug = required(argv[++i], "--slug");
    } else if (a === "--clarification") {
      clarifications.push(required(argv[++i], "--clarification"));
    } else if (a === "--constraint") {
      constraints.push(required(argv[++i], "--constraint"));
    } else if (a === "--open-question") {
      openQuestions.push(required(argv[++i], "--open-question"));
    } else if (a.startsWith("--")) {
      throw new ArgError(`unknown flag: ${a}`);
    } else if (prompt === undefined) {
      prompt = a;
    } else {
      throw new ArgError(`unexpected positional argument: ${a}`);
    }
  }
  if (prompt === undefined) {
    throw new ArgError("missing required positional argument: <prompt>");
  }
  if (intent === undefined) throw new ArgError("missing required flag: --intent");
  if (summary === undefined) throw new ArgError("missing required flag: --summary");
  return {
    prompt,
    intent,
    summary,
    slug,
    clarifications,
    constraints,
    openQuestions,
  };
}

function required(v: string | undefined, flag: string): string {
  if (v === undefined) throw new ArgError(`${flag} requires a value`);
  return v;
}

// --- Canonical root (mirrors src/util/git.ts) ---

/**
 * Result of canonical-root resolution. Distinguishes the two ways root
 * lookup can fail so the caller can produce different error wording:
 * `git` missing from PATH is a setup problem, while "not in a git repo"
 * is a use-site problem.
 */
export type CanonicalRootResult =
  | { kind: "ok"; path: string }
  | { kind: "git-missing" }
  | { kind: "not-a-repo" };

/**
 * Returns the *primary* worktree path even when invoked from a child
 * worktree — `flow run` refuses to operate from a child worktree's cwd, so
 * the helper must canonicalise before spawning. Mirrors `findCanonicalRoot`
 * in `src/util/git.ts`; duplicated because the script ships into target
 * repos that don't have flow's TS sources on disk (same constraint as
 * `flow-watch.ts`).
 *
 * `spawnSync`-with-missing-binary surfaces as `r.error.code === "ENOENT"`
 * (no thrown exception), so the git-missing classification reads the
 * `error` field rather than relying on a try/catch.
 */
export function findCanonicalRootResult(cwd: string): CanonicalRootResult {
  let gitMissing = false;
  const r1 = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd, encoding: "utf8" },
  );
  if ((r1.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    gitMissing = true;
  } else if (r1.status === 0 && r1.stdout) {
    const commonDir = r1.stdout.trim();
    if (commonDir.endsWith(`${sep}.git`) || commonDir.endsWith("/.git")) {
      return { kind: "ok", path: commonDir.slice(0, -".git".length - 1) };
    }
    // Bare repo / custom GIT_DIR — fall through to toplevel.
  }
  const r2 = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  if ((r2.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    gitMissing = true;
  } else if (r2.status === 0 && r2.stdout) {
    return { kind: "ok", path: r2.stdout.trim() };
  }
  return gitMissing ? { kind: "git-missing" } : { kind: "not-a-repo" };
}

/**
 * Backwards-compatible wrapper returning the path or null. `main` uses the
 * richer `findCanonicalRootResult` to distinguish error classes; tests for
 * the pure git-rooted resolution still consume this string-or-null shape.
 */
export function findCanonicalRoot(cwd: string): string | null {
  const r = findCanonicalRootResult(cwd);
  return r.kind === "ok" ? r.path : null;
}

/**
 * Adapter from the legacy string-or-null shape to the richer result. Tests
 * that inject only `findCanonicalRoot` (pre-rich-API) get an "ok" or
 * "not-a-repo" classification — they can't drive "git-missing" without
 * switching to `findCanonicalRootResult`.
 */
function toCanonicalRootResult(p: string | null): CanonicalRootResult {
  return p === null ? { kind: "not-a-repo" } : { kind: "ok", path: p };
}

// --- Existing-id discovery ---

export function readExistingIds(tasksRoot: string): string[] {
  const ids: string[] = [];
  collectIds(tasksRoot, ids);
  collectIds(join(tasksRoot, "archive"), ids);
  return ids;
}

function collectIds(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    out.push(name.slice(0, -3));
  }
}

// --- Detached spawn ---

function defaultSpawnDetach(args: {
  argv: string[];
  cwd: string;
}): SpawnedDetach {
  // Spawn `flow run <id> --detach` synchronously and let it print its own
  // status (`detached as pid <pid>`, `log → <path>`) to stdout/stderr. The
  // CLI returns immediately after forking the grandchild, so the user's
  // chat session is freed without us having to manage the detached process.
  try {
    const r = spawnSync(args.argv[0]!, args.argv.slice(1), {
      cwd: args.cwd,
      stdio: "inherit",
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "enoent" };
    }
    if (r.status !== 0) {
      return {
        ok: false,
        reason: "exit",
        code: r.status,
        stderr: r.stderr ? r.stderr.toString() : "",
      };
    }
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "enoent" };
    }
    throw err;
  }
}

// --- Output formatting ---

/**
 * The chat-visible artefact. Split into two halves so the helper can print
 * the "task recorded" facts before attempting the detached spawn (so the
 * user sees the absolute path even when spawn fails) and only assert the
 * pipeline actually started after a successful spawn.
 *
 * `formatSuccessBlock` is the concatenation of both halves — kept for
 * callers that want the full copy-pasteable block in one string.
 */
export function formatTaskRecordedBlock(args: {
  id: string;
  taskMdPath: string;
  logsDir: string;
}): string {
  return `task: ${args.id}
task-md: ${args.taskMdPath}
logs: ${args.logsDir}
`;
}

export function formatPipelineStartedBlock(args: { id: string }): string {
  return `
Pipeline started (detached). Next:
  /flow status ${args.id}
  /flow watch ${args.id}
`;
}

export function formatSuccessBlock(args: {
  id: string;
  taskMdPath: string;
  logsDir: string;
}): string {
  return (
    formatTaskRecordedBlock(args) + formatPipelineStartedBlock({ id: args.id })
  );
}

// --- Help ---

const HELP_TEXT = `Usage: ./scripts/flow-add.ts <prompt>
            --intent <feature|bug|refactor|docs|infra|chore>
            --summary "<one-sentence summary>"
            [--slug <kebab-slug>]
            [--clarification "<bullet>"]…
            [--constraint "<bullet>"]…
            [--open-question "<bullet>"]…

Records .orchestrator/tasks/<id>.md from triage results, then spawns
'flow run <id> --detach' so the pipeline runs as a detached process tree.

Exit codes:
  0  task.md written, pipeline detached
  1  unexpected error
  2  flow CLI not found on PATH
  3  not inside a git repository
  4  id collision exhausted (refine the prompt)
  5  argv parsing failed
`;

// --- main ---

export async function main(
  argv: string[],
  deps: MainDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? { write: (s) => process.stdout.write(s) };
  const stderr = deps.stderr ?? { write: (s) => process.stderr.write(s) };
  const cwd = deps.cwd ?? process.cwd();

  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(HELP_TEXT);
    return 0;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      stderr.write(`error: ${err.message}\n`);
      return 5;
    }
    throw err;
  }

  const rootResult: CanonicalRootResult = deps.findCanonicalRootResult
    ? deps.findCanonicalRootResult(cwd)
    : deps.findCanonicalRoot
      ? toCanonicalRootResult(deps.findCanonicalRoot(cwd))
      : findCanonicalRootResult(cwd);
  if (rootResult.kind !== "ok") {
    if (rootResult.kind === "git-missing") {
      stderr.write(
        "error: git not found on PATH; install git (or add it to PATH) and try again\n",
      );
    } else {
      stderr.write(
        "error: flow-add must be run from inside a git repository\n",
      );
    }
    return 3;
  }
  const repoRoot = rootResult.path;

  const tasksRoot = join(repoRoot, ".orchestrator", "tasks");
  await mkdir(tasksRoot, { recursive: true });

  const todayUtcDate =
    deps.todayUtcDate ?? (() => new Date().toISOString().slice(0, 10));
  const nowIsoFn =
    deps.nowIso ?? (() => new Date().toISOString());
  const slug = parsed.slug ? slugify(parsed.slug) : slugify(parsed.prompt);
  const baseId = buildTaskId(todayUtcDate(), slug);
  const existingIds = new Set(
    (deps.readExistingIds ?? readExistingIds)(tasksRoot),
  );

  let id: string;
  try {
    id = nextAvailableId(existingIds, baseId);
  } catch (err) {
    const collisions = [
      baseId,
      ...Array.from({ length: MAX_COLLISION_SUFFIX - 1 }, (_, i) => `${baseId}-${i + 2}`),
    ].filter((c) => existingIds.has(c));
    stderr.write(
      `error: id collision — every suffix of '${baseId}' is taken. Refine the prompt to produce a different slug.\n`,
    );
    stderr.write("colliding ids:\n");
    for (const c of collisions) stderr.write(`  ${c}\n`);
    void err;
    return 4;
  }

  const taskMdPath = join(tasksRoot, `${id}.md`);
  const nowIso = nowIsoFn();
  const body = buildTaskMd({
    id,
    prompt: parsed.prompt,
    intent: parsed.intent,
    summary: parsed.summary,
    clarifications: parsed.clarifications,
    constraints: parsed.constraints,
    openQuestions: parsed.openQuestions,
    repoRoot,
    nowIso,
  });
  // `flag: "wx"` is the atomic create-or-fail open mode — the kernel guarantees
  // exactly one writer wins when two concurrent helpers race past the
  // nextAvailableId snapshot. Without it, both writers' `writeFile` calls would
  // truncate-and-write, silently clobbering one task. EEXIST is the only
  // race-class error here; all other errors propagate.
  try {
    await writeFile(taskMdPath, body, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      stderr.write(
        `error: task file already exists at ${taskMdPath} (raced with another writer?). Re-run to pick a new id.\n`,
      );
      return 1;
    }
    throw err;
  }

  const logsDir = join(tasksRoot, id);

  // Surface "task recorded" before the spawn so the user sees the absolute
  // path even when the detached spawn fails (otherwise a missing `flow` CLI
  // hides the path the user just wrote to). The "Pipeline started" half
  // only prints after the spawn returns ok, so chat never lies about state.
  stdout.write(formatTaskRecordedBlock({ id, taskMdPath, logsDir }));

  const spawnFn = deps.spawnDetach ?? defaultSpawnDetach;
  const spawnResult = spawnFn({
    argv: ["flow", "run", id, "--detach"],
    cwd: repoRoot,
  });

  if (!spawnResult.ok) {
    if (spawnResult.reason === "enoent") {
      stderr.write(
        "error: flow CLI not found on PATH; is flow installed in this repo?\n",
      );
      return 2;
    }
    stderr.write(
      `error: 'flow run ${id} --detach' exited with code ${spawnResult.code ?? "(null)"}\n`,
    );
    if (spawnResult.stderr) stderr.write(spawnResult.stderr);
    return 1;
  }

  stdout.write(formatPipelineStartedBlock({ id }));

  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
