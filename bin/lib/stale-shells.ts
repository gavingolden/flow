/**
 * Pure selection of Claude Code tool shells (background `run_in_background`
 * waits, timed-out foreground calls) that only watch pipelines that have
 * closed. A shell is selected when it references at least one flow path (a
 * state file directly under the state dir, or a pipeline worktree root) and
 * EVERY flow path it references belongs to a closed pipeline. Slug words and
 * PR numbers are never matched, so `flow ls | grep <slug>` is left alone.
 */

import * as path from "node:path";
import type { OrphanProc } from "./worktree-orphans";
import { WORKTREE_CONTAINER_NAME } from "./worktree-slot";

export type StaleRef = { kind: "state-file" | "worktree"; path: string };
export type StaleTarget = { slug: string; worktree?: string };
export type StaleShell = {
  pid: number;
  pgid: number;
  ownerPid: number;
  ownerAlive: boolean;
  ageSec: number;
  refs: StaleRef[];
  preview: string;
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const SNAPSHOT_MARK = "/.claude/shell-snapshots/snapshot-";
const PREVIEW_MAX = 80;

function firstWord(command: string): string {
  return command.trimStart().split(/\s+/, 1)[0] ?? "";
}

function baseName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** `eval '…'` wrapper, or the shell-snapshot wrapper, or a no-tty child of `claude`. */
export function isClaudeToolShell(
  row: OrphanProc,
  parentCommand: string | undefined,
): boolean {
  if (row.command.includes(SNAPSHOT_MARK) && row.command.includes("eval ")) {
    return true;
  }
  return (
    row.tty === null &&
    row.pgid === row.pid &&
    parentCommand !== undefined &&
    baseName(firstWord(parentCommand)) === "claude" &&
    SHELLS.has(baseName(firstWord(row.command)))
  );
}

const WRAPPER_TAIL = String.raw`(?: < /dev/null)? && pwd -P >\| \S+\s*$`;
const QUOTED = new RegExp(String.raw` eval '([\s\S]*)'${WRAPPER_TAIL}`);
const UNQUOTED = new RegExp(String.raw` eval ([\s\S]*?)${WRAPPER_TAIL}`);

/**
 * The command the model asked for, unwrapped from Claude Code's shell wrapper
 * (quoted `eval '…'` or unquoted `eval … < /dev/null && pwd -P >| …`), or
 * null when neither form unwraps. Never falls back to the raw argv: its first
 * word is always the shell, which would blind the `flow*` exemption.
 */
export function toolShellCommand(command: string): string | null {
  const q = QUOTED.exec(command);
  if (q) return q[1].replace(/'"'"'/g, "'").replace(/'\\''/g, "'");
  const u = UNQUOTED.exec(command);
  return u ? u[1] : null;
}

function startsFlowHelper(cmd: string): boolean {
  const statements = cmd
    .replace(/\\012/g, "\n")
    .split(/&&|\|\||[;|\n(){}]/)
    .map((s) =>
      s
        .trim()
        .replace(/^(?:(?:until|while|if|then|do|else|!)\s+)+/, "")
        .replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, ""),
    );
  return statements.some((s) => {
    const w = baseName(firstWord(s));
    return w === "flow" || w.startsWith("flow-");
  });
}

const NAME_CHARS = String.raw`[^\s"'` + "`" + String.raw`;&|()<>\\$]`;
const SEGMENT_CHARS = String.raw`[^\s/"'` + "`" + String.raw`;&|()<>\\$]`;
const ASSIGN = String.raw`(?:^|[\s;&|(])([A-Za-z_]\w*)=(?:"([^"$` + "`" + String.raw`\\]*)"|'([^']*)'|([^\s;&|"'$` + "`" + String.raw`()]+))`;
const VAR_OR_ASSIGN = new RegExp(
  `${ASSIGN}|\\$\\{(\\w+)\\}|\\$(\\w+)`,
  "g",
);

