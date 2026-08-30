import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { epicCreateSeed, epicResumeSeed, epicRunSeed } from "./epic-seed";
import { flowPipelineResumeSeed, flowPipelineSeed } from "./feature";
import {
  chunkByBytes,
  deliverSeed,
  MAX_SEND_KEYS_BYTES,
  REMAINDER_CHUNK_BYTES,
  REMAINDER_SETTLE_MS,
  sanitizeSeedLine,
  splitSeed,
  type DeliverSeedSeams,
} from "./seed-delivery";
import { requestFilePath } from "./state";

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

  it("should emit a single over-budget chunk when maxBytes is smaller than one code point's byte length, rather than looping or dropping it", () => {
    // "😀" is 4 bytes; a 2-byte budget can never fit it. The guard only splits
    // when `current.length > 0`, so an empty `current` still takes the char —
    // production never reaches this (MAX_SEND_KEYS_BYTES is 8192), but the
    // behavior is pinned here so a future change to loop/throw/drop is caught.
    expect(chunkByBytes("😀", 2)).toEqual(["😀"]);
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

  it("should still attempt delivery when the pane never settles (settleGate exhausts its attempts)", () => {
    // Capture returns a distinct non-empty string every probe during the
    // settle phase — it never stabilises across two consecutive calls. Pins
    // the documented "never settles ⇒ deliver anyway" fall-through.
    const { seams, sends } = makeSeams(SEED);
    let settleProbe = 0;
    const originalCapture = seams.capture;
    seams.capture = vi.fn((): string => {
      settleProbe++;
      if (settleProbe <= 3) return `unstable-${settleProbe}`;
      return originalCapture();
    });
    const result = deliverSeed(SEED, seams, { settleAttempts: 3 });
    expect(result).toEqual({ delivered: true, stderr: "" });
    expect(sends.some((s) => s.text === MARKER)).toBe(true);
  });
});

