import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkpointBodyPath, checkpointMarkerPath } from "./flow-checkpoint";
import { parseArgs, run } from "./flow-epic-escalate";
import { readState, writeState, type PipelineState } from "./lib/state";

let stateDir!: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-epic-escalate-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function seed(slug: string, overrides: Partial<PipelineState> = {}): void {
  writeState(
    {
      slug,
      phase: "epic-designing",
      repo: "/tmp/repo",
      updatedAt: "2026-06-30T12:00:00Z",
      kind: "epic-design",
      phaseLog: [{ phase: "epic-designing", at: "2026-06-30T12:00:00Z" }],
      ...overrides,
    },
    stateDir,
  );
}

function runCapture(argv: string[]): {
  exit: number;
  stdout: string;
  stderr: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(s.toString());
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    err.push(s.toString());
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((...a) => {
    err.push(a.join(" "));
  });
  const exit = run(argv, { stateDir, resolveSlug: () => null });
  vi.restoreAllMocks();
  return { exit, stdout: out.join(""), stderr: err };
}

const armedLines = (stderr: string[]): string[] =>
  stderr
    .join("")
    .split("\n")
    .filter((l) => l.startsWith("checkpointed:"));

describe("parseArgs", () => {
  it("requires --reason and rejects unknown flags", () => {
    expect(parseArgs([])).toEqual({ error: "--reason <tag> is required" });
    expect(parseArgs(["--reason", "x", "--bogus"])).toEqual({
      error: "unknown argument: --bogus",
    });
    expect(parseArgs(["--reason"])).toEqual({
      error: "--reason needs a value",
    });
  });

  it("rejects a --slug that is not a valid slug", () => {
    expect(parseArgs(["--reason", "x", "--slug", "../evil"])).toEqual({
      error: "--slug requires a valid slug value (got: ../evil)",
    });
  });

  it("collapses a multi-line why to one line", () => {
    expect(parseArgs(["--reason", "r", "--why", "a\nb"])).toEqual({
      reason: "r",
      why: "a b",
      slug: undefined,
    });
  });
});

