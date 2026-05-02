import { describe, expect, it, vi } from "vitest";
import {
  cadenceFor,
  decideOnPoll,
  deriveCheckState,
  deriveCopilotPosted,
  parseArgs,
  run,
  type Check,
  type GhRunner,
  type PollState,
  type Review,
  type RunResult,
} from "./flow-ci-wait";

// ---------------------------------------------------------------------------
// 1. cadenceFor
// ---------------------------------------------------------------------------

describe(cadenceFor, () => {
  it("returns 30 for poll 1", () => {
    expect(cadenceFor(1)).toBe(30);
  });
  it("returns 30 for poll 5 (last in tier 1)", () => {
    expect(cadenceFor(5)).toBe(30);
  });
  it("returns 60 for poll 6 (first in tier 2)", () => {
    expect(cadenceFor(6)).toBe(60);
  });
  it("returns 60 for poll 10 (last in tier 2)", () => {
    expect(cadenceFor(10)).toBe(60);
  });
  it("returns 90 for poll 11 (first in tier 3)", () => {
    expect(cadenceFor(11)).toBe(90);
  });
  it("returns 90 for very late polls (e.g. 100)", () => {
    expect(cadenceFor(100)).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// 2. deriveCheckState
// ---------------------------------------------------------------------------

describe(deriveCheckState, () => {
  it("reports 'no-checks-reported' on an empty list", () => {
    expect(deriveCheckState([])).toEqual({ kind: "no-checks-reported" });
  });
  it("reports 'pending' when at least one check is PENDING/QUEUED/IN_PROGRESS", () => {
    const r = deriveCheckState([
      { name: "test", state: "SUCCESS" },
      { name: "lint", state: "IN_PROGRESS" },
    ]);
    expect(r).toEqual({ kind: "pending" });
  });
  it("reports 'all-passed' when every check is SUCCESS or SKIPPED", () => {
    const r = deriveCheckState([
      { name: "test", state: "SUCCESS" },
      { name: "lint", state: "SKIPPED" },
    ]);
    expect(r).toEqual({ kind: "all-passed" });
  });
  it("reports 'failed' (with names) when any check is FAILURE/CANCELLED/TIMED_OUT/STARTUP_FAILURE/STALE", () => {
    const r = deriveCheckState([
      { name: "test", state: "SUCCESS" },
      { name: "lint", state: "FAILURE" },
      { name: "deploy", state: "TIMED_OUT" },
    ]);
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.failedChecks.map((c) => c.name)).toEqual(["lint", "deploy"]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. deriveCopilotPosted
// ---------------------------------------------------------------------------

describe(deriveCopilotPosted, () => {
  const LOGIN = "copilot-pull-request-reviewer";

  it("returns false on an empty reviews list", () => {
    expect(deriveCopilotPosted([], LOGIN)).toBe(false);
  });

  it("returns false when no review's author matches", () => {
    const reviews: Review[] = [{ author: { login: "alice" }, state: "APPROVED" }];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(false);
  });

  it("returns true when a review's login matches case-insensitively", () => {
    // GitHub may emit a mixed-case login; both sides are lowercased.
    const reviews: Review[] = [
      { author: { login: "Copilot-Pull-Request-Reviewer" }, state: "APPROVED" },
    ];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(true);
  });

  it("ignores reviews in PENDING state (still drafting)", () => {
    const reviews: Review[] = [{ author: { login: LOGIN }, state: "PENDING" }];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(false);
  });

  it("accepts APPROVED reviews", () => {
    const reviews: Review[] = [{ author: { login: LOGIN }, state: "APPROVED" }];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(true);
  });
  it("accepts CHANGES_REQUESTED reviews", () => {
    const reviews: Review[] = [{ author: { login: LOGIN }, state: "CHANGES_REQUESTED" }];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(true);
  });
  it("accepts COMMENTED reviews", () => {
    const reviews: Review[] = [{ author: { login: LOGIN }, state: "COMMENTED" }];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. decideOnPoll — pure decision matrix
// ---------------------------------------------------------------------------

function makePollState(overrides: Partial<PollState> = {}): PollState {
  return {
    pollNum: 1,
    elapsedSec: 0,
    ciTerminalAt: null,
    prState: "OPEN",
    prUrl: "https://x/y/pull/1",
    ci: { kind: "pending" },
    copilotPosted: false,
    ciConfigured: true,
    copilotConfigured: true,
    maxElapsed: 1200,
    copilotTimeout: 600,
    ...overrides,
  };
}

describe("decideOnPoll — pr_state precedence", () => {
  it("exits with 'merged-externally' when pr_state is MERGED", () => {
    const v = decideOnPoll(makePollState({ prState: "MERGED" }));
    expect(v).toEqual({ verdict: "exit", decision: "merged-externally" });
  });

  it("exits with 'pr-closed' when pr_state is CLOSED", () => {
    const v = decideOnPoll(makePollState({ prState: "CLOSED" }));
    expect(v).toEqual({ verdict: "exit", decision: "pr-closed" });
  });
});

describe("decideOnPoll — ci-failed", () => {
  it("exits with 'ci-failed' including failed check names", () => {
    const failedChecks: Check[] = [{ name: "lint", state: "FAILURE" }];
    const v = decideOnPoll(makePollState({ ci: { kind: "failed", failedChecks } }));
    expect(v).toEqual({ verdict: "exit", decision: "ci-failed", ciFailedChecks: failedChecks });
  });
});

describe("decideOnPoll — proceed-to-review", () => {
  it("exits with 'proceed-to-review' when ci passed and copilot already posted", () => {
    const v = decideOnPoll(
      makePollState({
        ci: { kind: "all-passed" },
        copilotPosted: true,
        ciTerminalAt: 0,
      }),
    );
    expect(v).toEqual({ verdict: "exit", decision: "proceed-to-review" });
  });
});

describe("decideOnPoll — proceed-to-review-no-bot (Copilot timeout)", () => {
  it("keeps looping while ci_terminal but copilot has not posted within 10 minutes", () => {
    // ci went terminal at elapsedSec=0; we're now at 300s (5 min), still inside the 10-min window.
    const v = decideOnPoll(
      makePollState({
        ci: { kind: "all-passed" },
        copilotPosted: false,
        ciTerminalAt: 0,
        elapsedSec: 300,
        pollNum: 7,
      }),
    );
    expect(v).toEqual({ verdict: "loop", cadenceSec: 60 });
  });

  it("exits with 'proceed-to-review-no-bot' once 10 minutes elapse from ci-terminal", () => {
    const v = decideOnPoll(
      makePollState({
        ci: { kind: "all-passed" },
        copilotPosted: false,
        ciTerminalAt: 30,
        elapsedSec: 30 + 600, // exactly 10 min after ci_terminal
        pollNum: 12,
      }),
    );
    expect(v).toEqual({ verdict: "exit", decision: "proceed-to-review-no-bot" });
  });
});

describe("decideOnPoll — ci-hang (20-min cap)", () => {
  it("exits with 'ci-hang' when total elapsed reaches 20 minutes", () => {
    // Still pending at the 20-min mark.
    const v = decideOnPoll(
      makePollState({
        ci: { kind: "pending" },
        elapsedSec: 1200,
        pollNum: 20,
      }),
    );
    expect(v).toEqual({ verdict: "exit", decision: "ci-hang" });
  });
});

describe("decideOnPoll — presence overrides", () => {
  it("treats ci as passed when CI is not configured (collapses pending observations)", () => {
    // ciConfigured=false; copilotPosted=true (so not blocked on bot).
    const v = decideOnPoll(
      makePollState({
        ciConfigured: false,
        ci: { kind: "no-checks-reported" },
        copilotPosted: true,
        ciTerminalAt: 0,
      }),
    );
    expect(v).toEqual({ verdict: "exit", decision: "proceed-to-review" });
  });

  it("treats copilot as posted when Copilot is not requested as a reviewer", () => {
    const v = decideOnPoll(
      makePollState({
        ci: { kind: "all-passed" },
        copilotConfigured: false,
        copilotPosted: false,
        ciTerminalAt: 0,
      }),
    );
    expect(v).toEqual({ verdict: "exit", decision: "proceed-to-review" });
  });

  it("exits with 'proceed-to-review' on poll 1 when neither CI nor Copilot is configured", () => {
    const v = decideOnPoll(
      makePollState({
        ciConfigured: false,
        copilotConfigured: false,
        ci: { kind: "no-checks-reported" },
        copilotPosted: false,
        ciTerminalAt: 0,
      }),
    );
    expect(v).toEqual({ verdict: "exit", decision: "proceed-to-review" });
  });
});

describe("decideOnPoll — looping cadence", () => {
  it("loops with cadence 30s on poll 1 when ci is still pending", () => {
    const v = decideOnPoll(makePollState({ pollNum: 1, ci: { kind: "pending" } }));
    expect(v).toEqual({ verdict: "loop", cadenceSec: 30 });
  });
  it("loops with cadence 60s on poll 6 when ci is still pending", () => {
    const v = decideOnPoll(makePollState({ pollNum: 6, ci: { kind: "pending" } }));
    expect(v).toEqual({ verdict: "loop", cadenceSec: 60 });
  });
  it("loops with cadence 90s on poll 11 when ci is still pending", () => {
    const v = decideOnPoll(makePollState({ pollNum: 11, ci: { kind: "pending" } }));
    expect(v).toEqual({ verdict: "loop", cadenceSec: 90 });
  });
});

// ---------------------------------------------------------------------------
// 5. parseArgs
// ---------------------------------------------------------------------------

describe(parseArgs, () => {
  it("errors when no PR is provided", () => {
    expect(parseArgs([])).toEqual({ error: "PR number is required" });
  });
  it("errors on an unknown flag", () => {
    expect(parseArgs(["100", "--bogus"])).toEqual({ error: "unknown flag: --bogus" });
  });
  it("accepts just a PR number", () => {
    expect(parseArgs(["100"])).toEqual({ pr: 100 });
  });
  it("accepts --copilot-login override", () => {
    expect(parseArgs(["100", "--copilot-login", "coderabbitai"])).toEqual({
      pr: 100,
      copilotLogin: "coderabbitai",
    });
  });
  it("rejects a non-integer PR", () => {
    expect(parseArgs(["abc"])).toEqual({ error: "PR must be a positive integer, got 'abc'" });
  });
});

// ---------------------------------------------------------------------------
// 6. run() integration — fake clock, fake gh, fake fs
// ---------------------------------------------------------------------------

/**
 * Logical clock + sleep that advances the clock instantly. Lets the loop
 * "wait" 20 minutes in microseconds.
 */
function makeFakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function captureStreams() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sOut = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout.push(s.toString());
    return true;
  });
  const sErr = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr.push(s.toString());
    return true;
  });
  return {
    stdout,
    stderr,
    restore: () => {
      sOut.mockRestore();
      sErr.mockRestore();
    },
  };
}

type GhStep = { matches: (argv: string[]) => boolean; response: { stdout: string; stderr: string; exitCode: number } };

/**
 * Replays a queue of {match, response} pairs in order. Each gh call
 * consumes the first matching entry. If a step's match fails, the test
 * fails with a descriptive error.
 */
function makeGhSequence(steps: GhStep[]): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let cursor = 0;
  const fn = ((argv: string[]) => {
    calls.push(argv);
    const step = steps[cursor];
    if (!step) {
      throw new Error(`unexpected gh call (no step left): gh ${argv.join(" ")}`);
    }
    if (!step.matches(argv)) {
      throw new Error(`gh call ${cursor} did not match: got 'gh ${argv.join(" ")}'`);
    }
    cursor++;
    return step.response;
  }) as GhRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const isReviewRequests = (argv: string[]) =>
  argv[0] === "pr" &&
  argv[1] === "view" &&
  argv.includes("--json") &&
  argv[argv.indexOf("--json") + 1] === "reviewRequests";

const isPrView = (argv: string[]) =>
  argv[0] === "pr" &&
  argv[1] === "view" &&
  argv.includes("--json") &&
  argv[argv.indexOf("--json") + 1] === "state,url,reviews";

const isPrChecks = (argv: string[]) => argv[0] === "pr" && argv[1] === "checks";

const PR_URL = "https://x/y/pull/100";

function reviewRequestsResponse(logins: string[]) {
  return {
    stdout: JSON.stringify({ reviewRequests: logins.map((login) => ({ login })) }),
    stderr: "",
    exitCode: 0,
  };
}

function prViewResponse(state: "OPEN" | "MERGED" | "CLOSED", reviews: Review[] = []) {
  return {
    stdout: JSON.stringify({ state, url: PR_URL, reviews }),
    stderr: "",
    exitCode: 0,
  };
}

function prChecksResponse(checks: Check[]) {
  return { stdout: JSON.stringify(checks), stderr: "", exitCode: 0 };
}

const ALL_PASSED: Check[] = [{ name: "test", state: "SUCCESS" }];
const COPILOT_REVIEW: Review[] = [
  { author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED" },
];

describe("run() integration", () => {
  it("exits 0 with 'merged-externally' JSON when PR is MERGED on poll 1", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false,
      readCopilotLogin: () => "copilot-pull-request-reviewer",
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("merged-externally");
    expect(result.polls).toBe(1);
    expect(result.prState).toBe("MERGED");
  });

  it("exits 0 with 'pr-closed' JSON when PR is CLOSED on poll 1", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("CLOSED") },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false,
      readCopilotLogin: () => "copilot-pull-request-reviewer",
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-closed");
  });

  it("exits 0 with 'ci-failed' JSON listing failed check names", async () => {
    const clock = makeFakeClock();
    const failed: Check[] = [{ name: "lint", state: "FAILURE" }];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      { matches: isPrChecks, response: prChecksResponse(failed) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readCopilotLogin: () => "copilot-pull-request-reviewer",
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("ci-failed");
    expect(result.ciFailedChecks).toEqual(failed);
  });

  it("exits 0 with 'proceed-to-review' JSON when ci passes and the bot posts", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readCopilotLogin: () => "copilot-pull-request-reviewer",
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(true);
    expect(result.copilotConfigured).toBe(true);
  });

  it("exits 0 with 'proceed-to-review-no-bot' JSON after the 10-min copilot timeout", async () => {
    const clock = makeFakeClock();
    // Build a sequence: review-requests once, then 12 polls each (prView + prChecks).
    // CI is all-passed from poll 1 onward; copilot never posts. The 10-min
    // copilot timeout fires when elapsed-since-ci-terminal >= 600s.
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
    ];
    // ci_terminal lands at elapsedSec=0 (poll 1's all-passed observation).
    // Cadence ramp: 30×5 + 60×5 + 90×… → poll 12 elapsed=540s (<600), poll 13
    // elapsed=630s (>=600) → exit. 15 iterations gives headroom.
    for (let i = 0; i < 15; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", []) });
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readCopilotLogin: () => "copilot-pull-request-reviewer",
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.elapsedSec).toBeGreaterThanOrEqual(600);
    expect(result.polls).toBe(13);
  });

  it("exits 0 with 'ci-hang' JSON after the 20-min cap", async () => {
    const clock = makeFakeClock();
    // CI stays pending forever; PR open; copilot never posts. We need
    // enough steps for ~20 polls. Each poll = 1 prView + 1 prChecks.
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
    ];
    const PENDING_CHECKS: Check[] = [{ name: "test", state: "IN_PROGRESS" }];
    for (let i = 0; i < 25; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", []) });
      steps.push({ matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readCopilotLogin: () => "copilot-pull-request-reviewer",
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("ci-hang");
    expect(result.elapsedSec).toBeGreaterThanOrEqual(1200);
  });

  it("does NOT call 'gh pr checks' when CI is not configured", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      // No isPrChecks step — if the runner calls it, the sequence will fail.
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false, // CI not configured
      readCopilotLogin: () => "copilot-pull-request-reviewer",
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(false);
    // Belt + suspenders: check the call log directly.
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "checks")).toBe(false);
  });

  it("does NOT wait the copilot timeout when Copilot is not in reviewRequests", async () => {
    const clock = makeFakeClock();
    // Copilot not requested → COPILOT_REQUESTED=0; first poll where ci is
    // all-passed should immediately decide proceed-to-review without waiting
    // the 10-min timeout.
    const gh = makeGhSequence([
      // No copilot in reviewRequests.
      { matches: isReviewRequests, response: reviewRequestsResponse(["someone-else"]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readCopilotLogin: () => "copilot-pull-request-reviewer",
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotConfigured).toBe(false);
    expect(result.polls).toBe(1);
  });

  it("prints one progress line per iteration to stderr (not stdout)", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false,
      readCopilotLogin: () => "copilot-pull-request-reviewer",
    });
    cap.restore();
    // Final JSON on stdout; progress on stderr.
    expect(cap.stdout.join("")).toMatch(/"decision":/);
    expect(cap.stdout.join("")).not.toMatch(/CI poll/);
    expect(cap.stderr.join("")).toMatch(/CI poll 1/);
  });

  it("exits 2 with usage error on bad CLI args", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = await run([], {
      gh: vi.fn(),
      now: () => 0,
      sleep: async () => {},
      readWorkflowsDir: () => false,
      readCopilotLogin: () => "copilot-pull-request-reviewer",
    });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });
});
