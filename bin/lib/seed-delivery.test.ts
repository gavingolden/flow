import { describe, expect, it, vi } from "vitest";
import {
  chunkByBytes,
  deliverSeed,
  MAX_SEND_KEYS_BYTES,
  splitSeed,
  type DeliverSeedSeams,
} from "./seed-delivery";

const MARKER = "[pipeline-slug: csv-export]";
const BODY = "Use the /flow-pipeline skill for: csv export";
const SEED = `${MARKER}\n${BODY}`;

type Send = { text: string; literal: boolean };

/**
 * Models a live claude pane: the capture echoes the leading line only AFTER a
 * literal chunk lands (mirroring send-keys typing into the box), and the caller
 * observes every send. Options drive the failure paths:
 *   - `dropLeadingEchoes`: first N post-send captures echo a TRUNCATED leading
 *     line (dropped prefix) → exercises the C-u+resend branch.
 *   - `failLiteral`: literal sends fail with the given stderr.
 * Once the remainder is typed the capture always collapses to a paste chip
 * (no marker) — proving verification must run before the remainder exists.
 */
function makeSeams(
  seed: string,
  opts: {
    dropLeadingEchoes?: number;
    failLiteral?: string;
  } = {},
) {
  const { leadingLine } = splitSeed(seed);
  const sends: Send[] = [];
  let leadingSent = false;
  let leadingVerified = false;
  let remainderSent = false;
  let echoChecks = 0;
  let capturedAfterRemainder = false;
  const send = vi.fn((text: string, literal: boolean) => {
    sends.push({ text, literal });
    if (literal) {
      if (opts.failLiteral !== undefined) {
        return { ok: false, stderr: opts.failLiteral };
      }
      if (leadingVerified) remainderSent = true;
      else leadingSent = true;
    }
    return { ok: true, stderr: "" };
  });
  const capture = vi.fn((): string => {
    if (!leadingSent) return "❯ a rendered claude pane"; // settle-gate phase
    if (remainderSent) {
      capturedAfterRemainder = true;
      return "❯ [Pasted text #1 +9 lines][Pasted text #2 +8 lines]";
    }
    echoChecks++;
    if (echoChecks <= (opts.dropLeadingEchoes ?? 0)) {
      return `❯ ${leadingLine.slice(3)}`; // dropped prefix ⇒ no full-marker match
    }
    leadingVerified = true;
    return `❯ ${leadingLine}`;
  });
  const seams: DeliverSeedSeams = { capture, send, sleep: () => {} };
  return {
    seams,
    sends,
    send,
    capture,
    get capturedAfterRemainder() {
      return capturedAfterRemainder;
    },
  };
}

describe("splitSeed", () => {
  it("should return the whole seed as the leading line and an empty remainder when the seed has no newline", () => {
    expect(splitSeed("just one line")).toEqual({
      leadingLine: "just one line",
      remainder: "",
    });
  });

  it("should split at the FIRST newline when the seed body itself contains newlines", () => {
    const seed = `${MARKER}\nline one\nline two`;
    const { leadingLine, remainder } = splitSeed(seed);
    expect(leadingLine).toBe(MARKER);
    expect(remainder).toBe("\nline one\nline two");
    expect(leadingLine + remainder).toBe(seed); // remainder keeps the newline
  });
});

describe("chunkByBytes", () => {
  it("should return a single chunk when the text fits the byte budget", () => {
    expect(chunkByBytes("short", 8192)).toEqual(["short"]);
  });

  it("should split into multiple chunks each within the byte budget when the text exceeds it", () => {
    const text = "a".repeat(20);
    const chunks = chunkByBytes(text, 8);
    expect(chunks).toEqual(["aaaaaaaa", "aaaaaaaa", "aaaa"]);
    for (const c of chunks)
      expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(8);
  });

  it("should never split a multi-byte character across two chunks", () => {
    // "😀" is 4 bytes. With a 6-byte budget only one fits per chunk (never half).
    const chunks = chunkByBytes("😀😀😀", 6);
    expect(chunks).toEqual(["😀", "😀", "😀"]);
  });

  it("should rejoin to the original text when the chunks are concatenated", () => {
    const text = "héllo wörld 😀 with mixed bytes ".repeat(50);
    expect(chunkByBytes(text, 17).join("")).toBe(text);
  });
});

describe("deliverSeed — settle gate", () => {
  it("should not send anything until the pane capture is non-empty and stable across consecutive probes", () => {
    let probes = 0;
    let firstSendAtProbe = -1;
    const capture = vi.fn((): string => {
      probes++;
      if (probes <= 2) return `changing-${probes}`; // unstable
      return "STABLE"; // non-empty and identical thereafter
    });
    const send = vi.fn((_t: string, _l: boolean) => {
      if (firstSendAtProbe < 0) firstSendAtProbe = probes;
      return { ok: true, stderr: "" };
    });
    // Single-line seed whose leading line the "STABLE" capture then echoes.
    deliverSeed("STABLE", { capture, send, sleep: () => {} });
    // The first send must not fire before the capture stabilised (≥3 probes:
    // two changing + the first "STABLE", then a matching repeat).
    expect(firstSendAtProbe).toBeGreaterThanOrEqual(3);
  });
});

