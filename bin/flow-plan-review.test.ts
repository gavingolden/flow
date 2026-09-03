import { describe, expect, it, vi } from "vitest";
import {
  computeDecisionHash,
  computeDepth,
  extractDecisionAnalysisBody,
  extractGoalLine,
  godurToSec,
  hasDecisionAnalysis,
  isPlanReviewEnabled,
  mapReviewerSkipReason,
  maxElapsedSec,
  normalizeDecisionBody,
  parseArgs,
  readPriorHash,
  run,
  type DelegateEnvelope,
  type Deps,
  type FanoutAggregate,
} from "./flow-plan-review";

const MODEL_1 = "Gemini 3.7 Flash (High)";
const MODEL_2 = "Claude Opus 4.6 (Thinking)";

// Must clear BOTH the engagement bars in bin/lib/plan-review-engagement.ts:
// >=40 chars AND >=2 lens tokens (case-insensitive, from the lens-matcher
// list — "goal"/"preference"/"walkthrough or user-flow"/"alternative"/
// "failure-mode"/"cut-list"). Realistic prose, not keyword salad.
const AGY_PROSE =
  "Judged against the stated goal, the supervisor branch dominates the subagent alternative because it owns the gate. A preference the author elicited mid-discovery softens this, but the goal anchor still wins. Failure-mode: if agy is flaky the review silently skips, which is acceptable.";

const PLAN_WITH_SECTION = [
  "# PRD",
  "## Open Questions",
  "- [ ] something",
  "## Decision analysis",
  "**Decision A — X vs Y?** Verdict: X.",
  "## Recommendation",
  "**Proceed**",
].join("\n");

const PLAN_NO_SECTION = ["# PRD", "## Open Questions", "- [ ] something"].join(
  "\n",
);

describe("isPlanReviewEnabled (config gate — reuses review.gemini)", () => {
  it.each([
    ["absent file (empty read)", "", false],
    ["malformed JSON", "{not json", false],
    ["missing review key", JSON.stringify({ other: 1 }), false],
    [
      "review present but gemini missing",
      JSON.stringify({ review: { foo: 1 } }),
      false,
    ],
    [
      "gemini as 'true' string",
      JSON.stringify({ review: { gemini: "true" } }),
      false,
    ],
    ["gemini false", JSON.stringify({ review: { gemini: false } }), false],
    ["review not an object", JSON.stringify({ review: true }), false],
    ["gemini true", JSON.stringify({ review: { gemini: true } }), true],
  ])("enables only on strict boolean true: %s", (_name, raw, expected) => {
    expect(isPlanReviewEnabled(raw as string)).toBe(expected);
  });

  it("never throws on garbage input", () => {
    expect(() => isPlanReviewEnabled("\x00\x01")).not.toThrow();
    expect(isPlanReviewEnabled("[]")).toBe(false);
  });
});

describe("hasDecisionAnalysis (section-present gate)", () => {
  it("matches an anchored `## Decision analysis` heading", () => {
    expect(hasDecisionAnalysis(PLAN_WITH_SECTION)).toBe(true);
  });
  it("is false when the heading is absent", () => {
    expect(hasDecisionAnalysis(PLAN_NO_SECTION)).toBe(false);
  });
  it("does not match a non-heading mention of the phrase", () => {
    expect(hasDecisionAnalysis("see the Decision analysis sub-section")).toBe(
      false,
    );
  });
});

describe("parseArgs", () => {
  it("requires --plan-file and --out", () => {
    expect(parseArgs([])).toEqual({ error: "--plan-file is required" });
    expect(parseArgs(["--plan-file", "/p.md"])).toEqual({
      error: "--out is required",
    });
  });

  it("rejects a value-flag with no value", () => {
    expect(parseArgs(["--plan-file"])).toEqual({
      error: "--plan-file requires a value",
    });
  });

  it("parses a full arg set with defaults", () => {
    expect(
      parseArgs([
        "--plan-file",
        "/p.md",
        "--out",
        "/wt/.flow-tmp/plan-review.md",
      ]),
    ).toMatchObject({
      planFile: "/p.md",
      out: "/wt/.flow-tmp/plan-review.md",
      task: "plan-review",
      printHash: false,
    });
  });

  it("--print-hash needs only --plan-file (no --out required)", () => {
    expect(parseArgs(["--print-hash", "--plan-file", "/p.md"])).toMatchObject({
      planFile: "/p.md",
      printHash: true,
    });
  });

  it("still requires --plan-file under --print-hash", () => {
    expect(parseArgs(["--print-hash"])).toEqual({
      error: "--plan-file is required",
    });
  });
});

const ENABLED = JSON.stringify({ review: { gemini: true } });
const PLAN_FILE = "/wt/.flow-tmp/plan.md";
const OUT = "/wt/.flow-tmp/plan-review.md";
const WORKTREE = "/wt";
const BASE_ARGV = [
  "--plan-file",
  PLAN_FILE,
  "--out",
  OUT,
  "--worktree",
  WORKTREE,
];

function makeDeps(overrides: Partial<Deps> = {}): Deps & {
  calls: {
    delegate: string[][];
    fanout: Array<{
      manifestPath: string;
      outPath: string;
      concurrency: number;
    }>;
    writes: Array<{ path: string; contents: string }>;
    removed: string[];
    out: string[];
    spawnDetached: string[][];
    killed: number[];
  };
  files: Map<string, string>;
  stateRecords: Map<string, import("./lib/state").PlanReviewRecord>;
} {
  const files = new Map<string, string>();
  const stateRecords = new Map<
    string,
    import("./lib/state").PlanReviewRecord
  >();
  const calls = {
    delegate: [] as string[][],
    fanout: [] as Array<{
      manifestPath: string;
      outPath: string;
      concurrency: number;
    }>,
    writes: [] as Array<{ path: string; contents: string }>,
    removed: [] as string[],
    out: [] as string[],
    spawnDetached: [] as string[][],
    killed: [] as number[],
  };
  const base: Deps = {
    readConfig: () => ENABLED,
    runDelegate: (argv) => {
      calls.delegate.push(argv);
      // Default: a conformant agy run that wrote raw prose to the --out scratch.
      const rawPath = argv[argv.indexOf("--out") + 1]!;
      files.set(rawPath, AGY_PROSE);
      return { ran: true, artifactPath: rawPath } as DelegateEnvelope;
    },
    runFanout: (input) => {
      calls.fanout.push(input);
      // Default: both manifest entries "ran", each writing its own artifact —
      // a conformant deep-tier two-reviewer success. Honors each manifest
      // entry's own `out` (the real `flow-delegate-fanout` binary's
      // `entryOutPath` behavior — bin/flow-delegate-fanout.ts:187 "if
      // (entry.out) return entry.out") so this stub's artifact path matches
      // production and the scratch-lifecycle tests can actually see a leak.
      let manifest: Array<{ task: string; model: string; out?: string }> = [];
      try {
        manifest = JSON.parse(files.get(input.manifestPath) ?? "[]");
      } catch {
        manifest = [];
      }
      const entries = manifest.map((m, i) => {
        const artifactPath = m.out ?? `${input.outPath}.artifact.${i}.md`;
        files.set(artifactPath, `${AGY_PROSE} (reviewer ${i + 1})`);
        return { task: m.task, model: m.model, ran: true, artifactPath };
      });
      return {
        entries,
        anyRan: entries.length > 0,
        allSkipped: entries.length === 0,
      } as FanoutAggregate;
    },
    readFile: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    },
    writeFile: (p, c) => {
      calls.writes.push({ path: p, contents: c });
      files.set(p, c);
    },
    removeFile: (p) => {
      calls.removed.push(p);
      files.delete(p);
    },
    renameFile: (from, to) => {
      const c = files.get(from);
      if (c !== undefined) files.set(to, c);
      files.delete(from);
    },
    mkdirp: () => {},
    writeOut: (line) => calls.out.push(line),
    dirExists: () => true,
    fileExists: (p) => files.has(p),

    spawnDetached: (argv) => {
      calls.spawnDetached.push(argv);
      return { pid: 4242 };
    },
    probeStartEpoch: () => 1000,
    readStateRecord: (slug) => stateRecords.get(slug),
    writeStateRecord: (slug, rec) => {
      stateRecords.set(slug, rec);
    },
    isAlive: () => false,
    killWorker: (pid) => {
      calls.killed.push(pid);
    },
    now: () => new Date("2026-08-27T00:00:00.000Z"),
    env: { FLOW_SLUG: "test-slug" },
    readWorkerStderrTail: (p) => files.get(p) ?? "",
  };
  // Seed the plan file the helper reads (with the gate section present).
  files.set(PLAN_FILE, PLAN_WITH_SECTION);
  return Object.assign(base, overrides, { calls, files, stateRecords });
}

