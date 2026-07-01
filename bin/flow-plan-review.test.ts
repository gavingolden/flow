import { describe, expect, it, vi } from "vitest";
import {
  hasDecisionAnalysis,
  isPlanReviewEnabled,
  parseArgs,
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

describe("run — happy path", () => {
  it("copies AGY raw prose to --out and reports ran:true with skipReason null", () => {
    const deps = makeDeps();
    expect(run(BASE_ARGV, deps)).toBe(0);
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

describe("run — usage errors", () => {
  it("returns 2 on a missing required flag", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run(["--plan-file", PLAN_FILE], makeDeps())).toBe(2);
    expect(run(["--out", OUT], makeDeps())).toBe(2);
    errSpy.mockRestore();
  });
});
