import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./flow-review-prep";
import {
  runReviewPrep,
  type ExecResult,
  type ReviewPrep,
} from "./lib/review-prep";

let worktree!: string;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), "flow-review-prep-test-"));
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

const OK = { stderr: "", exitCode: 0 } as const;

function reviewScopeJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    started_at: "2026-01-01T00:00:00.000Z",
    scope: "full",
    reason: "no prior marker",
    base_sha: null,
    head_sha: "deadbeef",
    pr_files: ["a.ts"],
    delta_files: [],
    delta_ratio: null,
    gates: {
      "bug-detection": { run: true, reason: "always-on lens" },
      security: { run: false, reason: "docs-only diff (1 files)" },
    },
    gates_enabled: true,
    delta_enabled: true,
    forced_full: false,
    ...extra,
  });
}

/** Injectable-subprocess fake: never touches real gh/network. Pattern-matches
 * on argv[0] and, for `flow-review-scope`, simulates its file-writing side
 * effect (the real binary writes `review-scope.json` itself). */
function makeExec(
  opts: {
    metaAdditions?: number;
    metaDeletions?: number;
    metaChangedFiles?: number;
    failFetch?: boolean;
    failIntent?: boolean;
    reviewScopeExtra?: Record<string, unknown>;
    staticAnalysisStderr?: string;
  } = {},
) {
  return (argv: string[]): ExecResult => {
    const [cmd] = argv;
    if (cmd === "flow-fetch-pr-review") {
      if (opts.failFetch) {
        return { stdout: "", stderr: "gh: PR not found", exitCode: 1 };
      }
      return { stdout: "# PR #1: title\n", ...OK };
    }
    if (cmd === "gh" && argv.includes("commits")) {
      return { stdout: "abc1234 fix: thing\nbody\n---\n", ...OK };
    }
    if (cmd === "gh") {
      return {
        stdout: JSON.stringify({
          state: "OPEN",
          isDraft: false,
          additions: opts.metaAdditions ?? 10,
          deletions: opts.metaDeletions ?? 5,
          changedFiles: opts.metaChangedFiles ?? 2,
        }),
        ...OK,
      };
    }
    if (cmd === "flow-pr-static-analysis") {
      return {
        stdout: JSON.stringify({ security: [], meta: {} }),
        stderr: opts.staticAnalysisStderr ?? "",
        exitCode: 0,
      };
    }
    if (cmd === "flow-review-scope") {
      fs.mkdirSync(path.join(worktree, ".flow-tmp"), { recursive: true });
      fs.writeFileSync(
        path.join(worktree, ".flow-tmp", "review-scope.json"),
        reviewScopeJson(opts.reviewScopeExtra),
      );
      return { stdout: "", ...OK };
    }
    if (cmd === "flow-fetch-intent-comments") {
      if (opts.failIntent) {
        return { stdout: "", stderr: "network error", exitCode: 1 };
      }
      return { stdout: "(none — author posted no intent annotations)", ...OK };
    }
    throw new Error(`unexpected exec call: ${argv.join(" ")}`);
  };
}

