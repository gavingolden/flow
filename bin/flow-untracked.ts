#!/usr/bin/env bun
/**
 * Discovered-but-not-in-plan work items: a decision surface, not an issue
 * tracker. Mid-run discoveries have no home today — they either get
 * auto-filed (the candidate-issues machinery), buried in prose, or lost.
 * `flow-untracked` gives them one: `add` records an item on `state.json`
 * (survives `flow-remove-worktree` — the terminal block after MERGED still
 * needs to show it), `list`/`render` surface it at every pause, and `file
 * <id>` files it as a real issue only on an explicit, user-instructed reply
 * — never automatically (`.claude/rules/flow-supervisor-contracts.md` "Auto-issue-create exemption").
 *
 * Storage: `state.json.untracked[]` (not the worktree — `flow-followups`'s
 * JSONL pattern dies with the worktree, which is gone by MERGED). Ids are
 * monotonic per pipeline and never renumbered. Items not filed by `flow
 * done` are discarded with the state file; nothing accumulates across
 * pipelines.
 *
 * Usage:
 *   flow-untracked add --title <t> [--body <b>] --source <s> [--kind work|manual]
 *   flow-untracked list [--json]
 *   flow-untracked file <id> | --all      (--all: open work items only)
 *   flow-untracked drop <id> | --all
 *   flow-untracked done <id> | --all      (manual checks only; id required)
 *   flow-untracked launch <id> [--model <m>] [--effort <e>]
 *   flow-untracked verdict --json
 *   flow-untracked seed-merge [--after-merge-file <p>] [--followups-jsonl <p>]
 *                             [--followups-block-file <p>]
 *   flow-untracked render --format gate|markdown [--unfiled-only] [--uncapped]
 *
 * Exit codes:
 *   0 — success (including no-op cases like an empty/absent state file for
 *       `list`/`render`).
 *   1 — `flow-create-issue` failed during `file` for a reason other than a
 *       body rejection (e.g. `gh` unavailable, no Issues surface), or
 *       `flow feature create` did not confirm a launch during `launch`.
 *   2 — bad CLI args, missing state file, unknown id, `done` on a work item,
 *       or an unresolvable slug.
 *   3 — `flow-create-issue` rejected the body (exit 3, mapped straight
 *       through — see `CreateIssueError`).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readState,
  writeState,
  statePath,
  type PipelineState,
  type UntrackedItem,
} from "./lib/state";
import { closeVerdict, isOpenItem } from "./lib/close-verdict";
import {
  defaultPublishBadges,
  defaultSpawnLaunch,
  doneItem,
  dropAll,
  fileAll,
  launchItem,
  verdictJson,
  type SpawnLaunch,
} from "./lib/untracked-verbs";
import { applyMergeSeeds, mergeSeedEntries } from "./lib/untracked-merge-seed";
import { resolveSlugAmbient } from "./lib/session-identity";
import { resolveAnchorRepoRoot } from "./lib/value-anchors";

export const UNTRACKED_RENDER_CAP = 2;

// --- Pure state mutators ---

function nextId(items: UntrackedItem[]): number {
  let max = 0;
  for (const item of items) {
    if (item.id > max) max = item.id;
  }
  return max + 1;
}

export function addItem(
  state: PipelineState,
  input: {
    title: string;
    body?: string;
    source: string;
    kind?: "work" | "manual";
  },
  now: () => string = () => new Date().toISOString(),
): PipelineState {
  const items = state.untracked ?? [];
  const item: UntrackedItem = {
    id: nextId(items),
    title: input.title,
    source: input.source,
    at: now(),
  };
  if (input.body !== undefined) item.body = input.body;
  if (input.kind === "manual") item.kind = "manual";
  return { ...state, untracked: [...items, item] };
}

/**
 * `add`'s dedup-aware entry point: mechanical seeders (e.g. the pr-review
 * Step 13 untracked seed) can run again across a review fix loop or a
 * resume, and `addItem` alone is append-only — every re-run would add the
 * same finding/anti-pattern again under a new id. Skip re-adding when an
 * existing UNDROPPED item shares the same `title` + `source` (a dropped
 * item's title is deliberately re-addable — the reader dropped it once,
 * a genuinely new occurrence should surface again). Distinct discoveries
 * (different title or source) still append normally.
 */
