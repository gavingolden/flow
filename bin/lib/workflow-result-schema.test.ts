import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateWorkflowResult } from "./workflow-result-schema";

const SCHEMA_SCRIPT = path.resolve(__dirname, "workflow-result-schema.ts");

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
  const dir = mkdtempSync(path.join(tmpdir(), "workflow-schema-test-"));
  const filePath = path.join(dir, "artifact.json");
  writeFileSync(filePath, contents, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_A: unknown = {
  stage: "A",
  outcome: "gate-ready",
  decision: "gated",
  pr: 1,
  prUrl: "https://github.com/x/y/pull/1",
  ran: {
    implement: true,
    resymlink: false,
    verify: true,
    ciWait: true,
    review: true,
    gateRead: true,
  },
  loops: { ciFix: 0, reviewFix: 0 },
  artifacts: [".flow-tmp/stage-a-result.json"],
  summary: "gate read decision: gated",
};

const VALID_B: unknown = {
  stage: "B",
  outcome: "merged",
  pr: 1,
  prUrl: "https://github.com/x/y/pull/1",
  resolver: { ran: false },
  sweep: { filed: [], unfiled: [], rejected: [] },
  summary: "merged cleanly",
};

describe("validateWorkflowResult", () => {
  it("accepts a well-formed stage A artifact", () => {
    const result = validateWorkflowResult(VALID_A);
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed stage B artifact", () => {
    const result = validateWorkflowResult(VALID_B);
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown stage value", () => {
    const result = validateWorkflowResult({
      ...(VALID_A as object),
      stage: "C",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a stage A artifact missing a required key", () => {
    const { pr, ...rest } = VALID_A as Record<string, unknown>;
    const result = validateWorkflowResult(rest);
    expect(result.ok).toBe(false);
  });

  it("rejects a stage A artifact with a bad outcome enum", () => {
    const result = validateWorkflowResult({
      ...(VALID_A as object),
      outcome: "not-a-real-outcome",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a stage B artifact with a bad push_status enum", () => {
    const result = validateWorkflowResult({
      ...(VALID_B as object),
      resolver: { ran: true, push_status: "maybe" },
    });
    expect(result.ok).toBe(false);
  });

  it("CLI --validate exits 0 on a valid artifact via /dev/stdin", () => {
    const result = spawnSync(
      "bun",
      [SCHEMA_SCRIPT, "--validate", "/dev/stdin"],
      { input: JSON.stringify(VALID_A), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });

  it("CLI --validate exits non-zero on an invalid artifact", () => {
    withTmpFile(JSON.stringify({ stage: "A" }), (filePath) => {
      const result = runCli(["--validate", filePath]);
      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stderr).ok).toBe(false);
    });
  });

  it("accepts a needs-human stage A artifact with empty prUrl and empty summary (implement-failed before a PR ever opened)", () => {
    const result = validateWorkflowResult({
      ...(VALID_A as object),
      outcome: "needs-human",
      decision: undefined,
      reason: "implement-failed",
      pr: 0,
      prUrl: "",
      summary: "",
    });
    expect(result.ok).toBe(true);
  });

  it("still rejects a non-needs-human stage A artifact with empty prUrl", () => {
    const result = validateWorkflowResult({
      ...(VALID_A as object),
      prUrl: "",
    });
    expect(result.ok).toBe(false);
  });

  it("still rejects a non-needs-human stage A artifact with empty summary", () => {
    const result = validateWorkflowResult({
      ...(VALID_A as object),
      summary: "",
    });
    expect(result.ok).toBe(false);
  });
});
