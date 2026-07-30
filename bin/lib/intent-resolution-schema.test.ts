import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateIntentResolution } from "./intent-resolution-schema";

const SCHEMA_SCRIPT = path.resolve(__dirname, "intent-resolution-schema.ts");

function runCli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bun", [SCHEMA_SCRIPT, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function withTmpFile(contents: string, fn: (filePath: string) => void): void {
  const dir = mkdtempSync(
    path.join(tmpdir(), "intent-resolution-schema-test-"),
  );
  const filePath = path.join(dir, "artifact.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Contract tests for `/flow-pr-review` Step 3.6's intent-mismatch
 * resolution artifact at `<worktree>/.flow-tmp/intent-resolution.json`.
 * The five real-world drift fixtures below are inlined (not read from disk
 * at test runtime) from genuine past-pipeline artifacts observed to fail
 * this reader, adjusted to isolate the row each case exercises.
 */

const VALID_FULL: Record<string, unknown> = {
  verdict: "benign-divergence",
  guessed_purpose: "Refactors the logger to structured output.",
  resolution: "Guess matches the actual request; no scope difference.",
  cross_model: { ran: true, agreement: "agree" },
};

describe("validateIntentResolution", () => {
  it("accepts the documented shape", () => {
    expect(validateIntentResolution(VALID_FULL)).toEqual({
      ok: true,
      value: VALID_FULL,
    });
  });

  it("accepts the documented shape without cross_model", () => {
    const { cross_model, ...withoutCrossModel } = VALID_FULL as Record<
      string,
      unknown
    >;
    expect(validateIntentResolution(withoutCrossModel).ok).toBe(true);
  });

  it("does not fail on extra unknown keys (writers legitimately emit more)", () => {
    const withExtras = {
      ...VALID_FULL,
      ran: true,
      actual_intent_source: "pipeline-launched: verbatim request",
      blind_guess: "some guess",
      drift_candidates: [{ candidate: "x", disposition: "benign" }],
      escalated: false,
      test_steps_item_added: false,
      summary: "note and proceed",
    };
    expect(validateIntentResolution(withExtras)).toEqual({
      ok: true,
      value: withExtras,
    });
  });

  it("rejects non-object input", () => {
    const result = validateIntentResolution("not an object");
    expect(result.ok).toBe(false);
  });

  it("rejects array input", () => {
    const result = validateIntentResolution([1, 2, 3]);
    expect(result.ok).toBe(false);
  });

  it("rejects null input", () => {
    const result = validateIntentResolution(null);
    expect(result.ok).toBe(false);
  });

  // Real-world drift shape 1 (econ-data-stripe-legal-pages): empty file —
  // JSON.parse throws before validateIntentResolution is even called; the
  // parse-failure path is covered at the CLI level below.

  // Real-world drift shape 2 (econ-data-stripe-legal-pages is empty; this
  // fixture is modeled on pokemon-account-page-app-account-deletion, which
  // uses `action` instead of `resolution`).
  it("rejects an artifact using `action` instead of `resolution`, naming both keys", () => {
    const drifted = {
      verdict: "match",
      guessed_purpose: "Build a self-service account page.",
      action: "note-and-proceed",
    };
    const result = validateIntentResolution(drifted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('"resolution"');
      expect(result.reason).toContain('"action"');
    }
  });

  // Real-world drift shape 3 (pokemon-fix-issue-436-apps-web): off-enum
  // verdict "benign" instead of "benign-divergence".
  it('rejects verdict "benign", hinting "benign-divergence"', () => {
    const drifted = {
      verdict: "benign",
      guessed_purpose: "Fix false cap-reached rejections.",
      resolution: "note and proceed",
    };
    const result = validateIntentResolution(drifted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('"benign"');
      expect(result.reason).toContain('"benign-divergence"');
    }
  });

  // Real-world drift shape 4 (econ-data-when-cliking-upgrade-pro-https /
  // econ-data-briefing-pipeline): `rung` instead of `verdict`.
  it("rejects an artifact using `rung` instead of `verdict`, naming both keys", () => {
    const drifted = {
      rung: "benign",
      resolution: "proceed",
    };
    const result = validateIntentResolution(drifted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('"verdict"');
      expect(result.reason).toContain('"rung"');
    }
  });

  // Real-world drift shape 5 (flow-extend-checkpoint-clear-auto-resume /
  // flow-ensure-agents-close-down-their): these two carry BOTH `verdict`
  // and `resolution` alongside a `rung` alias, so they are actually valid
  // per the required-keys-strict / extra-keys-permissive contract — this
  // pins that a writer emitting drift aliases ALONGSIDE the required keys
  // is not penalized for the extras.
  it("accepts an artifact carrying both the required keys and a stray `rung` alias key", () => {
    const both = {
      ran: true,
      rung: "benign-divergence",
      verdict: "benign-divergence",
      guessed_purpose: "Extend checkpoint auto-resume to epic sessions.",
      resolution: "diff-only guess matched the actual request",
    };
    expect(validateIntentResolution(both).ok).toBe(true);
  });

  it("rejects cross_model missing `ran`", () => {
    const drifted = {
      ...VALID_FULL,
      cross_model: { agreement: "agree" },
    };
    expect(validateIntentResolution(drifted).ok).toBe(false);
  });

  it('rejects cross_model.agreement outside "agree" | "disagree" | null', () => {
    const drifted = {
      ...VALID_FULL,
      cross_model: { ran: true, agreement: "strong" },
    };
    expect(validateIntentResolution(drifted).ok).toBe(false);
  });

  it("accepts cross_model.agreement === null", () => {
    const withNull = {
      ...VALID_FULL,
      cross_model: { ran: false, agreement: null },
    };
    expect(validateIntentResolution(withNull).ok).toBe(true);
  });
});

describe("intent-resolution-schema CLI", () => {
  it("exits 0 on a valid artifact", () => {
    withTmpFile(JSON.stringify(VALID_FULL), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    });
  });

  it("exits 1 on an off-shape artifact", () => {
    withTmpFile(JSON.stringify({ rung: "benign" }), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain('"verdict"');
    });
  });

  it("exits 1 on unparseable JSON (the empty-file drift shape)", () => {
    withTmpFile("", (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stderr);
      expect(parsed.ok).toBe(false);
    });
  });

  it("exits 1 when the file does not exist", () => {
    const result = runCli(["--validate", "/nonexistent/path.json"]);
    expect(result.status).toBe(1);
  });

  it("exits 2 on missing --validate flag", () => {
    const result = runCli([]);
    expect(result.status).toBe(2);
  });
});
