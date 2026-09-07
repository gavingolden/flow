import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkflowResultAttrs,
  validateWorkflowResult,
  type ValidationResult,
  type WorkflowResult,
} from "./workflow-result-schema";

const SCHEMA_SCRIPT = path.resolve(__dirname, "workflow-result-schema.ts");

type SpawnEnv = Record<string, string | undefined>;

type RunCliOpts = {
  /** Test seam: extra/overriding env for the spawned process. */
  env?: SpawnEnv;
  /** Test seam: cwd for the spawned process. */
  cwd?: string;
  /** Test seam: entry point to run, defaults to the module source. */
  script?: string;
};

function runCli(
  args: string[],
  opts: RunCliOpts = {},
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bun", [opts.script ?? SCHEMA_SCRIPT, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv | undefined,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * A process env pointing `$HOME` at an isolated dir, with `FLOW_SLUG`
 * stripped. `flowTelemetryLogPath()` resolves off `os.homedir()` at call time
 * (which honours `$HOME`), so the spawned validator writes its telemetry into
 * the sandbox; dropping `FLOW_SLUG` keeps correlation deterministic whether or
 * not the suite is run from inside a live flow pipeline window.
 */
function isolatedEnv(home: string): SpawnEnv {
  const env: SpawnEnv = { ...(process.env as SpawnEnv), HOME: home };
  delete env.FLOW_SLUG;
  return env;
}

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "workflow-schema-telemetry-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readEvents(home: string): Record<string, unknown>[] {
  const logPath = path.join(home, ".flow", "telemetry", "events.jsonl");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function attrsOf(event: Record<string, unknown>): Record<string, unknown> {
  return event.attrs as Record<string, unknown>;
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

describe("workflow.result telemetry", () => {
  const NEEDS_HUMAN_A: unknown = {
    stage: "A",
    outcome: "needs-human",
    reason: "agent-unavailable: review-tail-1",
    pr: 0,
    prUrl: "",
    ran: {
      implement: true,
      resymlink: false,
      verify: false,
      ciWait: false,
      review: false,
      gateRead: false,
    },
    loops: { ciFix: 1, reviewFix: 2 },
    artifacts: [],
    summary: "",
  };

  function attrsFor(artifact: unknown): Record<string, unknown> {
    const raw = JSON.stringify(artifact);
    const result = validateWorkflowResult(artifact);
    return buildWorkflowResultAttrs(artifact, result, raw);
  }

  it("builds the full stage A attrs from a validated artifact", () => {
    const attrs = attrsFor(VALID_A);
    expect(attrs).toEqual({
      stage: "A",
      outcome: "gate-ready",
      decision: "gated",
      loops: { ciFix: 0, reviewFix: 0 },
      ran: {
        implement: true,
        resymlink: false,
        verify: true,
        ciWait: true,
        review: true,
        gateRead: true,
      },
      valid: true,
      result_sha: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it("derives reason_class as the segment before the first colon", () => {
    const attrs = attrsFor(NEEDS_HUMAN_A);
    expect(attrs.outcome).toBe("needs-human");
    expect(attrs.reason).toBe("agent-unavailable: review-tail-1");
    expect(attrs.reason_class).toBe("agent-unavailable");
    expect(attrs.loops).toEqual({ ciFix: 1, reviewFix: 2 });
  });

  it("uses the whole reason as reason_class when it carries no colon", () => {
    const attrs = attrsFor({ ...(NEEDS_HUMAN_A as object), reason: "ci-hang" });
    expect(attrs.reason_class).toBe("ci-hang");
  });

  it("omits reason_class entirely when the artifact carries no reason", () => {
    const attrs = attrsFor(VALID_A);
    expect(attrs).not.toHaveProperty("reason");
    expect(attrs).not.toHaveProperty("reason_class");
  });

  it("builds stage B attrs without loops or ran (the envelope has neither)", () => {
    const attrs = attrsFor(VALID_B);
    expect(attrs).toEqual({
      stage: "B",
      outcome: "merged",
      valid: true,
      result_sha: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it("records a schema-invalid artifact with valid:false and the rejection reason", () => {
    const attrs = attrsFor({ ...(VALID_B as object), pr: "793" });
    expect(attrs.stage).toBe("B");
    expect(attrs.outcome).toBe("merged");
    expect(attrs.valid).toBe(false);
    expect(attrs.schema_error).toMatch(/'pr' must be a number/);
    expect(attrs.result_sha).toMatch(/^[0-9a-f]{12}$/);
  });

  it("returns verdict fields only, without throwing, for a non-object artifact", () => {
    for (const artifact of [null, [], 7, "nope"]) {
      const raw = JSON.stringify(artifact);
      const result = validateWorkflowResult(artifact);
      const attrs = buildWorkflowResultAttrs(artifact, result, raw);
      expect(attrs).toEqual({
        valid: false,
        schema_error: "artifact must be a JSON object",
        result_sha: expect.stringMatching(/^[0-9a-f]{12}$/),
      });
    }
  });

  it("keeps the ok branch reading the validated value rather than the raw object", () => {
    // The typed overload is the contract the ok branch relies on.
    const result: ValidationResult<WorkflowResult> =
      validateWorkflowResult(VALID_A);
    expect(result.ok).toBe(true);
    expect(buildWorkflowResultAttrs(VALID_A, result, "x").valid).toBe(true);
  });

  it("CLI --validate appends exactly one workflow.result event per invocation", () => {
    withTmpDir((home) => {
      const artifact = path.join(home, "stage-a-result.json");
      writeFileSync(artifact, JSON.stringify(NEEDS_HUMAN_A), "utf8");

      const run = runCli(["--validate", artifact], { env: isolatedEnv(home) });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ ok: true });

      const events = readEvents(home);
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("workflow.result");
      expect(attrsOf(events[0]).reason_class).toBe("agent-unavailable");
      expect(attrsOf(events[0]).valid).toBe(true);
    });
  });

  it("writes an identical result_sha when the same artifact is validated twice", () => {
    withTmpDir((home) => {
      const artifact = path.join(home, "stage-a-result.json");
      writeFileSync(artifact, JSON.stringify(VALID_A), "utf8");

      runCli(["--validate", artifact], { env: isolatedEnv(home) });
      runCli(["--validate", artifact], { env: isolatedEnv(home) });

      const events = readEvents(home);
      expect(events).toHaveLength(2);
      const shas = events.map((e) => attrsOf(e).result_sha);
      expect(shas[0]).toEqual(shas[1]);
      expect(shas[0]).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  it("records the invalid artifact and still exits 1 with the same stderr contract", () => {
    withTmpDir((home) => {
      const artifact = path.join(home, "stage-b-result.json");
      writeFileSync(
        artifact,
        JSON.stringify({ ...(VALID_B as object), pr: "793" }),
        "utf8",
      );

      const run = runCli(["--validate", artifact], { env: isolatedEnv(home) });
      expect(run.status).toBe(1);
      expect(JSON.parse(run.stderr).ok).toBe(false);

      const events = readEvents(home);
      expect(events).toHaveLength(1);
      expect(attrsOf(events[0]).valid).toBe(false);
      expect(attrsOf(events[0]).schema_error).toMatch(/'pr' must be a number/);
    });
  });

  it("emits nothing when the artifact cannot be read or parsed", () => {
    withTmpDir((home) => {
      const missing = runCli(["--validate", path.join(home, "absent.json")], {
        env: isolatedEnv(home),
      });
      expect(missing.status).toBe(1);

      const bad = path.join(home, "bad.json");
      writeFileSync(bad, "{not json", "utf8");
      const parseFail = runCli(["--validate", bad], { env: isolatedEnv(home) });
      expect(parseFail.status).toBe(1);

      expect(readEvents(home)).toHaveLength(0);
    });
  });

  it("still prints {ok:true} and exits 0 when the telemetry dir is unwritable", () => {
    withTmpDir((home) => {
      const artifact = path.join(home, "stage-a-result.json");
      writeFileSync(artifact, JSON.stringify(VALID_A), "utf8");
      // A regular FILE where the telemetry dir must go: mkdirSync and
      // appendFileSync both fail, exercising recordEvent's fail-open catch.
      writeFileSync(path.join(home, ".flow"), "not a directory", "utf8");

      const run = runCli(["--validate", artifact], { env: isolatedEnv(home) });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ ok: true });
      expect(run.stderr).toBe("");
    });
  });

  it("emits from a PATH-style symlink invoked outside the repo with no node_modules", () => {
    withTmpDir((home) => {
      const linkPath = path.join(home, "flow-workflow-result-schema");
      symlinkSync(SCHEMA_SCRIPT, linkPath);
      const artifact = path.join(home, "stage-a-result.json");
      writeFileSync(artifact, JSON.stringify(VALID_A), "utf8");

      const run = runCli(["--validate", artifact], {
        env: isolatedEnv(home),
        cwd: home,
        script: linkPath,
      });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ ok: true });

      const events = readEvents(home);
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("workflow.result");
    });
  });
});
