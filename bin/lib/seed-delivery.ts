/**
 * Shared seed delivery: type a multi-line launch/resume seed into a live claude
 * pane via `send-keys` with a verified leading-line handshake, chunked below
 * tmux's `send-keys` byte cap, checking every literal send. Pure and injectable
 * (no direct tmux calls) so both the verified launcher (`tmux.ts`) and the
 * SessionStart resume hook reuse ONE implementation.
 *
 * Why a leading-line handshake instead of verifying the whole seed: claude
 * collapses a long multi-line paste into `[Pasted text #N +M lines]` chips, so
 * the seed marker is never rendered as text and a whole-seed capture match would
 * report truncation on EVERY long seed. Verification therefore runs ONLY against
 * the leading line typed alone, BEFORE the remainder exists to chip the box.
 */

/** Injected seams. `send` mirrors `send-keys`; `literal` selects `-l --`. */
export interface DeliverSeedSeams {
  capture: () => string;
  send: (
    keysOrText: string,
    literal: boolean,
  ) => { ok: boolean; stderr: string };
  sleep: (ms: number) => void;
}

export interface DeliverSeedResult {
  delivered: boolean;
  stderr: string;
}

export interface DeliverSeedOpts {
  /** Skip the settle poll (e.g. a caller that already settled the pane itself). */
  settleAttempts?: number;
  maxSendBytes?: number;
}

/** tmux rejects a single literal `send-keys` above ~16 KB; stay well under. */
export const MAX_SEND_KEYS_BYTES = 8192;

const SETTLE_ATTEMPTS = 10;
const SETTLE_INTERVAL_MS = 100;
const VERIFY_ATTEMPTS = 3;
const VERIFY_SETTLE_MS = 150;

/**
 * Split at the FIRST newline. The leading line is everything before it; the
 * remainder KEEPS the newline (so `leadingLine + remainder === seed`). A seed
 * with no newline is entirely its own leading line with an empty remainder.
 */
export function splitSeed(seed: string): {
  leadingLine: string;
  remainder: string;
} {
  const idx = seed.indexOf("\n");
  if (idx === -1) return { leadingLine: seed, remainder: "" };
  return { leadingLine: seed.slice(0, idx), remainder: seed.slice(idx) };
}

/**
 * Split `text` into chunks each ≤ `maxBytes` UTF-8 bytes, never splitting a
 * code point (iterating by code point guarantees this). Concatenating the
 * chunks reproduces `text` exactly.
 */
export function chunkByBytes(text: string, maxBytes: number): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (currentBytes + chBytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Best-effort content-settle gate: poll `capture()` until it is non-empty AND
 * identical across two consecutive probes. Never blocks or fails the launch —
 * the leading-line verify below is the real guarantee, so a pane that never
 * settles falls through and delivery is attempted anyway.
 */
function settleGate(
  seams: DeliverSeedSeams,
  attempts: number,
  intervalMs: number,
): void {
  let prev: string | null = null;
  for (let i = 0; i < attempts; i++) {
    const cur = seams.capture();
    if (cur.trim().length > 0 && cur === prev) return;
    prev = cur;
    seams.sleep(intervalMs);
  }
}

/** Strips all whitespace so a wrapped/indented pane capture still matches. */
function squash(s: string): string {
  return s.replace(/\s+/g, "");
}

/**
 * Send the leading line, verify it echoed intact, then send the remainder.
 * NEVER sends Enter — the caller submits, and only when `delivered` is true.
 */
export function deliverSeed(
  seed: string,
  seams: DeliverSeedSeams,
  opts: DeliverSeedOpts = {},
): DeliverSeedResult {
  if (seed.length === 0) return { delivered: false, stderr: "empty seed" };

  const verifyAttempts = VERIFY_ATTEMPTS;
  const verifySettleMs = VERIFY_SETTLE_MS;
  const maxSendBytes = opts.maxSendBytes ?? MAX_SEND_KEYS_BYTES;

  settleGate(seams, opts.settleAttempts ?? SETTLE_ATTEMPTS, SETTLE_INTERVAL_MS);

  const { leadingLine, remainder } = splitSeed(seed);

  let verified = false;
  for (let attempt = 0; attempt < verifyAttempts; attempt++) {
    for (const chunk of chunkByBytes(leadingLine, maxSendBytes)) {
      const r = seams.send(chunk, true);
      if (!r.ok) return { delivered: false, stderr: r.stderr };
    }
    seams.sleep(verifySettleMs);
    // Whitespace-normalize both sides: a long leading line (up to ~77 chars for
    // a max-length explicit --slug) can wrap across rows in a default 80-column
    // pane, inserting a physical newline/indent that would otherwise defeat a
    // raw substring match and false-fail verification.
    if (squash(seams.capture()).includes(squash(leadingLine))) {
      verified = true;
      break;
    }
    // Echo came back short. `C-u` (kill-to-line-start) reliably clears the box
    // BECAUSE it holds exactly one line here — the remainder isn't typed yet.
    if (attempt < verifyAttempts - 1) {
      seams.send("C-u", false);
      seams.sleep(verifySettleMs);
    }
  }
  if (!verified) {
    return {
      delivered: false,
      stderr: `seed leading line never echoed intact after ${verifyAttempts} attempts`,
    };
  }

  // Remainder: fire-and-trust. Do NOT capture-and-verify here — a long paste
  // collapses into chips, so the marker is unmatchable once the body is present.
  if (remainder.length > 0) {
    for (const chunk of chunkByBytes(remainder, maxSendBytes)) {
      const r = seams.send(chunk, true);
      if (!r.ok) return { delivered: false, stderr: r.stderr };
    }
  }

  return { delivered: true, stderr: "" };
}