export function addItemDedup(
  state: PipelineState,
  input: {
    title: string;
    body?: string;
    source: string;
    kind?: "work" | "manual";
  },
  now: () => string = () => new Date().toISOString(),
): { state: PipelineState; id: number; deduped: boolean } {
  const items = state.untracked ?? [];
  const existing = items.find(
    (i) =>
      i.droppedAt === undefined &&
      i.title === input.title &&
      i.source === input.source,
  );
  if (existing) {
    return { state, id: existing.id, deduped: true };
  }
  const next = addItem(state, input, now);
  const added = next.untracked as UntrackedItem[];
  return { state: next, id: added[added.length - 1].id, deduped: false };
}

export type CreateIssue = (
  title: string,
  body: string | undefined,
) => { url: string };

/**
 * Structural exit-code carrier for a `flow-create-issue` failure — a
 * property on the thrown Error, not a message-string prefix. `runFile`
 * routes on `.exitCode` rather than bolting a second
 * `message.startsWith(...)` check onto the existing not-found routing.
 */
export class CreateIssueError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "CreateIssueError";
  }
}

/**
 * Normalizes an `UntrackedItem.source` into a rubric-conforming
 * `[anchor: …]` by construction, so the short form `fileItem` composes
 * below can never rejection-loop against its own output:
 *   - a source that resolves as a repo path emits the bare form,
 *   - any other non-empty source emits the quoted-text form,
 *   - an absent or empty source (representable per `bin/lib/state.ts`'s
 *     `isUntrackedList`, which only checks `typeof source === "string"`)
 *     falls back to the item's own id plus the untracked state-file path.
 */
export function normalizeSourceAnchor(
  source: string | undefined,
  id: number,
  slug: string,
): string {
  const trimmed = (source ?? "").replace(/\s*\n\s*/g, " ").trim();
  if (!trimmed) {
    return `[anchor: item #${id}, ${statePath(slug)}]`;
  }
  const repoRoot = resolveAnchorRepoRoot(undefined);
  const abs = path.resolve(repoRoot, trimmed);
  const rel = path.relative(repoRoot, abs);
  const inRepo =
    !path.isAbsolute(trimmed) && rel !== "" && !rel.startsWith("..");
  if (inRepo && fs.existsSync(abs)) {
    return `[anchor: ${trimmed}]`;
  }
  return `[anchor: "${trimmed}"]`;
}

/**
 * Composes a `**Short form:**` body line for an item with no recorded
 * body, satisfying the flow-value-rubric contract on its own (see
 * `bin/lib/issue-body-rubric.ts`) — `Value:2/Complexity:Trivial/Risk:Low`
 * is the deliberate baseline for a user-dictated note: genuinely a
 * one-liner, not something worth a full eight-label block.
 */
function buildShortFormBody(item: UntrackedItem, slug: string): string {
  const anchor = normalizeSourceAnchor(item.source, item.id, slug);
  // The rubric's short-form regex only scans the Short-form line itself,
  // so an embedded newline in a user-dictated title would push the
  // anchor onto line 2, where the checker can't see it — collapse to a
  // single line before composing.
  const title = item.title.replace(/\s*\n\s*/g, " ").trim();
  return `**Short form:** [V:2|C:Trivial|R:Low] ${title} ${anchor}`;
}

/**
 * Idempotent: a second `fileItem` call on an already-filed item returns
 * `state` unchanged without invoking `createIssue` again.
 */
export function fileItem(
  state: PipelineState,
  id: number,
  createIssue: CreateIssue,
): PipelineState {
  const items = state.untracked ?? [];
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) {
    throw new Error(`no untracked item #${id}`);
  }
  const item = items[idx];
  if (item.filedAs !== undefined) return state;
  if (item.kind === "manual") {
    throw new Error(
      `#${id} is a manual check — use done #${id} or drop #${id}`,
    );
  }
  const body = item.body ?? buildShortFormBody(item, state.slug);
  const { url } = createIssue(item.title, body);
  const next = [...items];
  next[idx] = { ...item, filedAs: url };
  return { ...state, untracked: next };
}

