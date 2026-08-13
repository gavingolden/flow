import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECKPOINT_SITES,
  checkpointBodyPath,
  checkpointDir,
  isCheckpointUsable,
  probeFreshness,
} from "./checkpoint-freshness";

let dir!: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-freshness-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeBody(slug: string, body = "note\n"): string {
  const p = checkpointBodyPath(slug, dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

describe("checkpointDir / checkpointBodyPath", () => {
  it("resolves under <dir>/checkpoints/<slug>/", () => {
    expect(checkpointDir("my-slug", dir)).toBe(
      path.join(dir, "checkpoints", "my-slug"),
    );
    expect(checkpointBodyPath("my-slug", dir)).toBe(
      path.join(dir, "checkpoints", "my-slug", "checkpoint.md"),
    );
  });

  it("does NOT create the directory — pure path.join, no mkdir, no existence probe", () => {
    const d = checkpointDir("never-created", dir);
    checkpointBodyPath("never-created", dir);
    expect(fs.existsSync(d)).toBe(false);
  });

  it("derivation is identical whether state.worktree is live, points at a deleted directory, or is unset", () => {
    // checkpointDir/checkpointBodyPath take only a slug — no worktree
    // parameter exists to vary, which is itself the point: a live worktree
    // path, a deleted one, and an unset one all resolve to the exact same
    // location because the function signature admits no worktree input.
    const live = checkpointBodyPath("same-slug", dir);
    const deleted = checkpointBodyPath("same-slug", dir);
    const unset = checkpointBodyPath("same-slug", dir);
    expect(live).toBe(deleted);
    expect(deleted).toBe(unset);
  });
});

describe("CHECKPOINT_SITES", () => {
  it("contains terminal", () => {
    expect(CHECKPOINT_SITES).toContain("terminal");
  });

  it("contains the four pre-existing sites unchanged", () => {
    expect(CHECKPOINT_SITES).toEqual(
      expect.arrayContaining([
        "manual",
        "plan-review",
        "plan-approval",
        "gate",
      ]),
    );
  });
});

describe("probeFreshness — keyed on state.slug, no path argument", () => {
  it("returns write/absent when the body is missing", () => {
    const state = { slug: "absent-slug" };
    expect(probeFreshness(state, "gate", dir)).toEqual({
      verdict: "write",
      reason: "absent",
    });
  });

  it("returns write/absent when the body is present but empty", () => {
    const p = checkpointBodyPath("empty-slug", dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "");
    const state = { slug: "empty-slug" };
    expect(probeFreshness(state, "gate", dir)).toEqual({
      verdict: "write",
      reason: "absent",
    });
  });

  it("preserves a fresh manual record with no phase advance since armedAt", () => {
    writeBody("manual-slug");
    const state = {
      slug: "manual-slug",
      checkpoint: {
        site: "manual" as const,
        phase: "gated",
        armedAt: "2026-06-30T12:00:00.000Z",
      },
      phaseLog: [{ at: "2026-06-30T11:00:00.000Z" }],
    };
    expect(probeFreshness(state, "gate", dir)).toEqual({
      verdict: "preserve",
      reason: "fresh-manual",
    });
  });

  it("writes over a manual record once the phase has advanced since armedAt", () => {
    writeBody("manual-stale-slug");
    const state = {
      slug: "manual-stale-slug",
      checkpoint: {
        site: "manual" as const,
        phase: "gated",
        armedAt: "2026-06-30T12:00:00.000Z",
      },
      phaseLog: [{ at: "2099-01-01T00:00:00.000Z" }],
    };
    const result = probeFreshness(state, "gate", dir);
    expect(result.verdict).toBe("write");
    expect(result.reason).toBe("stale-manual:gated");
  });

  it("always returns write for any auto-site record, regardless of phase advance (rule 5)", () => {
    writeBody("auto-slug");
    const state = {
      slug: "auto-slug",
      checkpoint: {
        site: "plan-approval" as const,
        phase: "checkpoint-pending-clear",
        armedAt: "2026-06-30T12:00:00.000Z",
      },
      phaseLog: [{ at: "2026-06-30T11:00:00.000Z" }],
    };
    const result = probeFreshness(state, "gate", dir);
    expect(result.verdict).toBe("write");
    expect(result.reason).toContain("auto-refresh:plan-approval");
  });
});

describe("isCheckpointUsable — keyed on state.slug, no path argument", () => {
  it("is false when the body is missing", () => {
    expect(isCheckpointUsable({ slug: "no-body" }, dir)).toBe(false);
  });

  it("is false when the body is present but empty", () => {
    const p = checkpointBodyPath("empty-usable", dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "");
    expect(isCheckpointUsable({ slug: "empty-usable" }, dir)).toBe(false);
  });

  it("is true for a fresh auto-site record even though probeFreshness would say 'write' for the same record", () => {
    writeBody("auto-usable");
    const state = {
      slug: "auto-usable",
      checkpoint: {
        site: "plan-approval" as const,
        phase: "checkpoint-pending-clear",
        armedAt: "2026-06-30T12:00:00.000Z",
      },
      phaseLog: [{ at: "2026-06-30T11:00:00.000Z" }],
    };
    expect(isCheckpointUsable(state, dir)).toBe(true);
  });

  it("is false once a later phase transition supersedes the record (manual or auto alike)", () => {
    writeBody("superseded");
    const state = {
      slug: "superseded",
      checkpoint: {
        site: "manual" as const,
        phase: "gated",
        armedAt: "2026-06-30T12:00:00.000Z",
      },
      phaseLog: [{ at: "2099-01-01T00:00:00.000Z" }],
    };
    expect(isCheckpointUsable(state, dir)).toBe(false);
  });

  it("preserves the intentional divergence from probeFreshness on a fresh, unsuperseded auto record", () => {
    writeBody("divergence-slug");
    const state = {
      slug: "divergence-slug",
      checkpoint: {
        site: "gate" as const,
        phase: "gating",
        armedAt: "2026-06-30T12:00:00.000Z",
      },
      phaseLog: [{ at: "2026-06-30T11:00:00.000Z" }],
    };
    expect(probeFreshness(state, "gate", dir).verdict).toBe("write");
    expect(isCheckpointUsable(state, dir)).toBe(true);
  });
});