const envelope = (deps: { calls: { out: string[] } }) =>
  JSON.parse(deps.calls.out[0] as string);

// Finds the battery prompt this run wrote to `${OUT}.prompt`, so prompt
// CONTENT can be asserted as substring checks without exporting the builder
// from flow-plan-review.ts itself (it lives in bin/lib/plan-review-prompt.ts).
const promptFor = (deps: {
  calls: { writes: Array<{ path: string; contents: string }> };
}) => deps.calls.writes.find((w) => w.path === `${OUT}.prompt`)?.contents ?? "";

describe("run — gate (config)", () => {
  it("skips with plan-review-disabled when the config gate is off", () => {
    const deps = makeDeps({ readConfig: () => JSON.stringify({}) });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "plan-review-disabled",
    });
    expect(deps.calls.delegate).toHaveLength(0);
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("treats an unreadable config (throw) as disabled, not a crash", () => {
    const deps = makeDeps({
      readConfig: () => {
        throw new Error("EACCES");
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps).skipReason).toBe("plan-review-disabled");
  });
});

describe("run — gate (section present)", () => {
  it("skips with no-decision-analysis when plan.md has no `## Decision analysis`", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_NO_SECTION);
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "no-decision-analysis",
    });
    expect(deps.calls.delegate).toHaveLength(0);
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("skips with plan-unreadable when plan.md read throws", () => {
    const deps = makeDeps({
      readFile: () => {
        throw new Error("EIO");
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "plan-unreadable",
    });
    expect(deps.calls.delegate).toHaveLength(0);
  });
});

describe("run — branch on envelope.ran, never the exit code", () => {
  it("propagates agy-not-found when the delegate returns {ran:false}", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        return { ran: false, skipReason: "agy-not-found" };
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({ ran: false, skipReason: "agy-not-found" });
    // No feedback file finalized on a skip.
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("falls back to agy-not-found when {ran:false} carries no skipReason", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        return { ran: false };
      },
    });
    run(BASE_ARGV, deps);
    expect(envelope(deps)).toEqual({ ran: false, skipReason: "agy-not-found" });
    expect(deps.files.has(OUT)).toBe(false);
  });
});

describe("run — stale --out cleanup on skip", () => {
  it("removes a pre-existing stale --out file when a post-gate skip fires", () => {
    // Pre-seed a stale feedback file from a prior run, then drive a skip that
    // occurs AFTER the config gate (no-decision-analysis). The unconditional
    // removeFile(parsed.out) must clear it so no stale feedback survives a skip.
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_NO_SECTION);
    deps.files.set(OUT, "stale prior feedback");
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps).skipReason).toBe("no-decision-analysis");
    expect(deps.files.has(OUT)).toBe(false);
    expect(deps.calls.removed).toContain(OUT);
  });
});

describe("run — worktree gate", () => {
  it("skips with worktree-not-provided when --worktree is omitted", () => {
    const deps = makeDeps();
    const argv = ["--plan-file", PLAN_FILE, "--out", OUT];
    expect(run(argv, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "worktree-not-provided",
    });
    expect(deps.calls.delegate).toHaveLength(0);
  });

  it("skips with worktree-not-found when --worktree does not exist", () => {
    const deps = makeDeps({ dirExists: () => false });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "worktree-not-found",
    });
    expect(deps.calls.delegate).toHaveLength(0);
  });
});

describe("run — post-delegate error paths (ran:true → degrade to skip)", () => {
  it("skips with plan-output-unreadable when reading the raw artifact throws", () => {
    // Delegate reports ran:true but the raw artifact it points at can't be read.
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        // Deliberately do NOT seed rawPath, so readFile(rawPath) throws.
        return { ran: true, artifactPath: rawPath } as DelegateEnvelope;
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "plan-output-unreadable",
    });
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("skips with plan-finalize-failed when the final --out write throws", () => {
    // Delegate produced a readable artifact, but finalizing --out fails: the
    // helper must degrade to a skip rather than emit ran:true at a partial file.
    const deps = makeDeps({
      writeFile: (p, c) => {
        if (p === OUT) throw new Error("ENOSPC");
        deps.calls.writes.push({ path: p, contents: c });
        deps.files.set(p, c);
      },
    });
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "plan-finalize-failed",
    });
    expect(deps.files.has(OUT)).toBe(false);
  });
});

describe("run — happy path", () => {
  it("copies AGY raw prose to --out and reports ran:true with skipReason null", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
    // The pre-revision hash is deliberately NOT emitted — the supervisor sources
    // the marker from `--print-hash` on the final revised plan instead.
    // `depth`/`reviewers` ride along on every ran:true envelope so step 3 can
    // report the resolved tier; a standard run names its single reviewer.
    expect(envelope(deps)).toEqual({
      ran: true,
      feedbackPath: OUT,
      skipReason: null,
      depth: "standard",
      reviewers: [
        {
          model: "Gemini 3.7 Flash (High)",
          ran: true,
          skipReason: null,
          lensesEngaged: 4,
        },
      ],
    });
    // The finalized feedback file holds AGY's raw prose verbatim.
    expect(deps.files.get(OUT)).toBe(AGY_PROSE);
    // Scratch is cleaned up.
    expect(deps.files.has(`${OUT}.prompt`)).toBe(false);
    expect(deps.files.has(`${OUT}.agy-raw`)).toBe(false);
  });

  it("passes the hardcoded Gemini model and the worktree as --add-dir, with a 3m --timeout, to the delegate", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("Gemini 3.7 Flash (High)");
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(WORKTREE);
    expect(argv[argv.indexOf("--task") + 1]).toBe("plan-review");
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("3m");
  });
});

describe("run — reviewer engagement (standard tier)", () => {
  it("demotes a zero-byte reviewer artifact to reviewer-empty", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(rawPath, "");
        return { ran: true, artifactPath: rawPath } as DelegateEnvelope;
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "reviewer-empty",
    });
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("demotes a non-engaging reviewer (0-1 lenses) to reviewer-not-engaged", () => {
    const deps = makeDeps({
      runDelegate: (argv) => {
        deps.calls.delegate.push(argv);
        const rawPath = argv[argv.indexOf("--out") + 1]!;
        deps.files.set(
          rawPath,
          "This plan looks fine overall and I have nothing further to add here.",
        );
        return { ran: true, artifactPath: rawPath } as DelegateEnvelope;
      },
    });
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "reviewer-not-engaged",
    });
    expect(deps.files.has(OUT)).toBe(false);
  });
});

// --- decision-analysis-unchanged skip (revision-pass re-fire guard) --------

describe("decision-analysis hash helpers (pure)", () => {
  it("extractDecisionAnalysisBody bounds the section and excludes the AGY subsection", () => {
    const plan = [
      "## Decision analysis",
      "body line one",
      "body line two",
      "### Cross-model review (AGY)",
      "- excluded point",
      "## Recommendation",
      "proceed",
    ].join("\n");
    const body = extractDecisionAnalysisBody(plan);
    expect(body).toContain("body line one");
    expect(body).toContain("body line two");
    expect(body).not.toContain("excluded point");
    expect(body).not.toContain("Recommendation");
  });

  it("returns '' when the section is absent", () => {
    expect(extractDecisionAnalysisBody("# PRD\n\nno section")).toBe("");
  });

  it("hash is UNCHANGED by appending only the `### Cross-model review (AGY)` subsection + marker", () => {
    const bare = [
      "## Decision analysis",
      "**A** verdict X",
      "## Recommendation",
      "go",
    ].join("\n");
    const withReview = [
      "## Decision analysis",
      "**A** verdict X",
      "### Cross-model review (AGY)",
      "- point — accepted",
      `<!-- flow-plan-review-hash: ${"a".repeat(64)} -->`,
      "## Recommendation",
      "go",
    ].join("\n");
    expect(computeDecisionHash(withReview)).toBe(computeDecisionHash(bare));
  });

  it("normalization holds: trailing ws, `*`-vs-`-` bullets, and blank-run churn hash equal", () => {
    const a = [
      "## Decision analysis",
      "- point one",
      "",
      "- point two",
      "## Recommendation",
    ].join("\n");
    const b = [
      "## Decision analysis",
      "* point one   ",
      "",
      "",
      "* point two",
      "## Recommendation",
    ].join("\n");
    expect(normalizeDecisionBody(extractDecisionAnalysisBody(b))).toBe(
      normalizeDecisionBody(extractDecisionAnalysisBody(a)),
    );
    expect(computeDecisionHash(b)).toBe(computeDecisionHash(a));
  });

  it("a SEMANTIC change to the body DOES change the hash", () => {
    const a = ["## Decision analysis", "verdict X", "## Recommendation"].join(
      "\n",
    );
    const b = ["## Decision analysis", "verdict Y", "## Recommendation"].join(
      "\n",
    );
    expect(computeDecisionHash(b)).not.toBe(computeDecisionHash(a));
  });

  it("readPriorHash is tolerant: null on absent or malformed marker", () => {
    expect(readPriorHash("no marker here")).toBeNull();
    expect(readPriorHash("<!-- flow-plan-review-hash: xyz -->")).toBeNull();
    const valid = "b".repeat(64);
    expect(readPriorHash(`<!-- flow-plan-review-hash: ${valid} -->`)).toBe(
      valid,
    );
  });
});