export function dropItem(
  state: PipelineState,
  id: number,
  now: () => string = () => new Date().toISOString(),
): PipelineState {
  const items = state.untracked ?? [];
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) {
    throw new Error(`no untracked item #${id}`);
  }
  const item = items[idx];
  if (item.droppedAt !== undefined) return state;
  const next = [...items];
  next[idx] = { ...item, droppedAt: now() };
  return { ...state, untracked: next };
}

// --- Pure renderers ---

/**
 * Renders the ≤`UNTRACKED_RENDER_CAP` most recent items, most-recent-first,
 * with an overflow tail line when more exist — so the untracked row can
 * never breach the pause/terminal block's ~12-line ceiling. Callers filter
 * (undropped, optionally unfiled-only) before calling.
 */
function capped(
  items: UntrackedItem[],
  uncapped = false,
): {
  shown: UntrackedItem[];
  remaining: number;
} {
  const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at));
  const shown = uncapped ? sorted : sorted.slice(0, UNTRACKED_RENDER_CAP);
  return { shown, remaining: sorted.length - shown.length };
}

/**
 * `uncapped` lists every open item — used only at the merged/cancelled
 * renders that offer `file all` / `drop all`, so a bulk reply never touches
 * an item the reader cannot see. Pauses keep the cap (the ~12-line ceiling).
 */
export function renderGate(
  items: UntrackedItem[],
  opts: { uncapped?: boolean } = {},
): string[] {
  const { shown, remaining } = capped(items, opts.uncapped);
  const lines = shown.map((i) =>
    i.kind === "manual"
      ? `  - #${i.id} ${i.title} (reply: done #${i.id} / drop #${i.id})`
      : `  - #${i.id} ${i.title} (reply: file #${i.id} / drop #${i.id} / launch #${i.id})`,
  );
  if (remaining > 0) {
    lines.push(`  (+${remaining} more — flow-untracked list)`);
  }
  return lines;
}

export function renderMarkdown(
  items: UntrackedItem[],
  opts: { uncapped?: boolean } = {},
): string[] {
  const { shown, remaining } = capped(items, opts.uncapped);
  const lines = shown.map((i) => `- #${i.id} ${i.title}`);
  if (remaining > 0) {
    lines.push(`  (+${remaining} more — flow-untracked list)`);
  }
  return lines;
}

// --- State I/O seam ---

export type Deps = {
  resolveSlug?: () => string | null;
  readStateFn?: typeof readState;
  writeStateFn?: typeof writeState;
  stateDir?: string;
  now?: () => string;
  createIssue?: CreateIssue;
  spawnLaunch?: SpawnLaunch;
  publishBadges?: (state: PipelineState) => void;
  readFileFn?: (p: string) => string | null;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

function loadState(deps: Deps): PipelineState | null {
  const resolveSlug = deps.resolveSlug ?? resolveSlugAmbient;
  const readSt = deps.readStateFn ?? readState;
  const slug = resolveSlug();
  if (!slug) return null;
  return deps.stateDir ? readSt(slug, deps.stateDir) : readSt(slug);
}

function saveState(state: PipelineState, deps: Deps): void {
  const writeSt = deps.writeStateFn ?? writeState;
  if (deps.stateDir) writeSt(state, deps.stateDir);
  else writeSt(state);
}

/** Persist, then refresh the tab badge best-effort (never fails the verb). */
function commit(state: PipelineState, deps: Deps): void {
  saveState(state, deps);
  try {
    (deps.publishBadges ?? defaultPublishBadges)(state);
  } catch {
    // publish-only
  }
}

function readTextOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// --- CLI arg parsing ---

type AddArgs = {
  title: string;
  body?: string;
  source: string;
  kind?: "work" | "manual";
};

function parseAddArgs(argv: string[]): AddArgs | { error: string } {
  const out: Partial<AddArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    if (flag === "--title") out.title = value;
    else if (flag === "--body") out.body = value;
    else if (flag === "--source") out.source = value;
    else if (flag === "--kind") {
      if (value !== "work" && value !== "manual") {
        return { error: "--kind must be 'work' or 'manual'" };
      }
      out.kind = value;
    } else return { error: `unknown flag: ${flag}` };
    i++;
  }
  if (!out.title) return { error: "--title is required" };
  if (!out.source) return { error: "--source is required" };
  return out as AddArgs;
}

