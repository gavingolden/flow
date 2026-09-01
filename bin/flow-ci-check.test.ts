import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseArgs,
  run,
  deriveAnchors,
  type CheckResult,
  type RunResult,
} from "./flow-ci-check";
import type { Check, Review } from "./lib/ci-decision";
import type { GhRunner } from "./lib/ci-observe";
import { readState, writeState, type CiWaitRecord } from "./lib/state";
import { registrySelfCheck } from "./lib/ci-observe";

// `resolveCopilotConfigured`/`readHistoricalBotReview` consult
// `bots.copilotAutoReview` via the default (file-backed) ReadConfigFile,
// which has no injectable seam at the call site — but every test below
// injects an explicit `readHistoricalBotReview` dep, so this file needs no
// `vi.mock` of `./lib/copilot-config` (unlike `ci-observe.test.ts`).

// `run()` persists its verdict to `<cwd>/.flow-tmp/ci-wait-result.json` by
// default. Redirect cwd to a throwaway temp dir for every test so an
// incidental default-path write never lands in the repo tree.
let globalCwd = "";
let originalFlowSlug: string | undefined;
const tmpStateDirs: string[] = [];

beforeEach(() => {
  globalCwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ci-check-cwd-"));
  vi.spyOn(process, "cwd").mockReturnValue(globalCwd);
  originalFlowSlug = process.env.FLOW_SLUG;
  delete process.env.FLOW_SLUG;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (globalCwd) {
    fs.rmSync(globalCwd, { recursive: true, force: true });
    globalCwd = "";
  }
  if (originalFlowSlug === undefined) delete process.env.FLOW_SLUG;
  else process.env.FLOW_SLUG = originalFlowSlug;
  while (tmpStateDirs.length > 0) {
    const d = tmpStateDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ci-check-state-"));
  tmpStateDirs.push(d);
  return d;
}

/** Seeds a minimal pre-existing pipeline state file, mirroring the real
 * shape `flow feature create` already wrote by the time step 7 runs a
 * `flow-ci-check` call — `flow-ci-check` never fabricates a whole
 * pipeline state, only the `ciWait` sub-record. `pr: 100` matches every
 * call site in this file (`run(["100", ...])`) — real pipelines already
 * have `state.pr` set by Step 5 (`flow-open-pr`) before Step 7 runs, so
 * the `advancePhase` `expectPr` guard must see it match here too, or every
 * test would spuriously trip the `pr-mismatch` NOTICE. */
function seedState(dir: string, slug: string, phase = "ci-wait-pending"): void {
  writeState(
    {
      slug,
      phase,
      repo: "/tmp/repo",
      pr: 100,
      updatedAt: "2026-01-01T00:00:00Z",
    },
    dir,
  );
}

function readAnchors(dir: string, slug: string): CiWaitRecord | undefined {
  return readState(slug, dir)?.ciWait;
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

type GhStep = {
  matches: (argv: string[]) => boolean;
  response: { stdout: string; stderr: string; exitCode: number };
};

const isRequestedReviewersRest = (argv: string[]) =>
  argv[0] === "api" &&
  typeof argv[1] === "string" &&
  argv[1].endsWith("/requested_reviewers");

function makeGhSequence(steps: GhStep[]): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let cursor = 0;
  const fn = ((argv: string[]) => {
    calls.push(argv);
    const step = steps[cursor];
    if (isRequestedReviewersRest(argv) && !(step && step.matches(argv))) {
      return { stdout: "[]", stderr: "", exitCode: 0 };
    }
    if (!step) {
      throw new Error(
        `unexpected gh call (no step left): gh ${argv.join(" ")}`,
      );
    }
    if (!step.matches(argv)) {
      throw new Error(
        `gh call ${cursor} did not match: got 'gh ${argv.join(" ")}'`,
      );
    }
    cursor++;
    return step.response;
  }) as GhRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

/** Wraps a `makeGhSequence` runner so every call across MULTIPLE `run()`
 * invocations (a ported multi-poll original, translated into separate
 * `run()` calls against the same `--state-dir`) lands in one shared call
 * log — mirrors the inline `trackingGh` helper the retrigger-idempotency
 * test above already uses, hoisted for reuse by the ported blocks below. */
function trackingGhSequence(steps: GhStep[], sink: string[][]): GhRunner {
  const inner = makeGhSequence(steps);
  return (argv) => {
    sink.push(argv);
    return inner(argv);
  };
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
  argv[argv.indexOf("--json") + 1] === "state,url,reviews,headRefOid";

const isPrChecks = (argv: string[]) => argv[0] === "pr" && argv[1] === "checks";

const isMergeState = (argv: string[]) =>
  argv[0] === "pr" &&
  argv[1] === "view" &&
  argv.includes("--json") &&
  argv[argv.indexOf("--json") + 1] === "mergeable,mergeStateStatus";

const isRequestedReviewersPost = (argv: string[]) =>
  argv[0] === "pr" && argv[1] === "edit" && argv.includes("--add-reviewer");

const PR_URL = "https://x/y/pull/100";
const STABLE_HEAD_SHA = "sha-current";

function reviewRequestsResponse(logins: string[]) {
  return {
    stdout: JSON.stringify({
      reviewRequests: logins.map((login) => ({ login })),
    }),
    stderr: "",
    exitCode: 0,
  };
}

const COPILOT_QUEUED = ["copilot-pull-request-reviewer"];
const COPILOT_NOT_QUEUED: string[] = [];
const postRetriggerReviewRequests = (
  logins: string[] = COPILOT_QUEUED,
): GhStep => ({
  matches: isReviewRequests,
  response: reviewRequestsResponse(logins),
});

function prViewResponse(
  state: "OPEN" | "MERGED" | "CLOSED",
  reviews: Review[] = [],
  headRefOid: string = STABLE_HEAD_SHA,
) {
  const wireReviews = reviews.map((r) => ({
    author: r.author,
    state: r.state,
    commit: r.commitOid !== null ? { oid: r.commitOid } : null,
  }));
  return {
    stdout: JSON.stringify({
      state,
      url: PR_URL,
      reviews: wireReviews,
      headRefOid,
    }),
    stderr: "",
    exitCode: 0,
  };
}

function prChecksResponse(
  checks: Array<Check & { startedAt?: string; completedAt?: string }>,
) {
  return { stdout: JSON.stringify(checks), stderr: "", exitCode: 0 };
}

const ALL_PASSED: Check[] = [{ name: "test", state: "SUCCESS" }];
const COPILOT_REVIEW: Review[] = [
  {
    author: { login: "copilot-pull-request-reviewer" },
    state: "COMMENTED",
    commitOid: STABLE_HEAD_SHA,
  },
];

const CLEAN_MERGE = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };

// Copilot retrigger (PR #161 stale-review incident) fixtures — ported from
// the original `run() integration — Copilot retrigger` describe.
const STALE_SHA = "sha-stale";
const HEAD_SHA = "sha-head-new";

function staleCopilotReview(commitOid: string = STALE_SHA): Review[] {
  return [
    {
      author: { login: "copilot-pull-request-reviewer" },
      state: "COMMENTED",
      commitOid,
    },
  ];
}

function baseDeps(
  gh: GhRunner,
  nowMs: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    isCopilotModuleActive: () => true,
    gh,
    now: () => nowMs,
    readWorkflowsDir: () => true,
    readMergeState: () => CLEAN_MERGE,
    readCopilotLogin: () => "copilot-pull-request-reviewer",
    readHistoricalBotReview: () => false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. parseArgs
// ---------------------------------------------------------------------------

describe(parseArgs, () => {
  it("errors when no PR is provided", () => {
    expect(parseArgs([])).toEqual({ error: "PR number is required" });
  });
  it("errors on an unknown flag", () => {
    expect(parseArgs(["100", "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
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
    expect(parseArgs(["abc"])).toEqual({
      error: "PR must be a positive integer, got 'abc'",
    });
  });
  it("returns 'help' on --help without requiring a PR", () => {
    expect(parseArgs(["--help"])).toEqual({ error: "help" });
  });
  it("accepts --wait-for-copilot as a boolean flag", () => {
    expect(parseArgs(["100", "--wait-for-copilot"])).toEqual({
      pr: 100,
      waitForCopilot: true,
    });
  });
  it("accepts --claim-deadline-sec with a positive integer value", () => {
    expect(parseArgs(["100", "--claim-deadline-sec", "30"])).toEqual({
      pr: 100,
      claimDeadlineSec: 30,
    });
  });
  it("errors when --claim-deadline-sec is missing its value", () => {
    expect(parseArgs(["100", "--claim-deadline-sec"])).toEqual({
      error: "--claim-deadline-sec requires a value",
    });
  });
  it("errors when --claim-deadline-sec is non-numeric", () => {
    expect(parseArgs(["100", "--claim-deadline-sec", "abc"])).toEqual({
      error: "--claim-deadline-sec must be a positive integer, got 'abc'",
    });
  });
  it("accepts --out with a path value", () => {
    expect(parseArgs(["100", "--out", "/tmp/verdict.json"])).toEqual({
      pr: 100,
      out: "/tmp/verdict.json",
    });
  });
  it("errors when --out is followed by another flag instead of a value", () => {
    expect(parseArgs(["100", "--out", "--wait-for-copilot"])).toEqual({
      error: "--out requires a value",
    });
  });
  it("accepts --state-dir with a path value", () => {
    expect(parseArgs(["100", "--state-dir", "/tmp/state"])).toEqual({
      pr: 100,
      stateDir: "/tmp/state",
    });
  });
  it("errors when --state-dir is missing its value", () => {
    expect(parseArgs(["100", "--state-dir"])).toEqual({
      error: "--state-dir requires a value",
    });
  });
  it("accepts --now with an ISO value", () => {
    expect(parseArgs(["100", "--now", "2026-01-01T00:00:00.000Z"])).toEqual({
      pr: 100,
      now: "2026-01-01T00:00:00.000Z",
    });
  });
  it("accepts --max-elapsed and --copilot-timeout test overrides", () => {
    expect(
      parseArgs(["100", "--max-elapsed", "10", "--copilot-timeout", "5"]),
    ).toEqual({ pr: 100, maxElapsed: 10, copilotTimeout: 5 });
  });
  it("accepts --copilot-not-requested as a boolean flag", () => {
    expect(parseArgs(["100", "--copilot-not-requested"])).toEqual({
      pr: 100,
      copilotNotRequested: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. deriveAnchors — pure anchor derivation
// ---------------------------------------------------------------------------

describe(deriveAnchors, () => {
  const START = "2026-01-01T00:00:00.000Z";
  const startMs = Date.parse(START);

  function freshRecord(overrides: Partial<CiWaitRecord> = {}): CiWaitRecord {
    return {
      pr: 100,
      headSha: "abc",
      startedAt: START,
      ciTerminalAt: null,
      lastObservedAt: null,
      checks: 1,
      copilotRetriggered: false,
      ...overrides,
    };
  }

  it("derives elapsedSec from now - startedAt, clamped at 0", () => {
    const anchors = deriveAnchors(freshRecord(), [], true, startMs + 5000);
    expect(anchors.elapsedSec).toBe(5);
    const clamped = deriveAnchors(freshRecord(), [], true, startMs - 5000);
    expect(clamped.elapsedSec).toBe(0);
  });

  it("ciTerminalAt=null while ci is not yet terminal and ciConfigured=true", () => {
    const anchors = deriveAnchors(
      freshRecord(),
      [{ name: "t", state: "IN_PROGRESS" }],
      true,
      startMs + 1000,
    );
    expect(anchors.ciTerminalAt).toBeNull();
    expect(anchors.record.ciTerminalAt).toBeNull();
  });

  it("ciConfigured=false collapses ciTerminalAt to startedAt (vacuously terminal)", () => {
    const anchors = deriveAnchors(freshRecord(), [], false, startMs + 10000);
    expect(anchors.ciTerminalAt).toBe(0);
    expect(anchors.record.ciTerminalAt).toBe(START);
  });

  it("prefers the GitHub-side completedAt floored at startedAt", () => {
    const completedAt = new Date(startMs + 30000).toISOString();
    const anchors = deriveAnchors(
      freshRecord(),
      [{ name: "t", state: "SUCCESS", completedAt }],
      true,
      startMs + 60000,
    );
    expect(anchors.ciTerminalAt).toBe(30);
    expect(anchors.record.ciTerminalAt).toBe(completedAt);
  });

  it("floors a completedAt that predates startedAt (clock skew) at startedAt", () => {
    const completedAt = new Date(startMs - 60000).toISOString();
    const anchors = deriveAnchors(
      freshRecord(),
      [{ name: "t", state: "SUCCESS", completedAt }],
      true,
      startMs + 60000,
    );
    expect(anchors.ciTerminalAt).toBe(0);
    expect(anchors.record.ciTerminalAt).toBe(START);
  });

  it("falls back to nowMs when checks are terminal but completedAt is absent (older gh)", () => {
    const anchors = deriveAnchors(
      freshRecord(),
      [{ name: "t", state: "SUCCESS" }],
      true,
      startMs + 45000,
    );
    expect(anchors.ciTerminalAt).toBe(45);
  });

  it("once persisted, ciTerminalAt does not move on a later call even if checks change", () => {
    const already = freshRecord({ ciTerminalAt: START });
    const anchors = deriveAnchors(
      already,
      [
        {
          name: "t",
          state: "SUCCESS",
          completedAt: new Date(startMs + 90000).toISOString(),
        },
      ],
      true,
      startMs + 120000,
    );
    expect(anchors.ciTerminalAt).toBe(0);
    expect(anchors.record.ciTerminalAt).toBe(START);
  });
});

// ---------------------------------------------------------------------------
// 3. run() — single-observation decision matrix (stateless; each test is a
//    standalone decided/waiting verdict, ported from flow-ci-wait.test.ts's
//    "run() integration" describe with `sleep` removed — one observation
//    pass, no in-process loop).
// ---------------------------------------------------------------------------

describe("run() — decision matrix", () => {
  it("exits 0 with 'merged-externally' JSON when PR is MERGED", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readWorkflowsDir: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult & {
      status: string;
    };
    expect(result.status).toBe("decided");
    expect(result.decision).toBe("merged-externally");
    expect(result.polls).toBe(1);
    expect(result.prState).toBe("MERGED");
  });

  it("exits 0 with 'pr-closed' JSON when PR is CLOSED", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("CLOSED") },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readWorkflowsDir: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-closed");
  });

  it("exits 0 with 'ci-failed' JSON listing failed check names", async () => {
    const failed: Check[] = [{ name: "lint", state: "FAILURE" }];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isMergeState,
        response: { stdout: "", stderr: "", exitCode: 0 },
      },
      { matches: isPrChecks, response: prChecksResponse(failed) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readMergeState: undefined }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("ci-failed");
    expect(result.ciFailedChecks).toEqual(failed);
  });

  it("exits 0 with 'proceed-to-review' JSON when ci passes and the bot posts", async () => {
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], baseDeps(gh, 0));
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(true);
    expect(result.copilotConfigured).toBe(true);
    expect(result.copilotRetriggered).toBe(false);
    expect(result.copilotSkipReason).toBeNull();
  });

  it("emits a 'waiting' verdict with nextCheckSec=60 when CI is still pending", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], baseDeps(gh, 0));
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as CheckResult;
    expect(result.status).toBe("waiting");
    expect((result as { nextCheckSec: number }).nextCheckSec).toBe(60);
    expect((result as { polls: number }).polls).toBe(1);
  });

  it("pr-conflicted fires at poll entry, before requested_reviewers/checks are read", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readMergeState: () => ({
          mergeable: "CONFLICTING",
          mergeStateStatus: "CONFLICTING",
        }),
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-conflicted");
    // Never reached observeChecks — no `pr checks` call in the sequence.
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "checks")).toBe(
      false,
    );
  });

  it("pr-blocked fires only after CI reaches terminal and would otherwise proceed to review", async () => {
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readMergeState: () => ({
          mergeable: "MERGEABLE",
          mergeStateStatus: "BLOCKED",
        }),
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-blocked");
  });
});

// ---------------------------------------------------------------------------
// 4. Failed observation — never fabricates a decision
// ---------------------------------------------------------------------------

describe("run() — failed observation", () => {
  it("a non-zero gh exit on PR view emits waiting + observation:'failed', never a decision", async () => {
    const gh: GhRunner = (argv) => {
      if (isReviewRequests(argv)) return reviewRequestsResponse([]);
      return { stdout: "", stderr: "gh: connection reset", exitCode: 1 };
    };
    const cap = captureStreams();
    const exit = await run(["100"], baseDeps(gh, 0));
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as CheckResult;
    expect(result.status).toBe("waiting");
    expect((result as { observation?: string }).observation).toBe("failed");
    expect(
      (result as { observationFailedSec?: number }).observationFailedSec,
    ).toBe(0);
    expect((result as { nextCheckSec: number }).nextCheckSec).toBe(60);
    expect(result).not.toHaveProperty("decision");
  });

  it("never fires ci-hang on a failed observation, even past the 20-min cap — startedAt-anchored", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-failed-obs";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-01-01T00:00:00.000Z");
    const gh: GhRunner = () => ({
      stdout: "",
      stderr: "gh: rate limited",
      exitCode: 1,
    });

    // Call 1 at T0 seeds the durable anchor: no prior state exists, so
    // `run()` takes the `freshRecord` branch and `startedAt === T0`. The
    // observation fails, so `lastObservedAt` is never set.
    const cap1 = captureStreams();
    const exit1 = await run(
      ["100", "--state-dir", dir, "--now", "2026-01-01T00:00:00.000Z"],
      baseDeps(gh, t0Ms, { now: undefined }),
    );
    cap1.restore();
    expect(exit1).toBe(0);
    expect(readAnchors(dir, slug)?.lastObservedAt).toBeNull();

    // Call 2, 1300s later (> the 1200s cap): the observation itself still
    // fails — `observationFailedSec` must measure the full 1300s against
    // the seeded `startedAt` anchor (the only anchor available, since
    // `lastObservedAt` was never set) and the result must stay "waiting",
    // never "ci-hang". This is the assertion the previous version of this
    // test never made — it asserted 0-elapsed with no prior anchor seeded,
    // so a reintroduced `elapsedSec >= maxElapsed => ci-hang` regression
    // would still have passed it.
    const laterMs = t0Ms + 1300 * 1000;
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir, "--now", "2026-01-01T00:21:40.000Z"],
      baseDeps(gh, laterMs, { now: undefined }),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result = JSON.parse(cap2.stdout.join("")) as CheckResult;
    expect(result.status).toBe("waiting");
    expect((result as { observation?: string }).observation).toBe("failed");
    expect(
      (result as { observationFailedSec?: number }).observationFailedSec,
    ).toBe(1300);
    expect(readAnchors(dir, slug)?.lastObservedAt).toBeNull();
  });

  it("never fires ci-hang on a failed observation, even past the 20-min cap — lastObservedAt-anchored", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-failed-obs-anchored";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-01-01T00:00:00.000Z");

    // Call 1 at T0 succeeds and is not CI-terminal, so it sets
    // `lastObservedAt = T0` and stays "waiting".
    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", [], "sha-1") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap1 = captureStreams();
    const exit1 = await run(
      ["100", "--state-dir", dir, "--now", "2026-01-01T00:00:00.000Z"],
      baseDeps(gh1, t0Ms, { now: undefined }),
    );
    cap1.restore();
    expect(exit1).toBe(0);
    expect(readAnchors(dir, slug)?.lastObservedAt).toBe(
      new Date(t0Ms).toISOString(),
    );

    // Call 2, 1300s later, fails the observation. `observationFailedSec`
    // must measure from the seeded `lastObservedAt` (T0), not from `now`,
    // and a failed observation must never advance `lastObservedAt`.
    const laterMs = t0Ms + 1300 * 1000;
    const gh2: GhRunner = () => ({
      stdout: "",
      stderr: "gh: rate limited",
      exitCode: 1,
    });
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir, "--now", "2026-01-01T00:21:40.000Z"],
      baseDeps(gh2, laterMs, { now: undefined }),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result = JSON.parse(cap2.stdout.join("")) as CheckResult;
    expect(result.status).toBe("waiting");
    expect((result as { observation?: string }).observation).toBe("failed");
    expect(
      (result as { observationFailedSec?: number }).observationFailedSec,
    ).toBe(1300);
    expect(readAnchors(dir, slug)?.lastObservedAt).toBe(
      new Date(t0Ms).toISOString(),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. --out is written only on 'decided'
// ---------------------------------------------------------------------------

describe("run() — --out persistence", () => {
  it("writes the verdict to --out matching stdout on a decided exit", async () => {
    const outPath = path.join(globalCwd, "out", "ci-wait-result.json");
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100", "--out", outPath],
      baseDeps(gh, 0, { readWorkflowsDir: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const stdoutResult = JSON.parse(cap.stdout.join(""));
    expect(fs.existsSync(outPath)).toBe(true);
    const fileResult = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(fileResult).toEqual(stdoutResult);
  });

  it("does NOT write --out on a 'waiting' verdict", async () => {
    const outPath = path.join(globalCwd, "out", "ci-wait-result.json");
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap = captureStreams();
    const exit = await run(["100", "--out", outPath], baseDeps(gh, 0));
    cap.restore();
    expect(exit).toBe(0);
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("defaults to <cwd>/.flow-tmp/ci-wait-result.json when --out is omitted", async () => {
    const defaultPath = path.join(
      globalCwd,
      ".flow-tmp",
      "ci-wait-result.json",
    );
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readWorkflowsDir: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    expect(fs.existsSync(defaultPath)).toBe(true);
  });

  it("a persist-write failure does not suppress stdout or change the exit code", async () => {
    const blocker = path.join(globalCwd, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const outPath = path.join(blocker, "result.json");
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100", "--out", outPath],
      baseDeps(gh, 0, { readWorkflowsDir: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const stdoutResult = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(stdoutResult.decision).toBe("merged-externally");
    expect(cap.stderr.join("")).toMatch(/failed to persist verdict/);
    expect(fs.existsSync(outPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Suspension immunity (Story 3, manifest criterion 3) — the bug class
//    this split exists to close: a suspended/slept process must never
//    inflate elapsed time, because elapsed is always re-derived from
//    ciWait.startedAt on a FRESH observation, never an in-process clock.
// ---------------------------------------------------------------------------

describe("suspension immunity", () => {
  const T0 = "2026-03-01T00:00:00.000Z";
  const t0Ms = Date.parse(T0);

  it("a call 3579s after startedAt with CI now ALL_PASSED proceeds to review instead of fabricating ci-hang", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-suspend-1";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;

    // Call 1 at T0: CI still pending. Persists startedAt=T0.
    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms));
    cap1.restore();
    expect(readAnchors(dir, slug)?.startedAt).toBe(T0);

    // Call 2, 3579s later (a suspended/parked waiter finally woke up), CI now
    // ALL_PASSED with no Copilot configured. A stale in-process clock design
    // would have racked up 3579s of "elapsed" against a 1200s cap and
    // fabricated ci-hang; the anchors-based design takes CI's genuinely
    // fresh terminal state instead.
    const laterMs = t0Ms + 3579 * 1000;
    const gh2 = makeGhSequence([
      { matches: isPrView, response: prViewResponse("OPEN") },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir, "--copilot-not-requested"],
      baseDeps(gh2, laterMs),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review");
    expect(result2.decision).not.toBe("ci-hang");
  });

  it("a genuine hang (CI still pending 1200s after startedAt) still reports ci-hang", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-suspend-2";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms));
    cap1.restore();

    const laterMs = t0Ms + 1200 * 1000;
    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, laterMs),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("ci-hang");
  });

  it("ciTerminalAt prefers the GitHub-side completedAt, floored at startedAt, over the observation wall-clock", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-suspend-3";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms));
    cap1.restore();

    // CI actually completed at T0+10s (long before this delayed observation
    // at T0+500s), so the retained ciTerminalAt anchor should be 10s, not
    // 500s — the copilot-timeout window starts from GitHub's own timestamp.
    const completedAt = new Date(t0Ms + 10 * 1000).toISOString();
    const laterMs = t0Ms + 500 * 1000;
    const gh2 = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse([]),
      },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([
          { name: "t", state: "SUCCESS", completedAt },
        ]),
      },
    ]);
    const cap2 = captureStreams();
    await run(
      ["100", "--state-dir", dir, "--copilot-timeout", "600"],
      baseDeps(gh2, laterMs, { readHistoricalBotReview: () => true }),
    );
    cap2.restore();
    expect(readAnchors(dir, slug)?.ciTerminalAt).toBe(completedAt);
  });
});

// ---------------------------------------------------------------------------
// 7. headSha-change reset — cycle identity = (pr, headSha)
// ---------------------------------------------------------------------------

describe("run() — headSha-change reset", () => {
  it("a new headRefOid resets startedAt/checks/copilotRetriggered", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-reset";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-04-01T00:00:00.000Z");

    // Call 1 uses the retrigger-idempotency fixtures (stale review vs
    // "sha-1" + CI terminal + POST-ok + queued re-read) so
    // `copilotRetriggered` is genuinely `true` before the reset — a
    // regression that carried the flag across a headSha reset would
    // otherwise go unnoticed by this test.
    const gh1 = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(COPILOT_QUEUED),
      },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", staleCopilotReview(), "sha-1"),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      {
        matches: isRequestedReviewersPost,
        response: { stdout: "", stderr: "", exitCode: 0 },
      },
      postRetriggerReviewRequests(),
    ]);
    const cap1 = captureStreams();
    await run(
      ["100", "--state-dir", dir],
      baseDeps(gh1, t0Ms, {
        readCommitsAreAllMerges: () => false,
        readIsSmallFollowup: () => false,
      }),
    );
    cap1.restore();
    const first = readAnchors(dir, slug)!;
    expect(first.headSha).toBe("sha-1");
    expect(first.checks).toBe(1);
    expect(first.copilotRetriggered).toBe(true);

    // A ci-fix push landed — headRefOid advances. 300s later.
    const laterMs = t0Ms + 300 * 1000;
    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", [], "sha-2") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap2 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh2, laterMs));
    cap2.restore();
    const second = readAnchors(dir, slug)!;
    expect(second.headSha).toBe("sha-2");
    expect(second.checks).toBe(1);
    expect(second.startedAt).not.toBe(first.startedAt);
    expect(Date.parse(second.startedAt)).toBe(laterMs);
    // A new headSha cycle re-arms the one-shot retrigger budget for the
    // new SHA (state.ts's cycle-identity contract) — this is the half of
    // the reset the title promised but the original fixtures never
    // exercised (copilotRetriggered was false on both sides).
    expect(second.copilotRetriggered).toBe(false);
  });

  it("does not reset when the observed headSha is empty (a transient gh projection miss)", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-no-reset";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-04-01T00:00:00.000Z");

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", [], "sha-1") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms));
    cap1.restore();
    const first = readAnchors(dir, slug)!;

    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", [], "") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap2 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh2, t0Ms + 10000));
    cap2.restore();
    const second = readAnchors(dir, slug)!;
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.headSha).toBe("sha-1");
  });
});

