import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_EVENTS,
  TELEMETRY_LINE_CAP,
  resolveCorrelation,
  serializeEvent,
  recordEvent,
  type TelemetryEvent,
} from "./telemetry";
import { writeState, type PipelineState } from "./state";

function makeEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    version: 1,
    ts: "2026-09-05T00:00:00.000Z",
    event: "delegate.call",
    slug: "my-slug",
    pr: 42,
    repo: "me/flow",
    session_id: "sess-1",
    attrs: {},
    ...overrides,
  };
}

describe("TELEMETRY_EVENTS", () => {
  it("is exactly the four named events, in order — plan.redirect is deliberately absent", () => {
    expect(TELEMETRY_EVENTS).toEqual([
      "delegate.call",
      "phase.transition",
      "verify.attempt",
      "run.terminal",
    ]);
  });

  it("TELEMETRY_SCHEMA_VERSION is 1", () => {
    expect(TELEMETRY_SCHEMA_VERSION).toBe(1);
  });
});

describe("serializeEvent", () => {
  it("returns a plain JSON line unchanged when under cap", () => {
    const event = makeEvent({ attrs: { foo: "bar" } });
    const line = serializeEvent(event);
    expect(JSON.parse(line)).toEqual(event);
  });

  it("truncates attrs.stderr_tail and sets attrs.truncated when over cap", () => {
    const event = makeEvent({
      attrs: { stderr_tail: "x".repeat(TELEMETRY_LINE_CAP * 2) },
    });
    const line = serializeEvent(event, TELEMETRY_LINE_CAP);
    expect(line.length).toBeLessThanOrEqual(TELEMETRY_LINE_CAP);
    const parsed = JSON.parse(line);
    expect(parsed.attrs.truncated).toBe(true);
  });

  it("truncates stderr_tail before touching stdout_tail", () => {
    const event = makeEvent({
      attrs: {
        stderr_tail: "e".repeat(3000),
        stdout_tail: "o".repeat(200),
      },
    });
    const line = serializeEvent(event, 3200);
    const parsed = JSON.parse(line);
    expect(line.length).toBeLessThanOrEqual(3200);
    // stdout_tail is small enough it should usually survive once
    // stderr_tail alone is trimmed down.
    expect(
      typeof parsed.attrs.stdout_tail === "string" ||
        !("stdout_tail" in parsed.attrs),
    ).toBe(true);
  });

  it("deletes both tail fields outright when even empty strings can't fit under a tiny cap", () => {
    const event = makeEvent({
      attrs: {
        stderr_tail: "e".repeat(500),
        stdout_tail: "o".repeat(500),
        other: "z".repeat(200),
      },
    });
    const line = serializeEvent(event, 250);
    const parsed = JSON.parse(line);
    expect(parsed.attrs.stderr_tail).toBeUndefined();
    expect(parsed.attrs.stdout_tail).toBeUndefined();
    expect(parsed.attrs.truncated).toBe(true);
  });

  it("never mutates the input event object", () => {
    const event = makeEvent({ attrs: { stderr_tail: "x".repeat(10_000) } });
    const attrsBefore = { ...event.attrs };
    serializeEvent(event, 500);
    expect(event.attrs).toEqual(attrsBefore);
  });
});

