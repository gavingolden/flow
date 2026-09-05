import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  TELEMETRY_MAX_BYTES,
  TELEMETRY_MAX_AGE_DAYS,
  shouldAttemptCompaction,
  compactLogIfNeeded,
} from "./telemetry-rotate";

function line(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    ts: "2026-01-01T00:00:00.000Z",
    event: "phase.transition",
    slug: null,
    pr: null,
    repo: null,
    session_id: null,
    attrs: {},
    ...overrides,
  });
}

describe("shouldAttemptCompaction", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-rotate-"));
    logPath = path.join(dir, "events.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when the file doesn't exist", () => {
    expect(shouldAttemptCompaction(logPath)).toBe(false);
  });

  it("returns false when under the byte cap", () => {
    fs.writeFileSync(logPath, "x".repeat(100));
    expect(shouldAttemptCompaction(logPath, 1000)).toBe(false);
  });

  it("returns true when over the byte cap", () => {
    fs.writeFileSync(logPath, "x".repeat(2000));
    expect(shouldAttemptCompaction(logPath, 1000)).toBe(true);
  });

  it("defaults maxBytes to TELEMETRY_MAX_BYTES", () => {
    expect(TELEMETRY_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe("compactLogIfNeeded", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-rotate-"));
    logPath = path.join(dir, "events.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the all-zero result when the log doesn't exist", () => {
    const result = compactLogIfNeeded(logPath, Date.now());
    expect(result).toEqual({
      compacted: false,
      linesKept: 0,
      linesDropped: 0,
      slugsDropped: [],
    });
  });

  it("is a no-op (no rewrite) when nothing needs pruning", () => {
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    const content =
      [
        line({ slug: "slug-a", ts: "2026-01-01T00:00:00.000Z" }),
        line({ slug: "slug-b", ts: "2026-01-01T00:00:01.000Z" }),
      ].join("\n") + "\n";
    fs.writeFileSync(logPath, content);
    const before = fs.readFileSync(logPath, "utf8");
    const result = compactLogIfNeeded(logPath, now);
    expect(result.compacted).toBe(false);
    expect(result.linesKept).toBe(2);
    expect(result.slugsDropped).toEqual([]);
    expect(fs.readFileSync(logPath, "utf8")).toBe(before);
  });

  it("drops an unparseable line without failing the whole compaction", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const oldTs = new Date(
      now - (TELEMETRY_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const content =
      [
        line({ slug: "old-slug", ts: oldTs }),
        "not-json-at-all",
        line({ slug: "fresh-slug", ts: "2026-05-31T00:00:00.000Z" }),
      ].join("\n") + "\n";
    fs.writeFileSync(logPath, content);
    const result = compactLogIfNeeded(logPath, now);
    expect(result.compacted).toBe(true);
    expect(result.linesKept).toBe(1);
    expect(result.slugsDropped).toEqual(["old-slug"]);
    const remaining = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]).slug).toBe("fresh-slug");
  });

  it("prunes a whole slug block once ITS NEWEST line is past TELEMETRY_MAX_AGE_DAYS", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const oldTs1 = new Date(
      now - (TELEMETRY_MAX_AGE_DAYS + 10) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const oldTs2 = new Date(
      now - (TELEMETRY_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const content =
      [
        line({ slug: "expired-slug", event: "phase.transition", ts: oldTs1 }),
        line({ slug: "expired-slug", event: "run.terminal", ts: oldTs2 }),
        line({ slug: "kept-slug", ts: "2026-05-31T00:00:00.000Z" }),
      ].join("\n") + "\n";
    fs.writeFileSync(logPath, content);
    const result = compactLogIfNeeded(logPath, now);
    expect(result.slugsDropped).toEqual(["expired-slug"]);
    expect(result.linesKept).toBe(1);
    const remaining = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(remaining.every((r) => r.slug === "kept-slug")).toBe(true);
  });

  it("keeps a block intact when it has ANY recent activity, even if it also has old lines", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const oldTs = new Date(
      now - (TELEMETRY_MAX_AGE_DAYS + 10) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const content =
      [
        line({ slug: "mixed-slug", event: "phase.transition", ts: oldTs }),
        line({
          slug: "mixed-slug",
          event: "run.terminal",
          ts: "2026-05-31T00:00:00.000Z",
        }),
      ].join("\n") + "\n";
    fs.writeFileSync(logPath, content);
    const result = compactLogIfNeeded(logPath, now);
    expect(result.compacted).toBe(false);
    expect(result.linesKept).toBe(2);
  });

  it("over the byte cap, drops whole slug blocks oldest-first, keeping the null-slug block for last", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const bigAttrs = { pad: "x".repeat(200) };
    const content =
      [
        line({
          slug: "slug-1",
          ts: "2026-05-01T00:00:00.000Z",
          attrs: bigAttrs,
        }),
        line({ slug: null, ts: "2026-05-02T00:00:00.000Z", attrs: bigAttrs }),
        line({
          slug: "slug-2",
          ts: "2026-05-03T00:00:00.000Z",
          attrs: bigAttrs,
        }),
      ].join("\n") + "\n";
    fs.writeFileSync(logPath, content);
    const totalBytes = Buffer.byteLength(content, "utf8");
    // Cap tight enough to require dropping exactly one block.
    const maxBytes = totalBytes - 10;
    const result = compactLogIfNeeded(logPath, now, maxBytes, 100000);
    expect(result.compacted).toBe(true);
    // slug-1 (oldest non-null block) drops before the null-slug block,
    // even though the null-slug block is chronologically older than slug-2.
    expect(result.slugsDropped).toContain("slug-1");
    expect(result.slugsDropped).not.toContain(null);
    const remaining = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(remaining.some((r) => r.slug === null)).toBe(true);
  });

  it("preserves whole-slug-block semantics: a slug's lines are all-or-nothing, never partially dropped", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const bigAttrs = { pad: "x".repeat(500) };
    const content =
      [
        line({
          slug: "multi-line-slug",
          event: "phase.transition",
          ts: "2026-05-01T00:00:00.000Z",
          attrs: bigAttrs,
        }),
        line({
          slug: "multi-line-slug",
          event: "verify.attempt",
          ts: "2026-05-01T01:00:00.000Z",
          attrs: bigAttrs,
        }),
        line({
          slug: "multi-line-slug",
          event: "run.terminal",
          ts: "2026-05-01T02:00:00.000Z",
          attrs: bigAttrs,
        }),
        line({ slug: "other-slug", ts: "2026-05-02T00:00:00.000Z" }),
      ].join("\n") + "\n";
    fs.writeFileSync(logPath, content);
    const totalBytes = Buffer.byteLength(content, "utf8");
    const maxBytes = totalBytes - 10;
    const result = compactLogIfNeeded(logPath, now, maxBytes, 100000);
    const remaining = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const multiLineCount = remaining.filter(
      (r) => r.slug === "multi-line-slug",
    ).length;
    // Never a partial drop: either all three multi-line-slug lines survive
    // or none do.
    expect([0, 3]).toContain(multiLineCount);
    if (multiLineCount === 0) {
      expect(result.slugsDropped).toContain("multi-line-slug");
    }
  });

  it("preserves an append landing after the snapshot (afterSnapshot race case)", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const oldTs = new Date(
      now - (TELEMETRY_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const content = line({ slug: "old-slug", ts: oldTs }) + "\n";
    fs.writeFileSync(logPath, content);

    const result = compactLogIfNeeded(
      logPath,
      now,
      TELEMETRY_MAX_BYTES,
      TELEMETRY_MAX_AGE_DAYS,
      {
        afterSnapshot: () => {
          const raced = line({
            slug: "raced-slug",
            ts: "2026-05-31T00:00:00.000Z",
          });
          fs.appendFileSync(logPath, `${raced}\n`);
        },
      },
    );

    // The dropped-block decision is made over the snapshot only (old-slug
    // dropped), but the race-appended line must survive the rewrite.
    expect(result.slugsDropped).toEqual(["old-slug"]);
    const remaining = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(remaining.map((r) => r.slug)).toEqual(["raced-slug"]);
  });

  it("cleans up its temp file instead of leaking it when rename fails", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const oldTs = new Date(
      now - (TELEMETRY_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    fs.writeFileSync(logPath, line({ slug: "old-slug", ts: oldTs }) + "\n");
    compactLogIfNeeded(
      logPath,
      now,
      TELEMETRY_MAX_BYTES,
      TELEMETRY_MAX_AGE_DAYS,
      {
        rename: () => {
          throw new Error("simulated rename failure");
        },
      },
    );
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  it("keeps every remaining line valid JSON after compaction", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const oldTs = new Date(
      now - (TELEMETRY_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const content =
      [
        line({ slug: "old-slug", ts: oldTs }),
        line({ slug: "fresh-slug", ts: "2026-05-31T00:00:00.000Z" }),
      ].join("\n") + "\n";
    fs.writeFileSync(logPath, content);
    compactLogIfNeeded(logPath, now);
    const remaining = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    for (const l of remaining) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });
});
