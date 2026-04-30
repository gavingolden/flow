import fsp from "node:fs/promises";
import type { Writable } from "node:stream";
import {
  type LogFile,
  latestFile,
  listLogFiles,
} from "./discover.js";
import { type RenderOptions, colorsFor, renderLine } from "./render.js";

export interface FollowOptions extends RenderOptions {
  stdout: Writable;
  stderr: Writable;
  taskDir: string;
  taskId: string;
  // Total set of files at follow start (already stamp-sorted, optionally
  // phase-filtered). The follower tails `latestFile(targetSet)`.
  targetSet: LogFile[];
  // Polling cadence and idle-window thresholds. Defaults are tuned for
  // a real terminal session; tests inject smaller values so wall-clock
  // is sub-second.
  pollIntervalMs?: number;
  idleWindowMs?: number;
  // When set, skip the initial full-backlog dump and start reading from
  // the byte offset that contains the last `tailEvents` newline-terminated
  // events (or 0 if the file has fewer events). The poll loop continues
  // from end-of-file as usual.
  tailEvents?: number;
}

export type FollowExitReason =
  | "stream-json-result"
  | "flow-result"
  | "idle"
  | "no-file";

export interface FollowResult {
  reason: FollowExitReason;
  // When the file ended with a recognized result event, surface the
  // status string ("ok" / "failed" / "needs-human" / "success" / "error").
  status?: string;
}

const DEFAULT_POLL_MS = 250;
const DEFAULT_IDLE_MS = 2_000;

export async function follow(opts: FollowOptions): Promise<FollowResult> {
  const target = latestFile(opts.targetSet);
  if (!target) {
    opts.stdout.write(`no logs yet for ${opts.taskId}\n`);
    return { reason: "no-file" };
  }
  const colors = colorsFor(opts);
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const idleMs = opts.idleWindowMs ?? DEFAULT_IDLE_MS;

  // Header banner so the user knows which file is being tailed.
  opts.stdout.write(
    `${colors.bold(`── ${target.phase} @ ${target.stamp} (follow) ──`)}\n`,
  );

  let position = 0;
  let pending = "";
  let lineNum = 0;
  let idleAccumMs = 0;
  let exitReason: FollowExitReason | null = null;
  let exitStatus: string | undefined;

  // Process one chunk of newly-read bytes through the renderer. Returns
  // a terminal-event signal if a `result` event was seen.
  const processChunk = (chunk: string): void => {
    pending += chunk;
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      lineNum++;
      const handled = renderOneLine(line, target.path, lineNum, opts);
      if (handled.terminal) {
        exitReason = handled.terminal;
        exitStatus = handled.status;
      }
      if (exitReason) return;
      nl = pending.indexOf("\n");
    }
  };

  // Step 1: render anything already present so the user sees backlog.
  // With `tailEvents`, seek to the offset of the Nth-from-last event so
  // the user sees the tail (live state) instead of stale head events.
  const startOffset =
    opts.tailEvents != null
      ? await offsetForLastNLines(target.path, opts.tailEvents)
      : 0;
  const initial = await readFromOffset(target.path, startOffset);
  position = initial.size;
  processChunk(initial.text);

  // Step 2: poll for growth until terminal event or idle.
  while (!exitReason) {
    await sleep(pollMs);
    const update = await readFromOffset(target.path, position);
    if (update.text.length > 0) {
      idleAccumMs = 0;
      position = update.size;
      processChunk(update.text);
    } else {
      idleAccumMs += pollMs;
      if (idleAccumMs >= idleMs) {
        exitReason = "idle";
      }
    }
  }

  // Flush pending residue (a file ending without `\n`) through the renderer
  // — same contract as the sink's residue flush in jsonl-sink.ts.
  if (pending.length > 0) {
    lineNum++;
    renderOneLine(pending, target.path, lineNum, opts);
    pending = "";
  }

  // Footer: surface exit reason + next-phase hint if a newer file exists.
  await writeFooter(target, exitReason, exitStatus, opts);
  return { reason: exitReason, status: exitStatus };
}

