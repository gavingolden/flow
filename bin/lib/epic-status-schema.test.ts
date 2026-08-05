import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  advanceStatus,
  isEpicStatus,
  readCommittedStatus,
  serializeEpicStatus,
  validateEpicStatus,
  type EpicStatusFile,
} from "./epic-status-schema";

/**
 * Contract tests for the committed epic status board at
 * `.flow/epics/<slug>/status.json`. This module owns the `EpicStatusFile`
 * shape; the tests pin the strict-on-shape / permissive-on-content policy,
 * the one-way latch, and the byte-identity serializer guarantee that makes
 * concurrent sibling epic PRs converge without manufactured merge conflicts.
 */

const VALID: unknown = {
  version: 1,
  epicId: "watchlist",
  features: {
    F1: { status: "merged", pr: 101 },
    F2: { status: "not-started" },
  },
};

describe("validateEpicStatus / isEpicStatus — happy paths", () => {
  it("accepts a well-formed status file", () => {
    expect(validateEpicStatus(VALID).ok).toBe(true);
    expect(isEpicStatus(VALID)).toBe(true);
  });

  it("tolerates unknown top-level keys", () => {
    const fixture = { ...(VALID as Record<string, unknown>), extra: "x" };
    expect(validateEpicStatus(fixture).ok).toBe(true);
  });

  it("tolerates unknown per-row keys", () => {
    const fixture = structuredClone(VALID) as Record<string, unknown>;
    (fixture.features as Record<string, unknown>).F1 = {
      status: "merged",
      pr: 101,
      note: "extra",
    };
    expect(validateEpicStatus(fixture).ok).toBe(true);
  });

  it("accepts a row with no pr", () => {
    const fixture = structuredClone(VALID) as Record<string, unknown>;
    (fixture.features as Record<string, unknown>).F1 = { status: "merged" };
    expect(validateEpicStatus(fixture).ok).toBe(true);
  });
});

describe("validateEpicStatus — off-shape rejections", () => {
  it("rejects the wrong version", () => {
    const fixture = { ...(VALID as Record<string, unknown>), version: 2 };
    const result = validateEpicStatus(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("version");
  });

  it("rejects a missing epicId", () => {
    const fixture = structuredClone(VALID) as Record<string, unknown>;
    delete fixture.epicId;
    const result = validateEpicStatus(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("epicId");
  });

  it("rejects non-object features", () => {
    const fixture = { ...(VALID as Record<string, unknown>), features: [] };
    const result = validateEpicStatus(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("features");
  });

  it("rejects a bad status literal", () => {
    const fixture = structuredClone(VALID) as Record<string, unknown>;
    (fixture.features as Record<string, unknown>).F1 = { status: "in-review" };
    const result = validateEpicStatus(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("F1");
  });

  it("rejects a non-number pr", () => {
    const fixture = structuredClone(VALID) as Record<string, unknown>;
    (fixture.features as Record<string, unknown>).F1 = {
      status: "merged",
      pr: "101",
    };
    const result = validateEpicStatus(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("F1");
  });
});

describe("isEpicStatus narrowing", () => {
  it("narrows a valid value and rejects an invalid one", () => {
    expect(isEpicStatus(VALID)).toBe(true);
    expect(isEpicStatus({ version: 1 })).toBe(false);
  });
});

describe("readCommittedStatus — tolerant reads", () => {
  function withTmpDir(fn: (dir: string) => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), "epic-status-schema-test-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("returns null for a missing epic dir", () => {
    withTmpDir((dir) => {
      expect(readCommittedStatus(path.join(dir, "does-not-exist"))).toBeNull();
    });
  });

  it("returns null for a missing status.json inside an existing dir", () => {
    withTmpDir((dir) => {
      expect(readCommittedStatus(dir)).toBeNull();
    });
  });

  it("returns null for malformed JSON, never throws", () => {
    withTmpDir((dir) => {
      writeFileSync(path.join(dir, "status.json"), "{not json", "utf8");
      expect(() => readCommittedStatus(dir)).not.toThrow();
      expect(readCommittedStatus(dir)).toBeNull();
    });
  });

  it("returns the parsed file when well-formed", () => {
    withTmpDir((dir) => {
      writeFileSync(
        path.join(dir, "status.json"),
        serializeEpicStatus(VALID as EpicStatusFile),
        "utf8",
      );
      expect(readCommittedStatus(dir)).toEqual(VALID);
    });
  });
});

describe("advanceStatus — the one-way latch", () => {
  it("advances not-started -> merged", () => {
    const result = advanceStatus(
      { status: "not-started" },
      { status: "merged", pr: 5 },
    );
    expect(result).toEqual({ status: "merged", pr: 5 });
  });

  it("stays merged when derived reports not-started, keeping its pr", () => {
    const result = advanceStatus(
      { status: "merged", pr: 5 },
      { status: "not-started" },
    );
    expect(result).toEqual({ status: "merged", pr: 5 });
  });

  it("is idempotent on merged -> merged", () => {
    const result = advanceStatus(
      { status: "merged", pr: 5 },
      { status: "merged", pr: 5 },
    );
    expect(result).toEqual({ status: "merged", pr: 5 });
  });

  it("adopts the derived row when committed is undefined", () => {
    const result = advanceStatus(undefined, { status: "merged", pr: 9 });
    expect(result).toEqual({ status: "merged", pr: 9 });
  });

  it("keeps the committed pr when the derived merged row has none", () => {
    const result = advanceStatus(
      { status: "merged", pr: 5 },
      { status: "merged" },
    );
    expect(result).toEqual({ status: "merged", pr: 5 });
  });
});

describe("serializeEpicStatus — byte-identity guarantee", () => {
  it("emits feature keys in lexicographic order regardless of insertion order", () => {
    const a: EpicStatusFile = {
      version: 1,
      epicId: "watchlist",
      features: {
        F2: { status: "not-started" },
        F1: { status: "merged", pr: 101 },
      },
    };
    const b: EpicStatusFile = {
      version: 1,
      epicId: "watchlist",
      features: {
        F1: { status: "merged", pr: 101 },
        F2: { status: "not-started" },
      },
    };
    expect(serializeEpicStatus(a)).toBe(serializeEpicStatus(b));
  });

  it("uses 2-space indent and a trailing newline", () => {
    const out = serializeEpicStatus(VALID as EpicStatusFile);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('\n  "epicId"');
  });
});
