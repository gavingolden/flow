import { describe, expect, it, vi } from "vitest";
import {
  computeDecisionHash,
  extractDecisionAnalysisBody,
  hasDecisionAnalysis,
  isPlanReviewEnabled,
  normalizeDecisionBody,
  parseArgs,
  readPriorHash,
  run,
  type DelegateEnvelope,
  type Deps,
} from "./flow-plan-review";

const AGY_PROSE =
  "Decision A — supervisor vs subagent: the supervisor branch dominates because it owns the gate. Pre-mortem: if agy is flaky the review silently skips, which is acceptable.";

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
const BASE_ARGV = ["--plan-file", PLAN_FILE, "--out", OUT];

function makeDeps(overrides: Partial<Deps> = {}): Deps & {
  calls: {
    delegate: string[][];
    writes: Array<{ path: string; contents: string }>;
    removed: string[];
    out: string[];
  };
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const calls = {
    delegate: [] as string[][],
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
  };
  // Seed the plan file the helper reads (with the gate section present).
  files.set(PLAN_FILE, PLAN_WITH_SECTION);
  return Object.assign(base, overrides, { calls, files });
}

const envelope = (deps: { calls: { out: string[] } }) =>
  JSON.parse(deps.calls.out[0] as string);

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
    expect(envelope(deps)).toEqual({
      ran: true,
      feedbackPath: OUT,
      skipReason: null,
    });
    // The finalized feedback file holds AGY's raw prose verbatim.
    expect(deps.files.get(OUT)).toBe(AGY_PROSE);
    // Scratch is cleaned up.
    expect(deps.files.has(`${OUT}.prompt`)).toBe(false);
    expect(deps.files.has(`${OUT}.agy-raw`)).toBe(false);
  });

  it("passes the hardcoded Gemini model and --plan-file dir as --add-dir to the delegate", () => {
    const deps = makeDeps();
    run(BASE_ARGV, deps);
    const argv = deps.calls.delegate[0]!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("Gemini 3.1 Pro (High)");
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe("/wt/.flow-tmp");
    expect(argv[argv.indexOf("--task") + 1]).toBe("plan-review");
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