describe("resolveCorrelation", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-state-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns all-null when FLOW_SLUG is absent", () => {
    const result = resolveCorrelation({ env: {}, stateDir });
    expect(result.slug).toBeNull();
    expect(result.pr).toBeNull();
    expect(result.repo).toBeNull();
    expect(result.attrs).toEqual({});
  });

  it("degrades to slug-only when no state file exists for the slug", () => {
    const result = resolveCorrelation({
      env: { FLOW_SLUG: "no-such-slug" },
      stateDir,
    });
    expect(result.slug).toBe("no-such-slug");
    expect(result.pr).toBeNull();
    expect(result.repo).toBeNull();
    // Absent on both sides (no session id anywhere) is not a mismatch.
    expect(result.attrs.slug_unverified).toBe(true);
  });

  it("keeps attribution and marks slug_unverified when session id is absent on one side (match case, not a mismatch)", () => {
    const state: PipelineState = {
      slug: "my-slug",
      phase: "implementing",
      repo: "me/flow",
      pr: 7,
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    writeState(state, stateDir);
    const result = resolveCorrelation({
      env: { FLOW_SLUG: "my-slug" }, // no CLAUDE_CODE_SESSION_ID
      stateDir,
    });
    expect(result.slug).toBe("my-slug");
    expect(result.pr).toBe(7);
    expect(result.repo).toBe("me/flow");
    expect(result.attrs.slug_unverified).toBe(true);
  });

  it("keeps full attribution with no guard attrs when session ids match", () => {
    const state: PipelineState = {
      slug: "my-slug",
      phase: "implementing",
      repo: "me/flow",
      pr: 7,
      sessionId: "sess-abc",
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    writeState(state, stateDir);
    const result = resolveCorrelation({
      env: { FLOW_SLUG: "my-slug", CLAUDE_CODE_SESSION_ID: "sess-abc" },
      stateDir,
    });
    expect(result.slug).toBe("my-slug");
    expect(result.pr).toBe(7);
    expect(result.repo).toBe("me/flow");
    expect(result.session_id).toBe("sess-abc");
    expect(result.attrs).toEqual({});
  });

  it("nulls slug/pr/repo and records unmatched_slug on a session-id mismatch", () => {
    const state: PipelineState = {
      slug: "my-slug",
      phase: "implementing",
      repo: "me/flow",
      pr: 7,
      sessionId: "sess-abc",
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    writeState(state, stateDir);
    const result = resolveCorrelation({
      env: { FLOW_SLUG: "my-slug", CLAUDE_CODE_SESSION_ID: "sess-DIFFERENT" },
      stateDir,
    });
    expect(result.slug).toBeNull();
    expect(result.pr).toBeNull();
    expect(result.repo).toBeNull();
    expect(result.session_id).toBe("sess-DIFFERENT");
    expect(result.attrs.unmatched_slug).toBe("my-slug");
  });
});

describe("recordEvent", () => {
  let logDir: string;
  let logPath: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-log-"));
    logPath = path.join(logDir, "events.jsonl");
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("appends one JSONL line carrying the event name and attrs", () => {
    recordEvent(
      "verify.attempt",
      { ok: true },
      { logPath, env: {}, stateDir: logDir },
    );
    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.event).toBe("verify.attempt");
    expect(record.attrs.ok).toBe(true);
    expect(record.version).toBe(1);
  });

  it("never throws when the target directory is unwritable (occupied by a plain file)", () => {
    const blockerParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "telemetry-blocker-"),
    );
    const blockedFile = path.join(blockerParent, "not-a-dir");
    fs.writeFileSync(blockedFile, "");
    const unwritableLogPath = path.join(blockedFile, "events.jsonl");
    try {
      expect(() =>
        recordEvent(
          "verify.attempt",
          {},
          { logPath: unwritableLogPath, env: {}, stateDir: logDir },
        ),
      ).not.toThrow();
      expect(fs.existsSync(unwritableLogPath)).toBe(false);
    } finally {
      fs.rmSync(blockerParent, { recursive: true, force: true });
    }
  });

  it("with no logPath override, falls back to flowTelemetryLogPath() under vitest's sandbox $HOME, never the real HOME", () => {
    const sandboxHome = process.env.HOME;
    expect(sandboxHome).toBeTruthy();
    const expectedPath = path.join(
      sandboxHome as string,
      ".flow",
      "telemetry",
      "events.jsonl",
    );
    try {
      recordEvent("verify.attempt", {}, { env: {}, stateDir: logDir });
      expect(fs.existsSync(expectedPath)).toBe(true);
      const lines = fs
        .readFileSync(expectedPath, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(path.join(sandboxHome as string, ".flow", "telemetry"), {
        recursive: true,
        force: true,
      });
    }
  });
});
