#!/usr/bin/env bun
/**
 * Discovered-but-not-in-plan work items: a decision surface, not an issue
 * tracker. Mid-run discoveries have no home today — they either get
 * auto-filed (the candidate-issues machinery), buried in prose, or lost.
 * `flow-untracked` gives them one: `add` records an item on `state.json`
 * (survives `flow-remove-worktree` — the terminal block after MERGED still
 * needs to show it), `list`/`render` surface it at every pause, and `file
 * <id>` files it as a real issue only on an explicit, user-instructed reply
 * — never automatically (AGENTS.md "Auto-issue-create exemption").
 *
 * Storage: `state.json.untracked[]` (not the worktree — `flow-followups`'s
 * JSONL pattern dies with the worktree, which is gone by MERGED). Ids are
 * monotonic per pipeline and never renumbered. Items not filed by `flow
 * done` are discarded with the state file; nothing accumulates across
 * pipelines.
 *
 * Usage:
 *   flow-untracked add --title <t> [--body <b>] --source <s>
 *   flow-untracked list [--json]
 *   flow-untracked file <id>
 *   flow-untracked drop <id>
 *   flow-untracked render --format gate|markdown [--unfiled-only]
 *
 * Exit codes:
 *   0 — success (including no-op cases like an empty/absent state file for
 *       `list`/`render`).
 *   1 — `flow-create-issue` failed during `file`.
 *   2 — bad CLI args, missing state file (for `add`/`file`/`drop`), or an
 *       unresolvable slug.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readState,
  writeState,
  type PipelineState,
  type UntrackedItem,
} from "./lib/state";
import { resolveSlugAmbient } from "./lib/session-identity";

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
  input: { title: string; body?: string; source: string },
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
  return { ...state, untracked: [...items, item] };
}

export type CreateIssue = (
  title: string,
  body: string | undefined,
) => { url: string };

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
  const { url } = createIssue(item.title, item.body);
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
function capped(items: UntrackedItem[]): {
  shown: UntrackedItem[];
  remaining: number;
} {
  const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at));
  const shown = sorted.slice(0, UNTRACKED_RENDER_CAP);
  return { shown, remaining: sorted.length - shown.length };
}

export function renderGate(items: UntrackedItem[]): string[] {
  const { shown, remaining } = capped(items);
  const lines = shown.map(
    (i) => `  - #${i.id} ${i.title} (reply: file #${i.id} / drop #${i.id})`,
  );
  if (remaining > 0) {
    lines.push(`  (+${remaining} more — flow-untracked list)`);
  }
  return lines;
}

export function renderMarkdown(items: UntrackedItem[]): string[] {
  const { shown, remaining } = capped(items);
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

// --- CLI arg parsing ---

type AddArgs = { title: string; body?: string; source: string };

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
    else return { error: `unknown flag: ${flag}` };
    i++;
  }
  if (!out.title) return { error: "--title is required" };
  if (!out.source) return { error: "--source is required" };
  return out as AddArgs;
}

type RenderArgs = { format: "gate" | "markdown"; unfiledOnly: boolean };

function parseRenderArgs(argv: string[]): RenderArgs | { error: string } {
  const out: Partial<RenderArgs> = { unfiledOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--unfiled-only") {
      out.unfiledOnly = true;
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
      "usage: flow-untracked add --title <t> [--body <b>] --source <s>",
    );
    return 2;
  }
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  const next = addItem(state, parsed, deps.now);
  saveState(next, deps);
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
        throw new Error(
          `flow-create-issue exited ${r.status}: ${(r.stderr ?? "").trim()}`,
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

function runFile(argv: string[], deps: Deps): number {
  const id = parseId(argv);
  if (typeof id !== "number") {
    console.error(`flow-untracked: ${id.error}`);
    console.error("usage: flow-untracked file <id>");
    return 2;
  }
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  const createIssue = deps.createIssue ?? defaultCreateIssue();
  try {
    const next = fileItem(state, id, createIssue);
    saveState(next, deps);
    return 0;
  } catch (e) {
    console.error(`flow-untracked: ${(e as Error).message}`);
    return 1;
  }
}

function runDrop(argv: string[], deps: Deps): number {
  const id = parseId(argv);
  if (typeof id !== "number") {
    console.error(`flow-untracked: ${id.error}`);
    console.error("usage: flow-untracked drop <id>");
    return 2;
  }
  const state = loadState(deps);
  if (!state) {
    console.error("flow-untracked: no state file for this pipeline");
    return 2;
  }
  try {
    const next = dropItem(state, id, deps.now);
    saveState(next, deps);
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
      "usage: flow-untracked render --format gate|markdown [--unfiled-only]",
    );
    return 2;
  }
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const state = loadState(deps);
  const items = (state?.untracked ?? []).filter(
    (i) =>
      i.droppedAt === undefined &&
      (!parsed.unfiledOnly || i.filedAs === undefined),
  );
  const lines =
    parsed.format === "gate" ? renderGate(items) : renderMarkdown(items);
  if (lines.length > 0) out(lines.join("\n") + "\n");
  return 0;
}

// --- Top-level dispatcher ---

export function run(argv: string[], deps: Deps = {}): number {
  if (argv.length === 0) {
    console.error(
      "flow-untracked: subcommand is required (add | list | file | drop | render)",
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
