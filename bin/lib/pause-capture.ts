/**
 * Saves each pipeline's last pause block so the global manager can show it
 * without reading a transcript. The Stop hook already receives
 * `last_assistant_message`; at a permitted turn end on a legitimate end phase
 * it parses the pause-output contract's labeled slots and writes them to
 * `~/.flow/state/checkpoints/<slug>/last-pause.json`.
 *
 * Best-effort throughout: nothing here may change the hook's decision or exit
 * code. A record is only ever returned while it still describes the state's
 * current pause (same phase, same phase-entered time).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { checkpointDir } from "./checkpoint-freshness";
import { flowStateDir } from "./paths";
import { readState, type PipelineState } from "./state";

export type PauseSlots = {
  phase: string;
  at: string;
  tldr?: string;
  unsolved?: string;
  needsAttention?: string;
  manualAction?: string;
  untracked?: string;
  nextAction?: string;
};

type Parsed = Omit<PauseSlots, "phase" | "at">;

const SLOT_KEYS: Record<string, keyof Parsed> = {
  tldr: "tldr",
  unsolved: "unsolved",
  "needs attention": "needsAttention",
  "manual action": "manualAction",
  untracked: "untracked",
  "next action": "nextAction",
};

const SLOT_LINE =
  /^\s*(?:[-*]\s+)?\*\*(TLDR|Unsolved|Needs attention|Manual action|Untracked|Next action):\*\*\s*(.*)$/i;
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;
const SLOT_CHAR_LIMIT = 2000;

/** The last pause block in `text`; null when it carries neither a TLDR nor a Next action. */
export function parsePauseSlots(text: string): Parsed | null {
  const lines = text.split("\n");
  let start = 0;
  lines.forEach((l, i) => {
    if (SLOT_LINE.exec(l)?.[1].toLowerCase() === "tldr") start = i;
  });
  const out: Parsed = {};
  let current: keyof Parsed | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current === null) return;
    const body = buf.join("\n").trim().slice(0, SLOT_CHAR_LIMIT);
    if (body !== "") out[current] = body;
  };
  for (const line of lines.slice(start)) {
    const m = SLOT_LINE.exec(line);
    if (m) {
      flush();
      current = SLOT_KEYS[m[1].toLowerCase()];
      buf = [m[2]];
    } else if (HEADING_LINE.test(line)) {
      flush();
      current = null;
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return out.tldr === undefined && out.nextAction === undefined ? null : out;
}

function lastPausePath(slug: string, dir: string): string {
  return path.join(checkpointDir(slug, dir), "last-pause.json");
}

/** When the state entered its current phase: its last `phaseLog` entry for that phase, else `updatedAt`. */
function phaseEnteredAt(state: PipelineState): string {
  const entry = [...(state.phaseLog ?? [])]
    .reverse()
    .find((e) => e.phase === state.phase);
  return entry?.at ?? state.updatedAt;
}

/**
 * Writes the pause block in `message` for `slug` at `phase`. Writes nothing
 * for a message with no block, when the state is gone, or when it has already
 * moved off `phase`. Never throws.
 */
export function recordLastPause(
  slug: string,
  phase: string,
  message: string | undefined,
  dir: string = flowStateDir(),
): void {
  try {
    if (!message) return;
    const slots = parsePauseSlots(message);
    if (!slots) return;
    const state = readState(slug, dir);
    if (!state || state.phase !== phase) return;
    const file = lastPausePath(slug, dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record: PauseSlots = { phase, at: phaseEnteredAt(state), ...slots };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // the hook's decision never depends on this
  }
}

const OPTIONAL_STRINGS: Array<keyof Parsed> = [
  "tldr",
  "unsolved",
  "needsAttention",
  "manualAction",
  "untracked",
  "nextAction",
];

/** The saved block, or null when none exists or it no longer matches the state's current phase and phase-entered time. */
export function readLastPause(
  slug: string,
  dir: string = flowStateDir(),
): PauseSlots | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(lastPausePath(slug, dir), "utf8"),
    ) as PauseSlots;
    if (typeof v?.phase !== "string" || typeof v.at !== "string") return null;
    if (
      OPTIONAL_STRINGS.some(
        (k) => v[k] !== undefined && typeof v[k] !== "string",
      )
    ) {
      return null;
    }
    const state = readState(slug, dir);
    if (!state || state.phase !== v.phase || phaseEnteredAt(state) !== v.at) {
      return null;
    }
    return v;
  } catch {
    return null;
  }
}
