import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpointBodyPath } from "./checkpoint-freshness";
import {
  SNAPSHOT_FILE_MAX_BYTES,
  appendHistoryEvent,
  appendJournal,
  historyLogPath,
  isTerminalOneLiner,
  logLiveNoteIfUnlogged,
  logNoteOnce,
  noteSha,
  readHistoryEvents,
  recordGateOutcome,
  resolveArtifactDir,
  snapshotDir,
  snapshotWorktreeArtifacts,
} from "./checkpoint-history";

let dir!: string;
let wt!: string;
const SLUG = "demo-slug";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-history-"));
  wt = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-history-wt-"));
  fs.mkdirSync(path.join(wt, ".flow-tmp"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(wt, { recursive: true, force: true });
});

function writeLive(body: string): void {
  const p = checkpointBodyPath(SLUG, dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe("history log", () => {
  it("should skip malformed lines when reading", () => {
    // Arrange
    appendHistoryEvent(
      SLUG,
      { type: "journal", at: "t1", phase: "p", body: "one" },
      dir,
    );
    fs.appendFileSync(historyLogPath(SLUG, dir), '{not json\n{"type":"x"}\n');
    appendHistoryEvent(
      SLUG,
      { type: "journal", at: "t2", phase: "p", body: "two" },
      dir,
    );
    // Act
    const events = readHistoryEvents(SLUG, dir);
    // Assert
    expect(events.map((e) => e.type === "journal" && e.body)).toEqual([
      "one",
      "two",
    ]);
  });

  it("should return nothing and not throw for an invalid slug", () => {
    expect(readHistoryEvents("../evil", dir)).toEqual([]);
    expect(appendJournal("../evil", "body", "reviewing", dir)).toBe(false);
  });

  it("should log a note once per sha and refuse an empty body", () => {
    const meta = { phase: "implementing", site: "manual" as const };
    expect(logNoteOnce(SLUG, "- [standing] keep", meta, dir)).toBe(true);
    expect(logNoteOnce(SLUG, "- [standing] keep", meta, dir)).toBe(false);
    expect(logNoteOnce(SLUG, "  \n", meta, dir)).toBe(false);
    const [event] = readHistoryEvents(SLUG, dir);
    expect(event).toMatchObject({
      type: "note",
      sha: noteSha("- [standing] keep"),
      items: [{ tag: "standing", text: "keep" }],
    });
  });

  it("should log an unlogged live note with site unarmed, once", () => {
    writeLive("remember this\n");
    expect(logLiveNoteIfUnlogged(SLUG, "reviewing", dir)).toBe(true);
    expect(logLiveNoteIfUnlogged(SLUG, "reviewing", dir)).toBe(false);
    expect(readHistoryEvents(SLUG, dir)[0]).toMatchObject({
      site: "unarmed",
      phase: "reviewing",
    });
  });

  it("should not log the terminal one-liner as a live note", () => {
    writeLive("Pipeline reached MERGED at 2026-11-08T21:48:04Z.\n");
    expect(logLiveNoteIfUnlogged(SLUG, "merged", dir)).toBe(false);
    expect(isTerminalOneLiner("Pipeline reached MERGED at 1.\n")).toBe(true);
    expect(
      isTerminalOneLiner("Pipeline reached MERGED (externally) at 1.\n"),
    ).toBe(true);
    expect(isTerminalOneLiner("Pipeline reached MERGED at 1.\nmore")).toBe(
      false,
    );
  });

  it("should skip an empty journal body", () => {
    expect(appendJournal(SLUG, "  ", "reviewing", dir)).toBe(false);
    expect(appendJournal(SLUG, "chose X", "reviewing", dir)).toBe(true);
  });
});

describe("snapshot", () => {
  it("should copy the allowlist byte-identically and name oversize files", () => {
    // Arrange
    const tmp = path.join(wt, ".flow-tmp");
    fs.writeFileSync(path.join(tmp, "plan.md"), "# plan\n");
    fs.writeFileSync(path.join(tmp, "epic-pr-body.md"), "epic body");
    fs.writeFileSync(
      path.join(tmp, "pr-review-result.json"),
      Buffer.alloc(SNAPSHOT_FILE_MAX_BYTES + 1, "a"),
    );
    fs.writeFileSync(path.join(tmp, "unrelated.txt"), "x");
    // Act
    const out = snapshotWorktreeArtifacts(SLUG, wt, dir);
    // Assert
    expect(out.files.sort()).toEqual(["epic-pr-body.md", "plan.md"]);
    expect(out.skipped).toEqual(["pr-review-result.json"]);
    expect(
      fs.readFileSync(path.join(snapshotDir(SLUG, dir), "plan.md"), "utf8"),
    ).toBe("# plan\n");
    expect(
      fs.existsSync(path.join(snapshotDir(SLUG, dir), "unrelated.txt")),
    ).toBe(false);
  });

  it("should resolve live scratch, then snapshot, then null", () => {
    const state = { slug: SLUG, worktree: wt };
    expect(resolveArtifactDir(state, dir)).toBe(path.join(wt, ".flow-tmp"));
    fs.writeFileSync(path.join(wt, ".flow-tmp", "plan.md"), "p");
    snapshotWorktreeArtifacts(SLUG, wt, dir);
    fs.rmSync(wt, { recursive: true, force: true });
    expect(resolveArtifactDir(state, dir)).toBe(snapshotDir(SLUG, dir));
    expect(resolveArtifactDir({ slug: "other-slug", worktree: wt }, dir)).toBe(
      null,
    );
  });
});

describe("recordGateOutcome", () => {
  it("should append a gate event and snapshot an existing worktree", () => {
    fs.writeFileSync(path.join(wt, ".flow-tmp", "plan.md"), "p");
    recordGateOutcome(
      SLUG,
      { status: "merged", tldr: "shipped", prUrl: "https://x/pull/1" },
      wt,
      dir,
    );
    const types = readHistoryEvents(SLUG, dir).map((e) => e.type);
    expect(types).toEqual(["gate", "snapshot"]);
  });

  it("should record only the gate when the worktree is gone", () => {
    recordGateOutcome(SLUG, { status: "gated" }, "/nonexistent/wt", dir);
    expect(readHistoryEvents(SLUG, dir).map((e) => e.type)).toEqual(["gate"]);
  });
});
