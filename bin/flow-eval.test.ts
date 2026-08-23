import * as realFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main, parseArgs, type Deps } from "./lib/eval-cli";
import { materializeFixture } from "./lib/eval-fixture";
import { gradeAll } from "./lib/eval-graders";
import type { EvalReport } from "./lib/eval-report";

// No test in this file ever spawns a real `claude` or `gh` process: every
// Deps hook that could is stubbed, and the one exception below (--dry-run
// against a real materialized fixture) still never calls runScenarioOnce —
// the dry-run branch inside eval-cli.ts's runOneScenarioRun grades the
// fixture directly.

const SUITE_DIR = path.join("evals", "fake-suite");
const SCENARIO_DIR = path.join(SUITE_DIR, "s1");

function suiteJson() {
  return JSON.stringify({
    schemaVersion: 1,
    id: "fake-suite",
    candidate: "fake-candidate",
    description: "a fake suite for unit tests",
    scenarios: ["s1"],
  });
}

function caseJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "s1",
    title: "S1",
    provenance: "test",
    prompt: "prompt.md",
    runs: 1,
    maxBudgetUsd: 1,
    timeoutSec: 30,
    graders: [{ id: "g1", kind: "file", file: "$REPO/out.txt", exists: true }],
    ...overrides,
  });
}

type MemFs = {
  files: Record<string, string>;
  dirs: Set<string>;
  readFile: (p: string) => string;
  writeFile: (p: string, data: string) => void;
  exists: (p: string) => boolean;
  mkdirp: (p: string) => void;
  rm: (p: string) => void;
  readdir: (p: string) => string[];
};

function memFs(initial: Record<string, string> = {}): MemFs {
  const files: Record<string, string> = { ...initial };
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    writeFile: (p, data) => {
      files[p] = data;
    },
    exists: (p) => p in files || dirs.has(p),
    mkdirp: (p) => {
      dirs.add(p);
    },
    rm: (p) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      dirs.delete(p);
      for (const d of [...dirs]) if (d.startsWith(prefix)) dirs.delete(d);
      for (const f of Object.keys(files)) {
        if (f === p || f.startsWith(prefix)) delete files[f];
      }
    },
    readdir: (p) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const names = new Set<string>();
      for (const f of [...Object.keys(files), ...dirs]) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length).split("/")[0];
          if (rest) names.add(rest);
        }
      }
      return [...names];
    },
  };
}

function fakeDeps(fs: MemFs, overrides: Partial<Deps> = {}): Deps {
  return {
    probeClaude: () => ({ ok: true, version: "2.1.239" }),
    probeFlowInstall: () => ({ ok: true, version: "" }),
    materializeFixture: vi.fn() as unknown as Deps["materializeFixture"],
    runScenarioOnce: vi.fn() as unknown as Deps["runScenarioOnce"],
    gradeAll,
    gitHead: () => "deadbeef".repeat(5),
    gitDirty: () => false,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    writeFile: fs.writeFile,
    readFile: fs.readFile,
    mkdirp: fs.mkdirp,
    rm: fs.rm,
    exists: fs.exists,
    readdir: fs.readdir,
    progress: () => {},
    sessionId: () => "sess-fixed",
    ...overrides,
  };
}

function baseFiles(): Record<string, string> {
  return {
    [path.join(SUITE_DIR, "suite.json")]: suiteJson(),
    [path.join(SCENARIO_DIR, "case.json")]: caseJson(),
    [path.join(SCENARIO_DIR, "prompt.md")]: "do the thing",
  };
}

