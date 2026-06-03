import { describe, expect, it, vi } from "vitest";
import {
  classifyByGlobs,
  resolveRequestDecision,
  run,
  type GlobClass,
} from "./flow-request-copilot";
import {
  DEFAULT_ALWAYS_REVIEW_GLOBS,
  DEFAULT_NEVER_ALONE_GLOBS,
  type CopilotGlobs,
  type ReadConfigFile,
} from "./lib/copilot-config";
import type { GhRunner } from "./flow-ci-wait";

const GLOBS: CopilotGlobs = {
  alwaysReview: DEFAULT_ALWAYS_REVIEW_GLOBS,
  neverAlone: DEFAULT_NEVER_ALONE_GLOBS,
};

// ---------------------------------------------------------------------------
// classifyByGlobs precedence table
// ---------------------------------------------------------------------------

describe("classifyByGlobs", () => {
  it("always-review beats never-alone when both match", () => {
    // One auth path (always-review) + one snapshot (never-alone) → always wins.
    expect(classifyByGlobs(["src/lib/auth/x.ts", "a.snap"], GLOBS)).toBe("always-review");
  });

  it("all paths matching neverAlone → never-alone", () => {
    expect(classifyByGlobs(["package-lock.json", "docs/guide/intro.md"], GLOBS)).toBe("never-alone");
  });

  it("one path outside all sets → ambiguous", () => {
    expect(classifyByGlobs(["package-lock.json", "src/feature.ts"], GLOBS)).toBe("ambiguous");
  });

  it("empty paths → never-alone (locked default)", () => {
    expect(classifyByGlobs([], GLOBS)).toBe("never-alone");
  });

  it("**/auth/** matches a nested auth path", () => {
    expect(classifyByGlobs(["src/lib/auth/session.ts"], GLOBS)).toBe("always-review");
  });

  it("**/*.snap matches a snapshot path", () => {
    expect(classifyByGlobs(["components/Button.snap"], GLOBS)).toBe("never-alone");
  });

  it("docs/**/*.md matches a nested docs markdown file", () => {
    expect(classifyByGlobs(["docs/guide/intro.md"], GLOBS)).toBe("never-alone");
  });

  it(".github/workflows/** stays in alwaysReview", () => {
    expect(classifyByGlobs([".github/workflows/ci.yml"], GLOBS)).toBe("always-review");
  });

  it("brace patterns behave (picomatch semantics)", () => {
    const globs: CopilotGlobs = {
      alwaysReview: ["src/{a,b}/**"],
      neverAlone: ["vendor/**"],
    };
    // brace: src/a/x.ts and src/b/y.ts match the always-review brace pattern.
    expect(classifyByGlobs(["src/a/x.ts"], globs)).toBe("always-review");
    expect(classifyByGlobs(["src/b/y.ts"], globs)).toBe("always-review");
    // a path outside the brace and not in neverAlone is ambiguous.
    expect(classifyByGlobs(["src/c/z.ts"], globs)).toBe("ambiguous");
    // a vendored path matches the neverAlone pattern.
    expect(classifyByGlobs(["vendor/lib.js"], globs)).toBe("never-alone");
  });

  it("extglob negation patterns behave (picomatch semantics)", () => {
    const globs: CopilotGlobs = {
      alwaysReview: ["!(src)/**"], // anything NOT under src/ is always-review
      neverAlone: ["docs/**"],
    };
    expect(classifyByGlobs(["infra/main.tf"], globs)).toBe("always-review");
    // src/ is excluded by the negation, and not in neverAlone → ambiguous.
    expect(classifyByGlobs(["src/x.ts"], globs)).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// resolveRequestDecision truth table (override × globClass × agentDecision)
// ---------------------------------------------------------------------------

describe("resolveRequestDecision", () => {
  const classes: GlobClass[] = ["always-review", "never-alone", "ambiguous"];

  it("override=always → true regardless of class", () => {
    for (const globClass of classes) {
      expect(resolveRequestDecision({ override: "always", globClass })).toBe(true);
    }
  });

  it("override=never → false regardless of class", () => {
    for (const globClass of classes) {
      expect(resolveRequestDecision({ override: "never", globClass })).toBe(false);
    }
  });

  it("auto + always-review → true", () => {
    expect(resolveRequestDecision({ override: "auto", globClass: "always-review" })).toBe(true);
  });

  it("auto + never-alone → false", () => {
    expect(resolveRequestDecision({ override: "auto", globClass: "never-alone" })).toBe(false);
  });

  it("auto + ambiguous + non-trivial → true", () => {
    expect(
      resolveRequestDecision({ override: "auto", globClass: "ambiguous", agentDecision: "non-trivial" }),
    ).toBe(true);
  });

  it("auto + ambiguous + trivial → false", () => {
    expect(
      resolveRequestDecision({ override: "auto", globClass: "ambiguous", agentDecision: "trivial" }),
    ).toBe(false);
  });

  it("auto + ambiguous + no decision → true (fail-open)", () => {
    expect(resolveRequestDecision({ override: "auto", globClass: "ambiguous" })).toBe(true);
  });

  it("undefined override behaves like auto", () => {
    expect(resolveRequestDecision({ globClass: "never-alone" })).toBe(false);
    expect(resolveRequestDecision({ globClass: "always-review" })).toBe(true);
    expect(resolveRequestDecision({ globClass: "ambiguous" })).toBe(true); // fail-open
  });
});

// ---------------------------------------------------------------------------
// CLI: --classify mode
// ---------------------------------------------------------------------------

const readConfig: ReadConfigFile = () => ({}); // → built-in default glob sets

function captureStdout() {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(s.toString());
    return true;
  });
  return { out, restore: () => spy.mockRestore() };
}

function captureStderr() {
  const err: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    err.push(s.toString());
    return true;
  });
  return { err, restore: () => spy.mockRestore() };
}