// Walks the file backward from EOF in fixed-size chunks, counting newlines,
// and returns the byte offset just past the boundary newline that begins the
// last `n` events. Returns 0 if the file is empty or has fewer than `n`
// events. A trailing-`\n` file needs one extra newline to skip past `n`
// complete lines (the trailing `\n` ends the last line rather than starting
// a new one); an unterminated file does not.
async function offsetForLastNLines(
  filePath: string,
  n: number,
): Promise<number> {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return 0;
  }
  if (stat.size === 0) return 0;
  const fh = await fsp.open(filePath, "r");
  try {
    const lastByte = Buffer.alloc(1);
    await fh.read(lastByte, 0, 1, stat.size - 1);
    const trailingNewline = lastByte[0] === 0x0a;
    const newlinesNeeded = trailingNewline ? n + 1 : n;

    const CHUNK = 4096;
    const buf = Buffer.alloc(CHUNK);
    let pos = stat.size;
    let found = 0;
    while (pos > 0) {
      const chunkSize = Math.min(CHUNK, pos);
      pos -= chunkSize;
      const got = await fh.read(buf, 0, chunkSize, pos);
      const data = buf.subarray(0, got.bytesRead);
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] === 0x0a) {
          found++;
          if (found === newlinesNeeded) {
            return pos + i + 1;
          }
        }
      }
    }
    return 0;
  } finally {
    await fh.close();
  }
}

async function readFromOffset(
  filePath: string,
  offset: number,
): Promise<{ text: string; size: number }> {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return { text: "", size: offset };
  }
  if (stat.size <= offset) return { text: "", size: stat.size };
  const fh = await fsp.open(filePath, "r");
  try {
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    return { text: buf.toString("utf8"), size: stat.size };
  } finally {
    await fh.close();
  }
}

interface RenderedLine {
  terminal: FollowExitReason | null;
  status?: string;
}

function renderOneLine(
  line: string,
  filePath: string,
  lineNum: number,
  opts: FollowOptions,
): RenderedLine {
  if (line.length === 0) return { terminal: null };
  const out = renderLine(line, opts);
  if ("malformed" in out) {
    opts.stderr.write(
      `warning: malformed jsonl line at ${filePath}:${lineNum}\n`,
    );
    return { terminal: null };
  }
  for (const rendered of out.lines) {
    opts.stdout.write(`${rendered}\n`);
  }
  // Re-parse to detect terminal events. The renderer threw away the parsed
  // shape; rather than complicate its return type for the one-call site
  // that needs it, parse the line again here. We're past the malformed
  // branch above, so renderLine already accepted this line as valid JSON
  // and `parsed` will be a record.
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed["type"] === "result") {
    const subtype =
      typeof parsed["subtype"] === "string" ? parsed["subtype"] : undefined;
    const status = parsed["is_error"] === true ? "error" : subtype ?? "ok";
    return { terminal: "stream-json-result", status };
  }
  if (parsed["kind"] === "result") {
    const status =
      typeof parsed["status"] === "string" ? parsed["status"] : undefined;
    return { terminal: "flow-result", status };
  }
  return { terminal: null };
}

async function writeFooter(
  target: LogFile,
  reason: FollowExitReason,
  status: string | undefined,
  opts: FollowOptions,
): Promise<void> {
  const colors = colorsFor(opts);
  const reasonLine =
    reason === "idle"
      ? colors.dim("(follow exited: no new bytes for the idle window)")
      : reason === "stream-json-result"
        ? colors.dim(`(follow exited: claude result status=${status ?? "?"})`)
        : reason === "flow-result"
          ? colors.dim(`(follow exited: flow result status=${status ?? "?"})`)
          : "";
  if (reasonLine) opts.stdout.write(`${reasonLine}\n`);

  const all = await listLogFiles(opts.taskDir);
  const newer = all.filter((f) => f.stamp > target.stamp);
  if (newer.length === 0) {
    opts.stdout.write(
      `${colors.dim("pipeline is between phases or finished.")}\n`,
    );
    return;
  }
  // `listLogFiles` returns files stamp-sorted ascending, so the *next*
  // chronological phase after `target` is the first entry of `newer`,
  // not the last. The last would jump past any intermediate phases.
  const next = newer[0]!;
  const hint = `flow log ${opts.taskId} --follow --phase ${next.phase}`;
  opts.stdout.write(`${colors.dim(`hint: ${hint}`)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
