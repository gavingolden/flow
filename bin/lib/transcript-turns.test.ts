import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  effortRunsOf,
  modelEffortRunsOf,
  readTranscriptTurns,
  type TranscriptTurn,
} from "./transcript-turns";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-turns-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(lines: object[]): string {
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return file;
}

function line(
  id: string | undefined,
  model: string,
  extra: Record<string, unknown> = {},
  usage: Record<string, unknown> = { input_tokens: 1, output_tokens: 1 },
): object {
  return {
    type: "assistant",
    message: { ...(id ? { id } : {}), model, usage },
    ...extra,
  };
}

function turn(model: string | null, effort: string): TranscriptTurn {
  return { id: "x", model, effort, ts: null, usage: {} };
}

describe(readTranscriptTurns, () => {
  it("keeps the last line per message id in first-seen order", () => {
    const file = write([
      line("m1", "claude-a", {}, { output_tokens: 1 }),
      line("m2", "claude-a", {}, { output_tokens: 2 }),
      line("m1", "claude-a", {}, { output_tokens: 9 }),
    ]);
    const turns = readTranscriptTurns(file);
    expect(turns?.map((t) => [t.id, t.usage.output_tokens])).toEqual([
      ["m1", 9],
      ["m2", 2],
    ]);
  });

  it("reads effort, then perTurnEffort, then falls back to unknown", () => {
    const file = write([
      line("m1", "claude-a", { effort: "low", perTurnEffort: "high" }),
      line("m2", "claude-a", { perTurnEffort: "high" }),
      line("m3", "claude-a"),
    ]);
    expect(readTranscriptTurns(file)?.map((t) => t.effort)).toEqual([
      "low",
      "high",
      "unknown",
    ]);
  });

  it("caps effort at 16 chars but keeps a new level verbatim", () => {
    const file = write([
      line("m1", "claude-a", { effort: "x".repeat(17) }),
      line("m2", "claude-a", { effort: "ultra" }),
      line("m3", "claude-a", { effort: "x".repeat(16) }),
    ]);
    expect(readTranscriptTurns(file)?.map((t) => t.effort)).toEqual([
      "unknown",
      "ultra",
      "x".repeat(16),
    ]);
  });

  it("skips <synthetic> turns and carries the line timestamp", () => {
    const file = write([
      line("m1", "<synthetic>"),
      line("m2", "claude-a", { timestamp: "2026-11-06T00:00:00Z" }),
      line("m3", "claude-a"),
    ]);
    const turns = readTranscriptTurns(file);
    expect(turns?.map((t) => [t.id, t.ts])).toEqual([
      ["m2", "2026-11-06T00:00:00Z"],
      ["m3", null],
    ]);
  });

  it("counts id-less lines individually and skips garbage lines", () => {
    const file = path.join(dir, "g.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify(line(undefined, "claude-a")),
        "{not json",
        JSON.stringify(line(undefined, "claude-a")),
      ].join("\n"),
    );
    expect(readTranscriptTurns(file)).toHaveLength(2);
  });

  it("reads every turn across chunk boundaries, including multi-byte text", () => {
    const pad = "é".repeat(500);
    const lines = Array.from({ length: 4000 }, (_, i) =>
      line(`m${i}`, "claude-a", { pad }),
    );
    const file = write(lines);
    expect(fs.statSync(file).size).toBeGreaterThan(1 << 21);
    const turns = readTranscriptTurns(file);
    expect(turns).toHaveLength(4000);
    expect(turns?.[3999].id).toBe("m3999");
  });

  it("returns null over maxBytes and for an unreadable path", () => {
    const file = write([line("m1", "claude-a")]);
    expect(readTranscriptTurns(file, { maxBytes: 5 })).toBeNull();
    expect(readTranscriptTurns(path.join(dir, "missing.jsonl"))).toBeNull();
  });
});

describe(effortRunsOf, () => {
  it("collapses consecutive equal efforts in order", () => {
    const turns = [
      turn("m", "low"),
      turn("m", "low"),
      turn("m", "high"),
      turn("m", "low"),
    ];
    expect(effortRunsOf(turns)).toEqual([
      ["low", 2],
      ["high", 1],
      ["low", 1],
    ]);
  });
});

describe(modelEffortRunsOf, () => {
  it("starts a new run when the model changes even at the same effort", () => {
    const turns = [
      turn("opus", "high"),
      turn("opus", "high"),
      turn("sonnet", "high"),
      turn("sonnet", "low"),
    ];
    expect(modelEffortRunsOf(turns)).toEqual([
      ["opus", "high", 2],
      ["sonnet", "high", 1],
      ["sonnet", "low", 1],
    ]);
  });
});
