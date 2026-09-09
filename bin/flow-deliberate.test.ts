import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BUDGET_USD,
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
  SKIP_REASONS,
  parseArgs,
  run,
  type Deps,
  type HeadlessEnvelope,
} from "./flow-deliberate";

const GOOD_ANSWER = [
  "### 1. Question as understood",
  "Where should a one-off script live?",
  "",
  "### 4. Recommendation",
  "Put it in bin/.",
  "",
  "Recommendation: Put it under bin/ with the other Bun helpers.",
  "Confidence: high",
  "Anchor: bin/flow-blind-survey.ts:549",
].join("\n");

type Harness = {
  deps: Deps;
  out: string[];
  events: Array<{ event: string; attrs: Record<string, unknown> }>;
  written: Map<string, string>;
  spawnCalls: string[][];
  removedDirs: string[];
};

function harness(over?: {
  files?: Record<string, string>;
  headless?: HeadlessEnvelope;
  configModel?: string;
  leaks?: boolean;
}): Harness {
  const files = new Map(Object.entries(over?.files ?? {}));
  const written = new Map<string, string>();
  const out: string[] = [];
  const events: Array<{ event: string; attrs: Record<string, unknown> }> = [];
  const spawnCalls: string[][] = [];
  const removedDirs: string[] = [];

  const headless: HeadlessEnvelope = over?.headless ?? {
    ran: true,
    artifact: "/wt/.flow-tmp/headless-deliberate-t.json",
    model: "opus",
    total_cost_usd: 0.42,
  };

  // The child writes its own artifact; model that by seeding it on spawn.
  const deps: Deps = {
    spawnHeadless: (argv) => {
      spawnCalls.push(argv);
      if (headless.ran === true && headless.artifact) {
        files.set(
          headless.artifact,
          JSON.stringify({ result: over?.files?.__answer ?? GOOD_ANSWER }),
        );
      }
      return headless;
    },
    readFile: (p) => {
      const v = files.get(p) ?? written.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: (p, c) => void written.set(p, c),
    fileExists: (p) => files.has(p) || written.has(p),
    dirExists: (p) => p === "/wt",
    mkdirp: () => {},
    mkdtemp: () => "/scratch",
    removeDir: (d) => void removedDirs.push(d),
    writeOut: (line) => void out.push(line),
    briefLeaksCorpus: () => over?.leaks ?? false,
    recordEvent: (event, attrs) => void events.push({ event, attrs }),
    resolveConfigModel: () => over?.configModel,
  };

  return { deps, out, events, written, spawnCalls, removedDirs };
}

function envelope(h: Harness): Record<string, unknown> {
  return JSON.parse(h.out.at(-1) ?? "{}");
}

const BASE_ARGV = [
  "--question-file",
  "/q.md",
  "--worktree",
  "/wt",
  "--task",
  "t",
];

const BASE_FILES = { "/q.md": "Where should a one-off script live?" };

describe("parseArgs", () => {
  it("requires --question-file", () => {
    expect(parseArgs([])).toEqual({ error: "--question-file is required" });
  });

  it("applies the approved defaults", () => {
    const args = parseArgs(["--question-file", "/q.md"]);
    expect(args).not.toHaveProperty("error");
    if ("error" in args) throw new Error("unreachable");
    expect(args.effort).toBe("high");
    expect(args.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
    expect(args.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(args.timeoutSec).toBe(300);
    expect(args.task).toBe("deliberate");
    // No default model here — resolution is --model > models.default > opus,
    // and the config layer is only reachable at run time.
    expect(args.model).toBeUndefined();
  });

  it("rejects an unknown flag, a missing value, and non-numeric caps", () => {
    expect(parseArgs(["--nope", "x"])).toEqual({
      error: "unknown flag --nope",
    });
    expect(parseArgs(["--question-file"])).toEqual({
      error: "missing value for --question-file",
    });
    expect(
      parseArgs(["--question-file", "/q", "--max-budget-usd", "0"]),
    ).toEqual({ error: "--max-budget-usd must be a positive number" });
    expect(parseArgs(["--question-file", "/q", "--max-turns", "1.5"])).toEqual({
      error: "--max-turns must be a positive integer",
    });
  });
});

describe("run — skip paths", () => {
  it("exits 2 with bad-args on a usage error, the only non-zero exit", () => {
    const h = harness();
    expect(run(["--nope", "x"], h.deps)).toBe(2);
    expect(envelope(h).skipReason).toBe("bad-args");
  });

  it("skips question-unreadable when the question file is missing or empty", () => {
    const missing = harness();
    expect(run(BASE_ARGV, missing.deps)).toBe(0);
    expect(envelope(missing)).toMatchObject({
      ran: false,
      skipReason: "question-unreadable",
    });

    const empty = harness({ files: { "/q.md": "   " } });
    run(BASE_ARGV, empty.deps);
    expect(envelope(empty).skipReason).toBe("question-unreadable");
  });

  it("skips worktree-not-found for a worktree that does not exist", () => {
    const h = harness({ files: BASE_FILES });
    run(["--question-file", "/q.md", "--worktree", "/nope"], h.deps);
    expect(envelope(h).skipReason).toBe("worktree-not-found");
  });

  it("skips question-not-blind without spawning when the lean leaked", () => {
    const h = harness({
      files: { ...BASE_FILES, "/lean.md": "I lean toward bin" },
      leaks: true,
    });
    run([...BASE_ARGV, "--blind-to-file", "/lean.md"], h.deps);
    expect(envelope(h)).toMatchObject({
      ran: false,
      skipReason: "question-not-blind",
    });
    // Refusing BEFORE the spawn is the point — a leaked question must cost $0.
    expect(h.spawnCalls).toHaveLength(0);
  });

  it("forwards a headless skip reason verbatim rather than flattening it", () => {
    for (const skipReason of [
      "claude-not-found",
      "claude-timeout",
      "claude-not-logged-in",
      "incomplete-result",
      "headless-depth-exceeded",
    ]) {
      const h = harness({
        files: BASE_FILES,
        headless: { ran: false, skipReason },
      });
      run(BASE_ARGV, h.deps);
      expect(envelope(h)).toMatchObject({ ran: false, skipReason });
    }
  });

  it("maps an unrecognised headless skip to headless-error", () => {
    const h = harness({
      files: BASE_FILES,
      headless: { ran: false, skipReason: "brand-new-reason" },
    });
    run(BASE_ARGV, h.deps);
    expect(envelope(h).skipReason).toBe("headless-error");
  });

  it("skips unparseable-result when the answer carries no trailer", () => {
    const h = harness({
      files: { ...BASE_FILES, __answer: "I think bin/ is nicer." },
    });
    run(BASE_ARGV, h.deps);
    expect(envelope(h)).toMatchObject({
      ran: false,
      skipReason: "unparseable-result",
    });
  });

  it("skips unparseable-result when the child artifact is missing", () => {
    const h = harness({
      files: BASE_FILES,
      headless: { ran: true, artifact: undefined, total_cost_usd: 0.1 },
    });
    run(BASE_ARGV, h.deps);
    expect(envelope(h).skipReason).toBe("unparseable-result");
  });

  it("records a telemetry event on every skip, so cost visibility has no gap", () => {
    const h = harness();
    run(BASE_ARGV, h.deps);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      event: "deliberate.call",
      attrs: { ran: false, skip_reason: "question-unreadable" },
    });
  });

  it("declares every skip reason it can emit", () => {
    expect(SKIP_REASONS).toContain("question-not-blind");
    expect(SKIP_REASONS).toContain("unparseable-result");
    expect(SKIP_REASONS).toContain("claude-timeout");
  });
});

describe("run — success path", () => {
  it("emits the parsed envelope and writes the note", () => {
    const h = harness({ files: BASE_FILES });
    expect(run(BASE_ARGV, h.deps)).toBe(0);
    expect(envelope(h)).toMatchObject({
      ran: true,
      task: "t",
      recommendation: "Put it under bin/ with the other Bun helpers.",
      confidence: "high",
      anchor: "bin/flow-blind-survey.ts:549",
      anchorDemoted: false,
      artifact: "/wt/.flow-tmp/deliberation-t.md",
      total_cost_usd: 0.42,
      model: "opus",
    });
    const note = h.written.get("/wt/.flow-tmp/deliberation-t.md") ?? "";
    expect(note).toContain("# Deliberation: t");
    expect(note).toContain("**Confidence:** high");
    expect(note).toContain("## Question asked");
  });

  it("passes the approved caps and the read-only tool allowlist to the child", () => {
    const h = harness({ files: BASE_FILES });
    run(BASE_ARGV, h.deps);
    const argv = h.spawnCalls[0];
    expect(argv).toContain("--prompt-file");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("2");
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("15");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
    expect(argv[argv.indexOf("--allowed-tools") + 1]).toBe("Read,Grep,Glob");
    expect(argv[argv.indexOf("--timeout-sec") + 1]).toBe("300");
  });

  it("writes the prompt outside the worktree and cleans the scratch dir up", () => {
    const h = harness({ files: BASE_FILES });
    run(BASE_ARGV, h.deps);
    const promptPath =
      h.spawnCalls[0][h.spawnCalls[0].indexOf("--prompt-file") + 1];
    expect(promptPath).toBe("/scratch/deliberate-prompt.md");
    expect(promptPath.startsWith("/wt")).toBe(false);
    expect(h.removedDirs).toContain("/scratch");
  });

  it("resolves the model --model > models.default > opus", () => {
    const explicit = harness({ files: BASE_FILES, configModel: "sonnet" });
    run([...BASE_ARGV, "--model", "haiku"], explicit.deps);
    expect(
      explicit.spawnCalls[0][explicit.spawnCalls[0].indexOf("--model") + 1],
    ).toBe("haiku");

    const fromConfig = harness({ files: BASE_FILES, configModel: "sonnet" });
    run(BASE_ARGV, fromConfig.deps);
    expect(
      fromConfig.spawnCalls[0][fromConfig.spawnCalls[0].indexOf("--model") + 1],
    ).toBe("sonnet");

    const fallback = harness({ files: BASE_FILES });
    run(BASE_ARGV, fallback.deps);
    expect(
      fallback.spawnCalls[0][fallback.spawnCalls[0].indexOf("--model") + 1],
    ).toBe(DEFAULT_MODEL);
  });

  it("records a deliberate.call telemetry event carrying the call's cost", () => {
    const h = harness({ files: BASE_FILES });
    run(BASE_ARGV, h.deps);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      event: "deliberate.call",
      attrs: { ran: true, confidence: "high", total_cost_usd: 0.42 },
    });
  });
});

