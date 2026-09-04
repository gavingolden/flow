/**
 * Unit tests for the probe harness's DISPATCH logic (D4 degradation, id
 * filtering, JSON shape) plus per-probe verdict classification for probes
 * whose spawn is mocked via `spawnMock` (`agent-invocation-name` argv shape,
 * `plugin-eval-availability` verdict classification). Never invoke the real
 * `claude` for the LIVE-only probes here — those stay behind `--live` and
 * are exercised live by running `bun bin/flow-plugin-probe.ts --json --live`
 * directly (see the file's own doc comment); that is a maintainer/CI
 * action, not a unit test.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  parseArgs,
  runProbes,
  runProbesFiltered,
  type ProbeId,
} from "./flow-plugin-probe";

const ALL_IDS: ProbeId[] = [
  "add-dir-discovery",
  "symlink-materialization",
  "bin-path-injection",
  "enabled-plugins",
  "skill-invocation-name",
  "agent-invocation-name",
  "agent-memory-scope",
  "skills-preload-name",
  "max-turns-partial",
  "cache-ttl-1h",
  "plugin-eval-availability",
];

const LIVE_ONLY_IDS: ProbeId[] = [
  "agent-memory-scope",
  "skills-preload-name",
  "max-turns-partial",
  "cache-ttl-1h",
];

// A dedicated mocked `spawn` (never `spawnSync`) so the new
// plugin-eval-availability classification tests and the Task-spawn argv
// assertion below can drive canned `claude` responses without ever
// invoking the real binary. `spawnSync` stays real — `probeEnabledPlugins`
// shells out to real `git init -q` on a scratch dir, unrelated to `claude`.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return { ...actual, spawn: spawnMock };
});

/** A minimal EventEmitter-shaped fake child process: emits `stdout`/`stderr`
 * data then `close(exitCode)` on the next microtask, matching the shape
 * `runClaude` consumes (`.stdout`, `.stderr`, `.on("close"|"error")`). */
function fakeChild(stdout: string, stderr: string, exitCode: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild("", "", 1));
});