describe("run — decision-analysis-unchanged skip", () => {
  // A plan whose embedded marker matches its own Decision-analysis hash. The
  // marker sits inside the excluded `### Cross-model review (AGY)` subsection,
  // so injecting it does not change the hash it records.
  function planWithMatchingMarker(): string {
    const noMarker = [
      "# PRD",
      "## Decision analysis",
      "**Decision A — X vs Y?** Verdict: X.",
      "### Cross-model review (AGY)",
      "- point one — accepted",
      "## Recommendation",
      "**Proceed**",
    ].join("\n");
    const h = computeDecisionHash(noMarker);
    return noMarker.replace(
      "- point one — accepted",
      `- point one — accepted\n<!-- flow-plan-review-hash: ${h} -->`,
    );
  }

  it("skips (no delegate) when the prior hash matches the current body", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, planWithMatchingMarker());
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "decision-analysis-unchanged",
    });
    expect(deps.calls.delegate).toHaveLength(0);
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("re-fires (delegate invoked) when NO prior marker exists", () => {
    const deps = makeDeps(); // default PLAN_WITH_SECTION has no marker
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(deps.calls.delegate).toHaveLength(1);
    expect(envelope(deps).ran).toBe(true);
    expect(envelope(deps)).not.toHaveProperty("decisionAnalysisHash");
  });

  it("re-fires when the prior marker's hash differs from the current body", () => {
    const stale = PLAN_WITH_SECTION.replace(
      "## Recommendation",
      `<!-- flow-plan-review-hash: ${"c".repeat(64)} -->\n## Recommendation`,
    );
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, stale);
    expect(run(BASE_ARGV, deps)).toBe(0);
    expect(deps.calls.delegate).toHaveLength(1);
    expect(envelope(deps).ran).toBe(true);
  });

  it("re-fires (never throws) on a malformed prior marker", () => {
    const malformed = PLAN_WITH_SECTION.replace(
      "## Recommendation",
      "<!-- flow-plan-review-hash: not-a-real-hash -->\n## Recommendation",
    );
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, malformed);
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(deps.calls.delegate).toHaveLength(1);
    expect(envelope(deps).ran).toBe(true);
  });
});

describe("run — usage errors", () => {
  it("returns 2 on a missing required flag", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run(["--plan-file", PLAN_FILE], makeDeps())).toBe(2);
    expect(run(["--out", OUT], makeDeps())).toBe(2);
    errSpy.mockRestore();
  });
});

describe("run — --print-hash compute-only mode", () => {
  const PRINT_ARGV = ["--print-hash", "--plan-file", PLAN_FILE];

  it("prints computeDecisionHash of the current plan, no delegate, no config gate", () => {
    // Config gate OFF: --print-hash must ignore it entirely.
    const deps = makeDeps({ readConfig: () => JSON.stringify({}) });
    expect(run(PRINT_ARGV, deps)).toBe(0);
    expect(deps.calls.delegate).toHaveLength(0);
    expect(deps.calls.out).toHaveLength(1);
    expect(deps.calls.out[0]).toBe(computeDecisionHash(PLAN_WITH_SECTION));
    // No feedback file, no scratch writes.
    expect(deps.files.has(OUT)).toBe(false);
  });

  it("is tolerant: an unreadable plan prints the empty-body hash (exit 0, no throw)", () => {
    const deps = makeDeps({
      readFile: () => {
        throw new Error("EIO");
      },
    });
    expect(() => run(PRINT_ARGV, deps)).not.toThrow();
    expect(run(PRINT_ARGV, deps)).toBe(0);
    expect(deps.calls.out.at(-1)).toBe(computeDecisionHash(""));
  });

  it("ignores the `<!-- flow-plan-review-hash -->` marker itself when hashing", () => {
    // A plan carrying its own marker (inside the excluded AGY subsection) prints
    // the SAME hash as the marker-free body — the round-trip invariant below.
    const marked = [
      "# PRD",
      "## Decision analysis",
      "**Decision A** verdict X",
      "### Cross-model review (AGY)",
      "- point one — accepted",
      `<!-- flow-plan-review-hash: ${"d".repeat(64)} -->`,
      "## Recommendation",
      "go",
    ].join("\n");
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, marked);
    run(PRINT_ARGV, deps);
    expect(deps.calls.out[0]).toBe(computeDecisionHash(marked));
  });

  // Regression guard: the worktree gate sits AFTER the printHash early
  // return, so --print-hash must stay gate-free even with NO --worktree
  // passed at all (PRINT_ARGV above never includes it, but this test pins
  // the invariant explicitly rather than leaving it implicit).
  it("still works with NO --worktree passed at all", () => {
    const deps = makeDeps();
    expect(PRINT_ARGV).not.toContain("--worktree");
    expect(run(PRINT_ARGV, deps)).toBe(0);
    expect(deps.calls.out[0]).toBe(computeDecisionHash(PLAN_WITH_SECTION));
  });
});

describe("round-trip: --print-hash marker makes the next run skip", () => {
  // The bug this closes: the supervisor must embed the hash of the FINAL revised
  // plan. Simulate that end-to-end — compute the hash of the revised plan via
  // --print-hash, embed it as a marker inside the AGY subsection, then assert a
  // subsequent review run skips with decision-analysis-unchanged.
  it("printed hash, once embedded, yields a decision-analysis-unchanged skip", () => {
    const revisedNoMarker = [
      "# PRD",
      "## Decision analysis",
      "**Decision A — X vs Y?** Verdict: X (revised per AGY).",
      "### Cross-model review (AGY)",
      "- point one — accepted: tightened the verdict wording",
      "## Recommendation",
      "**Proceed**",
    ].join("\n");

    // 1) Supervisor runs --print-hash on the final revised plan.
    const printDeps = makeDeps();
    printDeps.files.set(PLAN_FILE, revisedNoMarker);
    run(["--print-hash", "--plan-file", PLAN_FILE], printDeps);
    const printedHash = printDeps.calls.out[0]!;
    expect(printedHash).toMatch(/^[0-9a-f]{64}$/);

    // 2) Supervisor embeds it as a marker inside the AGY subsection (excluded
    //    from the hash, so embedding does not invalidate it).
    const embedded = revisedNoMarker.replace(
      "- point one — accepted: tightened the verdict wording",
      `- point one — accepted: tightened the verdict wording\n<!-- flow-plan-review-hash: ${printedHash} -->`,
    );

    // 3) Next step-3 pass re-runs the review unconditionally → must skip.
    const reviewDeps = makeDeps();
    reviewDeps.files.set(PLAN_FILE, embedded);
    expect(run(BASE_ARGV, reviewDeps)).toBe(0);
    expect(envelope(reviewDeps)).toEqual({
      ran: false,
      skipReason: "decision-analysis-unchanged",
    });
    expect(reviewDeps.calls.delegate).toHaveLength(0);
  });
});

// --- Battery prompt content (goal-anchored, adversarial) --------------------

const PLAN_WITH_GOAL = [
  "# PRD",
  "**Goal:** Let users export a widget to CSV in one click.",
  "## Open Questions",
  "- [ ] something",
  "## Decision analysis",
  "**Decision A — X vs Y?** Verdict: X.",
  "## Recommendation",
  "**Proceed**",
].join("\n");