describe("parseArgs", () => {
  it("applies documented defaults for run", () => {
    const parsed = parseArgs([
      "run",
      "--suite",
      "a",
      "--out",
      ".flow-tmp/eval",
    ]);
    expect(parsed).toMatchObject({
      verb: "run",
      claudeBin: "claude",
      evalsDir: "evals",
      concurrency: 1,
      dryRun: false,
      keepFixtures: false,
    });
  });

  it("rejects a missing verb and an unknown flag", () => {
    expect(parseArgs([])).toHaveProperty("error");
    expect(parseArgs(["run", "--bogus", "x"])).toHaveProperty("error");
  });

  it("requires --out for run and --suite or --all", () => {
    expect(parseArgs(["run", "--suite", "a"])).toHaveProperty("error");
    expect(parseArgs(["run", "--out", "x"])).toHaveProperty("error");
  });

  it("--suite is repeatable and --all sets suites to 'all'", () => {
    const parsed = parseArgs([
      "run",
      "--suite",
      "a",
      "--suite",
      "b",
      "--out",
      "x",
    ]);
    expect(parsed).toMatchObject({ suites: ["a", "b"] });
    const all = parseArgs(["run", "--all", "--out", "x"]);
    expect(all).toMatchObject({ suites: "all" });
  });

  it("--model and --effort parse into args.model/args.effort", () => {
    const parsed = parseArgs([
      "run",
      "--suite",
      "a",
      "--out",
      "x",
      "--model",
      "sonnet",
      "--effort",
      "medium",
    ]);
    expect(parsed).toMatchObject({ model: "sonnet", effort: "medium" });
  });

  it("parses compare defaults (tolerance 0.10) and validate positional paths", () => {
    const cmp = parseArgs([
      "compare",
      "--base",
      "b.json",
      "--candidate",
      "c.json",
    ]);
    expect(cmp).toMatchObject({
      tolerance: 0.1,
      failOnRegression: false,
      json: false,
    });
    const val = parseArgs(["validate", "evals/a", "evals/b"]);
    expect(val).toEqual({ verb: "validate", paths: ["evals/a", "evals/b"] });
  });
});

describe("main run — availability skip paths", () => {
  const reasons = [
    {
      probeFlowInstall: () => ({
        ok: false as const,
        reason: "flow-not-installed" as const,
        notice: "flow is not installed",
      }),
      expected: "flow-not-installed",
    },
    {
      probeClaude: () => ({
        ok: false as const,
        reason: "claude-not-on-path" as const,
        notice: "claude is not on PATH",
      }),
      expected: "claude-not-on-path",
    },
    {
      probeClaude: () => ({
        ok: false as const,
        reason: "claude-not-authenticated" as const,
        notice: "claude is not authenticated",
      }),
      expected: "claude-not-authenticated",
    },
  ] as const;

  for (const scenario of reasons) {
    it(`emits the exact skip line (via deps.progress) and a skipped report, exit 0 (${scenario.expected})`, async () => {
      const fs = memFs(baseFiles());
      const progressLines: string[] = [];
      const deps = fakeDeps(fs, {
        ...(scenario as Partial<Deps>),
        progress: (line) => progressLines.push(line),
      });
      const code = await main(
        [
          "run",
          "--suite",
          "fake-suite",
          "--out",
          "out",
          "--evals-dir",
          "evals",
        ],
        deps,
      );
      expect(code).toBe(0);
      expect(
        progressLines.some(
          (l) =>
            l ===
            `flow-eval: skipped — ${scenario.expected === "flow-not-installed" ? "flow is not installed" : scenario.expected === "claude-not-on-path" ? "claude is not on PATH" : "claude is not authenticated"} (vitest remains the CI gate; install and log in to Claude Code to run evals)\n`,
        ),
      ).toBe(true);
      const report: EvalReport = JSON.parse(
        fs.readFile(path.join("out", "fake-suite", "report.json")),
      );
      expect(report.skipped?.reason).toBe(scenario.expected);
    });
  }
});

describe("main run — nonexistent suite", () => {
  it("rejects with a `missing suite.json` error instead of routing through a stray/thrown readFile", async () => {
    const fs = memFs(baseFiles());
    const deps = fakeDeps(fs);
    await expect(
      main(
        [
          "run",
          "--suite",
          "does-not-exist",
          "--out",
          "out",
          "--evals-dir",
          "evals",
        ],
        deps,
      ),
    ).rejects.toThrow(/missing suite\.json/);
  });
});