describe("deliverSeed — leading-line verification", () => {
  it("should send the leading line alone, then the remainder, then report delivered when the leading line echoes intact", () => {
    // Pin: this remainder must stay under the 128-byte remainder chunk size
    // for the single-chunk `sends` shape below to hold by design, not by luck.
    expect(Buffer.byteLength(`\n${BODY}`, "utf8")).toBeLessThan(
      REMAINDER_CHUNK_BYTES,
    );
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
    // Pin: this remainder must stay under the 128-byte remainder chunk size
    // for the single-chunk `sends` shape below to hold by design, not by luck.
    expect(Buffer.byteLength(`\n${BODY}`, "utf8")).toBeLessThan(
      REMAINDER_CHUNK_BYTES,
    );
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
  it("should send the remainder as multiple chunks bounded by the remainder chunk size when the seed exceeds it", () => {
    const body = "x".repeat(MAX_SEND_KEYS_BYTES + 800); // remainder >> one remainder chunk
    const seed = `${MARKER}\n${body}`;
    const { seams, sends } = makeSeams(seed);
    expect(deliverSeed(seed, seams)).toEqual({ delivered: true, stderr: "" });
    const literals = sends.filter((s) => s.literal);
    const [leadingSend, ...remainderChunks] = literals;
    expect(leadingSend).toEqual({ text: MARKER, literal: true });
    // A ~9 KB remainder paced at <=128 bytes/chunk is dozens of chunks, not 3 —
    // the old literal-count pin (3) only held at the pre-pacing 8192-byte cap.
    expect(remainderChunks.length).toBeGreaterThanOrEqual(16);
    for (const s of remainderChunks) {
      expect(Buffer.byteLength(s.text, "utf8")).toBeLessThanOrEqual(
        REMAINDER_CHUNK_BYTES,
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

describe("deliverSeed — remainder pacing", () => {
  it("should send a 2048-byte remainder in <=128-byte chunks with a sleep between consecutive chunks but not after the last", () => {
    const body = "y".repeat(2048);
    const seed = `${MARKER}\n${body}`;
    const { remainder } = splitSeed(seed);
    const { seams, sends } = makeSeams(seed);
    const sleeps: number[] = [];
    seams.sleep = (ms: number) => sleeps.push(ms);
    expect(deliverSeed(seed, seams)).toEqual({ delivered: true, stderr: "" });
    const remainderChunks = sends.filter((s) => s.literal).slice(1);
    const expectedChunkCount = Math.ceil(
      Buffer.byteLength(remainder, "utf8") / REMAINDER_CHUNK_BYTES,
    );
    expect(remainderChunks).toHaveLength(expectedChunkCount);
    for (const s of remainderChunks) {
      expect(Buffer.byteLength(s.text, "utf8")).toBeLessThanOrEqual(
        REMAINDER_CHUNK_BYTES,
      );
    }
    expect(remainderChunks.map((s) => s.text).join("")).toBe(remainder);
    // One REMAINDER_SETTLE_MS sleep between each pair of consecutive remainder
    // chunks, none after the last (settle-gate and leading-line-verify sleeps
    // use different durations, so filtering on the exact value isolates these).
    const remainderSleeps = sleeps.filter((ms) => ms === REMAINDER_SETTLE_MS);
    expect(remainderSleeps).toHaveLength(remainderChunks.length - 1);
  });

  it("should honour remainderChunkBytes and remainderSettleMs overrides so tests never really sleep", () => {
    const body = "z".repeat(50);
    const seed = `${MARKER}\n${body}`;
    const { remainder } = splitSeed(seed);
    const { seams, sends } = makeSeams(seed);
    const sleeps: number[] = [];
    seams.sleep = (ms: number) => sleeps.push(ms);
    const result = deliverSeed(seed, seams, {
      remainderChunkBytes: 10,
      remainderSettleMs: 5,
    });
    expect(result).toEqual({ delivered: true, stderr: "" });
    const remainderChunks = sends.filter((s) => s.literal).slice(1);
    const expectedChunkCount = Math.ceil(
      Buffer.byteLength(remainder, "utf8") / 10,
    );
    expect(remainderChunks).toHaveLength(expectedChunkCount);
    for (const s of remainderChunks) {
      expect(Buffer.byteLength(s.text, "utf8")).toBeLessThanOrEqual(10);
    }
    expect(sleeps.filter((ms) => ms === 5)).toHaveLength(
      remainderChunks.length - 1,
    );
  });
});

describe("supervisor launch seeds — no unverified remainder", () => {
  // Fixed-length injected stateDir (never the real $HOME) so byte bounds stay
  // machine-independent — a 60-char --slug (slug.ts's cap) with a real home
  // dir pushes an absolute request-file path well past a flat bound. Built
  // with a deterministic fixed-length path (not a real mkdtemp draw, which
  // varies in length per OS/run) — these seeds are never written to disk,
  // only string-built, so no real directory needs to exist.
  const dir = path.join(os.tmpdir(), "flow-seed-bounds-fixture");

  const slug = "csv-export";
  const epicDir = ".flow/epics/csv-export";
  const skillDir = path.join(
    dir,
    "skills",
    "pipeline",
    "flow-product-planning",
  );

  // flowPipelineSeed is exported (mirroring flowPipelineResumeSeed on the
  // very next line of feature.ts) so this table calls the real production
  // builder instead of a hand-copied literal that can silently drift from
  // it (a drifted mirror is exactly what made this it.each case
  // constant-true before).
  const builders: Array<{ name: string; seed: string; maxBytes: number }> = [
    {
      name: "flowPipelineSeed",
      seed: flowPipelineSeed(slug, "add CSV export", dir),
      maxBytes: 320,
    },
    {
      name: "flowPipelineResumeSeed",
      seed: flowPipelineResumeSeed(slug),
      maxBytes: 320,
    },
    {
      name: "epicCreateSeed",
      seed: epicCreateSeed(
        "add CSV export",
        epicDir,
        skillDir,
        requestFilePath(slug, dir),
      ),
      maxBytes: 500,
    },
    {
      name: "epicResumeSeed",
      seed: epicResumeSeed(slug, epicDir, skillDir),
      maxBytes: 500,
    },
    {
      name: "epicRunSeed",
      seed: epicRunSeed(slug, epicDir),
      maxBytes: 500,
    },
  ];

  it.each(builders)(
    "$name produces a single line with an empty splitSeed remainder",
    ({ seed, maxBytes }) => {
      expect(splitSeed(seed).remainder).toBe("");
      expect(Buffer.byteLength(seed, "utf8")).toBeLessThanOrEqual(maxBytes);
    },
  );

  // The motivating worst case (block comment above, and the PR's
  // "Deviations from plan" note) is a 60-char --slug (slug.ts's
  // MAX_SLUG_LENGTH), not the 10-char "csv-export" every row above uses —
  // exercise the bound at the cap it was actually sized for.
  const capSlug = "a".repeat(60);
  const capEpicDir = `.flow/epics/${capSlug}`;
  const capSkillDir = path.join(
    dir,
    "skills",
    "pipeline",
    "flow-product-planning",
  );

  const buildersAtCap: Array<{ name: string; seed: string; maxBytes: number }> =
    [
      {
        name: "flowPipelineSeed",
        seed: flowPipelineSeed(capSlug, "add CSV export", dir),
        maxBytes: 320,
      },
      {
        name: "flowPipelineResumeSeed",
        seed: flowPipelineResumeSeed(capSlug),
        maxBytes: 320,
      },
      {
        name: "epicCreateSeed",
        seed: epicCreateSeed(
          "add CSV export",
          capEpicDir,
          capSkillDir,
          requestFilePath(capSlug, dir),
        ),
        maxBytes: 500,
      },
      {
        name: "epicResumeSeed",
        seed: epicResumeSeed(capSlug, capEpicDir, capSkillDir),
        maxBytes: 500,
      },
      {
        name: "epicRunSeed",
        seed: epicRunSeed(capSlug, capEpicDir),
        maxBytes: 500,
      },
    ];

  it.each(buildersAtCap)(
    "$name stays within its bound at the 60-char slug cap",
    ({ seed, maxBytes }) => {
      expect(splitSeed(seed).remainder).toBe("");
      expect(Buffer.byteLength(seed, "utf8")).toBeLessThanOrEqual(maxBytes);
    },
  );
});

describe("sanitizeSeedLine", () => {
  it("maps TAB (0x09) to a single space", () => {
    expect(sanitizeSeedLine("a\tb")).toBe("a b");
  });

  it("maps a newline to a single space", () => {
    expect(sanitizeSeedLine("a\nb")).toBe("a b");
  });

  it("maps DEL (0x7f) to a single space", () => {
    expect(sanitizeSeedLine("a\x7fb")).toBe("a b");
  });

  it("maps every other C0 control char to a single space", () => {
    expect(sanitizeSeedLine("a\x01\x1fb")).toBe("a  b");
  });

  it("does not collapse ordinary whitespace (unlike squash)", () => {
    expect(sanitizeSeedLine("a  b   c")).toBe("a  b   c");
  });

  it("leaves a control-char-free line untouched", () => {
    expect(sanitizeSeedLine("plain text, no control chars")).toBe(
      "plain text, no control chars",
    );
  });

  it("a control-char-bearing description still yields a control-char-free seed", () => {
    // Call-site assertion, not a pure-function one: with sanitizeSeedLine
    // now applied to the COMPOSED line at both feature.ts's flowPipelineSeed
    // and epic-seed.ts's epicCreateSeed, this is the guarantee those two
    // module doc comments claim, exercised at the real production call site
    // rather than at sanitizeSeedLine in isolation.
    const seed = flowPipelineSeed(
      "csv-export",
      "a\tb\nc\x1bd",
      path.join(os.tmpdir(), "flow-seed-bounds-fixture"),
    );
    expect(seed).not.toMatch(/[\x00-\x1f\x7f]/);
  });
});