describe("extractGoalLine (re-exported for the test suite)", () => {
  it("is re-exported from bin/lib/plan-review-prompt.ts", () => {
    expect(extractGoalLine(PLAN_WITH_GOAL)).toBe(
      "**Goal:** Let users export a widget to CSV in one click.",
    );
    expect(extractGoalLine(PLAN_NO_SECTION)).toBeNull();
  });
});

describe("run — battery prompt content", () => {
  it("quotes the plan's **Goal:** line as the anchor", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    expect(promptFor(deps)).toContain(
      "**Goal:** Let users export a widget to CSV in one click.",
    );
  });

  it("contains all six battery lenses", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    const prompt = promptFor(deps);
    expect(prompt).toContain("Goal-anchored verdicts");
    expect(prompt).toContain("Preference challenge");
    expect(prompt).toContain("user-flow walkthrough");
    expect(prompt).toContain("interruptions-per-run");
    expect(prompt).toContain("Structurally-different alternatives");
    expect(prompt).toContain("Failure-modes battery");
    expect(prompt).toContain("prompt-free mitigation");
    expect(prompt).toContain("Independent cut list");
  });

  it("instructs the reviewer to form its own cut-list BEFORE reading the plan's Cut list", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    expect(promptFor(deps)).toContain(
      "Before reading the plan's own `## Cut list` section, form your OWN list",
    );
  });

  it("falls back to '## Problem Statement' without throwing when no Goal line exists", () => {
    const plan = [
      "# PRD",
      "## Problem Statement",
      "Users cannot export widgets today.",
      "## Decision analysis",
      "**Decision A** verdict X.",
      "## Recommendation",
      "go",
    ].join("\n");
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, plan);
    expect(() => run(BASE_ARGV, deps)).not.toThrow();
    expect(promptFor(deps)).toContain("Users cannot export widgets today.");
  });

  it("names the worktree path as the readable repository root", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    expect(promptFor(deps)).toContain(WORKTREE);
  });

  it("instructs the reviewer to emit the exact authored lens headings", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    expect(promptFor(deps)).toContain("EXACT authored headings");
  });

  it("requires any current-behaviour claim to cite the exact file path it was read from", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    expect(promptFor(deps)).toContain(
      "must cite the exact file path you read it from",
    );
  });

  // Regression: verified live against agy. Told to verify claims against the
  // repo but not HOW, Gemini reached for shell (`grep`/`ls`) instead of its
  // file-read tools. Shell needs the "command" permission, which headless `-p`
  // mode cannot prompt for and auto-denies, so the run died at 0 bytes in 25s.
  // Naming the access method took the same reviewer to a full six-lens review.
  // Same failure class as the --add-dir bug this PR fixes, one layer over.
  it("tells the reviewer to use file-reading tools and never shell out", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    const prompt = promptFor(deps);
    expect(prompt).toContain("Do NOT shell out");
    expect(prompt).toContain("auto-denied");
  });

  it("no longer carries the removed 'Do NOT trace code paths you cannot see' instruction", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    expect(promptFor(deps)).not.toContain(
      "Do NOT trace code paths you cannot see",
    );
  });

  // Regression: `.flow-tmp/` sits inside the new `--add-dir`, and the deep
  // tier's `concurrency: 1` guarantees reviewer 1's finished review is on
  // disk before reviewer 2 starts — so without this instruction, "a point
  // BOTH reviewers raised independently" could silently be echo, not
  // agreement, undermining the convergence rule this PR hardens.
  it("tells the reviewer not to read .flow-tmp/, naming why independence matters", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    const prompt = promptFor(deps);
    expect(prompt).toContain(".flow-tmp/");
    expect(prompt).toContain("Do NOT read");
  });

  it("tells the reviewer not to open .env/credential/secret files", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    const prompt = promptFor(deps);
    expect(prompt).toContain(".env");
    expect(prompt).toMatch(/credential|secret/i);
  });
});

// --- computeDepth (auto|standard|deep boundary) ------------------------------

describe("computeDepth", () => {
  function planWithTasks(n: number): string {
    const tasks = Array.from(
      { length: n },
      (_, i) => `### Task ${i + 1}: do a thing`,
    ).join("\n\n");
    return `# Task breakdown\n\n${tasks}\n`;
  }

  it("3 tasks stays standard, 4 tasks goes deep", () => {
    expect(computeDepth(planWithTasks(3))).toBe("standard");
    expect(computeDepth(planWithTasks(4))).toBe("deep");
  });

  it("1 '### D' subsection stays standard, 2 goes deep", () => {
    const one = [
      "## Decision analysis",
      "### D1 — X vs Y",
      "body",
      "## Recommendation",
    ].join("\n");
    const two = [
      "## Decision analysis",
      "### D1 — X vs Y",
      "body",
      "### D2 — A vs B",
      "body",
      "## Recommendation",
    ].join("\n");
    expect(computeDepth(one)).toBe("standard");
    expect(computeDepth(two)).toBe("deep");
  });

  it("a '### Task breakdown'-style heading does not count as a task", () => {
    const plan = [
      "### Task breakdown",
      "### Task breakdown continued",
      "### Task breakdown again",
      "### Task breakdown yet again",
    ].join("\n");
    expect(computeDepth(plan)).toBe("standard");
  });
});

describe("run — --depth override", () => {
  const DEEP_SHAPED_PLAN = [
    "# PRD",
    "## Decision analysis",
    "### D1 — X vs Y",
    "body",
    "### D2 — A vs B",
    "body",
    "## Recommendation",
    "go",
  ].join("\n");

  it("--depth standard forces standard on a deep-shaped plan", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, DEEP_SHAPED_PLAN);
    expect(run([...BASE_ARGV, "--depth", "standard"], deps)).toBe(0);
    expect(deps.calls.delegate).toHaveLength(1);
    expect(deps.calls.fanout).toHaveLength(0);
    // The override is reported back, so the supervisor's chat summary names
    // the tier that actually ran rather than the one `auto` would have picked.
    expect(envelope(deps).depth).toBe("standard");
    expect(envelope(deps).reviewers).toHaveLength(1);
  });

  it("--depth deep forces deep on a trivial (single-reviewer-shaped) plan", () => {
    const deps = makeDeps();
    expect(run([...BASE_ARGV, "--depth", "deep"], deps)).toBe(0);
    expect(deps.calls.delegate).toHaveLength(0);
    expect(deps.calls.fanout).toHaveLength(1);
    expect(envelope(deps).depth).toBe("deep");
  });

  it("--depth bogus is a parseArgs error", () => {
    expect(parseArgs([...BASE_ARGV, "--depth", "bogus"])).toEqual({
      error: '--depth must be one of auto, standard, deep (got "bogus")',
    });
  });
});

// --- Deep tier: two-reviewer fanout ------------------------------------------