describe("deliverSeed — leading-line verification", () => {
  it("should send the leading line alone, then the remainder, then report delivered when the leading line echoes intact", () => {
    const { seams, sends } = makeSeams(SEED);
    expect(deliverSeed(SEED, seams)).toEqual({ delivered: true, stderr: "" });
    expect(sends).toEqual([
      { text: MARKER, literal: true },
      { text: `\n${BODY}`, literal: true },
    ]);
  });

  it("should not send a clear keystroke or re-send when the leading line echoes intact on the first attempt", () => {
    const { seams, sends } = makeSeams(SEED);
    deliverSeed(SEED, seams);
    expect(sends.filter((s) => s.text === "C-u")).toEqual([]);
    expect(sends.filter((s) => s.text === MARKER)).toHaveLength(1);
  });

  it("should send C-u and re-send only the leading line when the echo comes back with the leading characters dropped", () => {
    const { seams, sends } = makeSeams(SEED, { dropLeadingEchoes: 1 });
    expect(deliverSeed(SEED, seams)).toEqual({ delivered: true, stderr: "" });
    expect(sends).toEqual([
      { text: MARKER, literal: true }, // first attempt (echo truncated)
      { text: "C-u", literal: false }, // clear the single-line box
      { text: MARKER, literal: true }, // re-send the leading line ONLY
      { text: `\n${BODY}`, literal: true }, // remainder after verify
    ]);
    // The re-send is the leading line, never the whole seed.
    expect(sends.filter((s) => s.text === SEED)).toEqual([]);
  });

  it("should verify the leading line BEFORE the remainder is typed, so a capture that stops matching once the body is present never triggers a re-send", () => {
    const seam = makeSeams(SEED);
    expect(deliverSeed(SEED, seam.seams)).toEqual({
      delivered: true,
      stderr: "",
    });
    expect(seam.sends.filter((s) => s.text === "C-u")).toEqual([]);
    // deliverSeed must never capture after the remainder is typed (chip window).
    expect(seam.capturedAfterRemainder).toBe(false);
  });

  it("should report not-delivered after the bounded attempt limit when the leading line never echoes intact", () => {
    const { seams, sends } = makeSeams(SEED, { dropLeadingEchoes: 99 });
    const result = deliverSeed(SEED, seams);
    expect(result.delivered).toBe(false);
    expect(result.stderr).toMatch(/never echoed intact/);
    // No remainder, no Enter — only leading-line sends and the between-attempt C-u.
    expect(sends.filter((s) => s.text === MARKER)).toHaveLength(3);
    expect(sends.filter((s) => s.text === `\n${BODY}`)).toEqual([]);
  });
});

describe("deliverSeed — send failures", () => {
  it("should report not-delivered and surface the tmux stderr when the leading-line literal send fails", () => {
    const { seams, sends } = makeSeams(SEED, {
      failLiteral: "command too long",
    });
    expect(deliverSeed(SEED, seams)).toEqual({
      delivered: false,
      stderr: "command too long",
    });
    expect(sends).toEqual([{ text: MARKER, literal: true }]);
  });

  it("should report not-delivered and surface the tmux stderr when a remainder chunk send fails", () => {
    // Leading line verifies, then the remainder send fails.
    const { leadingLine } = splitSeed(SEED);
    const sends: Send[] = [];
    let leadingSent = false;
    let leadingVerified = false;
    const seams: DeliverSeedSeams = {
      capture: () => {
        if (!leadingSent) return "ready";
        leadingVerified = true;
        return `❯ ${leadingLine}`;
      },
      send: (text, literal) => {
        sends.push({ text, literal });
        if (literal && leadingVerified) {
          return { ok: false, stderr: "remainder rejected" };
        }
        if (literal) leadingSent = true;
        return { ok: true, stderr: "" };
      },
      sleep: () => {},
    };
    expect(deliverSeed(SEED, seams)).toEqual({
      delivered: false,
      stderr: "remainder rejected",
    });
  });

  it("should stop sending further chunks once a chunk send fails", () => {
    // A leading line that needs two chunks; the SECOND chunk fails ⇒ stop.
    const seed = "a".repeat(20); // single-line seed, no remainder
    const sends: Send[] = [];
    let sent = 0;
    const seams: DeliverSeedSeams = {
      capture: () => "irrelevant",
      send: (text, literal) => {
        sends.push({ text, literal });
        sent++;
        return sent >= 2
          ? { ok: false, stderr: "boom" }
          : { ok: true, stderr: "" };
      },
      sleep: () => {},
    };
    const result = deliverSeed(seed, seams, { maxSendBytes: 8 });
    expect(result).toEqual({ delivered: false, stderr: "boom" });
    // 3 chunks would fit, but delivery halts after the 2nd (failing) chunk.
    expect(sends).toHaveLength(2);
  });
});

describe("deliverSeed — oversized seeds", () => {
  it("should send the remainder as multiple bounded literal chunks when the seed exceeds the send-keys byte cap", () => {
    const body = "x".repeat(MAX_SEND_KEYS_BYTES + 800); // remainder > one chunk
    const seed = `${MARKER}\n${body}`;
    const { seams, sends } = makeSeams(seed);
    expect(deliverSeed(seed, seams)).toEqual({ delivered: true, stderr: "" });
    const literals = sends.filter((s) => s.literal);
    // 1 leading chunk + 2 remainder chunks (the "\n"+body spans two chunks).
    expect(literals).toHaveLength(3);
    for (const s of literals) {
      expect(Buffer.byteLength(s.text, "utf8")).toBeLessThanOrEqual(
        MAX_SEND_KEYS_BYTES,
      );
    }
    // Reassembling the literal sends reproduces the seed exactly.
    expect(literals.map((s) => s.text).join("")).toBe(seed);
  });

  it("should skip the remainder send entirely when the seed is a single line", () => {
    const seed = "just the leading line";
    const { seams, sends } = makeSeams(seed);
    expect(deliverSeed(seed, seams)).toEqual({ delivered: true, stderr: "" });
    expect(sends).toEqual([{ text: seed, literal: true }]);
  });
});