describe("run — anchor demotion", () => {
  const withAnchor = (confidence: string, anchor: string) =>
    [
      "Recommendation: Put it under bin/.",
      `Confidence: ${confidence}`,
      `Anchor: ${anchor}`,
    ].join("\n");

  it("demotes a weighing: anchor to low so speculation cannot be adopted", () => {
    const h = harness({
      files: {
        ...BASE_FILES,
        __answer: withAnchor("medium", "weighing: convention"),
      },
    });
    run(BASE_ARGV, h.deps);
    expect(envelope(h)).toMatchObject({
      ran: true,
      confidence: "low",
      anchorDemoted: true,
    });
    expect(h.written.get("/wt/.flow-tmp/deliberation-t.md")).toContain(
      "demoted to `low`",
    );
  });

  it("demotes an inference anchor and a prose anchor", () => {
    for (const anchor of ["inference", "the helpers are all verb-named"]) {
      const h = harness({
        files: { ...BASE_FILES, __answer: withAnchor("high", anchor) },
      });
      run(BASE_ARGV, h.deps);
      expect(envelope(h).confidence).toBe("low");
    }
  });

  it("keeps a closed-form anchor at its declared level", () => {
    for (const [confidence, anchor] of [
      ["high", "bin/lib/state.ts:42"],
      ["medium", "adjacent: bin/lib/state.ts"],
      ["high", 'user: "wire ONE site"'],
    ] as const) {
      const h = harness({
        files: { ...BASE_FILES, __answer: withAnchor(confidence, anchor) },
      });
      run(BASE_ARGV, h.deps);
      expect(envelope(h)).toMatchObject({ confidence, anchorDemoted: false });
    }
  });

  it("leaves a self-declared low alone rather than re-demoting it", () => {
    const h = harness({
      files: { ...BASE_FILES, __answer: withAnchor("low", "inference") },
    });
    run(BASE_ARGV, h.deps);
    expect(envelope(h)).toMatchObject({
      confidence: "low",
      anchorDemoted: false,
    });
  });
});