describe("run — deep tier happy path", () => {
  it("reports depth:deep with two reviewers[] and a combined --out file", () => {
    const deps = makeDeps();
    expect(run([...BASE_ARGV, "--depth", "deep"], deps)).toBe(0);
    const env = envelope(deps);
    expect(env.ran).toBe(true);
    expect(env.depth).toBe("deep");
    expect(env.skipReason).toBeNull();
    expect(env.reviewers).toEqual([
      { model: MODEL_1, ran: true, lensesEngaged: 4 },
      { model: MODEL_2, ran: true, lensesEngaged: 4 },
    ]);
    const out = deps.files.get(OUT);
    expect(out).toContain("## Reviewer 1 — " + MODEL_1);
    expect(out).toContain("## Reviewer 2 — " + MODEL_2);
    expect(out).toContain("Convergence rule");
  });

  it("hands reviewer 2 its OWN same-family-aware prompt file, distinct from reviewer 1's, with the asymmetric 3m/15m per-reviewer timeouts and addDirs threading the worktree", () => {
    // Reviewer 2 (SECOND_MODEL) is the same model family as the PRD's
    // author, so it must not receive the byte-identical "different model
    // family" prompt handed to reviewer 1.
    const deps = makeDeps();
    run([...BASE_ARGV, "--depth", "deep"], deps);
    const manifestRaw = deps.calls.writes.find(
      (w) => w.path === `${OUT}.fanout-manifest.json`,
    )?.contents;
    const manifest = JSON.parse(manifestRaw ?? "[]");
    expect(manifest).toHaveLength(2);
    expect(manifest[0].promptFile).toBe(`${OUT}.prompt`);
    expect(manifest[1].promptFile).toBe(`${OUT}.prompt.r2`);
    expect(manifest[0].promptFile).not.toBe(manifest[1].promptFile);
    expect(manifest[0].model).toBe(MODEL_1);
    expect(manifest[1].model).toBe(MODEL_2);
    expect(manifest[0].out).toBe(`${OUT}.r1.md`);
    expect(manifest[1].out).toBe(`${OUT}.r2.md`);
    // Asymmetric split: reviewer 1 (fast, Gemini) 3m, reviewer 2 (slow,
    // Opus) 15m — no sum constraint anymore (the async spine detaches the
    // worker), so reviewer 2 gets the literal budget the user asked for.
    expect(manifest[0].timeout).toBe("3m");
    expect(manifest[1].timeout).toBe("15m");
    // addDirs = [parsed.worktree] on BOTH manifest entries — this is the
    // exact line this PR exists to fix (the reviewer must be granted repo
    // access, not left to review in a vacuum).
    expect(manifest[0].addDirs).toEqual([WORKTREE]);
    expect(manifest[1].addDirs).toEqual([WORKTREE]);

    const r1Prompt = deps.calls.writes.find(
      (w) => w.path === `${OUT}.prompt`,
    )?.contents;
    const r2Prompt = deps.calls.writes.find(
      (w) => w.path === `${OUT}.prompt.r2`,
    )?.contents;
    expect(r1Prompt).toContain("A PRD drafted by a different model family");
    expect(r2Prompt).toContain(
      "A PRD drafted by another instance of your own model family",
    );
    // Reviewer 2's prompt is built at an independently-threaded second call
    // site (buildBatteryPrompt with sameFamilyAsAuthor:true), so its
    // worktree threading must be asserted separately from reviewer 1's.
    expect(r2Prompt).toContain(WORKTREE);
  });

  // Serial, not parallel — verified live, and the deep tier's whole premise
  // depends on it. Once both reviewers read the repository, two simultaneous
  // agy sessions contend: 3/3 concurrent deep runs lost Gemini (twice
  // `reviewer-empty`, once `agy-error`) while the same reviewer succeeded
  // 4/4 as the only running session. Serialising gave 2/2 reviewers at 6/6
  // lenses in 6m27s. Raising this to 2 silently returns a paid two-reviewer
  // review to one — the exact defect this helper was fixed to eliminate.
  it("pins --concurrency 1 on the fanout call so the two reviewers run serially", () => {
    const deps = makeDeps();
    run([...BASE_ARGV, "--depth", "deep"], deps);
    expect(deps.calls.fanout[0]?.concurrency).toBe(1);
  });
});

describe("run — deep tier partial failure", () => {
  it("degrades to the surviving reviewer's prose, recording the failed reviewer's skipReason", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        const manifest = JSON.parse(deps.files.get(input.manifestPath)!);
        const artifactPath = `${input.outPath}.artifact.0.md`;
        deps.files.set(
          artifactPath,
          "Reviewer one prose, verbatim: judged against the stated goal, this structurally different alternative holds up well.",
        );
        return {
          entries: [
            {
              task: manifest[0].task,
              model: manifest[0].model,
              ran: true,
              artifactPath,
            },
            {
              task: manifest[1].task,
              model: manifest[1].model,
              ran: false,
              skipReason: "agy-not-authenticated",
            },
          ],
          anyRan: true,
          allSkipped: false,
        } as FanoutAggregate;
      },
    });
    expect(run([...BASE_ARGV, "--depth", "deep"], deps)).toBe(0);
    const env = envelope(deps);
    expect(env.ran).toBe(true);
    expect(env.depth).toBe("deep");
    expect(env.reviewers).toEqual([
      { model: MODEL_1, ran: true, lensesEngaged: 2 },
      { model: MODEL_2, ran: false, skipReason: "agy-not-authenticated" },
    ]);
    expect(deps.files.get(OUT)).toBe(
      "Reviewer one prose, verbatim: judged against the stated goal, this structurally different alternative holds up well.",
    );
  });
});

describe("run — deep tier both-skip", () => {
  it("propagates the FIRST reviewer's skip reason exactly like a standard-tier skip, --out absent", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        const manifest = JSON.parse(deps.files.get(input.manifestPath)!);
        return {
          entries: manifest.map((m: { task: string; model: string }) => ({
            task: m.task,
            model: m.model,
            ran: false,
            skipReason: "agy-not-found",
          })),
          anyRan: false,
          allSkipped: true,
        } as FanoutAggregate;
      },
    });
    expect(run([...BASE_ARGV, "--depth", "deep"], deps)).toBe(0);
    expect(envelope(deps)).toEqual({ ran: false, skipReason: "agy-not-found" });
    expect(deps.files.has(OUT)).toBe(false);
  });
});

describe("run — deep tier reviewer engagement demotion", () => {
  // A non-engaging prose: clears the substance floor (>=40 chars) but
  // engages 0 lenses, so classifyEngagement demotes it to
  // reviewer-not-engaged rather than counting it as a survivor.
  const NON_ENGAGING_PROSE =
    "This plan looks fine overall and I have nothing further to add here.";

  it("one demoted reviewer yields a single-reviewer output with NO convergence preamble, reviewers[] telling the truth", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        const manifest = JSON.parse(deps.files.get(input.manifestPath)!);
        const artifactPath0 = `${input.outPath}.artifact.0.md`;
        const artifactPath1 = `${input.outPath}.artifact.1.md`;
        deps.files.set(artifactPath0, AGY_PROSE);
        deps.files.set(artifactPath1, NON_ENGAGING_PROSE);
        return {
          entries: [
            {
              task: manifest[0].task,
              model: manifest[0].model,
              ran: true,
              artifactPath: artifactPath0,
            },
            {
              task: manifest[1].task,
              model: manifest[1].model,
              ran: true,
              artifactPath: artifactPath1,
            },
          ],
          anyRan: true,
          allSkipped: false,
        } as FanoutAggregate;
      },
    });
    expect(run([...BASE_ARGV, "--depth", "deep"], deps)).toBe(0);
    const env = envelope(deps);
    expect(env.ran).toBe(true);
    expect(env.depth).toBe("deep");
    expect(env.reviewers).toEqual([
      { model: MODEL_1, ran: true, lensesEngaged: 4 },
      {
        model: MODEL_2,
        ran: false,
        skipReason: "reviewer-not-engaged",
        lensesEngaged: 0,
        // Task 7: the demoted reviewer's transcript is retained and named
        // in its own reviewers[] entry, even though the WHOLE run still
        // succeeds (partial deep success).
        partialArtifactPath: `${OUT}.fanout.json.artifact.1.md`,
      },
    ]);
    expect(deps.files.get(OUT)).toBe(AGY_PROSE);
    expect(deps.files.get(OUT)).not.toContain("Convergence rule");
    // The demoted reviewer's transcript is retained on disk, not deleted by
    // the terminal cleanScratch() call.
    expect(deps.files.has(`${OUT}.fanout.json.artifact.1.md`)).toBe(true);
  });

  it("both demoted yields {ran:false, skipReason:'reviewer-empty'} carrying NO depth and NO reviewers fields (amended invariant: MAY carry partialArtifactPath)", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        const manifest = JSON.parse(deps.files.get(input.manifestPath)!);
        const artifactPath0 = `${input.outPath}.artifact.0.md`;
        const artifactPath1 = `${input.outPath}.artifact.1.md`;
        deps.files.set(artifactPath0, "");
        deps.files.set(artifactPath1, NON_ENGAGING_PROSE);
        return {
          entries: [
            {
              task: manifest[0].task,
              model: manifest[0].model,
              ran: true,
              artifactPath: artifactPath0,
            },
            {
              task: manifest[1].task,
              model: manifest[1].model,
              ran: true,
              artifactPath: artifactPath1,
            },
          ],
          anyRan: true,
          allSkipped: false,
        } as FanoutAggregate;
      },
    });
    expect(run([...BASE_ARGV, "--depth", "deep"], deps)).toBe(0);
    // D2 / Task 7: the invariant is AMENDED, not relaxed — `depth` and
    // `reviewers` still NEVER appear on a skip (that half is preserved
    // verbatim), but a skip MAY now carry `partialArtifactPath` (the FIRST
    // reviewer's retained transcript) when one exists. `toEqual`, not
    // `toMatchObject` — this pins the WHOLE shape, including the absence of
    // `depth`/`reviewers`.
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "reviewer-empty",
      partialArtifactPath: `${OUT}.fanout.json.artifact.0.md`,
    });
    expect(deps.files.has(OUT)).toBe(false);
    // Both reviewers' transcripts are retained on the both-skipped path too.
    expect(deps.files.has(`${OUT}.fanout.json.artifact.0.md`)).toBe(true);
    expect(deps.files.has(`${OUT}.fanout.json.artifact.1.md`)).toBe(true);
  });
});