describe("runReviewPrep", () => {
  it("happy path returns every documented field and writes each payload under .flow-tmp", async () => {
    const prep = await runReviewPrep({ pr: 42, worktree, exec: makeExec() });

    expect(prep.pr).toBe(42);
    expect(prep.state).toBe("OPEN");
    expect(prep.draft).toBe(false);
    expect(prep.additions).toBe(10);
    expect(prep.deletions).toBe(5);
    expect(prep.changed_files).toBe(2);
    expect(prep.size_band).toBe("small");
    expect(prep.scope).toBe("full");
    expect(prep.gated_lenses).toEqual(["security"]);
    expect(prep.delta_files).toEqual([]);
    expect(prep.prompt_interpretation_tension).toBe(false);
    expect(prep.completeness).toBe("full");
    expect(prep.critical_skips).toEqual([]);
    expect(prep.skips).toEqual([]);
    expect(prep.notices).toEqual([]);
    expect(prep.tier).toBeUndefined();
    expect(prep.tier_reasons).toBeUndefined();

    for (const p of Object.values(prep.paths)) {
      if (p === prep.paths.diff) continue; // diff.txt is flow-review-scope's own output, not written by this fake
      expect(fs.existsSync(p)).toBe(true);
    }
  });

  it("defaults prompt_interpretation_tension to false when gatekeeper-result.json is absent", async () => {
    const prep = await runReviewPrep({ pr: 1, worktree, exec: makeExec() });
    expect(prep.prompt_interpretation_tension).toBe(false);
  });

  it("reads prompt_interpretation_tension from gatekeeper-result.json when present", async () => {
    fs.mkdirSync(path.join(worktree, ".flow-tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, ".flow-tmp", "gatekeeper-result.json"),
      JSON.stringify({ prompt_interpretation_tension: true }),
    );
    const prep = await runReviewPrep({ pr: 1, worktree, exec: makeExec() });
    expect(prep.prompt_interpretation_tension).toBe(true);
  });

  it("a non-critical sub-step failure (intent comments) yields completeness=partial with an EMPTY critical_skips", async () => {
    const prep = await runReviewPrep({
      pr: 1,
      worktree,
      exec: makeExec({ failIntent: true }),
    });
    expect(prep.completeness).toBe("partial");
    expect(prep.critical_skips).toEqual([]);
    expect(prep.skips).toEqual([
      { step: "intent_comments", reason: "network error", critical: false },
    ]);
  });

  it("a critical sub-step failure (the PR fetch) populates critical_skips", async () => {
    const prep = await runReviewPrep({
      pr: 1,
      worktree,
      exec: makeExec({ failFetch: true }),
    });
    expect(prep.completeness).toBe("partial");
    expect(prep.critical_skips).toEqual(["fetch"]);
    expect(prep.state).toBe("");
    expect(prep.additions).toBe(0);
  });

  describe("size_band boundaries", () => {
    it.each([
      [399, "small"],
      [400, "large"],
      [999, "large"],
      [1000, "very-large"],
    ] as const)("%i total lines -> %s", async (total, band) => {
      const additions = Math.floor(total / 2);
      const deletions = total - additions;
      const prep = await runReviewPrep({
        pr: 1,
        worktree,
        exec: makeExec({ metaAdditions: additions, metaDeletions: deletions }),
      });
      expect(prep.size_band).toBe(band);
    });
  });

  it("copies tier and tier_reasons through when review-scope.json carries them", async () => {
    const prep = await runReviewPrep({
      pr: 1,
      worktree,
      exec: makeExec({
        reviewScopeExtra: { tier: "standard", tier_reasons: ["small diff"] },
      }),
    });
    expect(prep.tier).toBe("standard");
    expect(prep.tier_reasons).toEqual(["small diff"]);
  });

  it("omits tier and tier_reasons (no key at all) when review-scope.json does not carry them", async () => {
    const prep = await runReviewPrep({ pr: 1, worktree, exec: makeExec() });
    expect("tier" in prep).toBe(false);
    expect("tier_reasons" in prep).toBe(false);
  });

  it("captures flow-pr-static-analysis stdout only — stderr progress lines never merge into the saved payload", async () => {
    const prep = await runReviewPrep({
      pr: 1,
      worktree,
      exec: makeExec({
        staticAnalysisStderr: "progress: running semgrep...\n",
      }),
    });
    const raw = fs.readFileSync(prep.paths.static_analysis, "utf8");
    expect(raw).toBe(JSON.stringify({ security: [], meta: {} }));
    expect(raw).not.toContain("progress:");
  });

  it("a critical review_scope failure populates critical_skips and leaves scope/gated_lenses at safe defaults", async () => {
    const exec: (argv: string[]) => ExecResult = (argv) => {
      if (argv[0] === "flow-review-scope") {
        return { stdout: "", stderr: "git rev-parse HEAD failed", exitCode: 1 };
      }
      return makeExec()(argv);
    };
    const prep = await runReviewPrep({ pr: 1, worktree, exec });
    expect(prep.critical_skips).toEqual(["review_scope"]);
    expect(prep.scope).toBe("full");
    expect(prep.gated_lenses).toEqual([]);
    expect(prep.delta_files).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("requires --pr and --worktree", () => {
    expect(parseArgs([])).toEqual({ error: "--pr is required" });
    expect(parseArgs(["--pr", "1"])).toEqual({
      error: "--worktree is required",
    });
  });

  it("rejects a non-numeric --pr", () => {
    expect(parseArgs(["--pr", "abc", "--worktree", "/tmp/x"])).toEqual({
      error: "invalid --pr value: abc",
    });
  });

  it("accepts --pr, --worktree, and an optional --out", () => {
    expect(
      parseArgs(["--pr", "7", "--worktree", "/tmp/wt", "--out", "/tmp/o.json"]),
    ).toEqual({
      pr: 7,
      worktree: "/tmp/wt",
      out: "/tmp/o.json",
    });
  });

  it("rejects an unknown flag", () => {
    expect(parseArgs(["--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });
});

describe("run()", () => {
  const stubPrep: ReviewPrep = {
    pr: 7,
    state: "OPEN",
    draft: false,
    additions: 1,
    deletions: 1,
    changed_files: 1,
    size_band: "small",
    scope: "full",
    gated_lenses: [],
    delta_files: [],
    prompt_interpretation_tension: false,
    completeness: "full",
    critical_skips: [],
    paths: {
      fetch: "",
      commits: "",
      static_analysis: "",
      review_scope: "",
      diff: "",
      intent_comments: "",
    },
    notices: [],
    skips: [],
  };

  it("bad arguments exit 2 without invoking reviewPrep", async () => {
    let called = false;
    const code = await run(["--pr", "abc"], async () => {
      called = true;
      return stubPrep;
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  it("prints the envelope on stdout, writes --out, and exits 0", async () => {
    const outPath = path.join(worktree, "custom-out.json");
    const logSpy = console.log;
    const lines: string[] = [];
    console.log = (s: string) => lines.push(s);
    try {
      const code = await run(
        ["--pr", "7", "--worktree", worktree, "--out", outPath],
        async () => stubPrep,
      );
      expect(code).toBe(0);
      expect(lines.join("")).toBe(JSON.stringify(stubPrep));
    } finally {
      console.log = logSpy;
    }
    expect(fs.readFileSync(outPath, "utf8")).toBe(JSON.stringify(stubPrep));
  });

  it("defaults --out to <worktree>/.flow-tmp/review-prep.json", async () => {
    const code = await run(
      ["--pr", "7", "--worktree", worktree],
      async () => stubPrep,
    );
    expect(code).toBe(0);
    const defaultOut = path.join(worktree, ".flow-tmp", "review-prep.json");
    expect(fs.readFileSync(defaultOut, "utf8")).toBe(JSON.stringify(stubPrep));
  });
});
