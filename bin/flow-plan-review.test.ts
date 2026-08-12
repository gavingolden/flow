import { describe, expect, it, vi } from "vitest";
import {
  computeDecisionHash,
  computeDepth,
  extractDecisionAnalysisBody,
  extractGoalLine,
  hasDecisionAnalysis,
  isPlanReviewEnabled,
  normalizeDecisionBody,
  parseArgs,
  readPriorHash,
  run,
  type DelegateEnvelope,
  type Deps,
  type FanoutAggregate,
} from "./flow-plan-review";

const MODEL_1 = "Gemini 3.1 Pro (High)";
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
  };
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
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
    mkdirp: () => {},
    writeOut: (line) => calls.out.push(line),
    dirExists: () => true,
  };
  // Seed the plan file the helper reads (with the gate section present).
  files.set(PLAN_FILE, PLAN_WITH_SECTION);
  return Object.assign(base, overrides, { calls, files });
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
          model: "Gemini 3.1 Pro (High)",
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

  it("passes the hardcoded Gemini model and the worktree as --add-dir, with an 8m --timeout, to the delegate", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("Gemini 3.1 Pro (High)");
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(WORKTREE);
    expect(argv[argv.indexOf("--task") + 1]).toBe("plan-review");
    expect(argv[argv.indexOf("--timeout") + 1]).toBe("8m");
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

  it("no longer carries the removed 'Do NOT trace code paths you cannot see' instruction", () => {
    const deps = makeDeps();
    deps.files.set(PLAN_FILE, PLAN_WITH_GOAL);
    run(BASE_ARGV, deps);
    expect(promptFor(deps)).not.toContain(
      "Do NOT trace code paths you cannot see",
    );
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

  it("hands reviewer 2 its OWN same-family-aware prompt file, distinct from reviewer 1's, both with an 8m timeout", () => {
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
    expect(manifest[0].timeout).toBe("8m");
    expect(manifest[1].timeout).toBe("8m");

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
  });

  it("pins --concurrency 2 on the fanout call so both reviewers dispatch in one wave", () => {
    const deps = makeDeps();
    run([...BASE_ARGV, "--depth", "deep"], deps);
    expect(deps.calls.fanout[0]?.concurrency).toBe(2);
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
      },
    ]);
    expect(deps.files.get(OUT)).toBe(AGY_PROSE);
    expect(deps.files.get(OUT)).not.toContain("Convergence rule");
  });

  it("both demoted yields {ran:false, skipReason:'reviewer-empty'} carrying NO depth and NO reviewers fields", () => {
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
    expect(envelope(deps)).toEqual({
      ran: false,
      skipReason: "reviewer-empty",
    });
    expect(deps.files.has(OUT)).toBe(false);
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
      { model: MODEL_2, ran: false, skipReason: "plan-output-unreadable" },
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