describe("run — deep tier near-cap demotion (durationMs fallback)", () => {
  // Reviewer 2's configured cap is 900s (REVIEWER_2_TIMEOUT = "15m"). A
  // fanout entry whose pool-observed durationMs lands within
  // NEAR_CAP_SLACK_SEC (10s) of that cap must be treated as
  // reviewer-timeout even on a clean exit:0 non-engaging demotion — the
  // exact "killed agy exits 0 with a partial" case this fallback exists
  // for. `durationSeconds` is deliberately absent from both entries below:
  // this module never sets `outputFormat: "json"` on its manifest, so
  // flow-delegate never lifts a `durationSeconds` field in production —
  // pinning the fixture on `durationSeconds` would assert a branch that
  // can never fire.
  const NON_ENGAGING_PROSE =
    "This plan looks fine overall and I have nothing further to add here.";

  it("maps a near-cap exit-0 demotion to reviewer-timeout even without an agy-timeout skipReason", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        const manifest = JSON.parse(deps.files.get(input.manifestPath)!);
        const artifactPath0 = `${input.outPath}.artifact.0.md`;
        const artifactPath1 = `${input.outPath}.artifact.1.md`;
        deps.files.set(artifactPath0, AGY_PROSE);
        deps.files.set(artifactPath1, NON_ENGAGING_PROSE);
        return {
          entries: [
            {
              task: manifest[0].task,
              model: manifest[0].model,
              ran: true,
              artifactPath: artifactPath0,
              durationMs: 100_000,
            },
            {
              task: manifest[1].task,
              model: manifest[1].model,
              ran: true,
              artifactPath: artifactPath1,
              durationMs: 895_000, // 895s: within the 10s slack of the 900s cap
            },
          ],
          anyRan: true,
          allSkipped: false,
        } as FanoutAggregate;
      },
    });
    expect(run([...BASE_ARGV, "--depth", "deep"], deps)).toBe(0);
    const env = envelope(deps);
    expect(env.reviewers[1].skipReason).toBe("reviewer-timeout");
  });

  it("does NOT demote to reviewer-timeout when the observed duration is well under the cap", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        const manifest = JSON.parse(deps.files.get(input.manifestPath)!);
        const artifactPath0 = `${input.outPath}.artifact.0.md`;
        const artifactPath1 = `${input.outPath}.artifact.1.md`;
        deps.files.set(artifactPath0, AGY_PROSE);
        deps.files.set(artifactPath1, NON_ENGAGING_PROSE);
        return {
          entries: [
            {
              task: manifest[0].task,
              model: manifest[0].model,
              ran: true,
              artifactPath: artifactPath0,
              durationMs: 100_000,
            },
            {
              task: manifest[1].task,
              model: manifest[1].model,
              ran: true,
              artifactPath: artifactPath1,
              durationMs: 100_000, // 100s: nowhere near the 900s cap
            },
          ],
          anyRan: true,
          allSkipped: false,
        } as FanoutAggregate;
      },
    });
    expect(run([...BASE_ARGV, "--depth", "deep"], deps)).toBe(0);
    const env = envelope(deps);
    expect(env.reviewers[1].skipReason).toBe("reviewer-not-engaged");
  });
});

describe("run — deep tier scratch lifecycle", () => {
  it("removes the manifest + fanout aggregate + per-reviewer artifacts on the ran path", () => {
    const deps = makeDeps();
    run([...BASE_ARGV, "--depth", "deep"], deps);
    expect(deps.files.has(`${OUT}.fanout-manifest.json`)).toBe(false);
    expect(deps.files.has(`${OUT}.fanout.json`)).toBe(false);
    expect(deps.files.has(`${OUT}.prompt`)).toBe(false);
    expect(deps.files.has(`${OUT}.prompt.r2`)).toBe(false);
    // The two reviewer-artifact scratch siblings must not leak either.
    expect(deps.files.has(`${OUT}.r1.md`)).toBe(false);
    expect(deps.files.has(`${OUT}.r2.md`)).toBe(false);
  });

  it("removes the manifest + fanout aggregate scratch files on a both-skip", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        const manifest = JSON.parse(deps.files.get(input.manifestPath)!);
        return {
          entries: manifest.map((m: { task: string; model: string }) => ({
            task: m.task,
            model: m.model,
            ran: false,
            skipReason: "agy-not-found",
          })),
          anyRan: false,
          allSkipped: true,
        } as FanoutAggregate;
      },
    });
    run([...BASE_ARGV, "--depth", "deep"], deps);
    expect(deps.files.has(`${OUT}.fanout-manifest.json`)).toBe(false);
    expect(deps.files.has(`${OUT}.fanout.json`)).toBe(false);
  });

  it("removes scratch on a throw path (manifest write fails)", () => {
    const deps = makeDeps({
      writeFile: (p, c) => {
        if (p === `${OUT}.fanout-manifest.json`) throw new Error("ENOSPC");
        deps.calls.writes.push({ path: p, contents: c });
        deps.files.set(p, c);
      },
    });
    expect(() => run([...BASE_ARGV, "--depth", "deep"], deps)).not.toThrow();
    expect(envelope(deps).skipReason).toBe("plan-prep-failed");
    expect(deps.files.has(`${OUT}.fanout-manifest.json`)).toBe(false);
    expect(deps.files.has(`${OUT}.prompt`)).toBe(false);
  });
});

describe("run — deep tier degrade branches (untested seams)", () => {
  it("degrades a ran:true reviewer whose artifact is unreadable to plan-output-unreadable", () => {
    const deps = makeDeps({
      runFanout: (input) => {
        const manifest = JSON.parse(deps.files.get(input.manifestPath)!);
        // Reviewer 1's artifact is seeded and readable; reviewer 2's
        // reported artifactPath is never written, so readFile throws.
        const artifactPath0 = `${input.outPath}.artifact.0.md`;
        deps.files.set(
          artifactPath0,
          "Reviewer one prose, verbatim: judged against the stated goal, this structurally different alternative holds up well.",
        );
        return {
          entries: [
            {
              task: manifest[0].task,
              model: manifest[0].model,
              ran: true,
              artifactPath: artifactPath0,
            },
            {
              task: manifest[1].task,
              model: manifest[1].model,
              ran: true,
              artifactPath: "/nope.md",
            },
          ],
          anyRan: true,
          allSkipped: false,
        } as FanoutAggregate;
      },
    });
    expect(run([...BASE_ARGV, "--depth", "deep"], deps)).toBe(0);
    const env = envelope(deps);
    expect(env.ran).toBe(true);
    expect(env.reviewers).toEqual([
      { model: MODEL_1, ran: true, lensesEngaged: 2 },
      {
        model: MODEL_2,
        ran: false,
        skipReason: "plan-output-unreadable",
        // resolveReviewer names the artifact path it FAILED to read too —
        // "unreadable" is still a diagnostic, not a reason to omit it.
        partialArtifactPath: "/nope.md",
      },
    ]);
    expect(deps.files.get(OUT)).toBe(
      "Reviewer one prose, verbatim: judged against the stated goal, this structurally different alternative holds up well.",
    );
  });

  it("treats an entry-less/malformed fanout aggregate as a both-skip (agy-not-found)", () => {
    const deps = makeDeps({
      runFanout: () => ({ allSkipped: true }) as FanoutAggregate,
    });
    expect(run([...BASE_ARGV, "--depth", "deep"], deps)).toBe(0);
    expect(envelope(deps)).toEqual({ ran: false, skipReason: "agy-not-found" });
    expect(deps.files.has(OUT)).toBe(false);
  });
});

// --- Hash widening: **Goal:** line + Decision analysis + Cut list -----------