describe("run()", () => {
  it("records needs-human keeping the paused epic phase, writes the note, arms the terminal checkpoint, and ends stdout with the sentinel", () => {
    seed("design-x");
    const r = runCapture([
      "--slug",
      "design-x",
      "--reason",
      "task-tool-unavailable",
      "--why",
      "no Task tool",
    ]);
    expect(r.exit).toBe(0);
    const state = readState("design-x", stateDir);
    expect(state?.phase).toBe("needs-human");
    const log = state?.phaseLog ?? [];
    expect(log[log.length - 2]?.phase).toBe("epic-designing");
    expect(log[log.length - 1]?.phase).toBe("needs-human");
    expect(fs.existsSync(checkpointMarkerPath("design-x", stateDir))).toBe(
      true,
    );
    expect(
      fs.readFileSync(checkpointBodyPath("design-x", stateDir), "utf8"),
    ).toContain("Paused at phase: epic-designing — task-tool-unavailable");
    expect(state?.checkpoint?.site).toBe("terminal");
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe("NEEDS HUMAN: task-tool-unavailable");
    expect(lines).toContain("WHY: no Task tool");
    expect(lines[lines.length - 2]).toBe(
      "NEXT ACTION: restart claude (or upgrade the CLI) so the Task tool loads, then run flow epic create --resume design-x",
    );
    expect(armedLines(r.stderr)).toEqual([
      "checkpointed: true — site=terminal — safe to /clear",
    ]);
  });

  it("re-arms and re-prints when the state is ALREADY needs-human, without a second phase write (resume-mode escalation)", () => {
    seed("already-paused", {
      phase: "needs-human",
      phaseLog: [
        { phase: "epic-designing", at: "2026-06-30T12:00:00Z" },
        { phase: "needs-human", at: "2026-06-30T12:05:00Z" },
      ],
    });
    const r = runCapture([
      "--slug",
      "already-paused",
      "--reason",
      "worktree-missing-on-resume",
    ]);
    expect(r.exit).toBe(0);
    expect(readState("already-paused", stateDir)?.phaseLog).toHaveLength(2);
    expect(
      fs.existsSync(checkpointMarkerPath("already-paused", stateDir)),
    ).toBe(true);
    expect(
      fs.readFileSync(checkpointBodyPath("already-paused", stateDir), "utf8"),
    ).toContain("Paused at phase: epic-designing");
    expect(r.stdout.trimEnd().split("\n").pop()).toBe(
      "NEEDS HUMAN: worktree-missing-on-resume",
    );
    expect(armedLines(r.stderr)).toHaveLength(1);
  });

  it("offers --resume only as the after-close path for a generic reason (it refuses while this window is alive)", () => {
    seed("generic");
    const r = runCapture(["--slug", "generic", "--reason", "pr-closed"]);
    expect(r.exit).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[lines.length - 2]).toBe(
      "NEXT ACTION: reply done here once resolved (a /clear first is fine); if this window closes or crashes, run flow epic create --resume generic",
    );
  });

  it("an arm failure still records the pause, prints the block, and exits 0 with checkpointed: false", () => {
    seed("arm-fail");
    const cpDir = path.join(stateDir, "checkpoints", "arm-fail");
    fs.mkdirSync(path.dirname(cpDir), { recursive: true });
    fs.writeFileSync(cpDir, "not a dir");
    const r = runCapture(["--slug", "arm-fail", "--reason", "x"]);
    expect(r.exit).toBe(0);
    expect(readState("arm-fail", stateDir)?.phase).toBe("needs-human");
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("NEEDS HUMAN: x");
    expect(
      r.stderr
        .join("")
        .split("\n")
        .filter((l) => l.startsWith("checkpointed: false")),
    ).toHaveLength(1);
  });

  it("allows a starting epic-design state (recorded kind) and reports the paused phase as starting", () => {
    seed("early", {
      phase: "starting",
      phaseLog: [{ phase: "starting", at: "2026-06-30T12:00:00Z" }],
    });
    const r = runCapture(["--slug", "early", "--reason", "request-problem"]);
    expect(r.exit).toBe(0);
    expect(
      fs.readFileSync(checkpointBodyPath("early", stateDir), "utf8"),
    ).toContain("Paused at phase: starting");
  });

  it("refuses a feature-phase state: exit 2, state unchanged, nothing armed", () => {
    seed("feat", { phase: "implementing", kind: "feature" });
    const before = readState("feat", stateDir);
    const r = runCapture(["--slug", "feat", "--reason", "x"]);
    expect(r.exit).toBe(2);
    expect(readState("feat", stateDir)).toEqual(before);
    expect(fs.existsSync(checkpointMarkerPath("feat", stateDir))).toBe(false);
    expect(armedLines(r.stderr)).toEqual([]);
  });

  it("refuses a feature-kind pipeline even at a phase name an epic could also hold", () => {
    seed("feat-starting", { phase: "starting", kind: "feature" });
    expect(runCapture(["--slug", "feat-starting", "--reason", "x"]).exit).toBe(
      2,
    );
    expect(readState("feat-starting", stateDir)?.phase).toBe("starting");
  });

  it.each(["implementing", "epic-approved"])(
    "refuses an epic-design pipeline at %s (not a live epic phase, starting, or needs-human)",
    (phase) => {
      seed("odd", { phase, kind: "epic-design" });
      expect(runCapture(["--slug", "odd", "--reason", "x"]).exit).toBe(2);
      expect(readState("odd", stateDir)?.phase).toBe(phase);
    },
  );

  it("exits 2 on a missing state file, a missing --reason, and no resolvable slug", () => {
    expect(runCapture(["--slug", "ghost", "--reason", "x"]).exit).toBe(2);
    seed("has-state");
    expect(runCapture(["--slug", "has-state"]).exit).toBe(2);
    expect(readState("has-state", stateDir)?.phase).toBe("epic-designing");
    expect(runCapture(["--reason", "x"]).exit).toBe(2);
  });

  it("maps a failed phase write (branch-mismatch guard) to exit 2 with state unchanged and nothing armed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-escalate-wt-"));
    try {
      spawnSync("git", ["init", "-q", "-b", "actual"], { cwd: root });
      spawnSync("git", ["config", "user.email", "t@example.com"], {
        cwd: root,
      });
      spawnSync("git", ["config", "user.name", "T"], { cwd: root });
      spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "i"], {
        cwd: root,
      });
      fs.writeFileSync(path.join(root, ".flow-branch"), "expected\n");
      seed("mismatch", { worktree: root });
      const r = runCapture(["--slug", "mismatch", "--reason", "x"]);
      expect(r.exit).toBe(2);
      expect(readState("mismatch", stateDir)?.phase).toBe("epic-designing");
      expect(fs.existsSync(checkpointMarkerPath("mismatch", stateDir))).toBe(
        false,
      );
      expect(armedLines(r.stderr)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