// ---------------------------------------------------------------------------
// 8. Cross-invocation retrigger idempotency
// ---------------------------------------------------------------------------

describe("run() — retrigger idempotency across invocations", () => {
  it("fires the retrigger POST once across two one-shot calls against the same cycle", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-retrigger";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-05-01T00:00:00.000Z");

    const staleReview: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer" },
        state: "COMMENTED",
        commitOid: "sha-old",
      },
    ];
    const allCalls: string[][] = [];

    // Call 1: CI terminal, stale Copilot review vs current headRefOid ->
    // fires the retrigger POST, then verifies it queued.
    const gh1 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        { matches: isPrView, response: prViewResponse("OPEN", staleReview) },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
        {
          matches: isRequestedReviewersPost,
          response: { stdout: "", stderr: "", exitCode: 0 },
        },
        postRetriggerReviewRequests(),
      ],
      allCalls,
    );
    const cap1 = captureStreams();
    const exit1 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh1, t0Ms, {
        readCommitsAreAllMerges: () => false,
        readIsSmallFollowup: () => false,
      }),
    );
    cap1.restore();
    expect(exit1).toBe(0);
    // The retrigger fires, but the fresh review has not posted yet on this
    // same pass — decideOnPoll still returns "loop" (waiting), which is the
    // correct outcome; the persisted anchor record is the authoritative
    // place to observe that the one-shot budget is now spent.
    const result1 = JSON.parse(cap1.stdout.join("")) as CheckResult;
    expect(result1.status).toBe("waiting");
    expect(readAnchors(dir, slug)?.copilotRetriggered).toBe(true);

    // Call 2, same (pr, headSha) cycle, same stale review still present (the
    // fresh review hasn't posted yet) — the budget is already spent, so no
    // second POST should fire.
    const gh2 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        { matches: isPrView, response: prViewResponse("OPEN", staleReview) },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      ],
      allCalls,
    );
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, t0Ms + 60000, {
        readCommitsAreAllMerges: () => false,
        readIsSmallFollowup: () => false,
      }),
    );
    cap2.restore();
    expect(exit2).toBe(0);

    const postCalls = allCalls.filter(isRequestedReviewersPost);
    expect(postCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Copilot auto-detect short-circuit (two-invocation port of the
//    original sleep-based 'unclaimed-after-deadline' test)
// ---------------------------------------------------------------------------

describe("run() — Copilot auto-detect short-circuit", () => {
  const LOGIN = "copilot-pull-request-reviewer";

  it("'unclaimed-after-deadline' fires once the claim deadline elapses since ciTerminalAt", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-autodetect";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-06-01T00:00:00.000Z");

    // Call 1: CI terminal at poll 1 (elapsedSec=0), no Copilot review,
    // Copilot not in per-poll reviewRequests.
    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap1 = captureStreams();
    const exit1 = await run(
      ["100", "--state-dir", dir, "--claim-deadline-sec", "30"],
      baseDeps(gh1, t0Ms, {
        readCopilotLogin: () => LOGIN,
        readHistoricalBotReview: () => true,
      }),
    );
    cap1.restore();
    expect(exit1).toBe(0);
    const result1 = JSON.parse(cap1.stdout.join("")) as CheckResult;
    expect(result1.status).toBe("waiting");

    // Call 2, 30s later: same observation — the deadline has now elapsed.
    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir, "--claim-deadline-sec", "30"],
      baseDeps(gh2, t0Ms + 30000, {
        readCopilotLogin: () => LOGIN,
        readHistoricalBotReview: () => true,
      }),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.copilotSkipReason).toBe("unclaimed-after-deadline");
    expect(result2.polls).toBe(2);
    expect(cap2.stderr.join("")).toMatch(
      /Copilot auto-detect: unclaimed-after-deadline/,
    );
  });

  it("'self-dismissed' fires when Copilot dismissed its own review on the current SHA", async () => {
    const dismissed: Review[] = [
      {
        author: { login: LOGIN },
        state: "DISMISSED",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", dismissed) },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readCopilotLogin: () => LOGIN,
        readHistoricalBotReview: () => true,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotSkipReason).toBe("self-dismissed");
  });

  it("--wait-for-copilot suppresses both auto-detect skips", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100", "--wait-for-copilot", "--claim-deadline-sec", "1"],
      baseDeps(gh, 0, {
        readCopilotLogin: () => LOGIN,
        readHistoricalBotReview: () => true,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as CheckResult;
    expect(result.status).toBe("waiting");
  });
});

