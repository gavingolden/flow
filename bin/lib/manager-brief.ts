/**
 * What the manager may read about one pipeline: a fixed list of PR body
 * sections, the plan's open questions and follow-ups, the saved pause block,
 * and the phase with its age. Never a diff, never a section outside the list.
 * A transcript tail is read only on request and only when no pause block was
 * saved. The caller (`flow-manager-ctl brief`) checks scope first.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultExec, GH_TIMEOUT_MS, type ExecFn } from "./epic-manage-observe";
import { readLastPause, type PauseSlots } from "./pause-capture";
import {
  defaultProjectsRoot,
  encodeProjectSegment,
  findSessionJsonlsSync,
} from "./session-discovery";
import { flowStateDir } from "./paths";
import { repoNameForPath } from "./manager-scope";
import {
  FINISHED_PHASE_SET,
  phaseEnteredAt,
  readState,
  type PipelineState,
} from "./state";

export const BRIEF_PR_SECTIONS = [
  "TLDR",
  "User-facing changes",
  "System changes",
  "Deviations from plan",
  "Test Steps",
] as const;

export const BRIEF_PLAN_SECTIONS = [
  "Open Questions",
  "Candidate follow-ups",
] as const;

const SECTION_CHAR_LIMIT = 4000;
const TAIL_BYTES = 128 * 1024;
const TAIL_MESSAGE_CHARS = 800;

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each heading found at `##` or `###` depth (its last occurrence), up to the next such heading. A missing heading is simply absent, unlike `explain-judge`'s all-or-nothing `extractSections`. */
export function extractPrSections(
  markdown: string,
  headings: readonly string[],
): Record<string, string> {
  const lines = markdown.split("\n");
  const out: Record<string, string> = {};
  for (const heading of headings) {
    const re = new RegExp(`^#{2,3}\\s+${escapeRegExp(heading)}\\s*$`, "i");
    let at = -1;
    lines.forEach((l, i) => {
      if (re.test(l)) at = i;
    });
    if (at === -1) continue;
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) {
      if (/^#{2,3}\s+/.test(lines[i])) {
        end = i;
        break;
      }
    }
    const body = lines
      .slice(at + 1, end)
      .join("\n")
      .trim()
      .slice(0, SECTION_CHAR_LIMIT);
    if (body !== "") out[heading] = body;
  }
  return out;
}

export type PipelineBrief = {
  ok: true;
  slug: string;
  phase: string;
  phaseEnteredAt: string;
  ageMs: number;
  repo: string;
  pr?: number;
  prUrl?: string;
  prSections?: Record<string, string>;
  planSections?: Record<string, string>;
  pause: PauseSlots | null;
  /** True when no saved pause block matches the current phase; the manager says so and never invents one. */
  pauseMissing: boolean;
  /** The phase log's outcome text, shown only when the pause block is missing. */
  outcome?: string;
  transcriptTail?: string[];
};

export type BriefDeps = {
  exec?: ExecFn;
  stateDir?: string;
  now?: () => Date;
  transcriptTail?: number;
  projectsRoot?: string;
};

async function prBody(
  pr: number,
  repo: string,
  exec: ExecFn,
): Promise<string | null> {
  const r = await exec(
    "gh",
    ["pr", "view", String(pr), "--json", "body"],
    repo,
    GH_TIMEOUT_MS,
  );
  if (r.exitCode !== 0 || r.timedOut) return null;
  try {
    const body = (JSON.parse(r.stdout) as { body?: unknown }).body;
    return typeof body === "string" ? body : null;
  } catch {
    return null;
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      (b as { type?: string; text?: unknown })?.type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .join("\n");
}

/** The last `n` user/assistant text messages of the pipeline's newest session transcript, read from its final 128 KiB only. */
export function readTranscriptTail(
  state: { slug: string; worktree?: string; repo: string },
  n: number,
  projectsRoot: string = defaultProjectsRoot(),
): string[] {
  const dir = path.join(
    projectsRoot,
    encodeProjectSegment(state.worktree ?? state.repo),
  );
  const files = findSessionJsonlsSync(dir, state.slug)
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (files.length === 0) return [];
  let raw = "";
  const fd = fs.openSync(files[0].f, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    raw = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const lines = raw.split("\n");
  const msgs: string[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as {
        type?: string;
        message?: { content?: unknown };
      };
      if (e.type !== "user" && e.type !== "assistant") continue;
      const text = messageText(e.message?.content).trim();
      if (text) msgs.push(`${e.type}: ${text.slice(0, TAIL_MESSAGE_CHARS)}`);
    } catch {
      // a torn first line of the tail window, or a non-message entry
    }
  }
  return msgs.slice(-n);
}

export async function buildBrief(
  slug: string,
  deps: BriefDeps = {},
): Promise<PipelineBrief | null> {
  const stateDir = deps.stateDir ?? flowStateDir();
  const state = readState(slug, stateDir);
  if (!state) return null;
  const now = (deps.now ?? (() => new Date()))();
  const entered = phaseEnteredAt(state);
  const pause = readLastPause(slug, stateDir);
  const brief: PipelineBrief = {
    ok: true,
    slug,
    phase: state.phase,
    phaseEnteredAt: entered,
    ageMs: Math.max(0, now.getTime() - Date.parse(entered)),
    repo: state.repo,
    ...(state.pr !== undefined ? { pr: state.pr } : {}),
    ...(state.prUrl ? { prUrl: state.prUrl } : {}),
    pause,
    pauseMissing: pause === null,
  };
  if (state.pr !== undefined) {
    const body = await prBody(state.pr, state.repo, deps.exec ?? defaultExec);
    if (body) brief.prSections = extractPrSections(body, BRIEF_PR_SECTIONS);
  }
  if (state.worktree) {
    try {
      const plan = fs.readFileSync(
        path.join(state.worktree, ".flow-tmp", "plan.md"),
        "utf8",
      );
      const sections = extractPrSections(plan, BRIEF_PLAN_SECTIONS);
      if (Object.keys(sections).length > 0) brief.planSections = sections;
    } catch {
      // no plan file: nothing to show
    }
  }
  if (pause === null) {
    const log = [...(state.phaseLog ?? [])]
      .reverse()
      .find((e) => e.phase === state.phase);
    if (log?.outcome) brief.outcome = log.outcome;
    if ((deps.transcriptTail ?? 0) > 0) {
      brief.transcriptTail = readTranscriptTail(
        state,
        deps.transcriptTail ?? 0,
        deps.projectsRoot,
      );
    }
  }
  return brief;
}

/** Names only — slug, repo and epic — for every unfinished pipeline; no phase, PR, plan or pause text. */
export function scopeCandidates(
  states: PipelineState[],
): Array<{ slug: string; repo: string; epic?: string }> {
  return states
    .filter((s) => !FINISHED_PHASE_SET.has(s.phase))
    .map((s) => ({
      slug: s.slug,
      repo: repoNameForPath(s.repo),
      ...(s.epic ? { epic: s.epic.slug } : {}),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