type RenderArgs = {
  format: "gate" | "markdown";
  unfiledOnly: boolean;
  uncapped: boolean;
};

function parseRenderArgs(argv: string[]): RenderArgs | { error: string } {
  const out: Partial<RenderArgs> = { unfiledOnly: false, uncapped: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--unfiled-only") {
      out.unfiledOnly = true;
      continue;
    }
    if (flag === "--uncapped") {
      out.uncapped = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }
    if (flag === "--format") {
      if (value !== "gate" && value !== "markdown") {
        return { error: "--format must be 'gate' or 'markdown'" };
      }
      out.format = value;
      i++;
      continue;
    }
    return { error: `unknown flag: ${flag}` };
  }
  if (!out.format) return { error: "--format is required" };
  return out as RenderArgs;
}

function parseId(argv: string[]): number | { error: string } {
  const first = argv[0];
  const id = Number.parseInt(first ?? "", 10);
  if (!Number.isFinite(id) || String(id) !== first) {
    return { error: `<id> must be a positive integer, got '${first}'` };
  }
  return id;
}

// --- Subcommand runners ---

function runAdd(argv: string[], deps: Deps): number {
  const parsed = parseAddArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-untracked: ${parsed.error}`);
    console.error(
      "usage: flow-untracked add --title <t> [--body <b>] --source <s> [--kind work|manual]",
    );
    return 2;
  }
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const result = addItemDedup(state, parsed, deps.now);
  if (result.deduped) {
    out(`flow-untracked: existing item #${result.id} (not re-added)\n`);
    return 0;
  }
  commit(result.state, deps);
  out(`flow-untracked: added #${result.id}\n`);
  return 0;
}

function runList(argv: string[], deps: Deps): number {
  const json = argv.includes("--json");
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const state = loadState(deps);
  const items = state?.untracked ?? [];
  if (json) {
    out(JSON.stringify(items) + "\n");
    return 0;
  }
  if (items.length === 0) return 0;
  const lines = items.map((i) => {
    const tags = [
      i.filedAs ? `filed: ${i.filedAs}` : undefined,
      i.droppedAt ? "dropped" : undefined,
      i.doneAt ? "done" : undefined,
      i.launchedAs ? `launched: ${i.launchedAs}` : undefined,
      i.kind === "manual" ? "manual" : undefined,
    ].filter((t): t is string => t !== undefined);
    const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
    return `#${i.id} ${i.title}${suffix}`;
  });
  out(lines.join("\n") + "\n");
  return 0;
}

function defaultCreateIssue(): CreateIssue {
  return (title, body) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-untracked-"));
    const bodyFile = path.join(tmpDir, "body.md");
    fs.writeFileSync(bodyFile, body ?? "");
    try {
      const r = spawnSync(
        "flow-create-issue",
        ["--title", title, "--body-file", bodyFile],
        { encoding: "utf8" },
      );
      if (r.status !== 0) {
        throw new CreateIssueError(
          `flow-create-issue exited ${r.status}: ${(r.stderr ?? "").trim()}`,
          r.status ?? 1,
        );
      }
      const parsed = JSON.parse(r.stdout) as { url: string };
      return { url: parsed.url };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  };
}

function failureExitCode(e: unknown): number {
  // A flow-create-issue failure carries its child exit code structurally
  // (CreateIssueError.exitCode) rather than a message-string prefix — a
  // rejected body (exit 3) is distinct from any other gh/Issues-surface
  // failure (exit 1). Unknown id stays a bad-args case (exit 2, matching
  // `drop`'s contract), routed on the plain-Error message prefix.
  if (e instanceof CreateIssueError) return e.exitCode === 3 ? 3 : 1;
  return (e as Error).message.startsWith("no untracked item") ? 2 : 1;
}

