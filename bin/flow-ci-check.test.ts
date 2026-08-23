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
 * pipeline state, only the `ciWait` sub-record. */
function seedState(dir: string, slug: string): void {
  writeState(
    {
      slug,
      phase: "ci-wait-pending",
      repo: "/tmp/repo",
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

const isReviewRequests = (argv: string[]) =>
  argv[0] === "pr" &&
  argv[1] === "view" &&
  argv.includes("--json") &&
  argv[argv.indexOf("--json") + 1] === "reviewRequests";

const isPrView = (argv: string[]) =>
  argv[0] === "pr" &&
  argv[1] === "view" &&
  argv.includes("--json") &&
  argv[argv.indexOf("--json") + 1] ===
    "state,url,reviews,headRefOid,reviewRequests";

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
const perPollReviewRequests = (logins: string[] = COPILOT_QUEUED): GhStep => ({
  matches: isReviewRequests,
  response: reviewRequestsResponse(logins),
});

function prViewResponse(
  state: "OPEN" | "MERGED" | "CLOSED",
  reviews: Review[] = [],
  headRefOid: string = STABLE_HEAD_SHA,
  reviewRequests: string[] = [],
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
      reviewRequests: reviewRequests.map((login) => ({ login })),
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
      perPollReviewRequests(),
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
      perPollReviewRequests(),
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

  it("never fires ci-hang on a failed observation, even past the 20-min cap", async () => {
    const dir = makeStateDir();
    const slug = "flow-ci-check-failed-obs";
    seedState(dir, slug);
    process.env.FLOW_SLUG = slug;
    const gh: GhRunner = () => ({
      stdout: "",
      stderr: "gh: rate limited",
      exitCode: 1,
    });
    const cap = captureStreams();
    // 1300s (> the 1200s cap) since startedAt, but the observation itself
    // still fails — must stay "waiting", never "ci-hang".
    const exit = await run(
      ["100", "--state-dir", dir, "--now", "2026-01-01T00:21:40.000Z"],
      baseDeps(gh, Date.parse("2026-01-01T00:21:40.000Z"), { now: undefined }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as CheckResult;
    expect(result.status).toBe("waiting");
    expect((result as { observation?: string }).observation).toBe("failed");
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
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN") },
      perPollReviewRequests([]),
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
      baseDeps(gh2, laterMs),
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
    expect(first.headSha).toBe("sha-1");
    expect(first.checks).toBe(1);

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
    function trackingGh(steps: GhStep[]): GhRunner {
      const inner = makeGhSequence(steps);
      return (argv) => {
        allCalls.push(argv);
        return inner(argv);
      };
    }

    // Call 1: CI terminal, stale Copilot review vs current headRefOid ->
    // fires the retrigger POST, then verifies it queued.
    const gh1 = trackingGh([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", staleReview) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      {
        matches: isRequestedReviewersPost,
        response: { stdout: "", stderr: "", exitCode: 0 },
      },
      perPollReviewRequests(),
    ]);
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
    const gh2 = trackingGh([
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(["copilot-pull-request-reviewer"]),
      },
      { matches: isPrView, response: prViewResponse("OPEN", staleReview) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
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
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []),
      },
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(COPILOT_NOT_QUEUED),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap1 = captureStreams();
    const exit1 = await run(
      ["100", "--state-dir", dir, "--claim-deadline-sec", "30"],
      baseDeps(gh1, t0Ms, { readCopilotLogin: () => LOGIN }),
    );
    cap1.restore();
    expect(exit1).toBe(0);
    const result1 = JSON.parse(cap1.stdout.join("")) as CheckResult;
    expect(result1.status).toBe("waiting");

    // Call 2, 30s later: same observation — the deadline has now elapsed.
    const gh2 = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []),
      },
      {
        matches: isReviewRequests,
        response: reviewRequestsResponse(COPILOT_NOT_QUEUED),
      },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap2 = captureStreams();
    const exit2 = await run(
      ["100", "--state-dir", dir, "--claim-deadline-sec", "30"],
      baseDeps(gh2, t0Ms + 30000, { readCopilotLogin: () => LOGIN }),
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
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      { matches: isPrView, response: prViewResponse("OPEN", dismissed) },
      perPollReviewRequests([]),
      {
        matches: isPrChecks,
        response: prChecksResponse([{ name: "t", state: "IN_PROGRESS" }]),
      },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100"],
      baseDeps(gh, 0, { readCopilotLogin: () => LOGIN }),
    );
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotSkipReason).toBe("self-dismissed");
  });

  it("--wait-for-copilot suppresses both auto-detect skips", async () => {
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      {
        matches: isPrView,
        response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []),
      },
      perPollReviewRequests([]),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(
      ["100", "--wait-for-copilot", "--claim-deadline-sec", "1"],
      baseDeps(gh, 0, { readCopilotLogin: () => LOGIN }),
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