describe("computeDecisionHash — widened content key", () => {
  // Ordered per the shipped contract (templates/prd-template.md /
  // discovery-instructions.md §8): Decision analysis -> Recommendation ->
  // Plan risks -> Cut list -> the h1 `# Task breakdown`. `## Cut list`
  // BEFORE `## Recommendation` (the prior fixture's ordering) never occurs
  // in a real plan.md and hid the extractCutListBody h1-termination bug.
  const BASE_HASH_PLAN = [
    "# PRD",
    "**Goal:** Ship CSV export quickly.",
    "## Decision analysis",
    "**Decision A** verdict X.",
    "## Recommendation",
    "go",
    "## Plan risks",
    "the format may not match expectations.",
    "## Cut list",
    "nothing — plan is minimal.",
  ].join("\n");

  it("editing only the Goal line changes the hash (re-fires)", () => {
    const changed = BASE_HASH_PLAN.replace(
      "Ship CSV export quickly.",
      "Ship CSV export FAST.",
    );
    expect(computeDecisionHash(changed)).not.toBe(
      computeDecisionHash(BASE_HASH_PLAN),
    );
  });

  it("editing only the Cut list changes the hash (re-fires)", () => {
    const changed = BASE_HASH_PLAN.replace(
      "nothing — plan is minimal.",
      "drop the legacy exporter.",
    );
    expect(computeDecisionHash(changed)).not.toBe(
      computeDecisionHash(BASE_HASH_PLAN),
    );
  });

  it("a Task-breakdown-only edit does NOT change the hash", () => {
    const changed =
      BASE_HASH_PLAN + "\n\n# Task breakdown\n\n### Task 1: do a thing\n";
    expect(computeDecisionHash(changed)).toBe(
      computeDecisionHash(BASE_HASH_PLAN),
    );
  });

  // Deliberately lint-violating fixture: `## Decision analysis` is
  // IMMEDIATELY followed by the h1 `# Task breakdown` with no intervening
  // `## ` heading. BASE_HASH_PLAN can't exercise the widened `/^#{1,2} /`
  // terminator because its own `## Recommendation` heading terminates the
  // scan first — this fixture is the one the widening actually fixes.
  const MALFORMED_PLAN = [
    "# PRD",
    "**Goal:** Ship CSV export quickly.",
    "## Decision analysis",
    "**Decision A** verdict X.",
    "# Task breakdown",
    "### Task 1: do a thing",
  ].join("\n");

  it("on a malformed plan (no '## ' between Decision analysis and the next h1), a Task-breakdown-only edit does NOT change the hash", () => {
    const changed = MALFORMED_PLAN + "\n\n### Task 2: do another thing\n";
    expect(computeDecisionHash(changed)).toBe(
      computeDecisionHash(MALFORMED_PLAN),
    );
  });

  it("extractDecisionAnalysisBody(BASE_HASH_PLAN) is unchanged by the terminator widening", () => {
    expect(extractDecisionAnalysisBody(BASE_HASH_PLAN)).toBe(
      "**Decision A** verdict X.",
    );
  });

  it("keeps '### D1'/'### D2' subsections in the extracted body while excluding '### Cross-model review (AGY)'", () => {
    const plan = [
      "# PRD",
      "**Goal:** Ship CSV export quickly.",
      "## Decision analysis",
      "### D1 — format",
      "CSV chosen over JSON.",
      "### D2 — pagination",
      "Cursor-based.",
      "### Cross-model review (AGY)",
      "Gemini agrees.",
      "## Recommendation",
      "go",
    ].join("\n");
    const body = extractDecisionAnalysisBody(plan);
    expect(body).toContain("### D1 — format");
    expect(body).toContain("### D2 — pagination");
    expect(body).not.toContain("### Cross-model review (AGY)");
  });
});

describe("godurToSec", () => {
  it("parses minutes, seconds, and combined durations", () => {
    expect(godurToSec("3m")).toBe(180);
    expect(godurToSec("15m")).toBe(900);
    expect(godurToSec("90s")).toBe(90);
    expect(godurToSec("2m30s")).toBe(150);
  });

  it("throws on an unparseable duration", () => {
    expect(() => godurToSec("")).toThrow();
    expect(() => godurToSec("nope")).toThrow();
  });

  // godurToSec is re-exported from ./lib/delegate-timeouts.ts (Task 2's
  // single-owner move) whose grammar is wider than this module's old
  // m/s-only regex — "3h" now parses instead of throwing. Deliberate
  // widening, not a behaviour change for the m/s inputs this module's own
  // call sites (REVIEWER_1_TIMEOUT/REVIEWER_2_TIMEOUT) feed it.
  it("parses hour units now that godurToSec is the wider-grammar lib owner", () => {
    expect(godurToSec("3h")).toBe(10800);
  });
});

describe("maxElapsedSec", () => {
  it("derives the deep-tier cap from REVIEWER_1_TIMEOUT + REVIEWER_2_TIMEOUT + slack", () => {
    // 3m (180) + 15m (900) + 300s slack = 1380s (23m).
    expect(maxElapsedSec("deep")).toBe(1380);
  });

  it("derives the standard-tier cap from REVIEWER_1_TIMEOUT + slack only", () => {
    // 3m (180) + 300s slack = 480s (8m).
    expect(maxElapsedSec("standard")).toBe(480);
  });
});

describe("mapReviewerSkipReason", () => {
  it("maps flow-delegate's agy-timeout to this module's reviewer-timeout", () => {
    expect(mapReviewerSkipReason("agy-timeout")).toBe("reviewer-timeout");
  });

  it("passes every other skipReason through unchanged", () => {
    expect(mapReviewerSkipReason("agy-error")).toBe("agy-error");
    expect(mapReviewerSkipReason("agy-not-authenticated")).toBe(
      "agy-not-authenticated",
    );
  });

  it("defaults an absent skipReason to agy-not-found (today's default)", () => {
    expect(mapReviewerSkipReason(undefined)).toBe("agy-not-found");
  });
});