function runFileAll(deps: Deps): number {
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const createIssue = deps.createIssue ?? defaultCreateIssue();
  const r = fileAll(state, {
    fileOne: (s, id) => fileItem(s, id, createIssue),
  });
  if (r.filed.length > 0) commit(r.state, deps);
  const summary = r.filed.map((f) => `#${f.id} → ${f.url}`).join(", ");
  out(
    r.filed.length > 0
      ? `Filed ${summary}.\n`
      : "flow-untracked: no open work items to file\n",
  );
  if (r.failure) {
    console.error(
      `flow-untracked: filing #${r.failure.id} failed: ${r.failure.message}; remaining items stay open`,
    );
    return failureExitCode(r.failure.error);
  }
  return 0;
}

function runFile(argv: string[], deps: Deps): number {
  if (argv[0] === "--all") return runFileAll(deps);
  const id = parseId(argv);
  if (typeof id !== "number") {
    console.error(`flow-untracked: ${id.error}`);
    console.error("usage: flow-untracked file <id> | --all");
    return 2;
  }
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const createIssue = deps.createIssue ?? defaultCreateIssue();
  try {
    const next = fileItem(state, id, createIssue);
    commit(next, deps);
    const url = next.untracked?.find((i) => i.id === id)?.filedAs;
    out(`Filed #${id}${url ? ` → ${url}` : ""}.\n`);
    return 0;
  } catch (e) {
    console.error(`flow-untracked: ${(e as Error).message}`);
    return failureExitCode(e);
  }
}

function runDrop(argv: string[], deps: Deps): number {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const all = argv[0] === "--all";
  const id = all ? 0 : parseId(argv);
  if (typeof id !== "number") {
    console.error(`flow-untracked: ${id.error}`);
    console.error("usage: flow-untracked drop <id> | --all");
    return 2;
  }
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  if (all) {
    const r = dropAll(state, deps.now);
    if (r.dropped.length > 0) commit(r.state, deps);
    out(
      r.dropped.length > 0
        ? `Dropped ${r.dropped.map((n) => `#${n}`).join(", ")}.\n`
        : "flow-untracked: no open items to drop\n",
    );
    return 0;
  }
  try {
    const next = dropItem(state, id, deps.now);
    commit(next, deps);
    out(`Dropped #${id}.\n`);
    return 0;
  } catch (e) {
    console.error(`flow-untracked: ${(e as Error).message}`);
    return 2;
  }
}

function runRender(argv: string[], deps: Deps): number {
  const parsed = parseRenderArgs(argv);
  if ("error" in parsed) {
    console.error(`flow-untracked: ${parsed.error}`);
    console.error(
      "usage: flow-untracked render --format gate|markdown [--unfiled-only] [--uncapped]",
    );
    return 2;
  }
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const state = loadState(deps);
  // `after-merge` items already render under MANUAL ACTION: after merge:.
  const items = (state?.untracked ?? []).filter(
    (i) =>
      i.source !== "after-merge" &&
      (parsed.unfiledOnly ? isOpenItem(i) : i.droppedAt === undefined),
  );
  const opts = { uncapped: parsed.uncapped };
  const lines =
    parsed.format === "gate"
      ? renderGate(items, opts)
      : renderMarkdown(items, opts);
  if (lines.length > 0) out(lines.join("\n") + "\n");
  return 0;
}

function runDone(argv: string[], deps: Deps): number {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const all = argv[0] === "--all";
  const id = all ? 0 : parseId(argv);
  if (typeof id !== "number") {
    console.error(`flow-untracked: ${id.error}`);
    console.error("usage: flow-untracked done <id> | --all");
    return 2;
  }
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  try {
    const r = doneItem(state, all ? "all" : id, deps.now);
    if (r.done.length > 0) commit(r.state, deps);
    out(
      r.done.length > 0
        ? `Marked ${r.done.map((n) => `#${n}`).join(", ")} done.\n`
        : "flow-untracked: no open manual items to mark done\n",
    );
    return 0;
  } catch (e) {
    console.error(`flow-untracked: ${(e as Error).message}`);
    return 2;
  }
}