function expandVariables(text: string, home: string): string {
  const vars = new Map<string, string>([["HOME", home]]);
  const homed = text.replace(/(^|[\s"'=:(])~\//g, `$1${home}/`);
  return homed.replace(
    VAR_OR_ASSIGN,
    (m, name, dq, sq, bare, braced, plain) => {
      if (name) {
        const value = dq ?? sq ?? bare;
        if (value !== undefined) vars.set(name, value);
        return m;
      }
      const ref = braced ?? plain;
      return vars.get(ref) ?? m;
    },
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Flow paths a command names, with `~`, `$HOME` and literal `NAME=value` expanded. */
export function referencedPaths(
  cmd: string,
  home: string,
  stateDir: string,
): StaleRef[] {
  const text = expandVariables(cmd.replace(/\\012/g, "\n"), home);
  const refs = new Map<string, StaleRef>();
  const add = (kind: StaleRef["kind"], p: string): void => {
    refs.set(`${kind}:${p}`, { kind, path: p });
  };
  const stateRe = new RegExp(
    `${escapeRe(stateDir.replace(/\/+$/, ""))}/(${NAME_CHARS}+)(?![$/*?\\[{])`,
    "g",
  );
  for (const m of text.matchAll(stateRe)) {
    if (!m[1].includes("/")) add("state-file", path.join(stateDir, m[1]));
  }
  const wtRe = new RegExp(
    `(/${NAME_CHARS}*?/?${escapeRe(WORKTREE_CONTAINER_NAME)})/(${SEGMENT_CHARS}+)(?![$*?\\[{])`,
    "g",
  );
  for (const m of text.matchAll(wtRe)) add("worktree", `${m[1]}/${m[2]}`);
  return [...refs.values()];
}

/** Matches refs of closed pipelines only; exact basename and exact worktree path. */
export function forPipelines(
  targets: StaleTarget[],
  stateDir: string,
): (ref: StaleRef) => boolean {
  const slugs = new Set(targets.map((t) => t.slug));
  const worktrees = new Set(
    targets.flatMap((t) => (t.worktree ? [path.resolve(t.worktree)] : [])),
  );
  const dir = path.resolve(stateDir);
  return (ref) => {
    if (ref.kind === "worktree") return worktrees.has(path.resolve(ref.path));
    if (path.dirname(path.resolve(ref.path)) !== dir) return false;
    return slugs.has(path.basename(ref.path).split(".")[0]);
  };
}

export function ancestryOf(pid: number, procs: OrphanProc[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set<number>();
  for (let p = byPid.get(pid); p && !out.has(p.pid); p = byPid.get(p.ppid)) {
    out.add(p.pid);
  }
  out.add(pid);
  return out;
}

function previewOf(cmd: string): string {
  const flat = cmd.replace(/\\012/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

export function selectStaleShells(
  procs: OrphanProc[],
  opts: {
    selfUid: number;
    exclude: Set<number>;
    minAgeSec: number;
    home: string;
    stateDir: string;
    matches: (ref: StaleRef) => boolean;
  },
): StaleShell[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out: StaleShell[] = [];
  for (const row of procs) {
    if (
      row.pgid !== row.pid ||
      row.tty !== null ||
      row.uid !== opts.selfUid ||
      row.ageSec < opts.minAgeSec ||
      opts.exclude.has(row.pid) ||
      !isClaudeToolShell(row, byPid.get(row.ppid)?.command)
    ) {
      continue;
    }
    const cmd = toolShellCommand(row.command);
    if (cmd === null || startsFlowHelper(cmd)) continue;
    const refs = referencedPaths(cmd, opts.home, opts.stateDir);
    if (refs.length === 0 || !refs.every(opts.matches)) continue;
    out.push({
      pid: row.pid,
      pgid: row.pgid,
      ownerPid: row.ppid,
      ownerAlive: row.ppid > 1 && byPid.has(row.ppid),
      ageSec: row.ageSec,
      refs,
      preview: previewOf(cmd),
    });
  }
  return out;
}