describe("main run — stale run dir", () => {
  it("wipes a stale run-N/ directory left by a cancelled earlier invocation before writing fresh output", async () => {
    const files = baseFiles();
    const staleRunFile = path.join(
      "out",
      "fake-suite",
      "s1",
      "run-1",
      "stale-leftover.txt",
    );
    files[staleRunFile] = "from a cancelled invocation";
    const fs = memFs(files);
    const deps = fakeDeps(fs, {
      materializeFixture: () =>
        ({
          root: "/r",
          repoDir: "/r/repo",
          claudeHome: "/r/home",
          pluginRoots: [],
          shimDir: "/r/shims",
          slug: "eval-fake-suite-s1-r1",
          stateDir: "/state",
          teardown: () => {},
        }) as ReturnType<Deps["materializeFixture"]>,
    });
    const code = await main(
      [
        "run",
        "--suite",
        "fake-suite",
        "--out",
        "out",
        "--evals-dir",
        "evals",
        "--dry-run",
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(fs.exists(staleRunFile)).toBe(false);
    expect(
      fs.exists(path.join("out", "fake-suite", "s1", "run-1", "grades.json")),
    ).toBe(true);
  });
});

describe("main run --dry-run", () => {
  it("materializes a real tmp fixture, grades non-spawned graders, and leaves no eval-* state", async () => {
    const scenarioRoot = realFs.mkdtempSync(
      path.join(os.tmpdir(), "flow-eval-cli-dry-"),
    );
    const stateDir = realFs.mkdtempSync(
      path.join(os.tmpdir(), "flow-eval-cli-state-"),
    );
    const suiteDir = path.join(scenarioRoot, "evals", "dry-suite");
    const scenarioDir = path.join(suiteDir, "s1");
    realFs.mkdirSync(path.join(scenarioDir, "fixture"), { recursive: true });
    realFs.writeFileSync(path.join(scenarioDir, "fixture", "out.txt"), "hi\n");
    realFs.writeFileSync(path.join(scenarioDir, "prompt.md"), "hello");
    realFs.writeFileSync(
      path.join(scenarioDir, "case.json"),
      JSON.stringify({
        id: "s1",
        title: "S1",
        provenance: "test",
        prompt: "prompt.md",
        runs: 1,
        maxBudgetUsd: 1,
        timeoutSec: 30,
        fixture: { repo: "fixture" },
        graders: [
          { id: "g1", kind: "file", file: "$REPO/out.txt", exists: true },
        ],
      }),
    );
    realFs.writeFileSync(
      path.join(suiteDir, "suite.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "dry-suite",
        candidate: "c",
        description: "d",
        scenarios: ["s1"],
      }),
    );

    const outDir = path.join(scenarioRoot, "out");
    const diskDeps: Deps = {
      probeClaude: () => ({ ok: true, version: "1.0.0" }),
      probeFlowInstall: () => ({ ok: true, version: "" }),
      materializeFixture: (scenario, suiteId, run, opts) =>
        materializeFixture(scenario, suiteId, run, { ...opts, stateDir }),
      runScenarioOnce: vi.fn() as unknown as Deps["runScenarioOnce"],
      gradeAll,
      gitHead: () => "deadbeef",
      gitDirty: () => false,
      now: () => new Date(),
      writeFile: (p, data) => {
        realFs.mkdirSync(path.dirname(p), { recursive: true });
        realFs.writeFileSync(p, data);
      },
      readFile: (p) => realFs.readFileSync(p, "utf8"),
      mkdirp: (p) => realFs.mkdirSync(p, { recursive: true }),
      rm: (p) => realFs.rmSync(p, { recursive: true, force: true }),
      exists: (p) => realFs.existsSync(p),
      readdir: (p) =>
        realFs
          .readdirSync(p, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name),
      progress: () => {},
      sessionId: () => "sess-dry",
    };

    try {
      const code = await main(
        [
          "run",
          "--suite",
          "dry-suite",
          "--out",
          outDir,
          "--evals-dir",
          path.join(scenarioRoot, "evals"),
          "--dry-run",
        ],
        diskDeps,
      );
      expect(code).toBe(0);
      const report: EvalReport = JSON.parse(
        realFs.readFileSync(
          path.join(outDir, "dry-suite", "report.json"),
          "utf8",
        ),
      );
      expect(report.scenarios[0].runs[0].status).toBe("skipped");
      expect(report.scenarios[0].runs[0].grades[0].pass).toBe(true); // file/exists grader ran for real
      expect(
        diskDeps.runScenarioOnce as ReturnType<typeof vi.fn>,
      ).not.toHaveBeenCalled();
      const stateEntries = realFs.existsSync(stateDir)
        ? realFs.readdirSync(stateDir).filter((n) => n.startsWith("eval-"))
        : [];
      expect(stateEntries).toEqual([]);
    } finally {
      realFs.rmSync(scenarioRoot, { recursive: true, force: true });
      realFs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("main run --threshold", () => {
  it("exits 1 when the suite score misses the threshold", async () => {
    const files = baseFiles();
    files[path.join(SCENARIO_DIR, "case.json")] = caseJson({
      graders: [
        { id: "g1", kind: "file", file: "$REPO/out.txt", exists: true },
      ],
    });
    const fs = memFs(files);
    const deps = fakeDeps(fs, {
      materializeFixture: () =>
        ({
          root: "/r",
          repoDir: "/r/repo",
          claudeHome: "/r/home",
          pluginRoots: [],
          shimDir: "/r/shims",
          slug: "eval-fake-suite-s1-r1",
          stateDir: "/state",
          teardown: () => {},
        }) as ReturnType<Deps["materializeFixture"]>,
      runScenarioOnce: async () =>
        ({
          exitCode: 0,
          timedOut: false,
          streamPath: "/r/stream.jsonl",
          assistantTextPath: "/r/assistant-text.txt",
          events: [],
          result: null,
        }) as Awaited<ReturnType<Deps["runScenarioOnce"]>>,
      // $REPO/out.txt is never written by this fake, so the `exists`
      // grader fails -> score 0 -> below any positive threshold.
    });
    const code = await main(
      [
        "run",
        "--suite",
        "fake-suite",
        "--out",
        "out",
        "--evals-dir",
        "evals",
        "--threshold",
        "0.5",
      ],
      deps,
    );
    expect(code).toBe(1);
  });
});

describe("main run --record-baseline", () => {
  it("refuses a dirty tree without --allow-dirty", async () => {
    const fs = memFs(baseFiles());
    const deps = fakeDeps(fs, { gitDirty: () => true });
    const code = await main(
      [
        "run",
        "--suite",
        "fake-suite",
        "--out",
        "out",
        "--evals-dir",
        "evals",
        "--record-baseline",
      ],
      deps,
    );
    expect(code).toBe(2);
  });

  function realRunDeps(fs: MemFs, overrides: Partial<Deps> = {}): Deps {
    return fakeDeps(fs, {
      materializeFixture: () =>
        ({
          root: "/r",
          repoDir: "/r/repo",
          claudeHome: "/r/home",
          pluginRoots: [],
          shimDir: "/r/shims",
          slug: "eval-fake-suite-s1-r1",
          stateDir: "/state",
          teardown: () => {},
        }) as ReturnType<Deps["materializeFixture"]>,
      runScenarioOnce: async () =>
        ({
          exitCode: 0,
          timedOut: false,
          streamPath: "/r/stream.jsonl",
          assistantTextPath: "/r/assistant-text.txt",
          events: [],
          result: null,
        }) as Awaited<ReturnType<Deps["runScenarioOnce"]>>,
      ...overrides,
    });
  }

  it("writes baseline report/summary files and refreshes the README table on a clean tree", async () => {
    const fs = memFs(baseFiles());
    const deps = realRunDeps(fs);
    const code = await main(
      [
        "run",
        "--suite",
        "fake-suite",
        "--out",
        "out",
        "--evals-dir",
        "evals",
        "--record-baseline",
        "--baseline-dir",
        "docs/eval/baseline",
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(
      fs.exists(path.join("docs/eval/baseline", "fake-suite.report.json")),
    ).toBe(true);
    expect(
      fs.exists(path.join("docs/eval/baseline", "fake-suite.summary.md")),
    ).toBe(true);
    const readme = fs.readFile(path.join("docs/eval/baseline", "README.md"));
    expect(readme).toContain("<!-- flow-eval-baseline:start -->");
    expect(readme).toContain("fake-suite");
  });

  it("skips writing a `skipped` report, warns on stderr, and leaves an existing baseline untouched", async () => {
    const fs = memFs(baseFiles());
    fs.dirs.add("docs/eval/baseline");
    fs.files[path.join("docs/eval/baseline", "fake-suite.report.json")] =
      JSON.stringify({
        schemaVersion: 1,
        runner: { name: "flow-eval-headless", model: "sonnet" },
        tree: { gitHead: "priorsha", dirty: false },
        suite: "fake-suite",
        candidate: "fake-candidate",
        startedAt: "t0",
        finishedAt: "t1",
        scenarios: [],
        summary: { scenarios: 0, passed: 0, score: 0, costUsd: 0 },
      });
    fs.files[path.join("docs/eval/baseline", "fake-suite.summary.md")] =
      "prior summary\n";
    fs.files[path.join("docs/eval/baseline", "README.md")] =
      "<!-- flow-eval-baseline:start -->\nold table\n<!-- flow-eval-baseline:end -->\n";

    const progressLines: string[] = [];
    const deps = fakeDeps(fs, {
      probeFlowInstall: () => ({
        ok: false,
        reason: "flow-not-installed",
        notice: "flow is not installed",
      }),
      progress: (line) => progressLines.push(line),
    });
    const code = await main(
      [
        "run",
        "--suite",
        "fake-suite",
        "--out",
        "out",
        "--evals-dir",
        "evals",
        "--record-baseline",
        "--baseline-dir",
        "docs/eval/baseline",
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(progressLines.some((l) => l.includes("skipped fake-suite"))).toBe(
      true,
    );
    // Skipped report never overwrites the prior real baseline on disk.
    expect(
      fs.readFile(path.join("docs/eval/baseline", "fake-suite.report.json")),
    ).toContain("priorsha");
    const readme = fs.readFile(path.join("docs/eval/baseline", "README.md"));
    expect(readme).toContain("fake-suite");
    expect(readme).toContain("priorsha".slice(0, 12));
  });

  it("merges the README table from on-disk baselines instead of dropping suites the --suite run didn't touch", async () => {
    const fs = memFs(baseFiles());
    fs.dirs.add("docs/eval/baseline");
    fs.files[path.join("docs/eval/baseline", "other-suite.report.json")] =
      JSON.stringify({
        schemaVersion: 1,
        runner: { name: "flow-eval-headless", model: "sonnet" },
        tree: { gitHead: "othersha".repeat(5), dirty: false },
        suite: "other-suite",
        candidate: "other-candidate",
        startedAt: "t0",
        finishedAt: "t1",
        scenarios: [],
        summary: { scenarios: 0, passed: 0, score: 1, costUsd: 0 },
      });
    const deps = realRunDeps(fs);
    const code = await main(
      [
        "run",
        "--suite",
        "fake-suite",
        "--out",
        "out",
        "--evals-dir",
        "evals",
        "--record-baseline",
        "--baseline-dir",
        "docs/eval/baseline",
      ],
      deps,
    );
    expect(code).toBe(0);
    const readme = fs.readFile(path.join("docs/eval/baseline", "README.md"));
    expect(readme).toContain("fake-suite");
    expect(readme).toContain("other-suite");
  });
});

describe("main compare", () => {
  function report(overrides: Partial<EvalReport> = {}): EvalReport {
    return {
      schemaVersion: 1,
      runner: { name: "flow-eval-headless", model: "sonnet" },
      tree: { gitHead: "aaa", dirty: false },
      suite: "s",
      candidate: "c",
      startedAt: "t0",
      finishedAt: "t1",
      scenarios: [
        {
          id: "s1",
          title: "S1",
          status: "pass",
          score: 1,
          runs: [],
          metrics: {
            "transcript.finalContextTokens": {
              median: 1000,
              min: 1000,
              max: 1000,
              direction: "lower",
              values: [1000],
            },
          },
        },
      ],
      summary: {
        score: 1,
        scenarios: 1,
        passed: 1,
        failed: 0,
        errored: 0,
        costUsd: 0,
      },
      ...overrides,
    };
  }

  it("exits 1 with --fail-on-regression when a regression is present", async () => {
    const base = report();
    const cand = report({
      scenarios: [
        {
          ...report().scenarios[0],
          metrics: {
            "transcript.finalContextTokens": {
              median: 1500,
              min: 1500,
              max: 1500,
              direction: "lower",
              values: [1500],
            },
          },
        },
      ],
    });
    const fs = memFs({
      "base.json": JSON.stringify(base),
      "cand.json": JSON.stringify(cand),
    });
    const deps = fakeDeps(fs);
    const code = await main(
      [
        "compare",
        "--base",
        "base.json",
        "--candidate",
        "cand.json",
        "--fail-on-regression",
      ],
      deps,
    );
    expect(code).toBe(1);
  });

  it("--json prints the Comparison object", async () => {
    const base = report();
    const fs = memFs({
      "base.json": JSON.stringify(base),
      "cand.json": JSON.stringify(base),
    });
    const deps = fakeDeps(fs);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const code = await main(
        [
          "compare",
          "--base",
          "base.json",
          "--candidate",
          "cand.json",
          "--json",
        ],
        deps,
      );
      expect(code).toBe(0);
      const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(printed);
      expect(parsed.suite).toBe("s");
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe("main validate", () => {
  it("validates a suite directory", async () => {
    // main()'s validate branch calls the real fs.statSync directly (to
    // decide directory vs. file) before routing through Deps, so this
    // needs a real tmp dir rather than the in-memory fs — no Deps override
    // at all, so `main` falls back to its own real default Deps entirely.
    const scenarioRoot = mkRealSuite();
    try {
      const code = await main(["validate", scenarioRoot]);
      expect(code).toBe(0);
    } finally {
      realFs.rmSync(scenarioRoot, { recursive: true, force: true });
    }
  });

  it("validates a report file and rejects a malformed one", async () => {
    const goodReportPath = path.join(
      os.tmpdir(),
      `flow-eval-good-${Date.now()}.json`,
    );
    const badReportPath = path.join(
      os.tmpdir(),
      `flow-eval-bad-${Date.now()}.json`,
    );
    realFs.writeFileSync(
      goodReportPath,
      JSON.stringify({
        schemaVersion: 1,
        runner: { name: "flow-eval-headless" },
        tree: { gitHead: "a", dirty: false },
        suite: "s",
        candidate: "c",
        startedAt: "t0",
        finishedAt: "t1",
        scenarios: [],
        summary: {
          score: 1,
          scenarios: 0,
          passed: 0,
          failed: 0,
          errored: 0,
          costUsd: 0,
        },
      }),
    );
    realFs.writeFileSync(badReportPath, JSON.stringify({ nope: true }));
    try {
      expect(await main(["validate", goodReportPath])).toBe(0);
      expect(await main(["validate", badReportPath])).toBe(2);
    } finally {
      realFs.rmSync(goodReportPath, { force: true });
      realFs.rmSync(badReportPath, { force: true });
    }
  });
});

function mkRealSuite(): string {
  const root = realFs.mkdtempSync(
    path.join(os.tmpdir(), "flow-eval-validate-"),
  );
  realFs.mkdirSync(path.join(root, "s1"), { recursive: true });
  realFs.writeFileSync(
    path.join(root, "suite.json"),
    suiteJson().replace("fake-suite", path.basename(root)),
  );
  const spec = JSON.parse(caseJson());
  realFs.writeFileSync(
    path.join(root, "s1", "case.json"),
    JSON.stringify(spec),
  );
  realFs.writeFileSync(path.join(root, "s1", "prompt.md"), "hi");
  realFs.writeFileSync(path.join(root, "s1", "out.txt"), "hi");
  return root;
}

describe("concurrency pool", () => {
  it("runs at most `concurrency` scenario-runs in flight at once", async () => {
    const files = baseFiles();
    // Two extra scenarios so the pool has real parallel work.
    for (const id of ["s2", "s3"]) {
      files[path.join(SUITE_DIR, id, "case.json")] = caseJson({
        id,
        graders: [
          { id: "g1", kind: "file", file: "$REPO/out.txt", exists: true },
        ],
      });
      files[path.join(SUITE_DIR, id, "prompt.md")] = "hi";
    }
    files[path.join(SUITE_DIR, "suite.json")] = JSON.stringify({
      schemaVersion: 1,
      id: "fake-suite",
      candidate: "c",
      description: "d",
      scenarios: ["s1", "s2", "s3"],
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const fs = memFs(files);
    const deps = fakeDeps(fs, {
      materializeFixture: () =>
        ({
          root: "/r",
          repoDir: "/r/repo",
          claudeHome: "/r/home",
          pluginRoots: [],
          shimDir: "/r/shims",
          slug: "eval-fake-suite-x-r1",
          stateDir: "/state",
          teardown: () => {},
        }) as ReturnType<Deps["materializeFixture"]>,
      runScenarioOnce: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return {
          exitCode: 0,
          timedOut: false,
          streamPath: "/r/stream.jsonl",
          assistantTextPath: "/r/assistant-text.txt",
          events: [],
          result: null,
        } as Awaited<ReturnType<Deps["runScenarioOnce"]>>;
      },
    });
    const code = await main(
      [
        "run",
        "--suite",
        "fake-suite",
        "--out",
        "out",
        "--evals-dir",
        "evals",
        "--concurrency",
        "2",
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