function runLaunch(argv: string[], deps: Deps): number {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const id = parseId(argv);
  const usage =
    "usage: flow-untracked launch <id> [--model <m>] [--effort <e>]";
  if (typeof id !== "number") {
    console.error(`flow-untracked: ${id.error}`);
    console.error(usage);
    return 2;
  }
  const opts: { model?: string; effort?: string } = {};
  for (let i = 1; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`flow-untracked: ${argv[i]} requires a value`);
      console.error(usage);
      return 2;
    }
    if (argv[i] === "--model") opts.model = value;
    else if (argv[i] === "--effort") opts.effort = value;
    else {
      console.error(`flow-untracked: unknown flag: ${argv[i]}`);
      console.error(usage);
      return 2;
    }
  }
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  try {
    const r = launchItem(state, id, opts, {
      spawnLaunch: deps.spawnLaunch ?? defaultSpawnLaunch(),
      env: deps.env,
    });
    commit(r.state, deps);
    out(`Launched #${id} as flow:${r.slug}.\n`);
    return 0;
  } catch (e) {
    console.error(`flow-untracked: ${(e as Error).message}`);
    return (e as Error).message.startsWith("no untracked item") ? 2 : 1;
  }
}

function runVerdict(argv: string[], deps: Deps): number {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  if (!argv.includes("--json")) {
    console.error("usage: flow-untracked verdict --json");
    return 2;
  }
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  out(verdictJson(state) + "\n");
  return 0;
}

function runSeedMerge(argv: string[], deps: Deps): number {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const paths: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (
      ![
        "--after-merge-file",
        "--followups-jsonl",
        "--followups-block-file",
      ].includes(argv[i]) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      console.error(`flow-untracked: bad seed-merge argument: ${argv[i]}`);
      console.error(
        "usage: flow-untracked seed-merge [--after-merge-file <p>] [--followups-jsonl <p>] [--followups-block-file <p>]",
      );
      return 2;
    }
    paths[argv[i]] = value;
  }
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  const read = deps.readFileFn ?? readTextOrNull;
  const text = (flag: string): string =>
    paths[flag] === undefined ? "" : (read(paths[flag]) ?? "");
  const followupEntries: Array<{
    command: string;
    reason: string;
    auto?: boolean;
  }> = [];
  for (const line of text("--followups-jsonl").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (typeof e.command === "string") {
        followupEntries.push({
          command: e.command,
          reason: typeof e.reason === "string" ? e.reason : "",
          auto: e.auto === true,
        });
      }
    } catch {
      // a torn JSONL line must not block the merge path
    }
  }
  const seeds = mergeSeedEntries({
    afterMerge: text("--after-merge-file")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    followupEntries,
    followupsBlock: text("--followups-block-file"),
  });
  const r = applyMergeSeeds(state, seeds, deps.now);
  if (r.added.length > 0) commit(r.state, deps);
  out(
    `flow-untracked: seeded ${r.added.length} item(s) from merge${
      r.added.length > 0 ? ` (${r.added.map((n) => `#${n}`).join(", ")})` : ""
    }\n`,
  );
  return 0;
}

// --- Top-level dispatcher ---

export function run(argv: string[], deps: Deps = {}): number {
  if (argv.length === 0) {
    console.error(
      "flow-untracked: subcommand is required (add | list | file | drop | done | launch | verdict | seed-merge | render)",
    );
    return 2;
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add":
      return runAdd(rest, deps);
    case "list":
      return runList(rest, deps);
    case "file":
      return runFile(rest, deps);
    case "drop":
      return runDrop(rest, deps);
    case "done":
      return runDone(rest, deps);
    case "launch":
      return runLaunch(rest, deps);
    case "verdict":
      return runVerdict(rest, deps);
    case "seed-merge":
      return runSeedMerge(rest, deps);
    case "render":
      return runRender(rest, deps);
    default:
      console.error(`flow-untracked: unknown subcommand '${sub}'`);
      return 2;
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