// ---------------------------------------------------------------------------
// 10. Workflow-trigger filesystem behavior (real cwd -> defaultReadWorkflowsDir
//     seam, no readWorkflowsDir injection). Verifies PR #152's fix survives
//     the split: schedule-only workflows must not trip ciConfigured=true.
// ---------------------------------------------------------------------------

describe("run() — workflow trigger filesystem behavior", () => {
  function writeWorkflow(tmp: string, name: string, body: string): void {
    const wfDir = path.join(tmp, ".github", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, name), body);
  }

  it("schedule-only workflow: ciConfigured=false, no 'gh pr checks' call", async () => {
    writeWorkflow(
      globalCwd,
      "cron.yml",
      "on:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo noop\n",
    );
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readWorkflowsDir: undefined, cwd: globalCwd }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(false);
    expect(result.copilotConfigured).toBe(false);
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "checks")).toBe(
      false,
    );
  });

  it("mixed workflows directory: schedule-only .yml + qualifying .yaml -> ciConfigured=true", async () => {
    writeWorkflow(
      globalCwd,
      "cron.yml",
      "on:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo noop\n",
    );
    writeWorkflow(
      globalCwd,
      "ci.yaml",
      "on:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n",
    );
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      {
        matches: isMergeState,
        response: { stdout: "", stderr: "", exitCode: 0 },
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readWorkflowsDir: undefined,
        readMergeState: undefined,
        cwd: globalCwd,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.ciConfigured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Stateless mode (no FLOW_SLUG resolves)
// ---------------------------------------------------------------------------

describe("run() — stateless mode", () => {
  it("warns on stderr and still emits a decision when no FLOW_SLUG resolves", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readWorkflowsDir: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    expect(cap.stderr.join("")).toMatch(/stateless mode/);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("merged-externally");
  });

  it("resets anchors on every call in stateless mode (elapsedSec always ~0 for a still-pending CI)", async () => {
    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap1 = captureStreams();
    await run(["100"], baseDeps(gh1, 0));
    cap1.restore();

    // A second call, far in wall-clock time, but stateless — no persisted
    // startedAt to compare against, so this call's elapsedSec starts fresh.
    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(["100"], baseDeps(gh2, 100000 * 1000));
    cap2.restore();
    const result2 = JSON.parse(cap2.stdout.join("")) as CheckResult;
    expect((result2 as { elapsedSec: number }).elapsedSec).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 12. registrySelfCheck wiring — the diagnostic never mutates the verdict.
// ---------------------------------------------------------------------------

describe("run() — registrySelfCheck wiring", () => {
  it("the startup wiring never mutates the --out verdict JSON", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const outPathA = path.join(globalCwd, "no-warning", "result.json");
    const capA = captureStreams();
    await run(
      ["100", "--out", outPathA],
      baseDeps(gh, 0, {
        registrySelfCheck: () => null,
        readWorkflowsDir: () => false,
      }),
    );
    capA.restore();
    const resultA = JSON.parse(capA.stdout.join(""));

    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const outPathB = path.join(globalCwd, "with-warning", "result.json");
    const capB = captureStreams();
    await run(
      ["100", "--out", outPathB],
      baseDeps(gh2, 0, {
        registrySelfCheck: () =>
          "running inside pipeline 'x' with no process-registry row for pid 1 — likely launched without the flow-spawn wrapper",
        readWorkflowsDir: () => false,
      }),
    );
    capB.restore();
    const resultB = JSON.parse(capB.stdout.join(""));

    expect(Object.keys(resultB).sort()).toEqual(Object.keys(resultA).sort());
    expect(capB.stderr.join("")).toMatch(
      /likely launched without the flow-spawn wrapper/,
    );
    expect(capA.stderr.join("")).not.toMatch(/flow-spawn wrapper/);
  });
});

// Sanity: registrySelfCheck itself (moved to ./lib/ci-observe, covered fully
// in ci-observe.test.ts) is reachable from this file's import for the
// wiring test above.
void registrySelfCheck;

// ===========================================================================
// PORTED FROM .flow-tmp/orig-flow-ci-wait.test.ts (plan Task 5) — every
// remaining run()-integration scenario from the pre-split suite, translated
// to the one-shot `run()` contract: a multi-poll original (clock.advance /
// sleep driving the next iteration) becomes multiple `run()` invocations
// against the SAME `--state-dir`, each with an advanced `--now`; a pure
// cadence-ramp original collapses to the flat-60 `nextCheckSec` contract;
// the old no-observation `ci-hang` shape is the NEW `status:"waiting"` +
// `observation:"failed"` + `observationFailedSec>=1200` contract (already
// covered above, never re-asserted here).
// ===========================================================================

// ---------------------------------------------------------------------------
// Ported: `run() integration` (orig lines 1955-2659) — remaining scenarios.
// Already covered above under "run() — decision matrix" / "suspension
// immunity": merged-externally poll 1, pr-closed poll 1, ci-failed poll 1,
// proceed-to-review poll 1, and the genuine ci-hang-after-1200s case.
// ---------------------------------------------------------------------------

describe("run() integration (ported)", () => {
  it("derives copilotConfigured=true from a [bot]-suffixed reviewRequests entry (historical fallback off)", async () => {
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse([
          "copilot-pull-request-reviewer[bot]",
        ]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], baseDeps(gh, 0));
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotConfigured).toBe(true);
  });

  it("exits 0 with 'proceed-to-review-no-bot' JSON after the 10-min copilot timeout", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-copilot-timeout";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-07-01T00:00:00.000Z");
    const PENDING_COPILOT_ON_HEAD: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer" },
        state: "PENDING",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const gh1 = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", PENDING_COPILOT_ON_HEAD),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms));
    cap1.restore();

    const laterMs = t0Ms + 600 * 1000;
    const gh2 = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", PENDING_COPILOT_ON_HEAD),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, laterMs),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.elapsedSec).toBeGreaterThanOrEqual(600);
  });

  it("does NOT fire 'unclaimed-after-deadline' when Copilot is visible only via the REST requested_reviewers endpoint", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-rest-only-copilot";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const LOGIN = "copilot-pull-request-reviewer";
    const t0Ms = Date.parse("2026-07-03T00:00:00.000Z");
    const gh: GhRunner = (argv) => {
      if (isRequestedReviewersRest(argv)) {
        return { stdout: JSON.stringify([LOGIN]), stderr: "", exitCode: 0 };
      }
      if (isReviewRequests(argv)) return reviewRequestsResponse([]);
      if (isPrView(argv)) return prViewResponse("OPEN", [], STABLE_HEAD_SHA);
      if (isPrChecks(argv)) return prChecksResponse(ALL_PASSED);
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const cap1 = captureStreams();
    await run(
      ["100", "--state-dir", dir],
      baseDeps(gh, t0Ms, {
        readCopilotLogin: () => LOGIN,
        readHistoricalBotReview: () => true,
      }),
    );
    cap1.restore();

    const laterMs = t0Ms + 600 * 1000;
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh, laterMs, {
        readCopilotLogin: () => LOGIN,
        readHistoricalBotReview: () => true,
      }),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    // The REST-only-visible Copilot is detected as queued, so the early
    // unclaimed-after-deadline skip is suppressed and the wait runs to the
    // 10-min copilot timeout instead.
    expect(result2.copilotSkipReason).toBeNull();
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.copilotConfigured).toBe(true);
    expect(result2.elapsedSec).toBeGreaterThanOrEqual(600);
  });

  it("does NOT call 'gh pr checks' when CI is not configured", async () => {
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readWorkflowsDir: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(false);
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "checks")).toBe(
      false,
    );
  });

  it("does NOT wait the copilot timeout when Copilot is not in reviewRequests", async () => {
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["someone-else"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], baseDeps(gh, 0));
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotConfigured).toBe(false);
    expect(result.polls).toBe(1);
  });

  it("--copilot-not-requested forces copilotConfigured=false even when historical fallback would say true (decline-collapse)", async () => {
    const gh = makeGhSequence([
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100", "--copilot-not-requested"],
      baseDeps(gh, 0, { readHistoricalBotReview: () => true }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(false);
    expect(result.decision).toBe("proceed-to-review");
    expect(result.polls).toBe(1);
  });

  it("a deselected copilot module collapses copilotConfigured to false, skips both live signals (including the upstream fetchRequestedReviewers gh reads), and emits a one-shot notice on stderr", async () => {
    const gh = makeGhSequence([
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        isCopilotModuleActive: () => false,
        readHistoricalBotReview: () => {
          throw new Error(
            "readHistoricalBotReview must not be called when copilot is deselected",
          );
        },
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(false);
    expect(result.decision).toBe("proceed-to-review");
    expect(result.polls).toBe(1);
    expect(cap.stderr.join("")).toMatch(
      /copilot module not installed \(deselected\)/,
    );
  });

  it("prints the per-invocation progress line to stderr, not stdout", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    await run(["100"], baseDeps(gh, 0, { readWorkflowsDir: () => false }));
    cap.restore();
    // Final JSON on stdout; progress on stderr. The split's per-poll marker
    // reads "CI check N, elapsed ..." (record.checks), not the pre-split
    // helper's "CI poll N" text.
    expect(cap.stdout.join("")).toMatch(/"decision":/);
    expect(cap.stdout.join("")).not.toMatch(/CI check/);
    expect(cap.stderr.join("")).toMatch(/CI check 1/);
  });

  it("exits 2 with usage error on bad CLI args", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const gh: GhRunner = () => {
      throw new Error("gh must not be called on a parseArgs failure");
    };
    const exit = await run([], baseDeps(gh, 0));
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  it("respects the historical-PR fallback when reviewRequests is empty: copilot review pending → wait, not decide on the first invocation", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-historical-fallback-wait";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-07-02T00:00:00.000Z");
    const PENDING_COPILOT_ON_HEAD: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer" },
        state: "PENDING",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", PENDING_COPILOT_ON_HEAD),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap1 = captureStreams();
    const exit1 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh1, t0Ms, { readHistoricalBotReview: () => true }),
    );
    cap1.restore();
    expect(exit1).toBe(0);
    const result1 = JSON.parse(cap1.stdout.join("")) as CheckResult;
    expect(result1.status).toBe("waiting");

    const laterMs = t0Ms + 600 * 1000;
    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", PENDING_COPILOT_ON_HEAD),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, laterMs, { readHistoricalBotReview: () => true }),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.copilotConfigured).toBe(true);
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.elapsedSec).toBeGreaterThanOrEqual(600);
    expect(result2.polls).toBeGreaterThan(1);
  });

  it("preserves COPILOT_REQUESTED=0 semantics when the historical-PR fallback misses", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readHistoricalBotReview: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(false);
    expect(result.decision).toBe("proceed-to-review");
    expect(result.polls).toBe(1);
  });

  it("does NOT invoke the historical-PR fallback when Copilot is already in reviewRequests", async () => {
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    let fallbackCalls = 0;
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readHistoricalBotReview: () => {
          fallbackCalls++;
          return true;
        },
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    expect(fallbackCalls).toBe(0); // short-circuited before the fallback
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(true);
    expect(result.decision).toBe("proceed-to-review");
  });

  it("collapses fallback errors to false (transient gh failure must not synthesise bot configured)", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: (argv) =>
          argv[0] === "repo" && argv.includes("defaultBranchRef"),
        response: { stdout: "main", stderr: "", exitCode: 0 },
      },
      {
        matches: (argv) => argv[0] === "api",
        response: { stdout: "", stderr: "forbidden", exitCode: 1 },
      },
      {
        matches: (argv) => argv[0] === "pr" && argv[1] === "list",
        response: { stdout: "", stderr: "boom", exitCode: 1 },
      },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readHistoricalBotReview: undefined }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(false);
    expect(result.decision).toBe("proceed-to-review");
    expect(result.polls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ported: `readHistoricalBotReview default wiring` (orig lines 1343-1502).
// ---------------------------------------------------------------------------

describe("readHistoricalBotReview default wiring (ported)", () => {
  it("falls through to the 5-PR heuristic when the ruleset read is 'unknown' (403)", async () => {
    const LOGIN = "copilot-pull-request-reviewer";
    const calls: string[][] = [];
    const gh: GhRunner = (argv) => {
      calls.push(argv);
      if (argv[0] === "repo")
        return { stdout: "main", stderr: "", exitCode: 0 };
      if (argv[0] === "api")
        return { stdout: "", stderr: "forbidden", exitCode: 1 };
      if (argv[0] === "pr" && argv[1] === "list") {
        return {
          stdout: JSON.stringify([{ number: 1 }]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (isPrView(argv)) return prViewResponse("OPEN", [], STABLE_HEAD_SHA);
      if (isReviewRequests(argv)) return reviewRequestsResponse([]);
      if (isPrChecks(argv)) return prChecksResponse(ALL_PASSED);
      if (argv[0] === "pr" && argv[1] === "view") {
        return {
          stdout: JSON.stringify({ reviews: [{ author: { login: LOGIN } }] }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readCopilotLogin: () => LOGIN,
        readHistoricalBotReview: undefined,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(true);
    expect(result.copilotConfigured).toBe(true);
  });

  it("short-circuits on an authoritative-true ruleset without consulting the heuristic", async () => {
    const LOGIN = "copilot-pull-request-reviewer";
    const calls: string[][] = [];
    const gh: GhRunner = (argv) => {
      calls.push(argv);
      if (argv[0] === "repo")
        return { stdout: "main", stderr: "", exitCode: 0 };
      if (argv[0] === "api") {
        return {
          stdout: JSON.stringify([{ type: "copilot_code_review" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (isReviewRequests(argv)) return reviewRequestsResponse([]);
      if (isPrView(argv)) return prViewResponse("OPEN", [], STABLE_HEAD_SHA);
      if (isPrChecks(argv)) return prChecksResponse(ALL_PASSED);
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readCopilotLogin: () => LOGIN,
        readHistoricalBotReview: undefined,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(true);
    expect(calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(false);
  });

  it("short-circuits on an authoritative-false ruleset without consulting the heuristic", async () => {
    const LOGIN = "copilot-pull-request-reviewer";
    const calls: string[][] = [];
    const gh: GhRunner = (argv) => {
      calls.push(argv);
      if (argv[0] === "repo")
        return { stdout: "main", stderr: "", exitCode: 0 };
      if (argv[0] === "api") {
        return {
          stdout: JSON.stringify([{ type: "pull_request" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (isReviewRequests(argv)) return reviewRequestsResponse([]);
      if (isPrView(argv)) return prViewResponse("OPEN", [], STABLE_HEAD_SHA);
      if (isPrChecks(argv)) return prChecksResponse(ALL_PASSED);
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readCopilotLogin: () => LOGIN,
        readHistoricalBotReview: undefined,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(false);
    expect(calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ported: `run() integration — Copilot retrigger` (orig lines 2660-3141).
// ---------------------------------------------------------------------------

describe("run() — Copilot retrigger (ported)", () => {
  it("(1) stale Copilot retrigger fires; fresh review at matching commit lands on the next invocation → proceed-to-review", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-retrigger-1";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-05-02T00:00:00.000Z");
    const stale = staleCopilotReview(STALE_SHA);
    const fresh = staleCopilotReview(HEAD_SHA);
    const allCalls: string[][] = [];
    const deps = {
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    };

    const gh1 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
        {
          matches: isRequestedReviewersPost,
          response: { stdout: "", stderr: "", exitCode: 0 },
        },
        postRetriggerReviewRequests(COPILOT_QUEUED),
      ],
      allCalls,
    );
    const cap1 = captureStreams();
    const exit1 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh1, t0Ms, deps),
    );
    cap1.restore();
    expect(exit1).toBe(0);
    const result1 = JSON.parse(cap1.stdout.join("")) as CheckResult;
    expect(result1.status).toBe("waiting");

    const gh2 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", fresh, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      ],
      allCalls,
    );
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, t0Ms + 1000, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review");
    expect(result2.copilotRetriggered).toBe(true);
    expect(result2.polls).toBe(2);
    // Exactly one POST landed across both invocations.
    expect(allCalls.filter(isRequestedReviewersPost)).toHaveLength(1);
  });

  it("(2) one-shot enforcement: stale review + no fresh review ever lands → proceed-to-review-no-bot, exactly one POST", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-retrigger-2";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-05-03T00:00:00.000Z");
    const stale = staleCopilotReview(STALE_SHA);
    const allCalls: string[][] = [];
    const deps = {
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    };

    const gh1 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
        {
          matches: isRequestedReviewersPost,
          response: { stdout: "", stderr: "", exitCode: 0 },
        },
        postRetriggerReviewRequests(COPILOT_QUEUED),
      ],
      allCalls,
    );
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms, deps));
    cap1.restore();

    const laterMs = t0Ms + 600 * 1000;
    const gh2 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      ],
      allCalls,
    );
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, laterMs, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.copilotRetriggered).toBe(true);
    // One-shot: exactly one POST regardless of subsequent invocations.
    expect(allCalls.filter(isRequestedReviewersPost)).toHaveLength(1);
  });

  it("(3) non-stale: latest Copilot review commit === headRefOid → proceed-to-review, no POST", async () => {
    const fresh = staleCopilotReview(HEAD_SHA);
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", fresh, HEAD_SHA) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readCommitsAreAllMerges: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotRetriggered).toBe(false);
    expect(result.polls).toBe(1);
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(0);
  });

  it("(4) retrigger gated on CI terminal: stale review with pending CI holds off the POST until CI reaches terminal", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-retrigger-4";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-05-04T00:00:00.000Z");
    const stale = staleCopilotReview(STALE_SHA);
    const fresh = staleCopilotReview(HEAD_SHA);
    const PENDING_CHECKS: Check[] = [{ name: "test", state: "IN_PROGRESS" }];
    const allCalls: string[][] = [];
    const deps = {
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    };

    // Poll 1: CI pending, stale review → no retrigger.
    const gh1 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) },
      ],
      allCalls,
    );
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms, deps));
    cap1.restore();

    // Poll 2: still pending, stale review → still no retrigger.
    const gh2 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) },
      ],
      allCalls,
    );
    const cap2 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh2, t0Ms + 30_000, deps));
    cap2.restore();

    // Poll 3: CI all-passed, stale review → retrigger fires.
    const gh3 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
        {
          matches: isRequestedReviewersPost,
          response: { stdout: "", stderr: "", exitCode: 0 },
        },
        postRetriggerReviewRequests(COPILOT_QUEUED),
      ],
      allCalls,
    );
    const cap3 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh3, t0Ms + 60_000, deps));
    cap3.restore();

    // Poll 4: fresh review lands → proceed-to-review.
    const gh4 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", fresh, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      ],
      allCalls,
    );
    const cap4 = captureStreams();
    const exit4 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh4, t0Ms + 90_000, deps),
    );
    cap4.restore();
    expect(exit4).toBe(0);
    const result4 = JSON.parse(cap4.stdout.join("")) as RunResult;
    expect(result4.decision).toBe("proceed-to-review");
    expect(result4.copilotRetriggered).toBe(true);
    expect(result4.polls).toBe(4);
    // The POST landed only after CI went terminal on invocation 3.
    expect(allCalls.filter(isRequestedReviewersPost)).toHaveLength(1);
  });

  it("(5) POST failure: gh returns non-zero on the POST → loop continues, copilotRetriggered:true, no retry", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-retrigger-5";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-05-05T00:00:00.000Z");
    const stale = staleCopilotReview(STALE_SHA);
    const allCalls: string[][] = [];
    const deps = {
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    };

    const gh1 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
        {
          matches: isRequestedReviewersPost,
          response: { stdout: "", stderr: "HTTP 422", exitCode: 1 },
        },
        // POST non-zero: NO post-POST re-read.
      ],
      allCalls,
    );
    const cap1 = captureStreams();
    const exit1 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh1, t0Ms, deps),
    );
    cap1.restore();
    expect(exit1).toBe(0);
    expect(cap1.stderr.join("")).toMatch(/Copilot retrigger failed/);

    const laterMs = t0Ms + 600 * 1000;
    const gh2 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      ],
      allCalls,
    );
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, laterMs, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.copilotRetriggered).toBe(true);
    // No second POST attempt even though the first failed.
    expect(allCalls.filter(isRequestedReviewersPost)).toHaveLength(1);
  });

  it("(6) skips retrigger when every intervening commit is a merge", async () => {
    const stale = staleCopilotReview(STALE_SHA);
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readCommitsAreAllMerges: () => true }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotRetriggered).toBe(false);
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(0);
    expect(result.decision).toBe("proceed-to-review");
    expect(cap.stderr.join("")).toMatch(
      /every intervening commit is a merge, skipping retrigger/,
    );
  });

  it("(7) fires retrigger when at least one intervening commit is a regular non-merge commit (regression: readCommitsAreAllMerges=false must not block the retrigger)", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-retrigger-7";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-05-07T00:00:00.000Z");
    const stale = staleCopilotReview(STALE_SHA);
    const fresh = staleCopilotReview(HEAD_SHA);
    const allCalls: string[][] = [];
    const deps = {
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    };

    const gh1 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
        {
          matches: isRequestedReviewersPost,
          response: { stdout: "", stderr: "", exitCode: 0 },
        },
        postRetriggerReviewRequests(COPILOT_QUEUED),
      ],
      allCalls,
    );
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms, deps));
    cap1.restore();

    const gh2 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", fresh, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      ],
      allCalls,
    );
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, t0Ms + 1000, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review");
    expect(result2.copilotRetriggered).toBe(true);
    expect(allCalls.filter(isRequestedReviewersPost)).toHaveLength(1);
  });

  it("(8) skips retrigger when intervening commits are a small follow-up", async () => {
    const stale = staleCopilotReview(STALE_SHA);
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readCommitsAreAllMerges: () => false,
        readIsSmallFollowup: () => true,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotRetriggered).toBe(false);
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(0);
    expect(result.decision).toBe("proceed-to-review");
    expect(cap.stderr.join("")).toMatch(/small follow-up, skipping retrigger/);
  });

  it("(9) fires retrigger when the intervening change is over the small-follow-up thresholds (regression: readIsSmallFollowup=false must not block the retrigger)", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-retrigger-9";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-05-09T00:00:00.000Z");
    const stale = staleCopilotReview(STALE_SHA);
    const fresh = staleCopilotReview(HEAD_SHA);
    const allCalls: string[][] = [];
    const deps = {
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    };

    const gh1 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
        {
          matches: isRequestedReviewersPost,
          response: { stdout: "", stderr: "", exitCode: 0 },
        },
        postRetriggerReviewRequests(COPILOT_QUEUED),
      ],
      allCalls,
    );
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms, deps));
    cap1.restore();

    const gh2 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", fresh, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      ],
      allCalls,
    );
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, t0Ms + 1000, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review");
    expect(result2.copilotRetriggered).toBe(true);
    expect(allCalls.filter(isRequestedReviewersPost)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ported: `run() integration — per-poll requested_reviewers signal` (orig
// lines 3151-3230). The stderr distinction fires per-poll (not cumulative),
// so a single terminal-CI invocation exercises it — no multi-invocation
// translation needed.
// ---------------------------------------------------------------------------

describe("run() — per-poll requested_reviewers signal (ported)", () => {
  it("logs 'Copilot queued, still waiting' when Copilot is in requested_reviewers (CI terminal, no review)", async () => {
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], baseDeps(gh, 0));
    cap.restore();
    expect(exit).toBe(0);
    const err = cap.stderr.join("");
    expect(err).toContain("Copilot queued, still waiting");
    expect(err).not.toContain("no Copilot review yet");
  });

  // A2 (rethread) regression anchor: entry reviewRequests is empty but
  // readHistoricalBotReview forces copilotConfigured=true, so this only
  // logs "no Copilot review yet" (rather than "queued") if the stderr
  // distinction is driven by the loop-entry snapshot rethreaded into
  // deriveCopilotSkipReason/copilotRequestedThisPoll — not a second,
  // now-removed per-poll re-read.
  it("logs 'no Copilot review yet' when Copilot is absent from requested_reviewers (CI terminal, no review)", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readHistoricalBotReview: () => true }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const err = cap.stderr.join("");
    expect(err).toContain("no Copilot review yet");
    expect(err).not.toContain("Copilot queued, still waiting");
  });

  it("reads requested_reviewers exactly once per copilot-configured OPEN poll (no redundant mid-poll re-read)", async () => {
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], baseDeps(gh, 0));
    cap.restore();
    expect(exit).toBe(0);
    expect(gh.calls.filter(isReviewRequests)).toHaveLength(1);
    expect(gh.calls.filter(isRequestedReviewersRest)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ported: `run() integration — post-POST verification (item 2)` (orig lines
// 3241-3397).
// ---------------------------------------------------------------------------

describe("run() — post-POST verification, item 2 (ported)", () => {
  it("POST ok + re-read confirms Copilot queued → copilotRetriggered:true, loop continues", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-postpost-1";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-05-10T00:00:00.000Z");
    const stale = staleCopilotReview(STALE_SHA);
    const fresh = staleCopilotReview(HEAD_SHA);
    const deps = {
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    };

    const gh1 = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      {
        matches: isRequestedReviewersPost,
        response: { stdout: "", stderr: "", exitCode: 0 },
      },
      postRetriggerReviewRequests(COPILOT_QUEUED),
    ]);
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms, deps));
    cap1.restore();

    const gh2 = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", fresh, HEAD_SHA) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, t0Ms + 1000, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review");
    expect(result2.copilotRetriggered).toBe(true);
    expect(result2.polls).toBe(2);
  });

  it("POST ok + re-read misses (silent rejection) → proceed-to-review-no-bot, copilotRetriggered:false, NOTICE, no 10-min wait, and the persisted anchors are restored", async () => {
    // Stateful (--state-dir), not the bare `["100"]` the previous version
    // of this test used: with no `--state-dir`, `persistRecord()` returns
    // at its first line (`stateless === true`), so the pre-fix code
    // (leaving `record.copilotRetriggered = true` and `ciTerminalAt`
    // un-restored in the persisted record) would have passed this test
    // just as well as the fix — the wire-only assertions below cannot
    // distinguish the two. Running with a real state dir and reading the
    // persisted record back closes that gap.
    const dir = makeStateDir();
    const slug = "flow-ci-check-silent-rejection-restore";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const stale = staleCopilotReview(STALE_SHA);
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      {
        matches: isRequestedReviewersPost,
        response: { stdout: "", stderr: "", exitCode: 0 },
      },
      postRetriggerReviewRequests(COPILOT_NOT_QUEUED),
      // No further steps: the invocation must short-circuit and return.
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh, 0, {
        readCommitsAreAllMerges: () => false,
        readIsSmallFollowup: () => false,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotRetriggered).toBe(false);
    expect(result.polls).toBe(1);
    expect(result.elapsedSec).toBeLessThan(600);
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(1);
    expect(cap.stderr.join("")).toContain("NOTICE");
    expect(cap.stderr.join("")).toContain("silent rejection");

    // The persisted record — not just the wire result — must show the
    // restore: a declined re-request never spends the one-shot retrigger
    // budget, so `copilotRetriggered` is `false` and `copilotRetriggeredAt`
    // is cleared in state.json, not merely on the emitted decision.
    const persisted = readAnchors(dir, slug)!;
    expect(persisted.copilotRetriggered).toBe(false);
    expect(persisted.copilotRetriggeredAt).toBeUndefined();
  });

  it("POST non-zero (422/403) path is unchanged: copilotRetriggered:true, no re-read, falls through to the timeout", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-postpost-3";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-05-11T00:00:00.000Z");
    const stale = staleCopilotReview(STALE_SHA);
    const allCalls: string[][] = [];
    const deps = {
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    };

    const gh1 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
        {
          matches: isRequestedReviewersPost,
          response: {
            stdout: "",
            stderr: "HTTP 422: Unprocessable",
            exitCode: 1,
          },
        },
        // POST non-zero: NO post-POST re-read.
      ],
      allCalls,
    );
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms, deps));
    cap1.restore();

    const laterMs = t0Ms + 600 * 1000;
    const gh2 = trackingGhSequence(
      [
        {
          matches: isReviewRequests,
          response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
        },
        {
          matches: isPrView,
          response: prViewResponse("OPEN", stale, HEAD_SHA),
        },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      ],
      allCalls,
    );
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, laterMs, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.copilotRetriggered).toBe(true);
    expect(result2.elapsedSec).toBeGreaterThanOrEqual(600);
    expect(allCalls.filter(isRequestedReviewersPost)).toHaveLength(1);
    expect(cap1.stderr.join("")).toContain("Copilot retrigger failed");
    expect(cap1.stderr.join("")).not.toContain("NOTICE");
  });
});