describe(runProbes, () => {
  it("emits exactly one verdict per ProbeId", async () => {
    const verdicts = await runProbes({ claudeOnPath: () => false });
    const ids = verdicts.map((v) => v.id);
    expect(new Set(ids).size).toBe(ALL_IDS.length);
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it("D4 degradation: every verdict is 'skipped' with a named reason when claudeOnPath returns false", async () => {
    const verdicts = await runProbes({ claudeOnPath: () => false });
    expect(verdicts).toHaveLength(ALL_IDS.length);
    for (const v of verdicts) {
      expect(v.verdict).toBe("skipped");
      expect(v.evidence).toContain("PATH");
    }
  });

  it("fixtures are built under the injected tmpRoot and the real HOME is never read or written", async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-plugin-probe-test-"),
    );
    try {
      // claude absent -> D4 short-circuit before any fixture is built, so
      // tmpRoot stays empty. This asserts the harness never touches the real
      // HOME on the degraded path (the only path this unit suite exercises
      // without a live claude dependency).
      await runProbes({ claudeOnPath: () => false, tmpRoot });
      expect(fs.readdirSync(tmpRoot)).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("--json output parses and every entry has id/verdict/evidence", async () => {
    const verdicts = await runProbes({ claudeOnPath: () => false });
    const parsed = JSON.parse(JSON.stringify(verdicts)) as typeof verdicts;
    for (const entry of parsed) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.verdict).toBe("string");
      expect(typeof entry.evidence).toBe("string");
      expect(entry.evidence.length).toBeGreaterThan(0);
    }
  });

  it("a non-confirmed (skipped) verdict never carries a fabricated fallback — D4 short-circuits before any probe's own fallback ladder runs", async () => {
    const verdicts = await runProbes({ claudeOnPath: () => false });
    for (const v of verdicts) {
      expect(v.fallback).toBeUndefined();
    }
  });

  it("without --live, the four live-only ids report skipped with '--live' named as the reason — scoped via runProbesFiltered so no real `claude` spawn is triggered by the other ids", async () => {
    const verdicts = await runProbesFiltered(LIVE_ONLY_IDS, {
      claudeOnPath: () => true,
    });
    expect(verdicts).toHaveLength(LIVE_ONLY_IDS.length);
    for (const v of verdicts) {
      expect(v.verdict).toBe("skipped");
      expect(v.evidence).toContain("--live");
      expect(v.fallback).toBeUndefined();
    }
  });

  it("without --live, the tmpRoot invariant holds for the live-only subset even when claudeOnPath is true (never builds a fixture)", async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "flow-plugin-probe-test-live-gate-"),
    );
    try {
      await runProbesFiltered(LIVE_ONLY_IDS, {
        claudeOnPath: () => true,
        tmpRoot,
      });
      expect(fs.readdirSync(tmpRoot)).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("Task-spawn probe argv shape (agent-invocation-name)", () => {
  // Scout finding, load-bearing: the fixture runs under an isolated
  // fixtureHome so the real Task-spawn probe already short-circuits to
  // "inconclusive" on "Not logged in" on a dev host — asserting a verdict
  // FLIP would fail for reasons unrelated to this change. Assert the argv
  // SHAPE the probe composes instead, captured directly off the mocked
  // `spawn` call, never the resulting verdict.
  it("carries --restricted, --tools Task, --permission-prompts none, with --tools followed by a flag (not a positional), and -p <prompt> last", async () => {
    await runProbesFiltered(["agent-invocation-name"], {
      claudeOnPath: () => true,
    });
    const taskSpawnCall = spawnMock.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        (call[1] as string[]).includes("--restricted"),
    );
    expect(taskSpawnCall).toBeDefined();
    const args = taskSpawnCall![1] as string[];

    expect(args).toContain("--restricted");
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(args[toolsIdx + 1]).toBe("Task");
    // `--tools <tools...>` is variadic per `claude --help` — the token
    // right after its one value MUST be another flag, never a bare
    // positional, or the variadic collector would swallow it.
    expect(args[toolsIdx + 2]?.startsWith("-")).toBe(true);

    const promptFlagIdx = args.indexOf("--permission-prompts");
    expect(promptFlagIdx).toBeGreaterThanOrEqual(0);
    expect(args[promptFlagIdx + 1]).toBe("none");

    expect(args[args.length - 2]).toBe("-p");
  });

  it("spawn options keep both merged halves live: stdio is piped and FLOW_SLUG/TMUX_PANE are stripped from the child env", async () => {
    vi.stubEnv("FLOW_SLUG", "some-slug");
    vi.stubEnv("TMUX_PANE", "%1");
    try {
      await runProbesFiltered(["agent-invocation-name"], {
        claudeOnPath: () => true,
      });
    } finally {
      vi.unstubAllEnvs();
    }
    const taskSpawnCall = spawnMock.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        (call[1] as string[]).includes("--restricted"),
    );
    expect(taskSpawnCall).toBeDefined();
    const spawnOptions = taskSpawnCall![2] as {
      stdio?: string[];
      env?: NodeJS.ProcessEnv;
    };
    expect(spawnOptions.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(spawnOptions.env?.FLOW_SLUG).toBeUndefined();
    expect(spawnOptions.env?.TMUX_PANE).toBeUndefined();
  });
});

describe("plugin-eval-availability", () => {
  function mockEvalGate(opts: {
    helpExit?: number;
    initExit: number;
    initStderr?: string;
    initStdout?: string;
  }) {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "plugin" && args[1] === "eval" && args[2] === "--help") {
        return fakeChild(
          "Usage: claude plugin eval [options] [command] [target]\n",
          "",
          opts.helpExit ?? 0,
        );
      }
      if (args[0] === "plugin" && args[1] === "eval" && args[2] === "init") {
        return fakeChild(
          opts.initStdout ?? "",
          opts.initStderr ?? "",
          opts.initExit,
        );
      }
      return fakeChild("", "", 1);
    });
  }

  it("classifies 'inconclusive' when --help itself exits non-zero (gate status undeterminable)", async () => {
    mockEvalGate({ helpExit: 1, initExit: 1 });
    const verdicts = await runProbesFiltered(["plugin-eval-availability"], {
      claudeOnPath: () => true,
    });
    const v = verdicts.find((x) => x.id === "plugin-eval-availability");
    expect(v?.verdict).toBe("inconclusive");
    expect(v?.evidence).toContain("could not determine gate status");
  });

  it("classifies 'inconclusive' when init --bare exits non-zero without the expected early-access stderr signal", async () => {
    mockEvalGate({ initExit: 1, initStderr: "some unrelated failure" });
    const verdicts = await runProbesFiltered(["plugin-eval-availability"], {
      claudeOnPath: () => true,
    });
    const v = verdicts.find((x) => x.id === "plugin-eval-availability");
    expect(v?.verdict).toBe("inconclusive");
    expect(v?.evidence).toContain(
      "without the expected early-access stderr signal",
    );
  });

  it("classifies 'refuted' when --help exits 0 but init --bare exits non-zero with an early-access stderr", async () => {
    mockEvalGate({
      initExit: 1,
      initStderr: "`plugin eval` is currently in early access",
    });
    const verdicts = await runProbesFiltered(["plugin-eval-availability"], {
      claudeOnPath: () => true,
    });
    const v = verdicts.find((x) => x.id === "plugin-eval-availability");
    expect(v?.verdict).toBe("refuted");
    expect(v?.evidence).toContain("early access");
  });

  it("classifies 'confirmed' when init --bare also exits 0 (gate lifted)", async () => {
    mockEvalGate({ initExit: 0, initStdout: "Scaffolded evals/demo\n" });
    const verdicts = await runProbesFiltered(["plugin-eval-availability"], {
      claudeOnPath: () => true,
    });
    const v = verdicts.find((x) => x.id === "plugin-eval-availability");
    expect(v?.verdict).toBe("confirmed");
  });

  it("classifies 'skipped' with a named reason when claude is not on PATH (no-claude)", async () => {
    const verdicts = await runProbes({ claudeOnPath: () => false });
    const v = verdicts.find((x) => x.id === "plugin-eval-availability");
    expect(v?.verdict).toBe("skipped");
    expect(v?.evidence).toContain("PATH");
  });
});

describe(parseArgs, () => {
  it("--probe <id> narrows the CLI to that single id", () => {
    expect(parseArgs(["--probe", "enabled-plugins"])).toEqual({
      json: false,
      probe: "enabled-plugins",
      live: false,
    });
  });

  it("--json sets json:true independent of --probe", () => {
    expect(parseArgs(["--json", "--probe", "bin-path-injection"])).toEqual({
      json: true,
      probe: "bin-path-injection",
      live: false,
    });
  });

  it("an unrecognized --probe value leaves probe undefined (falls through to running every id)", () => {
    expect(parseArgs(["--probe", "not-a-real-probe"])).toEqual({
      json: false,
      probe: undefined,
      live: false,
    });
  });

  it("no flags at all: json:false, probe:undefined, live:false", () => {
    expect(parseArgs([])).toEqual({
      json: false,
      probe: undefined,
      live: false,
    });
  });

  it("--live sets live:true independent of other flags", () => {
    expect(parseArgs(["--live"])).toEqual({
      json: false,
      probe: undefined,
      live: true,
    });
  });
});