describe("run --start", () => {
  const START_ARGV = [
    "--start",
    "--plan-file",
    PLAN_FILE,
    "--out",
    OUT,
    "--worktree",
    WORKTREE,
  ];

  it("emits today's byte-identical skip envelope and spawns nothing when the config gate is off", () => {
    const deps = makeDeps({ readConfig: () => JSON.stringify({}) });
    expect(run(START_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "plan-review-disabled",
    });
    expect(deps.calls.spawnDetached).toHaveLength(0);
  });

  it("emits plan-unreadable and spawns nothing when the plan file cannot be read", () => {
    const deps = makeDeps();
    deps.files.delete(PLAN_FILE);
    expect(run(START_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "plan-unreadable",
    });
    expect(deps.calls.spawnDetached).toHaveLength(0);
  });

  it("emits no-decision-analysis and spawns nothing when the plan has no Decision analysis section", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_NO_SECTION);
    expect(run(START_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "no-decision-analysis",
    });
    expect(deps.calls.spawnDetached).toHaveLength(0);
  });

  it("emits decision-analysis-unchanged and spawns nothing when the hash marker matches", () => {
    const deps = makeDeps();
    const hash = computeDecisionHash(PLAN_WITH_SECTION);
    deps.files.set(
      PLAN_FILE,
      `${PLAN_WITH_SECTION}\n<!-- flow-plan-review-hash: ${hash} -->\n`,
    );
    expect(run(START_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "decision-analysis-unchanged",
    });
    expect(deps.calls.spawnDetached).toHaveLength(0);
  });

  it("emits worktree-not-provided and spawns nothing when --worktree is omitted", () => {
    const deps = makeDeps();
    expect(run(["--start", "--plan-file", PLAN_FILE, "--out", OUT], deps)).toBe(
      0,
    );
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "worktree-not-provided",
    });
    expect(deps.calls.spawnDetached).toHaveLength(0);
  });

  it("emits worktree-not-found and spawns nothing when --worktree is not a directory", () => {
    const deps = makeDeps({ dirExists: () => false });
    expect(run(START_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "worktree-not-found",
    });
    expect(deps.calls.spawnDetached).toHaveLength(0);
  });

  it("detaches a worker and writes a planReview state record on a gate-passing plan with no prior record", () => {
    const deps = makeDeps();
    expect(run(START_ARGV, deps)).toBe(0);
    expect(deps.calls.spawnDetached).toHaveLength(1);
    const argv = deps.calls.spawnDetached[0]!;
    expect(argv[0]).toBe("flow-spawn");
    expect(argv).toContain("--detach");
    expect(argv).toContain("--stdout");
    expect(argv).toContain("--stderr");
    expect(argv).toContain("flow-plan-review");
    expect(argv).toContain("--result-file");
    const env = envelope(deps);
    expect(env.status).toBe("started");
    expect(env.reattached).toBe(false);
    expect(env.pid).toBe(4242);
    expect(env.depth).toBe("standard");
    expect(env.resultPath).toBe(`${OUT}.run.json`);
    expect(deps.stateRecords.get("test-slug")).toMatchObject({
      planFile: PLAN_FILE,
      pid: 4242,
      resultPath: `${OUT}.run.json`,
    });
  });

  it("re-attaches to a live matching cycle instead of spawning a second worker", () => {
    const deps = makeDeps({ isAlive: (pid) => pid === 999 });
    const decisionHash = computeDecisionHash(PLAN_WITH_SECTION);
    deps.stateRecords.set("test-slug", {
      planFile: PLAN_FILE,
      decisionHash,
      depth: "standard",
      startedAt: "2026-08-26T23:00:00.000Z",
      pid: 999,
      startEpoch: 1000,
      resultPath: `${OUT}.run.json`,
      stderrPath: `${OUT}.worker-stderr.log`,
      lastObservedAt: null,
      checks: 0,
    });
    expect(run(START_ARGV, deps)).toBe(0);
    expect(deps.calls.spawnDetached).toHaveLength(0);
    expect(deps.calls.killed).toHaveLength(0);
    const env = envelope(deps);
    expect(env).toEqual({
      status: "started",
      reattached: true,
      pid: 999,
      depth: "standard",
      resultPath: `${OUT}.run.json`,
    });
  });

  it("kills a stale non-matching (plan-revision) worker BEFORE spawning its replacement", () => {
    const deps = makeDeps({
      isAlive: (pid) => pid === 777,
    });
    deps.stateRecords.set("test-slug", {
      planFile: PLAN_FILE,
      decisionHash: "stale-hash-from-a-prior-revision",
      depth: "standard",
      startedAt: "2026-08-26T23:00:00.000Z",
      pid: 777,
      startEpoch: 500,
      resultPath: `${OUT}.run.json`,
      stderrPath: `${OUT}.worker-stderr.log`,
      lastObservedAt: null,
      checks: 0,
    });
    deps.files.set(`${OUT}.run.json`, "stale content");
    expect(run(START_ARGV, deps)).toBe(0);
    expect(deps.calls.killed).toEqual([777]);
    // The stale worker's scratch is cleared before the fresh spawn.
    expect(deps.files.has(`${OUT}.run.json`)).toBe(false);
    expect(deps.calls.spawnDetached).toHaveLength(1);
    const env = envelope(deps);
    expect(env.status).toBe("started");
    expect(env.reattached).toBe(false);
  });

  it("spawns a fresh worker (no kill) when the prior record's worker is already dead", () => {
    const deps = makeDeps({ isAlive: () => false });
    deps.stateRecords.set("test-slug", {
      planFile: PLAN_FILE,
      decisionHash: "some-other-hash",
      depth: "standard",
      startedAt: "2026-08-26T23:00:00.000Z",
      pid: 111,
      startEpoch: 500,
      resultPath: `${OUT}.run.json`,
      stderrPath: `${OUT}.worker-stderr.log`,
      lastObservedAt: null,
      checks: 0,
    });
    expect(run(START_ARGV, deps)).toBe(0);
    expect(deps.calls.killed).toHaveLength(0);
    expect(deps.calls.spawnDetached).toHaveLength(1);
  });
});

describe("run --check", () => {
  const CHECK_ARGV = ["--check", "--out", OUT];

  it("emits decided/plan-review-not-started when no planReview record exists", () => {
    const deps = makeDeps();
    expect(run(CHECK_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      status: "decided",
      ran: false,
      skipReason: "plan-review-not-started",
    });
  });

  function seedRecord(deps: ReturnType<typeof makeDeps>, overrides = {}) {
    deps.stateRecords.set("test-slug", {
      planFile: PLAN_FILE,
      decisionHash: "hash",
      depth: "standard",
      startedAt: "2026-08-26T23:00:00.000Z",
      pid: 4242,
      startEpoch: 1000,
      resultPath: `${OUT}.run.json`,
      stderrPath: `${OUT}.worker-stderr.log`,
      lastObservedAt: null,
      checks: 0,
      ...overrides,
    });
  }

  it("emits decided with the wrapped result envelope and kills a still-alive worker once the result file lands", () => {
    const deps = makeDeps({ isAlive: () => true });
    seedRecord(deps);
    deps.files.set(
      `${OUT}.run.json`,
      JSON.stringify({ ran: true, feedbackPath: OUT, depth: "standard" }),
    );
    expect(run(CHECK_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      status: "decided",
      ran: true,
      feedbackPath: OUT,
      depth: "standard",
    });
    expect(deps.calls.killed).toEqual([4242]);
  });

  it("emits waiting (suspension-immune: elapsedSec derives from startedAt, not process age) while the worker is alive", () => {
    const deps = makeDeps({
      isAlive: () => true,
      now: () => new Date("2026-08-26T23:05:00.000Z"),
    });
    seedRecord(deps);
    expect(run(CHECK_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      status: "waiting",
      nextCheckSec: 60,
      elapsedSec: 300,
      pid: 4242,
    });
  });

  it("treats a torn/partial result-file read as still-waiting for one cycle, not a terminal verdict", () => {
    const deps = makeDeps({
      isAlive: () => true,
      now: () => new Date("2026-08-26T23:01:00.000Z"),
    });
    seedRecord(deps);
    deps.files.set(`${OUT}.run.json`, "{not valid json");
    expect(run(CHECK_ARGV, deps)).toBe(0);
    const env = envelope(deps);
    expect(env.status).toBe("waiting");
  });

  // The derived cap reclaims a worker past its budget in BOTH liveness
  // states. Q9 specifies that on expiry --check "emits decided with
  // skipReason review-timed-out and kills the worker" — killing only means
  // anything for a LIVE worker, so an alive-but-hung one (agy's own
  // --print-timeout failing to land on a wedged child) must be reclaimed
  // here rather than reporting `waiting` forever. Within the cap, liveness
  // still discriminates: alive => waiting, dead => reviewer-worker-died.
  it("emits decided/review-timed-out and kills the worker once a DEAD worker's elapsed exceeds the derived cap", () => {
    const deps = makeDeps({
      isAlive: () => false,
      now: () => new Date("2026-08-27T00:00:00.000Z"), // 3600s elapsed
    });
    seedRecord(deps, { depth: "standard" }); // cap = 480s
    expect(run(CHECK_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      status: "decided",
      ran: false,
      skipReason: "review-timed-out",
    });
    expect(deps.calls.killed).toEqual([4242]);
  });

  it("emits decided/review-timed-out and kills the worker once a LIVE but hung worker's elapsed exceeds the derived cap", () => {
    const deps = makeDeps({
      isAlive: () => true,
      now: () => new Date("2026-08-27T00:00:00.000Z"), // 3600s elapsed
    });
    seedRecord(deps, { depth: "standard" }); // cap = 480s
    expect(run(CHECK_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      status: "decided",
      ran: false,
      skipReason: "review-timed-out",
    });
    expect(deps.calls.killed).toEqual([4242]);
  });

  it("keeps reporting waiting for a LIVE worker still inside the derived cap", () => {
    const deps = makeDeps({
      isAlive: () => true,
      now: () => new Date("2026-08-26T23:00:10.000Z"), // 10s elapsed, cap 480s
    });
    seedRecord(deps, { depth: "standard" });
    expect(run(CHECK_ARGV, deps)).toBe(0);
    expect(envelope(deps).status).toBe("waiting");
    expect(deps.calls.killed).toEqual([]);
  });

  it("emits decided/reviewer-worker-died when the worker is dead within the cap and no result file exists", () => {
    const deps = makeDeps({
      isAlive: () => false,
      now: () => new Date("2026-08-26T23:00:10.000Z"), // 10s elapsed
    });
    seedRecord(deps);
    expect(run(CHECK_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      status: "decided",
      ran: false,
      skipReason: "reviewer-worker-died",
    });
  });

  it("degrades to stateless mode absent FLOW_SLUG: never fires the wall-clock cap", () => {
    const deps = makeDeps({
      env: {},
      isAlive: () => false,
    });
    // No record can be read in stateless mode (readStateRecord is never
    // consulted), so this always reports plan-review-not-started — the
    // safe-by-construction degradation, never a fabricated timeout.
    expect(run(CHECK_ARGV, deps)).toBe(0);
    expect(envelope(deps)).toEqual({
      status: "decided",
      ran: false,
      skipReason: "plan-review-not-started",
    });
  });
});