// ---------------------------------------------------------------------------
// Ported: `run() integration — Copilot auto-detect short-circuit` (orig
// lines 3411-3998). The canonical 'unclaimed-after-deadline' scenario and
// the basic '--wait-for-copilot suppresses both auto-detect skips' scenario
// are already covered above under "run() — Copilot auto-detect
// short-circuit"; this block ports the remaining precedence/config/
// regression scenarios.
// ---------------------------------------------------------------------------

describe("run() — Copilot auto-detect short-circuit (ported)", () => {
  const LOGIN = "copilot-pull-request-reviewer";

  it("config readClaimDeadline (30) drives the deadline when no --claim-deadline-sec flag → fires on the next invocation", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-autodetect-config-30";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-06-02T00:00:00.000Z");
    const deps = {
      readCopilotLogin: () => LOGIN,
      readClaimDeadline: () => 30,
      readHistoricalBotReview: () => true,
    };

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms, deps));
    cap1.restore();

    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, t0Ms + 30_000, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.copilotSkipReason).toBe("unclaimed-after-deadline");
    expect(result2.polls).toBe(2);
  });

  it("--claim-deadline-sec flag (30) overrides config readClaimDeadline (5000) → fires on the next invocation", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-autodetect-flag-overrides-config";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-06-02T12:00:00.000Z");
    // High config value loses to the flag; if config won here the
    // short-circuit would not fire by invocation 2.
    const deps = {
      readCopilotLogin: () => LOGIN,
      readClaimDeadline: () => 5000,
      readHistoricalBotReview: () => true,
    };

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap1 = captureStreams();
    await run(
      ["100", "--state-dir", dir, "--claim-deadline-sec", "30"],
      baseDeps(gh1, t0Ms, deps),
    );
    cap1.restore();

    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir, "--claim-deadline-sec", "30"],
      baseDeps(gh2, t0Ms + 30_000, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.copilotSkipReason).toBe("unclaimed-after-deadline");
    expect(result2.polls).toBe(2);
  });

  it("falls back to DEFAULT_CLAIM_DEADLINE_SEC (60) when neither flag nor config is set", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-autodetect-default-60";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-06-03T00:00:00.000Z");
    const deps = {
      readCopilotLogin: () => LOGIN,
      readClaimDeadline: () => undefined,
      readHistoricalBotReview: () => true,
    };

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms, deps));
    cap1.restore();

    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, t0Ms + 60_000, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.copilotSkipReason).toBe("unclaimed-after-deadline");
    expect(result2.polls).toBe(2);
  });

  it("'self-dismissed' fires when DISMISSED on current headRefOid + retrigger does NOT fire", async () => {
    const dismissed: Review[] = [
      {
        author: { login: LOGIN },
        state: "DISMISSED",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", dismissed, STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readCopilotLogin: () => LOGIN,
        readCommitsAreAllMerges: () => false,
        readIsSmallFollowup: () => false,
        readHistoricalBotReview: () => true,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotSkipReason).toBe("self-dismissed");
    expect(result.polls).toBe(1);
    // CRITICAL ORDERING assertion: the stale-review retrigger does NOT fire
    // when self-dismissed short-circuits — auto-detect runs BEFORE the
    // retrigger gate.
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(0);
  });

  it("--wait-for-copilot suppresses 'self-dismissed' on current-SHA DISMISSED (falls through to the retrigger gate)", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-autodetect-wait-dismissed";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-06-04T00:00:00.000Z");
    const dismissed: Review[] = [
      {
        author: { login: LOGIN },
        state: "DISMISSED",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const deps = {
      readCopilotLogin: () => LOGIN,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
      readHistoricalBotReview: () => true,
    };

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", dismissed, STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap1 = captureStreams();
    await run(
      ["100", "--state-dir", dir, "--wait-for-copilot"],
      baseDeps(gh1, t0Ms, deps),
    );
    cap1.restore();

    const laterMs = t0Ms + 600 * 1000;
    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", dismissed, STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir, "--wait-for-copilot"],
      baseDeps(gh2, laterMs, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    // copilotSkipReason is null (the existing 10-min timeout fired, not the
    // auto-detect path).
    expect(result2.copilotSkipReason).toBeNull();
    expect(result2.elapsedSec).toBeGreaterThanOrEqual(600);
  });

  it("--wait-for-copilot suppresses 'unclaimed-after-deadline' too (falls through to the 10-min timeout)", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-autodetect-wait-unclaimed";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-06-05T00:00:00.000Z");
    const pending: Review[] = [
      {
        author: { login: LOGIN },
        state: "PENDING",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const deps = {
      readCopilotLogin: () => LOGIN,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
      readHistoricalBotReview: () => true,
    };

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", pending, STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap1 = captureStreams();
    await run(
      [
        "100",
        "--state-dir",
        dir,
        "--wait-for-copilot",
        "--claim-deadline-sec",
        "30",
      ],
      baseDeps(gh1, t0Ms, deps),
    );
    cap1.restore();

    const laterMs = t0Ms + 600 * 1000;
    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", pending, STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      [
        "100",
        "--state-dir",
        dir,
        "--wait-for-copilot",
        "--claim-deadline-sec",
        "30",
      ],
      baseDeps(gh2, laterMs, deps),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review-no-bot");
    expect(result2.copilotSkipReason).toBeNull();
    expect(result2.elapsedSec).toBeGreaterThanOrEqual(600);
  });

  it("ci-failed wins over 'unclaimed-after-deadline' (regression: short-circuit must not bypass ci-failed)", async () => {
    const failed: Check[] = [{ name: "lint", state: "FAILURE" }];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(failed) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100", "--claim-deadline-sec", "30"],
      baseDeps(gh, 0, {
        readCopilotLogin: () => LOGIN,
        readCommitsAreAllMerges: () => false,
        readIsSmallFollowup: () => false,
        readHistoricalBotReview: () => true,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("ci-failed");
    expect(result.copilotSkipReason).toBeNull();
    expect(result.ciFailedChecks).toEqual(failed);
  });

  it("ci-failed wins over 'self-dismissed' (regression: short-circuit must not bypass ci-failed)", async () => {
    const failed: Check[] = [{ name: "test", state: "FAILURE" }];
    const dismissed: Review[] = [
      {
        author: { login: LOGIN },
        state: "DISMISSED",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", dismissed, STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(failed) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readCopilotLogin: () => LOGIN,
        readCommitsAreAllMerges: () => false,
        readIsSmallFollowup: () => false,
        readHistoricalBotReview: () => true,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("ci-failed");
    expect(result.copilotSkipReason).toBeNull();
    expect(result.ciFailedChecks).toEqual(failed);
  });

  it("merged-externally wins over 'self-dismissed' (regression: short-circuit must not bypass pr-state)", async () => {
    const dismissed: Review[] = [
      {
        author: { login: LOGIN },
        state: "DISMISSED",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("MERGED", dismissed, STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readCopilotLogin: () => LOGIN,
        readCommitsAreAllMerges: () => false,
        readIsSmallFollowup: () => false,
        readHistoricalBotReview: () => true,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("merged-externally");
    expect(result.copilotSkipReason).toBeNull();
    expect(result.prState).toBe("MERGED");
    expect(result.copilotConfigured).toBe(true);
  });

  it("pr-closed wins over 'self-dismissed' (regression: short-circuit must not bypass pr-state)", async () => {
    const dismissed: Review[] = [
      {
        author: { login: LOGIN },
        state: "DISMISSED",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      {
        matches: isPrView,
        response: prViewResponse("CLOSED", dismissed, STABLE_HEAD_SHA),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readCopilotLogin: () => LOGIN,
        readCommitsAreAllMerges: () => false,
        readIsSmallFollowup: () => false,
        readHistoricalBotReview: () => true,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-closed");
    expect(result.copilotSkipReason).toBeNull();
    expect(result.prState).toBe("CLOSED");
    expect(result.copilotConfigured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ported: `run() integration — branch-conflict short-circuit` (orig lines
// 4012-4192).
// ---------------------------------------------------------------------------

describe("run() — branch-conflict short-circuit (ported)", () => {
  it("(1) CONFLICTING at entry → pr-conflicted at poll 1", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readWorkflowsDir: () => false,
        readMergeState: () => ({
          mergeable: "CONFLICTING",
          mergeStateStatus: "CONFLICTING",
        }),
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-conflicted");
    expect(result.polls).toBe(1);
    expect(cap.stderr.join("")).toMatch(/Branch conflict detected/);
  });

  it("(2) DIRTY at entry → pr-conflicted at poll 1", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readWorkflowsDir: () => false,
        readMergeState: () => ({
          mergeable: "MERGEABLE",
          mergeStateStatus: "DIRTY",
        }),
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-conflicted");
    expect(result.polls).toBe(1);
  });

  it("(3) mergeable/mergeStateStatus UNKNOWN (still computing) does NOT short-circuit — keeps polling to a terminal decision", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-conflict-unknown";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-04-10T00:00:00.000Z");
    const PENDING_CHECKS: Check[] = [{ name: "test", state: "IN_PROGRESS" }];
    const UNKNOWN_MERGE = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) },
    ]);
    const cap1 = captureStreams();
    await run(
      ["100", "--state-dir", dir],
      baseDeps(gh1, t0Ms, { readMergeState: () => UNKNOWN_MERGE }),
    );
    cap1.restore();

    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, t0Ms + 30_000, { readMergeState: () => UNKNOWN_MERGE }),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("proceed-to-review");
    expect(result2.polls).toBeGreaterThan(1);
  });

  it("(4) mid-wait flip: CLEAN on the first invocation then CONFLICTING on the next → pr-conflicted", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-conflict-flip";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-04-11T00:00:00.000Z");
    const PENDING_CHECKS: Check[] = [{ name: "test", state: "IN_PROGRESS" }];

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) },
    ]);
    const cap1 = captureStreams();
    await run(
      ["100", "--state-dir", dir],
      baseDeps(gh1, t0Ms, { readMergeState: () => CLEAN_MERGE }),
    );
    cap1.restore();

    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, t0Ms + 30_000, {
        readMergeState: () => ({
          mergeable: "CONFLICTING",
          mergeStateStatus: "CONFLICTING",
        }),
      }),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("pr-conflicted");
    expect(result2.polls).toBe(2);
  });

  it("(5) transient gh merge-state failure (readMergeState → null) keeps polling — no false pr-conflicted", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readMergeState: () => null }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(cap.stderr.join("")).not.toMatch(/Branch conflict detected/);
  });

  it("(6) precedence: MERGED PR with CONFLICTING merge state → merged-externally (OPEN guard preserves precedence)", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readWorkflowsDir: () => false,
        readMergeState: () => ({
          mergeable: "CONFLICTING",
          mergeStateStatus: "CONFLICTING",
        }),
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("merged-externally");
    expect(result.prState).toBe("MERGED");
  });
});