describe("--classify CLI", () => {
  it.each([
    [["src/lib/auth/x.ts"], "always-review"],
    [["package-lock.json"], "never-alone"],
    [["package-lock.json", "src/feature.ts"], "ambiguous"],
  ] as const)("prints %s → %s", async (paths, expected) => {
    const cap = captureStdout();
    const code = await run(["--classify"], { readConfig, stdinPaths: async () => [...paths] });
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out.join("").trim()).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// CLI: request mode — POST fires / suppresses / silent rejection / fail-open
// ---------------------------------------------------------------------------

// The request now fires via `gh pr edit <pr> --add-reviewer @copilot` (the
// gh-CLI native Copilot reviewer command), not the old requested_reviewers
// `gh api POST`. `isPost` is retained as the "did a request go out?" predicate.
const isPost = (argv: string[]) =>
  argv[0] === "pr" && argv[1] === "edit" && argv.includes("--add-reviewer");
const isReviewRequests = (argv: string[]) => argv[0] === "pr" && argv[1] === "view";
const isPrList = (argv: string[]) => argv[0] === "pr" && argv[1] === "list";

/**
 * `post` is the request exit code; `postStderr` the body returned on a
 * non-zero request exit (default ""). `queuedLogins` answers the queued
 * re-read. When `historicalReviews` is supplied, the stub answers `gh pr
 * list --state merged` (one merged PR) + `gh pr view --json
 * reviews,reviewRequests` so the Story-3 auto-review-already-on path
 * resolves; absent it, history is empty.
 */
function ghStub(responses: {
  post: number;
  queuedLogins: string[];
  postStderr?: string;
  historicalReviews?: string[];
}): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((argv: string[]) => {
    calls.push(argv);
    if (isPost(argv)) {
      return { stdout: "", stderr: responses.postStderr ?? "", exitCode: responses.post };
    }
    if (isPrList(argv)) {
      // fetchHistoricalBotReview: list of recent merged PRs.
      return {
        stdout: JSON.stringify(responses.historicalReviews ? [{ number: 7 }] : []),
        stderr: "",
        exitCode: 0,
      };
    }
    if (isReviewRequests(argv)) {
      const wantsReviews = argv.includes("reviews");
      return {
        stdout: JSON.stringify({
          reviews: wantsReviews
            ? (responses.historicalReviews ?? []).map((login) => ({ author: { login } }))
            : undefined,
          reviewRequests: responses.queuedLogins.map((login) => ({ login })),
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }) as GhRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe("request mode", () => {
  it("request branch fires the POST and reports queued when verified", async () => {
    const gh = ghStub({ post: 0, queuedLogins: ["copilot-pull-request-reviewer"] });
    const cap = captureStdout();
    const code = await run(["--pr", "42", "--override", "always"], {
      gh,
      readConfig,
      stdinPaths: async () => ["package-lock.json"],
    });
    cap.restore();
    expect(code).toBe(0);
    const verdict = JSON.parse(cap.out.join(""));
    expect(verdict.requestCopilot).toBe(true);
    expect(verdict.posted).toBe(true);
    expect(verdict.queued).toBe(true);
    expect(gh.calls.some(isPost)).toBe(true);
  });

  it("suppress branch fires nothing (override=never)", async () => {
    const gh = ghStub({ post: 0, queuedLogins: [] });
    const cap = captureStdout();
    const code = await run(["--pr", "42", "--override", "never"], {
      gh,
      readConfig,
      stdinPaths: async () => ["src/feature.ts"],
    });
    cap.restore();
    expect(code).toBe(0);
    const verdict = JSON.parse(cap.out.join(""));
    expect(verdict.requestCopilot).toBe(false);
    expect(verdict.posted).toBeUndefined();
    expect(gh.calls.length).toBe(0);
  });

  it("silent rejection: POST ok but login absent on re-read → queued:false + NOTICE to stderr", async () => {
    const gh = ghStub({ post: 0, queuedLogins: [] }); // POST ok, but not queued
    const cap = captureStdout();
    const errCap = captureStderr();
    const code = await run(["--pr", "42", "--override", "always"], {
      gh,
      readConfig,
      stdinPaths: async () => ["package-lock.json"],
    });
    cap.restore();
    errCap.restore();
    expect(code).toBe(0);
    const verdict = JSON.parse(cap.out.join(""));
    expect(verdict.posted).toBe(true);
    expect(verdict.queued).toBe(false);
    expect(errCap.err.join("")).toMatch(/silent rejection/);
  });

  it("fail-open on gh POST error: requestCopilot stays true, posted:false", async () => {
    const gh = ghStub({ post: 1, queuedLogins: [] }); // POST fails
    const cap = captureStdout();
    const errCap = captureStderr();
    const code = await run(["--pr", "42", "--override", "always"], {
      gh,
      readConfig,
      stdinPaths: async () => ["package-lock.json"],
    });
    cap.restore();
    errCap.restore();
    expect(code).toBe(0);
    const verdict = JSON.parse(cap.out.join(""));
    expect(verdict.requestCopilot).toBe(true);
    expect(verdict.posted).toBe(false);
    expect(verdict.queued).toBe(false);
    expect(errCap.err.join("")).toMatch(/NOTICE: Copilot request failed/);
  });

  it("422 not-a-requestable-collaborator → copilotRequestable:false, posted:false, exit 0, no NOTICE", async () => {
    const gh = ghStub({
      post: 1,
      queuedLogins: ["copilot-pull-request-reviewer"], // alreadyRequested → POST branch
      postStderr: "HTTP 422: Reviews may only be requested from collaborators that have access",
    });
    const cap = captureStdout();
    const errCap = captureStderr();
    const code = await run(["--pr", "42", "--override", "always"], {
      gh,
      readConfig,
      stdinPaths: async () => ["package-lock.json"],
    });
    cap.restore();
    errCap.restore();
    expect(code).toBe(0);
    const verdict = JSON.parse(cap.out.join(""));
    expect(verdict.copilotRequestable).toBe(false);
    expect(verdict.posted).toBe(false);
    expect(errCap.err.join("")).not.toMatch(/NOTICE:/);
  });

  it("auto-review-already-on → no POST, requestSkipReason set; control with no history still POSTs", async () => {
    // Auto-review on: empty reviewRequests + recent merged PR carries a Copilot review.
    const ghAuto = ghStub({
      post: 0,
      queuedLogins: [],
      historicalReviews: ["copilot-pull-request-reviewer[bot]"],
    });
    const capAuto = captureStdout();
    const codeAuto = await run(["--pr", "42", "--override", "always"], {
      gh: ghAuto,
      readConfig,
      stdinPaths: async () => ["package-lock.json"],
    });
    capAuto.restore();
    expect(codeAuto).toBe(0);
    const verdictAuto = JSON.parse(capAuto.out.join(""));
    expect(ghAuto.calls.some(isPost)).toBe(false);
    expect(verdictAuto.requestSkipReason).toBe("auto-review-already-enabled");

    // Control: empty reviewRequests + no history → POST still fires.
    const ghControl = ghStub({ post: 0, queuedLogins: [] });
    const capControl = captureStdout();
    const codeControl = await run(["--pr", "42", "--override", "always"], {
      gh: ghControl,
      readConfig,
      stdinPaths: async () => ["package-lock.json"],
    });
    capControl.restore();
    expect(codeControl).toBe(0);
    expect(ghControl.calls.some(isPost)).toBe(true);
  });

  it("request succeeds + queued re-read shows the `Copilot` entry → queued recognized via matchesCopilot", async () => {
    // GitHub renders the queued Copilot reviewer as login `Copilot` (a Bot),
    // NOT the `copilot-pull-request-reviewer` author form. The queued check
    // must recognise it.
    const gh = ghStub({ post: 0, queuedLogins: ["Copilot"] });
    const cap = captureStdout();
    const errCap = captureStderr();
    const code = await run(["--pr", "42", "--override", "always"], {
      gh,
      readConfig,
      stdinPaths: async () => ["package-lock.json"],
    });
    cap.restore();
    errCap.restore();
    expect(code).toBe(0);
    expect(gh.calls.some(isPost)).toBe(true);
    const verdict = JSON.parse(cap.out.join(""));
    expect(verdict.posted).toBe(true);
    expect(verdict.queued).toBe(true);
    expect(errCap.err.join("")).not.toMatch(/silent rejection/);
  });

  it("budget short-circuit: bots.copilotSkipWait=true → requestCopilot:false, no request issued", async () => {
    const gh = ghStub({ post: 0, queuedLogins: [] });
    const cap = captureStdout();
    // override=always would normally force a request; the budget toggle wins.
    const code = await run(["--pr", "42", "--override", "always"], {
      gh,
      readConfig: () => ({ bots: { copilotSkipWait: true } }),
      stdinPaths: async () => ["src/index.ts"],
    });
    cap.restore();
    expect(code).toBe(0);
    const verdict = JSON.parse(cap.out.join(""));
    expect(verdict.requestCopilot).toBe(false);
    expect(verdict.reason).toMatch(/budget/);
    expect(gh.calls.some(isPost)).toBe(false);
  });

  it("auto + ambiguous + no decision fails open to requesting", async () => {
    const gh = ghStub({ post: 0, queuedLogins: ["copilot-pull-request-reviewer"] });
    const cap = captureStdout();
    const code = await run(["--pr", "42"], {
      gh,
      readConfig,
      stdinPaths: async () => ["package-lock.json", "src/feature.ts"], // ambiguous
    });
    cap.restore();
    expect(code).toBe(0);
    const verdict = JSON.parse(cap.out.join(""));
    expect(verdict.globClass).toBe("ambiguous");
    expect(verdict.requestCopilot).toBe(true);
  });
});
