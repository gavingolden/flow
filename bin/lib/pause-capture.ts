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
import { phaseEnteredAt, readState, type PipelineState } from "./state";

export type PauseSlots = {
  phase: string;
  at: string;
  tldr?: string;
  unsolved?: string;
  needsAttention?: string;
  manualAction?: string;
  untracked?: string;
  nextAction?: string;
  window?: string;
  /** `"gate"` when `flow-gate-summary` wrote the record from its own render. */
  source?: "gate";
  /** Set once the turn-end hook has treated this record as that turn's block. */
  consumed?: boolean;
};

type Parsed = Omit<PauseSlots, "phase" | "at" | "source" | "consumed">;

const SLOT_KEYS: Record<string, keyof Parsed> = {
  tldr: "tldr",
  unsolved: "unsolved",
  "needs attention": "needsAttention",
  "manual action": "manualAction",
  untracked: "untracked",
  "next action": "nextAction",
  window: "window",
};

const SLOT_LINE =
  /^\s*(?:[-*]\s+)?\*\*(TLDR|Unsolved|Needs attention|Manual action|Untracked|Next action|Window):\*\*\s*(.*)$/i;
// `flow-gate-summary`'s upper-case rows: case-sensitive and column 0, so
// ordinary prose like "Untracked: …" never reads as a slot.
const GATE_ROW =
  /^(TLDR|NEXT ACTION|UNTRACKED|MANUAL ACTION|NEEDS ATTENTION|WINDOW):\s*(.*)$/;

// Gate rows that are not slots (and the sentinel line) end the slot above
// them, so `STATUS:` / `PR:` after a leading TLDR and a trailing sentinel
// never fold into a slot body.
const GATE_BREAK =
  /^(?:(?:STATUS|PR|WHY|CLEANUP|FOLLOW-UPS):|MERGED$|cancelled$|GATED:|NEEDS HUMAN:)/;

function matchSlot(line: string): [string, string] | null {
  const m = SLOT_LINE.exec(line) ?? GATE_ROW.exec(line);
  return m ? [m[1].toLowerCase(), m[2]] : null;
}
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;
const SLOT_CHAR_LIMIT = 2000;

/** The last pause block in `text`; null when it carries neither a TLDR nor a Next action. */
export function parsePauseSlots(text: string): Parsed | null {
  const lines = text.split("\n");
  let start = 0;
  lines.forEach((l, i) => {
    if (matchSlot(l)?.[0] === "tldr") start = i;
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
    const m = matchSlot(line);
    if (m) {
      flush();
      current = SLOT_KEYS[m[0]];
      buf = [m[1]];
    } else if (HEADING_LINE.test(line) || GATE_BREAK.test(line)) {
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

/**
 * The list items of a slot body that the ledger can record: `- ` / `* `
 * bullet lines with no `#N` id (numbered ones are already recorded), skipping
 * `none` / `—` / `n/a`, plus a lone un-bulleted line (an item written inline
 * on the label). Otherwise bullet-only on purpose — the parser folds count
 * lines, `checkpointed:` banners and sentinels into the last slot's body.
 */
export function slotItems(slot: string | undefined): string[] {
  if (!slot) return [];
  // Already-recorded items lead with their `#N` id or carry a reply verb
  // (`done #3`); a bare `#1084` in prose is an ordinary PR/issue mention.
  const isNoise = (text: string): boolean =>
    /^\d+\s.*\b(fixed|deferred|filed|dropped)\b/i.test(text) ||
    /^(checkpointed:|GATED:|MERGED$|NEEDS HUMAN:|cancelled$)/.test(text);
  const recordable = (text: string): boolean =>
    !/^#\d+\b/.test(text) &&
    !/\b(?:file|drop|done|launch)\s+#\d+\b/i.test(text) &&
    !/^(none\b|—|-$|n\/a\b)/i.test(text) &&
    !isNoise(text);
  const lines = slot
    .split("\n")
    .filter((l) => l.trim() !== "" && !isNoise(l.trim()));
  // A single un-bulleted line is the item written inline on the label line
  // (`**Untracked:** <idea>`), the shape a one-item slot usually takes.
  if (lines.length === 1 && !/^\s*[-*]\s/.test(lines[0])) {
    const text = lines[0].trim();
    return recordable(text) ? [text] : [];
  }
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!m) continue;
    const text = m[1].trim();
    if (recordable(text)) out.push(text);
  }
  return out;
}

function lastPausePath(slug: string, dir: string): string {
  return path.join(checkpointDir(slug, dir), "last-pause.json");
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
  opts: { source?: "gate" } = {},
): void {
  try {
    if (!message) return;
    const slots = parsePauseSlots(message);
    if (!slots) return;
    const state = readState(slug, dir);
    if (!state || state.phase !== phase) return;
    const file = lastPausePath(slug, dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record: PauseSlots = {
      phase,
      at: phaseEnteredAt(state),
      ...slots,
      ...(opts.source ? { source: opts.source } : {}),
    };
    writeRecord(file, record);
  } catch {
    // the hook's decision never depends on this
  }
}

function writeRecord(file: string, record: PauseSlots): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Marks the saved record consumed so a later block-less reply is not mistaken for it. Never throws. */
export function markPauseConsumed(
  slug: string,
  dir: string = flowStateDir(),
): void {
  try {
    const record = readLastPause(slug, dir);
    if (!record) return;
    writeRecord(lastPausePath(slug, dir), { ...record, consumed: true });
  } catch {
    // best-effort
  }
}

const OPTIONAL_STRINGS: Array<keyof Parsed> = [
  "tldr",
  "unsolved",
  "needsAttention",
  "manualAction",
  "untracked",
  "nextAction",
  "window",
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
    if (v.consumed !== undefined && typeof v.consumed !== "boolean")
      return null;
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