// ---------------------------------------------------------------------------
// Ported: `run() integration — branch-protection short-circuit` (orig lines
// 4198-4399). The `it.each` 4-status table is expanded into 4 individual
// `it()` cases so each is a countable, independently-titled test.
// ---------------------------------------------------------------------------

describe("run() — branch-protection short-circuit (ported)", () => {
  const BLOCKED_MERGE = { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" };

  it("(1) CI vacuously terminal + BLOCKED → pr-blocked at poll 1", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readWorkflowsDir: () => false,
        readMergeState: () => BLOCKED_MERGE,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-blocked");
    expect(result.polls).toBe(1);
    expect(cap.stderr.join("")).toMatch(
      /Branch protection blocked \(mergeStateStatus=BLOCKED\)/,
    );
  });

  it("(2) pending CI + BLOCKED does NOT fire while pending — fires only after CI reaches terminal", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-blocked-pending";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-04-12T00:00:00.000Z");
    const PENDING_CHECKS: Check[] = [{ name: "test", state: "IN_PROGRESS" }];

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) },
    ]);
    const cap1 = captureStreams();
    await run(
      ["100", "--state-dir", dir],
      baseDeps(gh1, t0Ms, { readMergeState: () => BLOCKED_MERGE }),
    );
    cap1.restore();

    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, t0Ms + 30_000, { readMergeState: () => BLOCKED_MERGE }),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("pr-blocked");
    expect(result2.polls).toBe(2);
  });

  it("(3a) CI terminal + non-blocking mergeStateStatus=CLEAN → proceed-to-review, never pr-blocked", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readMergeState: () => ({
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(cap.stderr.join("")).not.toMatch(/Branch protection blocked/);
  });

  it("(3b) CI terminal + non-blocking mergeStateStatus=BEHIND → proceed-to-review, never pr-blocked", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readMergeState: () => ({
          mergeable: "MERGEABLE",
          mergeStateStatus: "BEHIND",
        }),
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(cap.stderr.join("")).not.toMatch(/Branch protection blocked/);
  });

  it("(3c) CI terminal + non-blocking mergeStateStatus=UNSTABLE → proceed-to-review, never pr-blocked", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readMergeState: () => ({
          mergeable: "MERGEABLE",
          mergeStateStatus: "UNSTABLE",
        }),
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(cap.stderr.join("")).not.toMatch(/Branch protection blocked/);
  });

  it("(3d) CI terminal + non-blocking mergeStateStatus=HAS_HOOKS → proceed-to-review, never pr-blocked", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readMergeState: () => ({
          mergeable: "MERGEABLE",
          mergeStateStatus: "HAS_HOOKS",
        }),
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(cap.stderr.join("")).not.toMatch(/Branch protection blocked/);
  });

  it("(4) transient gh merge-state failure (readMergeState → null) keeps polling — no false pr-blocked", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readMergeState: () => null }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(cap.stderr.join("")).not.toMatch(/Branch protection blocked/);
  });

  it("(5) precedence: MERGED PR with BLOCKED merge state → merged-externally (OPEN guard preserves precedence)", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readWorkflowsDir: () => false,
        readMergeState: () => BLOCKED_MERGE,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("merged-externally");
    expect(result.prState).toBe("MERGED");
  });

  it("(6) proceed-to-review-no-bot arm: 10-min copilot timeout + still BLOCKED → pr-blocked", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-blocked-timeout";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const t0Ms = Date.parse("2026-04-13T00:00:00.000Z");
    const PENDING_COPILOT_ON_HEAD: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer" },
        state: "PENDING",
        commitOid: STABLE_HEAD_SHA,
      },
    ];

    const gh1 = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", PENDING_COPILOT_ON_HEAD),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap1 = captureStreams();
    await run(
      ["100", "--state-dir", dir],
      baseDeps(gh1, t0Ms, { readMergeState: () => BLOCKED_MERGE }),
    );
    cap1.restore();

    const laterMs = t0Ms + 600 * 1000;
    const gh2 = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", PENDING_COPILOT_ON_HEAD),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh2, laterMs, { readMergeState: () => BLOCKED_MERGE }),
    );
    cap2.restore();
    expect(exit2).toBe(0);
    const result2 = JSON.parse(cap2.stdout.join("")) as RunResult;
    expect(result2.decision).toBe("pr-blocked");
    expect(result2.elapsedSec).toBeGreaterThanOrEqual(600);
    expect(cap2.stderr.join("")).toMatch(
      /Branch protection blocked \(mergeStateStatus=BLOCKED\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Ported: `run() integration — workflow trigger filesystem behavior` (orig
// lines 4628-4814). The schedule-only and mixed-workflows-directory
// scenarios are already covered above under "run() — workflow trigger
// filesystem behavior"; this ports the remaining two.
// ---------------------------------------------------------------------------

describe("run() — workflow trigger filesystem behavior (ported)", () => {
  it("slow CI with qualifying trigger: ciConfigured=true, three invocations until SUCCESS lands", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-workflow-slow";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const wfDir = path.join(globalCwd, ".github", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, "ci.yml"),
      "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n",
    );
    const t0Ms = Date.parse("2026-04-14T00:00:00.000Z");
    const deps = {
      readWorkflowsDir: undefined,
      readMergeState: () => CLEAN_MERGE,
      readHistoricalBotReview: () => true, // bot expected -> don't short-circuit
    };

    // Invocation 1: empty checks -> no-checks-reported -> loop.
    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse([]) },
    ]);
    const cap1 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh1, t0Ms, deps));
    cap1.restore();

    // Invocation 2: still empty checks -> loop.
    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse([]) },
    ]);
    const cap2 = captureStreams();
    await run(["100", "--state-dir", dir], baseDeps(gh2, t0Ms + 30_000, deps));
    cap2.restore();

    // Invocation 3: SUCCESS + Copilot review posted -> exit.
    const gh3 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap3 = captureStreams();
    const exit3 = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh3, t0Ms + 60_000, deps),
    );
    cap3.restore();
    expect(exit3).toBe(0);
    const result3 = JSON.parse(cap3.stdout.join("")) as RunResult;
    expect(result3.decision).toBe("proceed-to-review");
    expect(result3.ciConfigured).toBe(true);
    expect(result3.polls).toBe(3);
  });

  it("no workflows directory: CI not configured, no 'gh pr checks' call", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, {
        readWorkflowsDir: undefined,
        readMergeState: () => CLEAN_MERGE,
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(false);
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "checks")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Ported: `run() integration — verdict persistence` (orig lines 4829-4973).
// The default-path and persist-write-failure scenarios (both on the MERGED
// fixture) are already covered above under "run() — --out persistence";
// this ports the two remaining scenarios (a different decision fixture and
// the pr-conflicted early-emit path).
// ---------------------------------------------------------------------------

describe("run() — verdict persistence (ported)", () => {
  it("writes the verdict to the --out path matching stdout on the standard proceed-to-review exit", async () => {
    const outPath = path.join(globalCwd, "out", "ci-wait-result.json");
    const gh = makeGhSequence([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100", "--out", outPath], baseDeps(gh, 0));
    cap.restore();
    expect(exit).toBe(0);
    const stdoutResult = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(stdoutResult.decision).toBe("proceed-to-review");
    expect(fs.existsSync(outPath)).toBe(true);
    const fileResult = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(fileResult).toEqual(stdoutResult);
  });

  it("writes the verdict on the pr-conflicted early-emit path", async () => {
    const outPath = path.join(globalCwd, "out", "ci-wait-result.json");
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100", "--out", outPath],
      baseDeps(gh, 0, {
        readWorkflowsDir: () => false,
        readMergeState: () => ({
          mergeable: "CONFLICTING",
          mergeStateStatus: "CONFLICTING",
        }),
      }),
    );
    cap.restore();
    expect(exit).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);
    const fileResult = JSON.parse(
      fs.readFileSync(outPath, "utf8"),
    ) as RunResult;
    expect(fileResult.decision).toBe("pr-conflicted");
  });
});

// ---------------------------------------------------------------------------
// 13. `advancePhase("ci-wait", ...)` side effect (plan.md Task 2)
// ---------------------------------------------------------------------------

describe("run() — phase advance", () => {
  it("advances a verifying pipeline to ci-wait, and the write survives persistRecord (not the priorState-cache regression)", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-phase-verifying";
    seedState(dir, slug, "verifying");
    process.env.FLOW_SLUG = slug;
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    // This path calls `decided()`, which calls `persistRecord()` exactly
    // once — asserting the phase AFTER this call is the regression guard:
    // if `persistRecord` still cached the pre-advance `priorState`, its
    // `writeState({ ...base, ciWait })` would silently revert the phase
    // this same `run()` call just advanced.
    const exit = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh, 0, { readWorkflowsDir: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const state = readState(slug, dir);
    expect(state?.phase).toBe("ci-wait");
    expect(state?.phaseLog).toHaveLength(1);
    expect(state?.phaseLog?.[0]?.phase).toBe("ci-wait");
  });

  it("does not regress a ci-wait-pending state (the Step-7 yield anchors at ci-wait's own index)", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-phase-pending";
    seedState(dir, slug); // default phase: "ci-wait-pending"
    process.env.FLOW_SLUG = slug;
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh, 0, { readWorkflowsDir: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    expect(readState(slug, dir)?.phase).toBe("ci-wait-pending");
  });

  it("adds no second phaseLog entry on a repeated poll", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-phase-repeat";
    seedState(dir, slug, "verifying");
    process.env.FLOW_SLUG = slug;

    const gh1 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    await run(["100", "--state-dir", dir], baseDeps(gh1, 0));
    expect(readState(slug, dir)?.phase).toBe("ci-wait");
    expect(readState(slug, dir)?.phaseLog).toHaveLength(1);

    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN") },
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    await run(["100", "--state-dir", dir], baseDeps(gh2, 60000));
    const state = readState(slug, dir);
    expect(state?.phase).toBe("ci-wait");
    expect(state?.phaseLog).toHaveLength(1);
  });

  it("skips the advance entirely in stateless mode (no FLOW_SLUG resolves)", async () => {
    const dir = makeStateDir();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    // No FLOW_SLUG set (beforeEach deletes it) — `--state-dir` is passed
    // only so a stray write would land in this throwaway dir instead of
    // the developer's real `~/.flow/state`, never so the stateless branch
    // can find it (it can't: it never resolves a slug).
    const exit = await run(
      ["100", "--state-dir", dir],
      baseDeps(gh, 0, { readWorkflowsDir: () => false }),
    );
    cap.restore();
    expect(exit).toBe(0);
    expect(fs.readdirSync(dir)).toHaveLength(0);
    // No slug ⇒ no state directory was ever consulted; the absence of a
    // `phase-advance` NOTICE (which only fires on a resolved-but-mismatched
    // slug) confirms the stateless branch never even attempts the call.
    expect(cap.stderr.join("")).not.toContain("phase-advance");
  });
});
