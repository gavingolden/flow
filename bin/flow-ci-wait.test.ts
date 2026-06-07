import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  QUALIFYING_PR_TRIGGERS,
  allMergeCommitsBetween,
  cadenceFor,
  decideOnPoll,
  deriveBlockedState,
  deriveCheckState,
  deriveConflictState,
  deriveCopilotPosted,
  deriveCopilotRulesetEnabled,
  deriveCopilotSkipReason,
  extractLatestCopilotReviewCommit,
  fetchHistoricalBotReview,
  hasQualifyingWorkflowTrigger,
  isCopilotReviewStale,
  isSmallFollowup,
  observeCopilotRuleset,
  observeMergeState,
  parseArgs,
  resolveCopilotConfigured,
  retriggerCopilotReview,
  run,
  type Check,
  type GhRunner,
  type PollState,
  type Review,
  type RunResult,
} from "./flow-ci-wait";

// `resolveCopilotConfigured` consults `bots.copilotAutoReview` via the default
// (file-backed) ReadConfigFile, which has no injectable seam at the call site.
// Mock only that one export so the config tier is deterministic; everything
// else in copilot-config stays real. `setAutoReview` drives the override per test.
const autoReviewHolder = vi.hoisted(() => ({ value: undefined as boolean | undefined }));
vi.mock("./lib/copilot-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/copilot-config")>();
  return { ...actual, readCopilotAutoReview: () => autoReviewHolder.value };
});
function setAutoReview(value: boolean | undefined): void {
  autoReviewHolder.value = value;
}
afterEach(() => setAutoReview(undefined));

// `run()` now persists its verdict to `<cwd>/.flow-tmp/ci-wait-result.json`
// by default. Redirect cwd to a throwaway temp dir for every test so the
// incidental write from a cwd-less `run()` call never lands in the repo
// tree. Tests that pass an explicit `cwd` dep (the workflow-trigger block)
// or an explicit `--out` path are unaffected — those win over this default.
let globalCwd = "";
beforeEach(() => {
  globalCwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ci-wait-cwd-"));
  vi.spyOn(process, "cwd").mockReturnValue(globalCwd);
});

// Restore any spies (e.g. captureStreams' process.stdout/stderr.write mocks)
// between tests so a test that throws before its local cap.restore() cannot
// leak a spy into a later test. Without this, an unrestored stream spy
// corrupts a subsequent test's fs/stream calls.
afterEach(() => {
  vi.restoreAllMocks();
  if (globalCwd) {
    fs.rmSync(globalCwd, { recursive: true, force: true });
    globalCwd = "";
  }
});

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
// 2a-2. deriveConflictState — branch-conflict classifier
// ---------------------------------------------------------------------------

describe(deriveConflictState, () => {
  it.each(["CONFLICTING", "DIRTY"])(
    "flags conflicting=true for mergeStateStatus=%s",
    (status) => {
      expect(deriveConflictState("MERGEABLE", status).conflicting).toBe(true);
    },
  );

  it.each(["CLEAN", "BEHIND", "BLOCKED", "UNSTABLE", "HAS_HOOKS", "UNKNOWN"])(
    "does NOT flag conflicting for mergeStateStatus=%s",
    (status) => {
      expect(deriveConflictState("MERGEABLE", status).conflicting).toBe(false);
    },
  );

  it("does NOT flag conflicting while GitHub is still computing (mergeable=UNKNOWN, mergeStateStatus=UNKNOWN)", () => {
    expect(deriveConflictState("UNKNOWN", "UNKNOWN").conflicting).toBe(false);
  });

  it("does NOT flag conflicting on a stale CONFLICTING status while mergeable is still recomputing (mergeable=UNKNOWN)", () => {
    expect(deriveConflictState("UNKNOWN", "CONFLICTING").conflicting).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2a-2b. deriveBlockedState — branch-protection classifier
// ---------------------------------------------------------------------------

describe(deriveBlockedState, () => {
  it("flags blocked=true for mergeStateStatus=BLOCKED", () => {
    expect(deriveBlockedState("MERGEABLE", "BLOCKED").blocked).toBe(true);
  });

  // The inverse of deriveConflictState's list: a conflict (CONFLICTING/DIRTY)
  // is NOT a block (it routes to pr-conflicted, not pr-blocked), and the
  // benign states never block either.
  it.each(["CLEAN", "BEHIND", "UNSTABLE", "HAS_HOOKS", "CONFLICTING", "DIRTY", "UNKNOWN"])(
    "does NOT flag blocked for mergeStateStatus=%s",
    (status) => {
      expect(deriveBlockedState("MERGEABLE", status).blocked).toBe(false);
    },
  );

  it("does NOT flag blocked while GitHub is still computing (mergeable=UNKNOWN, mergeStateStatus=UNKNOWN)", () => {
    expect(deriveBlockedState("UNKNOWN", "UNKNOWN").blocked).toBe(false);
  });

  it("does NOT flag blocked on a stale BLOCKED status while mergeable is still recomputing (mergeable=UNKNOWN)", () => {
    expect(deriveBlockedState("UNKNOWN", "BLOCKED").blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2a-3. observeMergeState — mergeability reader (fail-open)
// ---------------------------------------------------------------------------

describe(observeMergeState, () => {
  it("returns the parsed object on a zero-exit gh call", () => {
    const gh: GhRunner = () => ({
      stdout: JSON.stringify({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      stderr: "",
      exitCode: 0,
    });
    expect(observeMergeState(100, gh)).toEqual({
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    });
  });

  it("fails open (returns null) on a non-zero exit", () => {
    const gh: GhRunner = () => ({ stdout: "", stderr: "boom", exitCode: 1 });
    expect(observeMergeState(100, gh)).toBeNull();
  });

  it("fails open (returns null) on malformed JSON", () => {
    const gh: GhRunner = () => ({ stdout: "not json", stderr: "", exitCode: 0 });
    expect(observeMergeState(100, gh)).toBeNull();
  });

  it("coerces non-string fields to \"\" on valid-JSON-but-wrong-shape payloads", () => {
    // Pins the absent/non-string-field default: a valid-JSON response whose
    // mergeable/mergeStateStatus are missing or non-string (e.g. `null`)
    // coerces each to "" rather than throwing. "" is the safe direction —
    // it flows into deriveConflictState as not-conflicting.
    const missing: GhRunner = () => ({ stdout: "{}", stderr: "", exitCode: 0 });
    expect(observeMergeState(100, missing)).toEqual({
      mergeable: "",
      mergeStateStatus: "",
    });

    const nonString: GhRunner = () => ({
      stdout: JSON.stringify({ mergeable: 123, mergeStateStatus: null }),
      stderr: "",
      exitCode: 0,
    });
    const coerced = observeMergeState(100, nonString);
    expect(coerced).toEqual({ mergeable: "", mergeStateStatus: "" });
    expect(deriveConflictState(coerced!.mergeable, coerced!.mergeStateStatus).conflicting).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 2b. hasQualifyingWorkflowTrigger
// ---------------------------------------------------------------------------

describe(hasQualifyingWorkflowTrigger, () => {
  it("exports the qualifying-trigger set with the three GitHub-PR triggers", () => {
    expect(QUALIFYING_PR_TRIGGERS).toEqual(
      new Set(["pull_request", "pull_request_target", "merge_group"]),
    );
  });

  // Scalar form
  it("scalar form: 'on: pull_request' → true", () => {
    expect(hasQualifyingWorkflowTrigger("on: pull_request\njobs: {}\n")).toBe(true);
  });
  it("scalar form: 'on: schedule' → false", () => {
    expect(hasQualifyingWorkflowTrigger("on: schedule\njobs: {}\n")).toBe(false);
  });
  it("scalar form: 'on: push' → false", () => {
    expect(hasQualifyingWorkflowTrigger("on: push\njobs: {}\n")).toBe(false);
  });

  // List form
  it("list form: 'on: [pull_request, push]' → true", () => {
    expect(hasQualifyingWorkflowTrigger("on: [pull_request, push]\njobs: {}\n")).toBe(true);
  });
  it("list form: 'on: [schedule, push]' → false", () => {
    expect(hasQualifyingWorkflowTrigger("on: [schedule, push]\njobs: {}\n")).toBe(false);
  });
  it("list form: 'on: [merge_group]' → true", () => {
    expect(hasQualifyingWorkflowTrigger("on: [merge_group]\njobs: {}\n")).toBe(true);
  });

  // Map form
  it("map form: bare 'pull_request:' child key → true", () => {
    expect(hasQualifyingWorkflowTrigger("on:\n  pull_request:\njobs: {}\n")).toBe(true);
  });
  it("map form: 'pull_request:' with nested 'branches:' → true", () => {
    expect(
      hasQualifyingWorkflowTrigger(
        "on:\n  pull_request:\n    branches: [main]\njobs: {}\n",
      ),
    ).toBe(true);
  });
  it("map form: schedule + push only → false", () => {
    expect(
      hasQualifyingWorkflowTrigger(
        "on:\n  schedule:\n    - cron: '0 0 * * *'\n  push:\n    branches: [main]\njobs: {}\n",
      ),
    ).toBe(false);
  });
  it("map form: bare 'pull_request_target:' child key → true", () => {
    expect(hasQualifyingWorkflowTrigger("on:\n  pull_request_target:\n")).toBe(true);
  });
  it("map form: bare 'merge_group:' child key → true", () => {
    expect(hasQualifyingWorkflowTrigger("on:\n  merge_group:\n")).toBe(true);
  });

  // Block-sequence form (`on:` followed by `- trigger` dash items).
  it("block-sequence form: '- pull_request' → true", () => {
    expect(hasQualifyingWorkflowTrigger("on:\n  - pull_request\njobs: {}\n")).toBe(true);
  });
  it("block-sequence form: '- schedule, - push' → false", () => {
    expect(
      hasQualifyingWorkflowTrigger("on:\n  - schedule\n  - push\njobs: {}\n"),
    ).toBe(false);
  });
  it("block-sequence form: '- merge_group' → true", () => {
    expect(hasQualifyingWorkflowTrigger("on:\n  - merge_group\n")).toBe(true);
  });
  it("block-sequence form: '- pull_request_target' → true", () => {
    expect(hasQualifyingWorkflowTrigger("on:\n  - pull_request_target\n")).toBe(true);
  });
  it("block-sequence form: '- \"pull_request\"' (quoted) → true", () => {
    expect(hasQualifyingWorkflowTrigger('on:\n  - "pull_request"\n')).toBe(true);
  });

  // Known limitation: inline-flow map (`on: { pull_request: foo }`) is
  // intentionally out of scope; document the conservative false return.
  it("inline-flow map (known limitation): 'on: { pull_request: foo }' → false", () => {
    expect(hasQualifyingWorkflowTrigger("on: { pull_request: foo }\n")).toBe(false);
  });

  // Each qualifying trigger individually
  it("pull_request_target alone → true", () => {
    expect(hasQualifyingWorkflowTrigger("on: pull_request_target\n")).toBe(true);
  });
  it("merge_group alone (scalar) → true", () => {
    expect(hasQualifyingWorkflowTrigger("on: merge_group\n")).toBe(true);
  });

  // Quoted scalars
  it("quoted scalar: 'on: \"pull_request\"' → true", () => {
    expect(hasQualifyingWorkflowTrigger('on: "pull_request"\n')).toBe(true);
  });
  it("quoted scalar: \"on: 'pull_request'\" → true", () => {
    expect(hasQualifyingWorkflowTrigger("on: 'pull_request'\n")).toBe(true);
  });

  // Edge cases
  it("empty string → false", () => {
    expect(hasQualifyingWorkflowTrigger("")).toBe(false);
  });
  it("on: with a trailing inline comment and map form below → true", () => {
    expect(
      hasQualifyingWorkflowTrigger("on: # comment only\n  pull_request:\n"),
    ).toBe(true);
  });
  it("YAML with no top-level 'on:' key → false", () => {
    expect(hasQualifyingWorkflowTrigger("name: foo\njobs: {}\n")).toBe(false);
  });
  it("malformed indentation (child returns to zero indent) → false conservatively", () => {
    // The map-form body terminates at zero-indent — a trigger word that
    // appears as a sibling top-level key is not part of `on:`.
    expect(
      hasQualifyingWorkflowTrigger("on:\npull_request:\njobs: {}\n"),
    ).toBe(false);
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
    const reviews: Review[] = [
      { author: { login: "alice" }, state: "APPROVED", commitOid: null },
    ];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(false);
  });

  it("returns true when a review's login matches case-insensitively", () => {
    // GitHub may emit a mixed-case login; both sides are lowercased.
    const reviews: Review[] = [
      {
        author: { login: "Copilot-Pull-Request-Reviewer" },
        state: "APPROVED",
        commitOid: null,
      },
    ];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(true);
  });

  it("matches a [bot]-suffixed review author against the bare configured login", () => {
    // GitHub reports Copilot's review author as `<login>[bot]`; the
    // suffix-tolerant author-match must recognise it as the configured login.
    const reviews: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer[bot]" },
        state: "APPROVED",
        commitOid: null,
      },
    ];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(true);
  });

  it("ignores reviews in PENDING state (still drafting)", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "PENDING", commitOid: null },
    ];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(false);
  });

  it("accepts APPROVED reviews", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "APPROVED", commitOid: null },
    ];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(true);
  });
  it("accepts CHANGES_REQUESTED reviews", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "CHANGES_REQUESTED", commitOid: null },
    ];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(true);
  });
  it("accepts COMMENTED reviews", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "COMMENTED", commitOid: null },
    ];
    expect(deriveCopilotPosted(reviews, LOGIN)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3a. extractLatestCopilotReviewCommit — PR #161 stale-review detection helper
// ---------------------------------------------------------------------------

describe(extractLatestCopilotReviewCommit, () => {
  const LOGIN = "copilot-pull-request-reviewer";

  it("returns null on an empty reviews list", () => {
    expect(extractLatestCopilotReviewCommit([], LOGIN)).toBeNull();
  });

  it("returns null when no review matches the configured login", () => {
    const reviews: Review[] = [
      { author: { login: "alice" }, state: "APPROVED", commitOid: "sha-a" },
    ];
    expect(extractLatestCopilotReviewCommit(reviews, LOGIN)).toBeNull();
  });

  it("returns the single matching Copilot review's commitOid", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "COMMENTED", commitOid: "sha-1" },
    ];
    expect(extractLatestCopilotReviewCommit(reviews, LOGIN)).toBe("sha-1");
  });

  it("returns the last-in-array Copilot review when multiple match", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "COMMENTED", commitOid: "sha-old" },
      { author: { login: LOGIN }, state: "APPROVED", commitOid: "sha-new" },
    ];
    expect(extractLatestCopilotReviewCommit(reviews, LOGIN)).toBe("sha-new");
  });

  it("matches the login case-insensitively", () => {
    const reviews: Review[] = [
      {
        author: { login: "Copilot-Pull-Request-Reviewer" },
        state: "APPROVED",
        commitOid: "sha-x",
      },
    ];
    expect(extractLatestCopilotReviewCommit(reviews, LOGIN)).toBe("sha-x");
  });

  it("matches a [bot]-suffixed review author against the bare configured login", () => {
    const reviews: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer[bot]" },
        state: "COMMENTED",
        commitOid: "sha-bot",
      },
    ];
    expect(extractLatestCopilotReviewCommit(reviews, LOGIN)).toBe("sha-bot");
  });

  it("excludes PENDING Copilot reviews", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "PENDING", commitOid: "sha-pending" },
    ];
    expect(extractLatestCopilotReviewCommit(reviews, LOGIN)).toBeNull();
  });

  it("excludes DISMISSED Copilot reviews", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: "sha-dismissed" },
    ];
    expect(extractLatestCopilotReviewCommit(reviews, LOGIN)).toBeNull();
  });

  it("returns null when the matched review's commitOid is null", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "COMMENTED", commitOid: null },
    ];
    expect(extractLatestCopilotReviewCommit(reviews, LOGIN)).toBeNull();
  });

  it("returns null when the latest qualifying review has a null commitOid even when an earlier matching review had a real SHA", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "COMMENTED", commitOid: "sha-old" },
      { author: { login: LOGIN }, state: "COMMENTED", commitOid: null },
    ];
    expect(extractLatestCopilotReviewCommit(reviews, LOGIN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3a-2. isCopilotReviewStale — staleness predicate
// ---------------------------------------------------------------------------

describe(isCopilotReviewStale, () => {
  it("returns false when the latest Copilot commit is null", () => {
    expect(isCopilotReviewStale(null, "sha-head")).toBe(false);
  });

  it("returns false when the latest Copilot commit equals headRefOid", () => {
    expect(isCopilotReviewStale("sha-head", "sha-head")).toBe(false);
  });

  it("returns true when the latest Copilot commit differs from headRefOid", () => {
    expect(isCopilotReviewStale("sha-old", "sha-head")).toBe(true);
  });

  it("returns false when headRefOid is empty (transient gh projection miss)", () => {
    expect(isCopilotReviewStale("sha-old", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3a-2b. deriveCopilotSkipReason — Copilot auto-detect short-circuit
// ---------------------------------------------------------------------------

describe(deriveCopilotSkipReason, () => {
  const LOGIN = "copilot-pull-request-reviewer";
  const HEAD = "sha-head";
  const OLDER = "sha-older";

  function baseArgs(overrides: Partial<Parameters<typeof deriveCopilotSkipReason>[0]> = {}) {
    return {
      reviews: [] as Review[],
      headRefOid: HEAD,
      copilotLogin: LOGIN,
      ciTerminalAt: 0,
      elapsedSec: 60,
      claimDeadlineSec: 60,
      waitForCopilot: false,
      requestedReviewers: [] as string[],
      ...overrides,
    };
  }

  it("returns 'self-dismissed' when copilot DISMISSED on the current SHA with no fresher non-dismissed review", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: HEAD },
    ];
    expect(deriveCopilotSkipReason(baseArgs({ reviews }))).toBe("self-dismissed");
  });

  it("returns null when DISMISSED is on an older SHA but a posted review exists on the current SHA", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: OLDER },
      { author: { login: LOGIN }, state: "COMMENTED", commitOid: HEAD },
    ];
    expect(deriveCopilotSkipReason(baseArgs({ reviews }))).toBeNull();
  });

  it("returns null when DISMISSED is on an older SHA and no review exists on the current SHA (older-SHA dismiss does not signal self-dismissed)", () => {
    // DISMISSED on OLDER alone should NOT trigger self-dismissed — the
    // current-SHA pre-condition is what makes self-dismissed a strong
    // signal. (Falls through to unclaimed-after-deadline once CI terminal
    // + deadline elapsed since there's no current-SHA review of any kind.)
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: OLDER },
    ];
    expect(deriveCopilotSkipReason(baseArgs({ reviews }))).toBe(
      "unclaimed-after-deadline",
    );
  });

  it("returns 'unclaimed-after-deadline' when CI terminal + deadline elapsed + no review of any kind + not requested", () => {
    expect(
      deriveCopilotSkipReason(
        baseArgs({
          reviews: [],
          ciTerminalAt: 0,
          elapsedSec: 60,
          claimDeadlineSec: 60,
        }),
      ),
    ).toBe("unclaimed-after-deadline");
  });

  it("returns null when ciTerminalAt is null (CI not yet terminal)", () => {
    expect(
      deriveCopilotSkipReason(baseArgs({ ciTerminalAt: null, elapsedSec: 600 })),
    ).toBeNull();
  });

  it("returns null when the deadline has not yet elapsed", () => {
    expect(
      deriveCopilotSkipReason(baseArgs({ ciTerminalAt: 0, elapsedSec: 30, claimDeadlineSec: 60 })),
    ).toBeNull();
  });

  it("returns null when a PENDING Copilot review exists on the current headRefOid (claimed)", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "PENDING", commitOid: HEAD },
    ];
    expect(deriveCopilotSkipReason(baseArgs({ reviews }))).toBeNull();
  });

  it("returns null when Copilot is in requestedReviewers with a COMMENTED review on current SHA (also claimed by review)", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "COMMENTED", commitOid: HEAD },
    ];
    expect(
      deriveCopilotSkipReason(
        baseArgs({ reviews, requestedReviewers: [LOGIN] }),
      ),
    ).toBeNull();
  });

  it("returns null when Copilot is in requestedReviewers (claimed via reviewer-request)", () => {
    expect(
      deriveCopilotSkipReason(baseArgs({ requestedReviewers: [LOGIN] })),
    ).toBeNull();
  });

  it("returns null for every signal when waitForCopilot is true (user opt-out)", () => {
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: HEAD },
    ];
    expect(
      deriveCopilotSkipReason(baseArgs({ reviews, waitForCopilot: true })),
    ).toBeNull();
    expect(
      deriveCopilotSkipReason(
        baseArgs({ reviews: [], ciTerminalAt: 0, elapsedSec: 600, waitForCopilot: true }),
      ),
    ).toBeNull();
  });

  it("matches the configured login case-insensitively (mixed-case in response)", () => {
    const reviews: Review[] = [
      {
        author: { login: "Copilot-Pull-Request-Reviewer" },
        state: "DISMISSED",
        commitOid: HEAD,
      },
    ];
    expect(deriveCopilotSkipReason(baseArgs({ reviews }))).toBe("self-dismissed");
  });

  it("matches a [bot]-suffixed review author against the bare configured login", () => {
    const reviews: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer[bot]" },
        state: "DISMISSED",
        commitOid: HEAD,
      },
    ];
    expect(deriveCopilotSkipReason(baseArgs({ reviews }))).toBe("self-dismissed");
  });

  it("precedence: self-dismissed wins over unclaimed-after-deadline when both signals apply", () => {
    // DISMISSED on current SHA + ciTerminalAt + deadline elapsed + no
    // non-dismissed review on current SHA — both signals fire; self-dismissed
    // is the stronger signal so it must win.
    const reviews: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: HEAD },
    ];
    expect(
      deriveCopilotSkipReason(
        baseArgs({ reviews, ciTerminalAt: 0, elapsedSec: 600, claimDeadlineSec: 60 }),
      ),
    ).toBe("self-dismissed");
  });

  it("returns null when headRefOid is empty (transient gh projection miss)", () => {
    expect(deriveCopilotSkipReason(baseArgs({ headRefOid: "" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3a-3. retriggerCopilotReview — requested_reviewers POST
// ---------------------------------------------------------------------------

describe(retriggerCopilotReview, () => {
  it("requests Copilot via the gh-CLI native `--add-reviewer @copilot` argv and returns ok:true on success", () => {
    const calls: string[][] = [];
    const gh: GhRunner = (argv) => {
      calls.push(argv);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const out = retriggerCopilotReview(161, gh);
    expect(out).toEqual({ ok: true, stderr: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["pr", "edit", "161", "--add-reviewer", "@copilot"]);
  });

  it("returns ok:false with stderr propagated on non-zero exit", () => {
    const gh: GhRunner = () => ({ stdout: "", stderr: "HTTP 422: Unprocessable", exitCode: 1 });
    const out = retriggerCopilotReview(161, gh);
    expect(out).toEqual({ ok: false, stderr: "HTTP 422: Unprocessable" });
  });
});

// ---------------------------------------------------------------------------
// 3b. fetchHistoricalBotReview — repo-history fallback for Copilot detection
// ---------------------------------------------------------------------------

describe(fetchHistoricalBotReview, () => {
  const LOGIN = "copilot-pull-request-reviewer";

  function ghFromQueue(queue: Array<{ stdout: string; exitCode: number }>): GhRunner & {
    calls: string[][];
  } {
    const calls: string[][] = [];
    let cursor = 0;
    const fn = ((argv: string[]) => {
      calls.push(argv);
      const next = queue[cursor++];
      if (!next) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: next.stdout, stderr: "", exitCode: next.exitCode };
    }) as GhRunner & { calls: string[][] };
    fn.calls = calls;
    return fn;
  }

  // REGRESSION GUARD: never fail-open to `true` on a gh error. A wrong
  // "auto-review is configured" suppresses a needed review (expensive); the
  // safe failure direction is `false`. A future refactor must not silently
  // flip either branch below to fail-open-positive.
  it("never fail-open to true: returns false when 'gh pr list' exits non-zero", () => {
    const gh = ghFromQueue([{ stdout: "", exitCode: 1 }]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(false);
    expect(gh.calls).toHaveLength(1); // never reaches per-PR view
  });

  it("never fail-open to true: returns false when 'gh pr list' returns malformed JSON", () => {
    const gh = ghFromQueue([{ stdout: "not-json{", exitCode: 0 }]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(false);
  });

  it("returns false when the merged-PR list is empty", () => {
    const gh = ghFromQueue([{ stdout: "[]", exitCode: 0 }]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(false);
    expect(gh.calls).toHaveLength(1);
  });

  it("returns true when any recent merged PR has a review by the configured login", () => {
    const gh = ghFromQueue([
      { stdout: JSON.stringify([{ number: 78 }, { number: 77 }]), exitCode: 0 },
      // Pr 78: no copilot review
      { stdout: JSON.stringify({ reviews: [{ author: { login: "alice" } }] }), exitCode: 0 },
      // Pr 77: copilot review
      {
        stdout: JSON.stringify({ reviews: [{ author: { login: LOGIN } }] }),
        exitCode: 0,
      },
    ]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(true);
  });

  it("matches the login case-insensitively (mixed case in the API response)", () => {
    const gh = ghFromQueue([
      { stdout: JSON.stringify([{ number: 1 }]), exitCode: 0 },
      {
        stdout: JSON.stringify({
          reviews: [{ author: { login: "Copilot-Pull-Request-Reviewer" } }],
        }),
        exitCode: 0,
      },
    ]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(true);
  });

  it("matches a [bot]-suffixed review author against the bare configured login", () => {
    const gh = ghFromQueue([
      { stdout: JSON.stringify([{ number: 1 }]), exitCode: 0 },
      {
        stdout: JSON.stringify({
          reviews: [{ author: { login: "copilot-pull-request-reviewer[bot]" } }],
        }),
        exitCode: 0,
      },
    ]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(true);
  });

  it("short-circuits on the first match (does not view PRs past the hit)", () => {
    const gh = ghFromQueue([
      { stdout: JSON.stringify([{ number: 1 }, { number: 2 }, { number: 3 }]), exitCode: 0 },
      // Pr 1 already matches
      { stdout: JSON.stringify({ reviews: [{ author: { login: LOGIN } }] }), exitCode: 0 },
    ]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(true);
    // 1 list call + 1 view call; PR 2 / PR 3 never queried.
    expect(gh.calls).toHaveLength(2);
  });

  it("returns false when no merged PR has a review by the configured login", () => {
    const gh = ghFromQueue([
      { stdout: JSON.stringify([{ number: 1 }, { number: 2 }]), exitCode: 0 },
      { stdout: JSON.stringify({ reviews: [{ author: { login: "alice" } }] }), exitCode: 0 },
      { stdout: JSON.stringify({ reviews: [] }), exitCode: 0 },
    ]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(false);
  });

  it("skips PRs whose 'gh pr view' fails and continues scanning", () => {
    const gh = ghFromQueue([
      { stdout: JSON.stringify([{ number: 1 }, { number: 2 }]), exitCode: 0 },
      // Pr 1 view errors
      { stdout: "", exitCode: 1 },
      // Pr 2 has the review
      { stdout: JSON.stringify({ reviews: [{ author: { login: LOGIN } }] }), exitCode: 0 },
    ]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(true);
  });

  it("skips PRs whose 'gh pr view' returns malformed JSON and continues scanning", () => {
    const gh = ghFromQueue([
      { stdout: JSON.stringify([{ number: 1 }, { number: 2 }]), exitCode: 0 },
      { stdout: "not-json{", exitCode: 0 },
      { stdout: JSON.stringify({ reviews: [{ author: { login: LOGIN } }] }), exitCode: 0 },
    ]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(true);
  });

  it("passes the limit through to 'gh pr list'", () => {
    const gh = ghFromQueue([{ stdout: "[]", exitCode: 0 }]);
    fetchHistoricalBotReview(LOGIN, gh, 7);
    expect(gh.calls[0]).toEqual([
      "pr",
      "list",
      "--state",
      "merged",
      "--limit",
      "7",
      "--json",
      "number",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3c. deriveCopilotRulesetEnabled — pure ruleset parser (tri-state)
// ---------------------------------------------------------------------------

describe(deriveCopilotRulesetEnabled, () => {
  it("returns true when a copilot_code_review rule is present", () => {
    expect(deriveCopilotRulesetEnabled([{ type: "copilot_code_review" }])).toBe(true);
  });

  it("returns true when copilot_code_review appears alongside other rules", () => {
    expect(
      deriveCopilotRulesetEnabled([{ type: "pull_request" }, { type: "copilot_code_review" }]),
    ).toBe(true);
  });

  it("returns false for a valid array without the copilot_code_review rule", () => {
    expect(deriveCopilotRulesetEnabled([{ type: "pull_request" }])).toBe(false);
  });

  it("returns false for an empty array", () => {
    expect(deriveCopilotRulesetEnabled([])).toBe(false);
  });

  it("returns 'unknown' for null", () => {
    expect(deriveCopilotRulesetEnabled(null)).toBe("unknown");
  });

  it("returns 'unknown' for a non-array object", () => {
    expect(deriveCopilotRulesetEnabled({})).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 3d. observeCopilotRuleset — authoritative ruleset reader (tri-state)
// ---------------------------------------------------------------------------

describe(observeCopilotRuleset, () => {
  function ghFromQueue(queue: Array<{ stdout: string; exitCode: number }>): GhRunner & {
    calls: string[][];
  } {
    const calls: string[][] = [];
    let cursor = 0;
    const fn = ((argv: string[]) => {
      calls.push(argv);
      const next = queue[cursor++];
      if (!next) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: next.stdout, stderr: "", exitCode: next.exitCode };
    }) as GhRunner & { calls: string[][] };
    fn.calls = calls;
    return fn;
  }

  it("returns true when the rules API includes copilot_code_review", () => {
    const gh = ghFromQueue([
      { stdout: "main\n", exitCode: 0 },
      { stdout: JSON.stringify([{ type: "copilot_code_review" }]), exitCode: 0 },
    ]);
    expect(observeCopilotRuleset(gh)).toBe(true);
    expect(gh.calls[1]).toEqual(["api", "repos/{owner}/{repo}/rules/branches/main"]);
  });

  it("returns false when the rules API omits copilot_code_review", () => {
    const gh = ghFromQueue([
      { stdout: "main", exitCode: 0 },
      { stdout: JSON.stringify([{ type: "pull_request" }]), exitCode: 0 },
    ]);
    expect(observeCopilotRuleset(gh)).toBe(false);
  });

  it("returns 'unknown' on a 403 (rules API non-zero exit)", () => {
    const gh = ghFromQueue([
      { stdout: "main", exitCode: 0 },
      { stdout: "", exitCode: 1 },
    ]);
    expect(observeCopilotRuleset(gh)).toBe("unknown");
  });

  it("returns 'unknown' on a 404 (rules API non-zero exit)", () => {
    const gh = ghFromQueue([
      { stdout: "main", exitCode: 0 },
      { stdout: "Not Found", exitCode: 1 },
    ]);
    expect(observeCopilotRuleset(gh)).toBe("unknown");
  });

  it("returns 'unknown' on malformed JSON from the rules API", () => {
    const gh = ghFromQueue([
      { stdout: "main", exitCode: 0 },
      { stdout: "not-json{", exitCode: 0 },
    ]);
    expect(observeCopilotRuleset(gh)).toBe("unknown");
  });

  it("returns 'unknown' on default-branch-resolution failure (non-zero exit)", () => {
    const gh = ghFromQueue([{ stdout: "", exitCode: 1 }]);
    expect(observeCopilotRuleset(gh)).toBe("unknown");
    expect(gh.calls).toHaveLength(1); // never reaches the rules API
  });

  it("returns 'unknown' when the resolved default branch is empty", () => {
    const gh = ghFromQueue([{ stdout: "  \n", exitCode: 0 }]);
    expect(observeCopilotRuleset(gh)).toBe("unknown");
    expect(gh.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3d-bis. resolveCopilotConfigured — three-tier precedence
// ---------------------------------------------------------------------------

describe(resolveCopilotConfigured, () => {
  const LOGIN = "copilot-pull-request-reviewer";

  function ghFromQueue(queue: Array<{ stdout: string; exitCode: number }>): GhRunner & {
    calls: string[][];
  } {
    const calls: string[][] = [];
    let cursor = 0;
    const fn = ((argv: string[]) => {
      calls.push(argv);
      const next = queue[cursor++];
      if (!next) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: next.stdout, stderr: "", exitCode: next.exitCode };
    }) as GhRunner & { calls: string[][] };
    fn.calls = calls;
    return fn;
  }

  it("returns the override verbatim (true) and issues ZERO gh calls", () => {
    setAutoReview(true);
    const gh = ghFromQueue([]);
    expect(resolveCopilotConfigured(LOGIN, gh)).toBe(true);
    expect(gh.calls).toHaveLength(0);
  });

  it("returns the override verbatim (false) and issues ZERO gh calls", () => {
    setAutoReview(false);
    const gh = ghFromQueue([]);
    expect(resolveCopilotConfigured(LOGIN, gh)).toBe(false);
    expect(gh.calls).toHaveLength(0);
  });

  it("override unset + ruleset 'unknown' → reaches the fetchHistoricalBotReview heuristic", () => {
    setAutoReview(undefined);
    const gh = ghFromQueue([
      // observeCopilotRuleset: default branch resolves, rules api 403s → "unknown".
      { stdout: "main", exitCode: 0 },
      { stdout: "", exitCode: 1 },
      // heuristic floor: list merged PRs, then per-PR reviews (Copilot hit).
      { stdout: JSON.stringify([{ number: 1 }]), exitCode: 0 },
      { stdout: JSON.stringify({ reviews: [{ author: { login: LOGIN } }] }), exitCode: 0 },
    ]);
    expect(resolveCopilotConfigured(LOGIN, gh)).toBe(true);
    // The heuristic pr-list call must have been issued.
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(true);
  });

  it("override unset + authoritative-true ruleset → true WITHOUT the pr-list heuristic", () => {
    setAutoReview(undefined);
    const gh = ghFromQueue([
      { stdout: "main", exitCode: 0 },
      { stdout: JSON.stringify([{ type: "copilot_code_review" }]), exitCode: 0 },
    ]);
    expect(resolveCopilotConfigured(LOGIN, gh)).toBe(true);
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3e. readHistoricalBotReview default — authoritative-read-then-heuristic
// ---------------------------------------------------------------------------

describe("readHistoricalBotReview default wiring", () => {
  it("falls through to the 5-PR heuristic when the ruleset read is 'unknown' (403)", async () => {
    // Drives the un-injected default factory through run(): with empty
    // reviewRequests, the factory calls observeCopilotRuleset (repo view +
    // rules api). The api 403s → "unknown" → the factory falls through to
    // fetchHistoricalBotReview (pr list + per-PR view), which here HITS a
    // historical Copilot review, so copilotConfigured resolves true.
    const LOGIN = "copilot-pull-request-reviewer";
    const clock = makeFakeClock();
    const calls: string[][] = [];
    const gh: GhRunner = (argv) => {
      calls.push(argv);
      // observeCopilotRuleset: default-branch resolution succeeds, rules api 403s.
      if (argv[0] === "repo") return { stdout: "main", stderr: "", exitCode: 0 };
      if (argv[0] === "api") return { stdout: "", stderr: "forbidden", exitCode: 1 };
      // heuristic floor: list the merged PRs, then per-PR reviews (Copilot hit).
      if (argv[0] === "pr" && argv[1] === "list") {
        return { stdout: JSON.stringify([{ number: 1 }]), stderr: "", exitCode: 0 };
      }
      if (isPrView(argv)) return prViewResponse("OPEN", [], STABLE_HEAD_SHA, []);
      if (isReviewRequests(argv)) return reviewRequestsResponse([]);
      if (isPrChecks(argv)) return prChecksResponse(ALL_PASSED);
      // The heuristic per-PR `gh pr view <n> --json reviews` call.
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
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      // readHistoricalBotReview intentionally NOT injected — exercise the default.
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    // The 403 routed through to the heuristic, which found a historical review.
    expect(calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(true);
    expect(result.copilotConfigured).toBe(true);
  });

  it("short-circuits on an authoritative-true ruleset without consulting the heuristic", async () => {
    // Drives the un-injected default factory through run(): with empty
    // reviewRequests, the factory calls observeCopilotRuleset (repo view +
    // rules api). The api returns an authoritative copilot_code_review rule →
    // true, so the factory MUST short-circuit and never reach
    // fetchHistoricalBotReview. Asserts (a) copilotConfigured true AND (b) no
    // `gh pr list` heuristic call — the negative assertion that locks the
    // short-circuit (a regression running the heuristic unconditionally would
    // otherwise pass).
    const LOGIN = "copilot-pull-request-reviewer";
    const clock = makeFakeClock();
    const calls: string[][] = [];
    const gh: GhRunner = (argv) => {
      calls.push(argv);
      // observeCopilotRuleset: default-branch resolution + authoritative rules api.
      if (argv[0] === "repo") return { stdout: "main", stderr: "", exitCode: 0 };
      if (argv[0] === "api") {
        return {
          stdout: JSON.stringify([{ type: "copilot_code_review" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (isReviewRequests(argv)) return reviewRequestsResponse([]);
      if (isPrView(argv)) return prViewResponse("OPEN", [], STABLE_HEAD_SHA, []);
      if (isPrChecks(argv)) return prChecksResponse(ALL_PASSED);
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      // readHistoricalBotReview intentionally NOT injected — exercise the default.
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(true);
    // The authoritative read short-circuited: the heuristic `gh pr list` floor
    // was never consulted.
    expect(calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(false);
  });

  it("short-circuits on an authoritative-false ruleset without consulting the heuristic", async () => {
    // Symmetric to the authoritative-true case: the rules api resolves an
    // authoritative array WITHOUT a copilot_code_review rule → false. The
    // factory short-circuits to false and never reaches the heuristic, so
    // copilotConfigured is false and no `gh pr list` call is made.
    const LOGIN = "copilot-pull-request-reviewer";
    const clock = makeFakeClock();
    const calls: string[][] = [];
    const gh: GhRunner = (argv) => {
      calls.push(argv);
      if (argv[0] === "repo") return { stdout: "main", stderr: "", exitCode: 0 };
      if (argv[0] === "api") {
        return {
          stdout: JSON.stringify([{ type: "pull_request" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (isReviewRequests(argv)) return reviewRequestsResponse([]);
      if (isPrView(argv)) return prViewResponse("OPEN", [], STABLE_HEAD_SHA, []);
      if (isPrChecks(argv)) return prChecksResponse(ALL_PASSED);
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      // readHistoricalBotReview intentionally NOT injected — exercise the default.
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(false);
    expect(calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(false);
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
    copilotRequestedThisPoll: true,
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

  it("does NOT fire ci-hang when CI already passed but copilot timeout has not elapsed", () => {
    // Per polling-protocol.md the ci-hang row only applies when ci_passed=false
    // AND ci_failed=false. CI passed at minute 18 and copilot has not posted —
    // the loop must keep going until the 10-min copilot-after-ci-terminal
    // window elapses, not bail at the 20-min wall-clock cap.
    const v = decideOnPoll(
      makePollState({
        ci: { kind: "all-passed" },
        copilotPosted: false,
        copilotConfigured: true,
        ciTerminalAt: 1100,
        elapsedSec: 1200,
        pollNum: 20,
      }),
    );
    expect(v.verdict).toBe("loop");
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

  // --- --wait-for-copilot (boolean presence) ---
  it("accepts --wait-for-copilot as a boolean flag", () => {
    expect(parseArgs(["100", "--wait-for-copilot"])).toEqual({
      pr: 100,
      waitForCopilot: true,
    });
  });
  it("defaults waitForCopilot to absent when the flag is omitted", () => {
    expect(parseArgs(["100"])).toEqual({ pr: 100 });
  });

  // --- --claim-deadline-sec (positive-integer value) ---
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
  it("errors when --claim-deadline-sec is negative", () => {
    expect(parseArgs(["100", "--claim-deadline-sec", "-5"])).toEqual({
      error: "--claim-deadline-sec must be a positive integer, got '-5'",
    });
  });
  it("errors when --claim-deadline-sec is zero", () => {
    expect(parseArgs(["100", "--claim-deadline-sec", "0"])).toEqual({
      error: "--claim-deadline-sec must be a positive integer, got '0'",
    });
  });

  // --- --out (verdict-persistence path) ---
  it("accepts --out with a path value", () => {
    expect(parseArgs(["100", "--out", "/tmp/verdict.json"])).toEqual({
      pr: 100,
      out: "/tmp/verdict.json",
    });
  });
  it("errors when --out is missing its value", () => {
    expect(parseArgs(["100", "--out"])).toEqual({
      error: "--out requires a value",
    });
  });
  it("errors when --out is followed by another flag instead of a value", () => {
    expect(parseArgs(["100", "--out", "--wait-for-copilot"])).toEqual({
      error: "--out requires a value",
    });
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
  argv[argv.indexOf("--json") + 1] === "state,url,reviews,headRefOid,reviewRequests";

const isPrChecks = (argv: string[]) => argv[0] === "pr" && argv[1] === "checks";

// The retrigger now requests Copilot via the gh-CLI native command
// `gh pr edit <pr> --add-reviewer @copilot` (not the old requested_reviewers
// POST, which 422'd on the wrong Org login). The matcher name is retained
// for continuity with the tests that count "how many requests went out".
const isRequestedReviewersPost = (argv: string[]) =>
  argv[0] === "pr" && argv[1] === "edit" && argv.includes("--add-reviewer");

const PR_URL = "https://x/y/pull/100";
const STABLE_HEAD_SHA = "sha-current";

function reviewRequestsResponse(logins: string[]) {
  return {
    stdout: JSON.stringify({ reviewRequests: logins.map((login) => ({ login })) }),
    stderr: "",
    exitCode: 0,
  };
}

// Per-poll requested_reviewers read (item 1) + post-POST re-read (item 2) are
// both `gh pr view --json reviewRequests` calls matched by isReviewRequests.
// COPILOT_QUEUED reflects "Copilot is still queued this poll" (or, after a
// POST, "the re-read confirms Copilot was queued"). COPILOT_NOT_QUEUED is the
// silent-rejection / no-bot-queued variant.
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
  // The wire payload nests commit.oid under each review; the parser flattens
  // to commitOid. Stringify the wire shape, not the parsed shape.
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

function prChecksResponse(checks: Check[]) {
  return { stdout: JSON.stringify(checks), stderr: "", exitCode: 0 };
}

const ALL_PASSED: Check[] = [{ name: "test", state: "SUCCESS" }];
// Default commitOid matches STABLE_HEAD_SHA so existing tests don't trip the
// new stale-review retrigger (which would otherwise fire on any PR with a
// Copilot review against a SHA different from the PR's headRefOid).
const COPILOT_REVIEW: Review[] = [
  {
    author: { login: "copilot-pull-request-reviewer" },
    state: "COMMENTED",
    commitOid: STABLE_HEAD_SHA,
  },
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
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
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
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
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
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
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
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(true);
    expect(result.copilotConfigured).toBe(true);
  });

  it("derives copilotConfigured=true from a [bot]-suffixed reviewRequests entry (historical fallback off)", async () => {
    // GitHub may render the requested reviewer as `<login>[bot]` now that the
    // POST targets the [bot] request form. With readHistoricalBotReview forced
    // false, the only way copilotConfigured can be true is the suffix-tolerant
    // reviewRequests membership check at loop entry — and copilotRequestedThisPoll
    // re-reading the same [bot] form per poll. The exact-match form would miss both.
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer[bot]"]) },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      perPollReviewRequests(["copilot-pull-request-reviewer[bot]"]),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotConfigured).toBe(true);
  });

  it("exits 0 with 'proceed-to-review-no-bot' JSON after the 10-min copilot timeout", async () => {
    const clock = makeFakeClock();
    // Build a sequence: review-requests once, then 12 polls each (prView + prChecks).
    // CI is all-passed from poll 1 onward; copilot never POSTs a posted-state
    // review. The 10-min copilot timeout fires when elapsed-since-ci-terminal
    // >= 600s.
    //
    // PENDING-Copilot-review fixture rationale: under the new auto-detect
    // default, `unclaimed-after-deadline` would fire ~60s after CI terminal
    // (no Copilot review of any kind on current headRefOid + not in
    // requestedReviewers). To keep this test exercising the original 10-min
    // path, include a PENDING Copilot review on STABLE_HEAD_SHA — PENDING
    // counts as "a review of some kind on the current SHA" so the
    // unclaimed-after-deadline precondition fails, and PENDING is not
    // DISMISSED so the self-dismissed path also stays inert.
    const PENDING_COPILOT_ON_HEAD: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer" },
        state: "PENDING",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
    ];
    // ci_terminal lands at elapsedSec=0 (poll 1's all-passed observation).
    // Cadence ramp: 30×5 + 60×5 + 90×… → poll 12 elapsed=540s (<600), poll 13
    // elapsed=630s (>=600) → exit. 15 iterations gives headroom. Each poll also
    // re-reads requested_reviewers (item 1) between the prView and prChecks reads.
    for (let i = 0; i < 15; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", PENDING_COPILOT_ON_HEAD) });
      steps.push(perPollReviewRequests());
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
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
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
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
      perPollReviewRequests(),
      // No isPrChecks step — if the runner calls it, the sequence will fail.
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false, // CI not configured
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
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
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotConfigured).toBe(false);
    expect(result.polls).toBe(1);
  });

  it("--copilot-not-requested forces copilotConfigured=false even when historical fallback would say true (decline-collapse)", async () => {
    const clock = makeFakeClock();
    // reviewRequests EMPTY (no explicit request) and readHistoricalBotReview
    // returns true — without the flag this repo's history would keep
    // copilotConfigured true and the declined PR would wait the 10-min
    // Copilot timeout. With --copilot-not-requested the derivation is hard-
    // forced false, so poll 1 (CI all-passed) exits proceed-to-review.
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100", "--copilot-not-requested"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => true,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(false);
    expect(result.decision).toBe("proceed-to-review");
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
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
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
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    errSpy.mockRestore();
    expect(exit).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Historical-PR Copilot fallback (PR #78 / 2026-05-03 incident).
  // Repos with org/repo-level auto-review configurations don't add Copilot
  // to reviewRequests, so the supervisor must consult the recent-PR history
  // before deciding the bot is "not configured".
  // -------------------------------------------------------------------------

  it("respects the historical-PR fallback when reviewRequests is empty: copilot review pending → wait, not exit poll 1", async () => {
    const clock = makeFakeClock();
    // CI is all-passed from poll 1; copilot has not yet posted. The fallback
    // resolves copilotConfigured=true, so the loop must NOT exit poll 1 with
    // proceed-to-review — it must wait for the bot review or its 10-min timeout.
    // PENDING-on-current-SHA included so the new auto-detect skip
    // ('unclaimed-after-deadline') does not short-circuit the 10-min path —
    // same rationale as the canonical 10-min timeout test above.
    const PENDING_COPILOT_ON_HEAD: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer" },
        state: "PENDING",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
    ];
    // copilotConfigured=true via the historical fallback, but the in-flight PR's
    // requested_reviewers stays empty (the org-level auto-review case), so the
    // per-poll read returns COPILOT_NOT_QUEUED.
    for (let i = 0; i < 15; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", PENDING_COPILOT_ON_HEAD) });
      steps.push(perPollReviewRequests(COPILOT_NOT_QUEUED));
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => true, // historical fallback HIT
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(true);
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.elapsedSec).toBeGreaterThanOrEqual(600);
    expect(result.polls).toBeGreaterThan(1);
  });

  it("preserves COPILOT_REQUESTED=0 semantics when the historical-PR fallback misses", async () => {
    const clock = makeFakeClock();
    // No copilot in reviewRequests AND no historical reviews → fallback misses,
    // copilotConfigured stays false, copilot_posted treated as vacuously true,
    // helper exits on poll 1 once CI is terminal.
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false, // historical fallback MISS
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(false);
    expect(result.decision).toBe("proceed-to-review");
    expect(result.polls).toBe(1);
  });

  it("does NOT invoke the historical-PR fallback when Copilot is already in reviewRequests", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    let fallbackCalls = 0;
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => {
        fallbackCalls++;
        return true;
      },
    });
    cap.restore();
    expect(exit).toBe(0);
    expect(fallbackCalls).toBe(0); // short-circuited before the fallback
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(true);
    expect(result.decision).toBe("proceed-to-review");
  });

  it("collapses fallback errors to false (transient gh failure must not synthesise bot configured)", async () => {
    const clock = makeFakeClock();
    // Default fallback uses fetchHistoricalBotReview, which collapses gh
    // failures to false. Simulate by injecting a fake gh that rejects the
    // 'pr list' call; the helper must return copilotConfigured=false and
    // proceed without waiting the 10-min timeout.
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      // Default factory first tries the authoritative ruleset read; the
      // rules api 403s → "unknown" → it falls through to the heuristic.
      {
        matches: (argv) => argv[0] === "repo" && argv.includes("defaultBranchRef"),
        response: { stdout: "main", stderr: "", exitCode: 0 },
      },
      {
        matches: (argv) => argv[0] === "api",
        response: { stdout: "", stderr: "forbidden", exitCode: 1 },
      },
      // Heuristic floor fires here: 'gh pr list ...' fails.
      {
        matches: (argv) => argv[0] === "pr" && argv[1] === "list",
        response: { stdout: "", stderr: "boom", exitCode: 1 },
      },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      // No readHistoricalBotReview — exercises the default that uses gh.
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotConfigured).toBe(false);
    expect(result.decision).toBe("proceed-to-review");
    expect(result.polls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6b. run() integration — Copilot retrigger (PR #161 stale-review incident)
//
// Stale-review predicate: the most-recent Copilot review's commit.oid !==
// the PR's current headRefOid. Retrigger is one-shot per invocation, gated
// on CI terminal, and resets the 10-min Copilot timeout window from
// re-request. POST failure still consumes the budget.
// ---------------------------------------------------------------------------

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

describe("run() integration — Copilot retrigger", () => {
  it("(1) stale Copilot retrigger fires; fresh review at matching commit lands poll 2 → proceed-to-review", async () => {
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    const fresh = staleCopilotReview(HEAD_SHA); // same login, fresh commit
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      // Poll 1: stale review observed against HEAD_SHA → retrigger fires.
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isRequestedReviewersPost, response: { stdout: "", stderr: "", exitCode: 0 } },
      // Post-POST re-read (item 2) confirms Copilot is queued → copilotRetriggered.
      perPollReviewRequests(COPILOT_QUEUED),
      // Poll 2: fresh review at HEAD_SHA → proceed-to-review.
      { matches: isPrView, response: prViewResponse("OPEN", fresh, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotRetriggered).toBe(true);
    expect(result.polls).toBe(2);
    // Exactly one POST landed in the call sequence.
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(1);
    // Pins the user-facing stderr contract documented in the PR body's
    // User-facing changes section.
    expect(cap.stderr.join("")).toMatch(/Copilot review stale.*re-requested at poll 1/);
  });

  it("(2) one-shot enforcement: stale review + no fresh review → proceed-to-review-no-bot, exactly one POST", async () => {
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    // Build a long sequence where the stale review never gets a fresh follow-up.
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      // Poll 1: stale → retrigger fires.
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isRequestedReviewersPost, response: { stdout: "", stderr: "", exitCode: 0 } },
      perPollReviewRequests(COPILOT_QUEUED), // post-POST re-read confirms queued
    ];
    // Polls 2+ keep observing the stale review (no fresh one ever lands).
    // ciTerminalAt reset to poll-1 elapsed; the 10-min Copilot timeout fires
    // at >=600s elapsed-since-retrigger. Need enough polls for ~12-15
    // iterations under the 30-30-30-30-30-60-60-60-60-60-90-90-… ramp.
    for (let i = 0; i < 20; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) });
      steps.push(perPollReviewRequests());
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotRetriggered).toBe(true);
    // One-shot: exactly one POST regardless of how many subsequent polls
    // observe the stale review.
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(1);
  });

  it("(3) non-stale: latest Copilot review commit === headRefOid → proceed-to-review, no POST", async () => {
    const clock = makeFakeClock();
    const fresh = staleCopilotReview(HEAD_SHA); // commit matches HEAD
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", fresh, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotRetriggered).toBe(false);
    expect(result.polls).toBe(1);
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(0);
  });

  it("(4) retrigger gated on CI terminal: stale review with pending CI → no POST until CI is terminal", async () => {
    // readCommitsAreAllMerges:() => false preserves prior behavior; the
    // trigger-gated-on-CI-terminal test never reaches the new check on the
    // pending-CI polls (CI-terminal gate blocks first), so this only matters
    // on poll 3 — and false means we don't divert the retrigger.
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    const PENDING_CHECKS: Check[] = [{ name: "test", state: "IN_PROGRESS" }];
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      // Poll 1: CI pending, stale review observed → NO retrigger fires.
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) },
      // Poll 2: CI pending, stale review observed → still NO retrigger.
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) },
      // Poll 3: CI all-passed, stale review observed → retrigger fires.
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isRequestedReviewersPost, response: { stdout: "", stderr: "", exitCode: 0 } },
      perPollReviewRequests(COPILOT_QUEUED), // post-POST re-read confirms queued
      // Poll 4: fresh review lands → proceed-to-review.
      { matches: isPrView, response: prViewResponse("OPEN", staleCopilotReview(HEAD_SHA), HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ];
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotRetriggered).toBe(true);
    expect(result.polls).toBe(4);
    // The POST landed only after CI went terminal on poll 3.
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(1);
  });

  it("(5) POST failure: gh returns non-zero on the POST → loop continues, copilotRetriggered:true, no retry", async () => {
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      // Poll 1: stale review → retrigger fires but FAILS.
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      {
        matches: isRequestedReviewersPost,
        response: { stdout: "", stderr: "HTTP 422", exitCode: 1 },
      },
      // POST non-zero: NO post-POST re-read (item 2 only re-reads on POST ok).
    ];
    // Polls 2+ still observe the stale review (the POST didn't actually
    // re-request anyone). One-shot cap means no retry; eventual exit at the
    // 10-min Copilot timeout under the no-bot decision branch.
    for (let i = 0; i < 20; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) });
      steps.push(perPollReviewRequests());
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotRetriggered).toBe(true);
    // No second POST attempt even though the first failed.
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(1);
    // Retrigger stderr is surfaced (polling-protocol.md "request failure is
    // logged" contract — see bin/flow-ci-wait.ts run() retrigger site).
    expect(cap.stderr.join("")).toMatch(/Copilot retrigger failed/);
  });

  it("(6) skips retrigger when every intervening commit is a merge", async () => {
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    // Stale review + readCommitsAreAllMerges:() => true → no POST in gh.calls,
    // copilotRetriggered:false, decision proceeds via the existing-fresh-review
    // branch (the stale review still counts as "posted" pre-retrigger). The
    // first poll observes the stale review at HEAD_SHA, the merge-only check
    // diverts the retrigger, and deriveCopilotPosted (pre-retrigger semantics)
    // sees a POSTED Copilot review → exit proceed-to-review.
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => true,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotRetriggered).toBe(false);
    // Exactly zero POSTs went out.
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(0);
    // Decision proceeds via the existing-fresh-review or copilot-timeout
    // branches — for this single-poll fixture (CI-passed + stale-but-posted
    // Copilot review), the decision matrix exits proceed-to-review on poll 1.
    expect(result.decision).toBe("proceed-to-review");
    // The merge-only stderr line fires so the user sees why the loop didn't
    // retrigger.
    expect(cap.stderr.join("")).toMatch(/every intervening commit is a merge, skipping retrigger/);
  });

  it("(7) fires retrigger when at least one intervening commit is a regular non-merge commit", async () => {
    // Pin the default-behavior contract: same setup as test (1) but with
    // readCommitsAreAllMerges:() => false explicitly, asserting the
    // retrigger still fires (no regression from the new check when at
    // least one intervening commit is a non-merge).
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    const fresh = staleCopilotReview(HEAD_SHA);
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isRequestedReviewersPost, response: { stdout: "", stderr: "", exitCode: 0 } },
      perPollReviewRequests(COPILOT_QUEUED), // post-POST re-read confirms queued
      { matches: isPrView, response: prViewResponse("OPEN", fresh, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotRetriggered).toBe(true);
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(1);
    expect(cap.stderr.join("")).toMatch(/Copilot review stale.*re-requested at poll 1/);
  });

  it("(8) skips retrigger when intervening commits are a small follow-up", async () => {
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    // Stale review + readIsSmallFollowup:() => true (and readCommitsAreAllMerges
    // false, so the merge-only branch is skipped) → no POST, copilotRetriggered
    // false, decision proceeds via the existing-fresh-review branch (the stale
    // review still counts as "posted" pre-retrigger). Single-poll fixture: CI
    // all-passed + stale-but-posted Copilot review → exit proceed-to-review.
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => true,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.copilotRetriggered).toBe(false);
    // Exactly zero POSTs went out.
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(0);
    expect(result.decision).toBe("proceed-to-review");
    // The small-follow-up stderr line fires so the user sees why the loop
    // didn't retrigger.
    expect(cap.stderr.join("")).toMatch(/small follow-up, skipping retrigger/);
  });

  it("(9) fires retrigger when the intervening change is over the small-follow-up thresholds", async () => {
    // Over-threshold regression guard: same setup as test (7) but with
    // readIsSmallFollowup:() => false explicitly, asserting the retrigger
    // still fires when the intervening change is neither merge-only nor a
    // small follow-up.
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    const fresh = staleCopilotReview(HEAD_SHA);
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isRequestedReviewersPost, response: { stdout: "", stderr: "", exitCode: 0 } },
      perPollReviewRequests(COPILOT_QUEUED), // post-POST re-read confirms queued
      { matches: isPrView, response: prViewResponse("OPEN", fresh, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotRetriggered).toBe(true);
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(1);
    expect(cap.stderr.join("")).toMatch(/Copilot review stale.*re-requested at poll 1/);
  });
});

// ---------------------------------------------------------------------------
// 6b-2. run() integration — per-poll requested_reviewers signal (item 1)
//
// When CI is terminal and no Copilot review has posted, the per-poll stderr
// distinguishes "Copilot queued, still waiting" (login present in this poll's
// requested_reviewers) from "no Copilot review yet" (login absent).
// ---------------------------------------------------------------------------

describe("run() integration — per-poll requested_reviewers signal", () => {
  it("logs 'Copilot queued, still waiting' when Copilot is in requested_reviewers (CI terminal, no review)", async () => {
    const clock = makeFakeClock();
    // CI all-passed from poll 1; Copilot configured + still queued each poll but
    // never posts → loop until the 10-min timeout. Per-poll read returns the
    // login, so the queued-variant stderr fires.
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
    ];
    for (let i = 0; i < 15; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", []) });
      steps.push(perPollReviewRequests(COPILOT_QUEUED));
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const err = cap.stderr.join("");
    expect(err).toContain("Copilot queued, still waiting");
    expect(err).not.toContain("no Copilot review yet");
  });

  it("logs 'no Copilot review yet' when Copilot is absent from requested_reviewers (CI terminal, no review)", async () => {
    const clock = makeFakeClock();
    // Copilot configured via the historical fallback, but the in-flight PR's
    // requested_reviewers is empty each poll (org-level auto-review case) → the
    // no-bot-queued variant fires.
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
    ];
    for (let i = 0; i < 15; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", []) });
      steps.push(perPollReviewRequests(COPILOT_NOT_QUEUED));
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => true, // fallback → copilotConfigured
    });
    cap.restore();
    expect(exit).toBe(0);
    const err = cap.stderr.join("");
    expect(err).toContain("no Copilot review yet");
    expect(err).not.toContain("Copilot queued, still waiting");
  });
});

// ---------------------------------------------------------------------------
// 6b-3. run() integration — post-POST verification / silent rejection (item 2)
//
// After a POST-ok retrigger, re-read requested_reviewers. If the login is
// present → today's behavior (copilotRetriggered:true, loop continues). If
// absent (silent rejection) → NOTICE on stderr, copilotRetriggered:false,
// immediate proceed-to-review-no-bot with no 10-min wait.
// ---------------------------------------------------------------------------

describe("run() integration — post-POST verification (item 2)", () => {
  it("POST ok + re-read confirms Copilot queued → copilotRetriggered:true, loop continues", async () => {
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    const fresh = staleCopilotReview(HEAD_SHA);
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      // Poll 1: stale → POST → re-read confirms queued.
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isRequestedReviewersPost, response: { stdout: "", stderr: "", exitCode: 0 } },
      perPollReviewRequests(COPILOT_QUEUED), // re-read: present
      // Poll 2: fresh review lands → proceed-to-review.
      { matches: isPrView, response: prViewResponse("OPEN", fresh, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.copilotRetriggered).toBe(true);
    expect(result.polls).toBe(2);
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(1);
  });

  it("POST ok + re-read misses (silent rejection) → proceed-to-review-no-bot, copilotRetriggered:false, NOTICE, no 10-min wait", async () => {
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      // Poll 1: stale → POST returns ok → re-read does NOT include Copilot.
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isRequestedReviewersPost, response: { stdout: "", stderr: "", exitCode: 0 } },
      perPollReviewRequests(COPILOT_NOT_QUEUED), // re-read: absent → silent rejection
      // No further steps: the run must short-circuit and return immediately.
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotRetriggered).toBe(false);
    // Short-circuit on poll 1, well below the 600s Copilot timeout.
    expect(result.polls).toBe(1);
    expect(result.elapsedSec).toBeLessThan(600);
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(1);
    expect(cap.stderr.join("")).toContain("NOTICE");
    expect(cap.stderr.join("")).toContain("silent rejection");
  });

  it("POST non-zero (422/403) path is unchanged: copilotRetriggered:true, no re-read, falls through to the timeout", async () => {
    const clock = makeFakeClock();
    const stale = staleCopilotReview(STALE_SHA);
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      {
        matches: isRequestedReviewersPost,
        response: { stdout: "", stderr: "HTTP 422: Unprocessable", exitCode: 1 },
      },
      // POST non-zero: NO post-POST re-read. Loop falls through to the 10-min timeout.
    ];
    for (let i = 0; i < 15; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", stale, HEAD_SHA) });
      steps.push(perPollReviewRequests());
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotRetriggered).toBe(true);
    expect(result.elapsedSec).toBeGreaterThanOrEqual(600);
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(1);
    expect(cap.stderr.join("")).toContain("Copilot retrigger failed");
    expect(cap.stderr.join("")).not.toContain("NOTICE");
  });
});

// ---------------------------------------------------------------------------
// 6b-2. run() integration — Copilot auto-detect short-circuit
//
// Covers the two new exit attributions:
//   - 'unclaimed-after-deadline': CI terminal + claim deadline elapsed +
//     no Copilot review of any state on the current headRefOid + Copilot
//     not in requestedReviewers.
//   - 'self-dismissed': DISMISSED Copilot review on the current headRefOid
//     with no non-dismissed review by the same login on the same SHA.
// Both suppressed by --wait-for-copilot.
// ---------------------------------------------------------------------------

describe("run() integration — Copilot auto-detect short-circuit", () => {
  const LOGIN = "copilot-pull-request-reviewer";

  it("'unclaimed-after-deadline' fires after the claim deadline elapses with no Copilot review and Copilot not requested", async () => {
    const clock = makeFakeClock();
    // 30s claim deadline; CI terminal at poll 1 (elapsedSec=0); poll 2 fires
    // after 30s sleep at elapsedSec=30 → elapsedSec - ciTerminalAt >= 30 → exit.
    // Copilot not in per-poll reviewRequests, no Copilot review on any SHA.
    const gh = makeGhSequence([
      // Loop-entry presence check: copilot is configured (loop-entry only).
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      // Poll 1: CI terminal, no Copilot review, copilot NOT in per-poll requests.
      { matches: isPrView, response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      // Poll 2: same observation, but now 30s elapsed since CI terminal.
      { matches: isPrView, response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100", "--claim-deadline-sec", "30"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotSkipReason).toBe("unclaimed-after-deadline");
    expect(result.polls).toBe(2);
    // The auto-detect stderr line attributing the exit.
    expect(cap.stderr.join("")).toMatch(/Copilot auto-detect: unclaimed-after-deadline/);
  });

  // --- claim-deadline precedence: CLI flag -> config -> default -----------
  // Observable: with a 30s deadline the short-circuit fires at poll 2
  // (elapsedSec=30); with the default 60s it only fires at poll 3
  // (elapsedSec=60). Same fixture shape as the canonical
  // 'unclaimed-after-deadline' test above.
  it("config readClaimDeadline (30) drives the deadline when no --claim-deadline-sec flag → fires at poll 2", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      { matches: isPrView, response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isPrView, response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      readClaimDeadline: () => 30,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotSkipReason).toBe("unclaimed-after-deadline");
    expect(result.polls).toBe(2);
  });

  it("--claim-deadline-sec flag (30) overrides config readClaimDeadline (5000) → fires at poll 2", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      { matches: isPrView, response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isPrView, response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100", "--claim-deadline-sec", "30"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      // High config value loses to the flag; if config won here the
      // short-circuit would not fire by poll 2 and polls would exceed 2.
      readClaimDeadline: () => 5000,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotSkipReason).toBe("unclaimed-after-deadline");
    expect(result.polls).toBe(2);
  });

  it("falls back to DEFAULT_CLAIM_DEADLINE_SEC (60) when neither flag nor config is set → fires at poll 3", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      // Poll 1 (elapsedSec=0), poll 2 (elapsedSec=30) — below the 60s
      // default so no short-circuit yet; poll 3 (elapsedSec=60) fires.
      { matches: isPrView, response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isPrView, response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      { matches: isPrView, response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      readClaimDeadline: () => undefined,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotSkipReason).toBe("unclaimed-after-deadline");
    expect(result.polls).toBe(3);
  });

  it("'self-dismissed' fires when DISMISSED on current headRefOid + retrigger does NOT fire", async () => {
    const clock = makeFakeClock();
    const dismissed: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: STABLE_HEAD_SHA },
    ];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      // Poll 1: CI terminal + Copilot DISMISSED on current SHA → self-dismissed.
      { matches: isPrView, response: prViewResponse("OPEN", dismissed, STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotSkipReason).toBe("self-dismissed");
    expect(result.polls).toBe(1);
    // CRITICAL ORDERING assertion: the stale-review retrigger does NOT
    // fire when self-dismissed short-circuits — the auto-detect runs BEFORE
    // the retrigger gate. Belt-and-suspenders via the captured gh call log.
    expect(gh.calls.filter(isRequestedReviewersPost)).toHaveLength(0);
  });

  it("--wait-for-copilot suppresses 'self-dismissed' on current-SHA DISMISSED (falls through to retrigger gate)", async () => {
    const clock = makeFakeClock();
    // With --wait-for-copilot, the auto-detect short-circuit is inert.
    // A DISMISSED Copilot review on the current SHA is not "stale" by the
    // PR #161 predicate (commitOid === headRefOid), so the retrigger
    // doesn't fire either. The loop runs until the existing 10-min copilot
    // timeout fires (Copilot has not POSTED).
    const dismissed: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: STABLE_HEAD_SHA },
    ];
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
    ];
    for (let i = 0; i < 15; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", dismissed, STABLE_HEAD_SHA, []) });
      steps.push(perPollReviewRequests(COPILOT_NOT_QUEUED));
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100", "--wait-for-copilot"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    // copilotSkipReason is null (the existing 10-min timeout fired, not the
    // auto-detect path). Every normal-exit path now emits null on the wire
    // so the documented schema and the actual JSON agree — see
    // polling-protocol.md decision-matrix row for the 10-min timeout.
    expect(result.copilotSkipReason).toBeNull();
    expect(result.elapsedSec).toBeGreaterThanOrEqual(600);
  });

  it("--wait-for-copilot suppresses 'unclaimed-after-deadline' too (falls through to the 10-min timeout)", async () => {
    const clock = makeFakeClock();
    // PENDING Copilot review on current SHA prevents 'unclaimed-after-deadline'
    // from firing under the auto-detect path (defence in depth, the
    // --wait-for-copilot flag is the primary suppressor here).
    const pending: Review[] = [
      { author: { login: LOGIN }, state: "PENDING", commitOid: STABLE_HEAD_SHA },
    ];
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
    ];
    for (let i = 0; i < 15; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", pending, STABLE_HEAD_SHA, []) });
      steps.push(perPollReviewRequests(COPILOT_NOT_QUEUED));
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100", "--wait-for-copilot", "--claim-deadline-sec", "30"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review-no-bot");
    expect(result.copilotSkipReason).toBeNull();
    expect(result.elapsedSec).toBeGreaterThanOrEqual(600);
  });

  // Precedence-guard regression tests. The auto-detect short-circuit in
  // run() must not pre-empt `decideOnPoll`'s pr-state (MERGED/CLOSED) or
  // ci-failed branches. Without the guards on the short-circuit, a poll
  // whose `deriveCopilotSkipReason` returns non-null would silently reroute
  // ci-failed → proceed-to-review-no-bot (disabling the 3-loop fix-loop
  // recovery) and merged-externally → proceed-to-review-no-bot (skipping
  // the documented MERGED cleanup). The fixtures below combine the
  // auto-detect triggering conditions with each pre-empted branch, so the
  // regression has a failing test the moment the guards are removed.

  it("ci-failed wins over 'unclaimed-after-deadline' (regression: short-circuit must not bypass ci-failed)", async () => {
    const clock = makeFakeClock();
    // Same fixture shape as the 'unclaimed-after-deadline' test above, but CI
    // is FAILED. Without the `ci.kind !== 'failed'` guard, the helper exits
    // proceed-to-review-no-bot at poll 2 instead of ci-failed at poll 1.
    const failed: Check[] = [{ name: "lint", state: "FAILURE" }];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      // Poll 1: CI failed, no Copilot review on current SHA, Copilot not
      // requested. The auto-detect's deadline hasn't elapsed yet (poll 1
      // is at elapsedSec=0), but on poll 2 it would — except ci-failed
      // already exited at poll 1.
      { matches: isPrView, response: prViewResponse("OPEN", [], STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(failed) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100", "--claim-deadline-sec", "30"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("ci-failed");
    expect(result.copilotSkipReason).toBeNull();
    expect(result.ciFailedChecks).toEqual(failed);
  });

  it("ci-failed wins over 'self-dismissed' (regression: short-circuit must not bypass ci-failed)", async () => {
    const clock = makeFakeClock();
    // Copilot self-dismissed on current SHA + CI fails on the same poll.
    // Without the guard, the helper exits proceed-to-review-no-bot via
    // self-dismissed instead of ci-failed. The fix-loop recovery would be
    // silently disabled.
    const failed: Check[] = [{ name: "test", state: "FAILURE" }];
    const dismissed: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: STABLE_HEAD_SHA },
    ];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      { matches: isPrView, response: prViewResponse("OPEN", dismissed, STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(failed) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("ci-failed");
    expect(result.copilotSkipReason).toBeNull();
    expect(result.ciFailedChecks).toEqual(failed);
  });

  it("merged-externally wins over 'self-dismissed' (regression: short-circuit must not bypass pr-state)", async () => {
    const clock = makeFakeClock();
    // PR is MERGED + Copilot self-dismissed on current SHA. Without the
    // `prInfo.state === 'OPEN'` guard, the helper exits
    // proceed-to-review-no-bot instead of merged-externally — and the
    // supervisor's MERGED cleanup block never runs. The `pr checks` step
    // is required because copilotConfigured=true via reviewRequests forces
    // ciConfigured=true (the per-poll observeChecks fires before
    // decideOnPoll routes on prState).
    const dismissed: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: STABLE_HEAD_SHA },
    ];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      { matches: isPrView, response: prViewResponse("MERGED", dismissed, STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("merged-externally");
    expect(result.copilotSkipReason).toBeNull();
    expect(result.prState).toBe("MERGED");
  });

  it("pr-closed wins over 'self-dismissed' (regression: short-circuit must not bypass pr-state)", async () => {
    const clock = makeFakeClock();
    // PR is CLOSED + Copilot self-dismissed on current SHA. Same shape as
    // the MERGED test above; both pr-state branches must take precedence.
    const dismissed: Review[] = [
      { author: { login: LOGIN }, state: "DISMISSED", commitOid: STABLE_HEAD_SHA },
    ];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([LOGIN]) },
      { matches: isPrView, response: prViewResponse("CLOSED", dismissed, STABLE_HEAD_SHA, []) },
      { matches: isReviewRequests, response: reviewRequestsResponse(COPILOT_NOT_QUEUED) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readCommitsAreAllMerges: () => false,
      readIsSmallFollowup: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-closed");
    expect(result.copilotSkipReason).toBeNull();
    expect(result.prState).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// 6b-4. run() integration — branch-conflict short-circuit (pr-conflicted)
//
// A branch conflict (mergeStateStatus in {CONFLICTING, DIRTY}) means GitHub
// cannot build the merge ref, so CI never starts. The loop detects this
// per-poll (covering loop-entry and mid-wait) and emits pr-conflicted
// immediately rather than waiting out the 20-min cap to ci-hang. UNKNOWN
// (still computing) and a transient gh failure (readMergeState → null) both
// keep polling. MERGED/CLOSED precedence is preserved by the OPEN guard.
// Uses the readMergeState Deps injectable to avoid the strict-order gh trap.
// ---------------------------------------------------------------------------

describe("run() integration — branch-conflict short-circuit", () => {
  const LOGIN = "copilot-pull-request-reviewer";
  const CLEAN_MERGE = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };

  it("(1) CONFLICTING at entry → pr-conflicted at poll 1", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false,
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readMergeState: () => ({ mergeable: "CONFLICTING", mergeStateStatus: "CONFLICTING" }),
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-conflicted");
    expect(result.polls).toBe(1);
    expect(cap.stderr.join("")).toMatch(/Branch conflict detected/);
  });

  it("(2) DIRTY at entry → pr-conflicted at poll 1", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false,
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" }),
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-conflicted");
    expect(result.polls).toBe(1);
  });

  it("(3) mergeable/mergeStateStatus UNKNOWN (still computing) does NOT short-circuit — keeps polling to a terminal decision", async () => {
    const clock = makeFakeClock();
    // CI configured + pending on poll 1, all-passed on poll 2; copilot not
    // configured (empty entry reviewRequests + no history). UNKNOWN merge
    // state every poll must NOT fire pr-conflicted, so the loop reaches
    // proceed-to-review on poll 2 (polls > 1).
    const PENDING_CHECKS: Check[] = [{ name: "test", state: "IN_PROGRESS" }];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readMergeState: () => ({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.polls).toBeGreaterThan(1);
  });

  it("(4) mid-wait flip: CLEAN on poll 1 then CONFLICTING on poll 2 → pr-conflicted on poll 2", async () => {
    const clock = makeFakeClock();
    const PENDING_CHECKS: Check[] = [{ name: "test", state: "IN_PROGRESS" }];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      // Poll 1: CLEAN merge state, CI pending → keep polling.
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) },
      // Poll 2: conflict flips in → pr-conflicted before observeChecks.
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    let call = 0;
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readMergeState: () => {
        call++;
        return call === 1
          ? CLEAN_MERGE
          : { mergeable: "CONFLICTING", mergeStateStatus: "CONFLICTING" };
      },
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-conflicted");
    expect(result.polls).toBe(2);
  });

  it("(5) transient gh merge-state failure (readMergeState → null) keeps polling — no false pr-conflicted", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readMergeState: () => null,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(cap.stderr.join("")).not.toMatch(/Branch conflict detected/);
  });

  it("(6) precedence: MERGED PR with CONFLICTING merge state → merged-externally (OPEN guard preserves precedence)", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false,
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readMergeState: () => ({ mergeable: "CONFLICTING", mergeStateStatus: "CONFLICTING" }),
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("merged-externally");
    expect(result.prState).toBe("MERGED");
  });
});

// ---------------------------------------------------------------------------
// 6b-2. run() integration — branch-protection (pr-blocked) short-circuit
// ---------------------------------------------------------------------------

describe("run() integration — branch-protection short-circuit", () => {
  const LOGIN = "copilot-pull-request-reviewer";
  const BLOCKED_MERGE = { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" };

  it("(1) CI vacuously terminal + BLOCKED → pr-blocked at poll 1", async () => {
    // readWorkflowsDir:false ⇒ CI not configured ⇒ vacuously terminal, so the
    // poll would otherwise emit proceed-to-review on poll 1. BLOCKED intercepts.
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false,
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readMergeState: () => BLOCKED_MERGE,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-blocked");
    expect(result.polls).toBe(1);
    expect(cap.stderr.join("")).toMatch(/Branch protection blocked \(mergeStateStatus=BLOCKED\)/);
  });

  it("(2) pending CI + BLOCKED does NOT fire while pending — fires only after CI reaches terminal (poll 2)", async () => {
    // The load-bearing CI-terminal gate: poll 1 has a pending required check
    // (which is WHY mergeStateStatus is BLOCKED); the short-circuit must NOT
    // fire there or it would defeat the wait. Poll 2 the check passes but the
    // PR is still BLOCKED (a non-check protection rule) → pr-blocked.
    const clock = makeFakeClock();
    const PENDING_CHECKS: Check[] = [{ name: "test", state: "IN_PROGRESS" }];
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(PENDING_CHECKS) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readMergeState: () => BLOCKED_MERGE,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-blocked");
    expect(result.polls).toBe(2);
  });

  it.each(["CLEAN", "BEHIND", "UNSTABLE", "HAS_HOOKS"])(
    "(3) CI terminal + non-blocking mergeStateStatus=%s → proceed-to-review, never pr-blocked",
    async (status) => {
      const clock = makeFakeClock();
      const gh = makeGhSequence([
        { matches: isReviewRequests, response: reviewRequestsResponse([]) },
        { matches: isPrView, response: prViewResponse("OPEN", []) },
        { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
      ]);
      const cap = captureStreams();
      const exit = await run(["100"], {
        gh,
        now: clock.now,
        sleep: clock.sleep,
        readWorkflowsDir: () => true,
        readCopilotLogin: () => LOGIN,
        readHistoricalBotReview: () => false,
        readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: status }),
      });
      cap.restore();
      expect(exit).toBe(0);
      const result = JSON.parse(cap.stdout.join("")) as RunResult;
      expect(result.decision).toBe("proceed-to-review");
      expect(cap.stderr.join("")).not.toMatch(/Branch protection blocked/);
    },
  );

  it("(4) transient gh merge-state failure (readMergeState → null) keeps polling — no false pr-blocked", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readMergeState: () => null,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(cap.stderr.join("")).not.toMatch(/Branch protection blocked/);
  });

  it("(5) precedence: MERGED PR with BLOCKED merge state → merged-externally (OPEN guard preserves precedence)", async () => {
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false,
      readCopilotLogin: () => LOGIN,
      readHistoricalBotReview: () => false,
      readMergeState: () => BLOCKED_MERGE,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("merged-externally");
    expect(result.prState).toBe("MERGED");
  });

  it("(6) proceed-to-review-no-bot arm: 10-min copilot timeout + still BLOCKED → pr-blocked", async () => {
    // Exercises the OTHER interception disjunct: decideOnPoll returns
    // proceed-to-review-no-bot (the 10-min copilot timeout, not the auto-detect
    // early-emit which returns before the intercept), and the PR is still
    // BLOCKED → pr-blocked. Mirrors the canonical 10-min timeout integration
    // test, including the PENDING-Copilot-on-head fixture that keeps the
    // unclaimed-after-deadline / self-dismissed auto-detect paths inert so the
    // verdict flows through decideOnPoll to the intercept.
    const clock = makeFakeClock();
    const PENDING_COPILOT_ON_HEAD: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer" },
        state: "PENDING",
        commitOid: STABLE_HEAD_SHA,
      },
    ];
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
    ];
    for (let i = 0; i < 15; i++) {
      steps.push({ matches: isPrView, response: prViewResponse("OPEN", PENDING_COPILOT_ON_HEAD) });
      steps.push(perPollReviewRequests());
      steps.push({ matches: isPrChecks, response: prChecksResponse(ALL_PASSED) });
    }
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("pr-blocked");
    expect(result.elapsedSec).toBeGreaterThanOrEqual(600);
    expect(cap.stderr.join("")).toMatch(/Branch protection blocked \(mergeStateStatus=BLOCKED\)/);
  });
});

// ---------------------------------------------------------------------------
// 6c. allMergeCommitsBetween — unit tests
// ---------------------------------------------------------------------------

describe(allMergeCommitsBetween, () => {
  function ghFromQueue(queue: Array<{ stdout: string; exitCode: number }>): GhRunner & {
    calls: string[][];
  } {
    const calls: string[][] = [];
    let cursor = 0;
    const fn = ((argv: string[]) => {
      calls.push(argv);
      const next = queue[cursor++];
      if (!next) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: next.stdout, stderr: "", exitCode: next.exitCode };
    }) as GhRunner & { calls: string[][] };
    fn.calls = calls;
    return fn;
  }

  it("returns true when every commit has >= 2 parents (all-merges)", () => {
    const gh = ghFromQueue([
      {
        stdout: JSON.stringify([
          { sha: "a", parents: [{ sha: "p1" }, { sha: "p2" }] },
          { sha: "b", parents: [{ sha: "p3" }, { sha: "p4" }] },
        ]),
        exitCode: 0,
      },
    ]);
    expect(allMergeCommitsBetween("from", "to", gh)).toBe(true);
  });

  it("returns false when at least one commit has < 2 parents (one non-merge)", () => {
    const gh = ghFromQueue([
      {
        stdout: JSON.stringify([
          { sha: "a", parents: [{ sha: "p1" }, { sha: "p2" }] },
          { sha: "b", parents: [{ sha: "p3" }] }, // regular commit
        ]),
        exitCode: 0,
      },
    ]);
    expect(allMergeCommitsBetween("from", "to", gh)).toBe(false);
  });

  it("returns false when gh exits non-zero (fail-open)", () => {
    const gh = ghFromQueue([{ stdout: "", exitCode: 1 }]);
    expect(allMergeCommitsBetween("from", "to", gh)).toBe(false);
  });

  it("returns false on malformed JSON", () => {
    const gh = ghFromQueue([{ stdout: "not-json{", exitCode: 0 }]);
    expect(allMergeCommitsBetween("from", "to", gh)).toBe(false);
  });

  it("returns false on an empty commits array (no commits to skip on)", () => {
    const gh = ghFromQueue([{ stdout: "[]", exitCode: 0 }]);
    expect(allMergeCommitsBetween("from", "to", gh)).toBe(false);
  });

  it("returns true on a single merge commit", () => {
    const gh = ghFromQueue([
      {
        stdout: JSON.stringify([{ sha: "a", parents: [{ sha: "p1" }, { sha: "p2" }] }]),
        exitCode: 0,
      },
    ]);
    expect(allMergeCommitsBetween("from", "to", gh)).toBe(true);
  });

  it("builds the documented gh api argv with the compare endpoint and --jq .commits", () => {
    const gh = ghFromQueue([{ stdout: "[]", exitCode: 0 }]);
    allMergeCommitsBetween("oldsha", "newsha", gh);
    expect(gh.calls[0]).toEqual([
      "api",
      "repos/{owner}/{repo}/compare/oldsha...newsha",
      "--jq",
      ".commits",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6d. isSmallFollowup — unit tests
// ---------------------------------------------------------------------------

describe(isSmallFollowup, () => {
  function ghFromQueue(queue: Array<{ stdout: string; exitCode: number }>): GhRunner & {
    calls: string[][];
  } {
    const calls: string[][] = [];
    let cursor = 0;
    const fn = ((argv: string[]) => {
      calls.push(argv);
      const next = queue[cursor++];
      if (!next) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: next.stdout, stderr: "", exitCode: next.exitCode };
    }) as GhRunner & { calls: string[][] };
    fn.calls = calls;
    return fn;
  }

  it("returns true when every commit message carries the (pr-review #N) marker (kind signal)", () => {
    const gh = ghFromQueue([
      {
        stdout: JSON.stringify({
          messages: ["fix(x): thing (pr-review #97)", "chore(y): z (pr-review #97)"],
          // Files large enough to exceed the size thresholds — the kind
          // signal must short-circuit before the size signal is consulted.
          files: [{ additions: 200, deletions: 100, filename: "a.ts" }],
        }),
        exitCode: 0,
      },
    ]);
    expect(isSmallFollowup("from", "to", gh)).toBe(true);
  });

  it("returns true on non-fix-applier messages when total LOC <= 15 and files <= 3 (size signal)", () => {
    const gh = ghFromQueue([
      {
        stdout: JSON.stringify({
          messages: ["feat: small change", "docs: tweak"],
          files: [
            { additions: 5, deletions: 3, filename: "a.ts" },
            { additions: 2, deletions: 1, filename: "b.ts" },
          ],
        }),
        exitCode: 0,
      },
    ]);
    expect(isSmallFollowup("from", "to", gh)).toBe(true);
  });

  it("returns false when total LOC exceeds 15 (over-LOC)", () => {
    const gh = ghFromQueue([
      {
        stdout: JSON.stringify({
          messages: ["feat: bigger change"],
          files: [{ additions: 20, deletions: 0, filename: "a.ts" }],
        }),
        exitCode: 0,
      },
    ]);
    expect(isSmallFollowup("from", "to", gh)).toBe(false);
  });

  it("returns false when more than 3 distinct files are touched (over-files)", () => {
    const gh = ghFromQueue([
      {
        stdout: JSON.stringify({
          messages: ["feat: spread-out change"],
          files: [
            { additions: 1, deletions: 0, filename: "a.ts" },
            { additions: 1, deletions: 0, filename: "b.ts" },
            { additions: 1, deletions: 0, filename: "c.ts" },
            { additions: 1, deletions: 0, filename: "d.ts" },
          ],
        }),
        exitCode: 0,
      },
    ]);
    expect(isSmallFollowup("from", "to", gh)).toBe(false);
  });

  it("returns false when files is absent and the kind signal does not match (fail-open)", () => {
    const gh = ghFromQueue([
      {
        stdout: JSON.stringify({ messages: ["feat: change"] }),
        exitCode: 0,
      },
    ]);
    expect(isSmallFollowup("from", "to", gh)).toBe(false);
  });

  it("returns false when gh exits non-zero (fail-open)", () => {
    const gh = ghFromQueue([{ stdout: "", exitCode: 1 }]);
    expect(isSmallFollowup("from", "to", gh)).toBe(false);
  });

  it("returns false on malformed JSON (fail-open)", () => {
    const gh = ghFromQueue([{ stdout: "not-json{", exitCode: 0 }]);
    expect(isSmallFollowup("from", "to", gh)).toBe(false);
  });

  it("returns false on an empty messages array (fail-open / no commits)", () => {
    const gh = ghFromQueue([
      { stdout: JSON.stringify({ messages: [], files: [] }), exitCode: 0 },
    ]);
    expect(isSmallFollowup("from", "to", gh)).toBe(false);
  });

  it("falls through to the size signal when only some messages carry the marker", () => {
    const gh = ghFromQueue([
      {
        stdout: JSON.stringify({
          // One marked, one not → kind signal false; size signal then
          // fires on a small diff and decides true.
          messages: ["fix(x): thing (pr-review #97)", "feat: unmarked"],
          files: [{ additions: 4, deletions: 2, filename: "a.ts" }],
        }),
        exitCode: 0,
      },
    ]);
    expect(isSmallFollowup("from", "to", gh)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. run() integration — workflow trigger filesystem behavior
//
// These tests exercise the real cwd → defaultReadWorkflowsDir seam (no
// readWorkflowsDir injection). The point is to verify PR #152's fix:
// schedule-only workflows must NOT trip CI_CONFIGURED=1 just because a
// .yml file sits in .github/workflows/.
// ---------------------------------------------------------------------------

describe("run() integration — workflow trigger filesystem behavior", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop()!;
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function makeTmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ci-wait-test-"));
    tmpDirs.push(d);
    return d;
  }

  function writeWorkflow(tmp: string, name: string, body: string): void {
    const wfDir = path.join(tmp, ".github", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, name), body);
  }

  it("schedule-only workflow: CI not configured, no 'gh pr checks' call, exits poll 1", async () => {
    const tmp = makeTmp();
    writeWorkflow(
      tmp,
      "cron.yml",
      "on:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo noop\n",
    );
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      // No isPrChecks step — if the runner calls it, the sequence throws.
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      cwd: tmp,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(false);
    // Fence the historical fallback: a future presence-check ordering change
    // must not synthesise a bot signal silently for schedule-only repos.
    expect(result.copilotConfigured).toBe(false);
    expect(result.polls).toBe(1);
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "checks")).toBe(false);
  });

  it("mixed workflows directory: schedule-only .yml + qualifying .yaml → ciConfigured=true", async () => {
    const tmp = makeTmp();
    // Cron workflow does NOT qualify; ci.yaml DOES (note the .yaml extension).
    writeWorkflow(
      tmp,
      "cron.yml",
      "on:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo noop\n",
    );
    writeWorkflow(
      tmp,
      "ci.yaml",
      "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n",
    );
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      cwd: tmp,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(true);
  });

  it("slow CI with qualifying trigger: ciConfigured=true, three polls until SUCCESS lands", async () => {
    const tmp = makeTmp();
    writeWorkflow(
      tmp,
      "ci.yml",
      "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n",
    );
    const clock = makeFakeClock();
    const steps: GhStep[] = [
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      // Poll 1: empty checks → no-checks-reported → loop
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      perPollReviewRequests(COPILOT_NOT_QUEUED),
      { matches: isPrChecks, response: prChecksResponse([]) },
      // Poll 2: empty checks → loop
      { matches: isPrView, response: prViewResponse("OPEN", []) },
      perPollReviewRequests(COPILOT_NOT_QUEUED),
      { matches: isPrChecks, response: prChecksResponse([]) },
      // Poll 3: SUCCESS + Copilot review posted → exit
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      perPollReviewRequests(COPILOT_NOT_QUEUED),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ];
    const gh = makeGhSequence(steps);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      cwd: tmp,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => true, // bot is expected → don't short-circuit
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(true);
    expect(result.polls).toBe(3);
  });

  it("no workflows directory: CI not configured, no 'gh pr checks' call", async () => {
    const tmp = makeTmp(); // no .github/workflows/ created
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100"], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      cwd: tmp,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const result = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(result.decision).toBe("proceed-to-review");
    expect(result.ciConfigured).toBe(false);
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "checks")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6c. run() integration — verdict persistence
//
// The verdict JSON is written to a durable file in addition to stdout, so a
// backgrounded call whose foreground capture is cut by the harness budget is
// still recoverable on resume. Persistence must fire on every emitResult exit
// path; these tests cover the standard verdict-driven exit plus one early-emit
// path (pr-conflicted), assert the file parses to the same object emitted on
// stdout, and assert the default `<cwd>/.flow-tmp/ci-wait-result.json` path is
// used when --out is omitted.
// ---------------------------------------------------------------------------

describe("run() integration — verdict persistence", () => {
  it("writes the verdict to the --out path matching stdout on the standard exit", async () => {
    const outPath = path.join(globalCwd, "out", "ci-wait-result.json");
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse(["copilot-pull-request-reviewer"]) },
      { matches: isPrView, response: prViewResponse("OPEN", COPILOT_REVIEW) },
      perPollReviewRequests(),
      { matches: isPrChecks, response: prChecksResponse(ALL_PASSED) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100", "--out", outPath], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => true,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const stdoutResult = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(stdoutResult.decision).toBe("proceed-to-review");
    // The file exists, parses, and is byte-identical to the stdout JSON.
    expect(fs.existsSync(outPath)).toBe(true);
    const fileResult = JSON.parse(fs.readFileSync(outPath, "utf8")) as RunResult;
    expect(fileResult).toEqual(stdoutResult);
  });

  it("writes the verdict on the pr-conflicted early-emit path", async () => {
    const outPath = path.join(globalCwd, "out", "ci-wait-result.json");
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("OPEN", []) },
    ]);
    const cap = captureStreams();
    const exit = await run(["100", "--out", outPath], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false,
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
      readMergeState: () => ({ mergeable: "CONFLICTING", mergeStateStatus: "CONFLICTING" }),
    });
    cap.restore();
    expect(exit).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);
    const fileResult = JSON.parse(fs.readFileSync(outPath, "utf8")) as RunResult;
    expect(fileResult.decision).toBe("pr-conflicted");
  });

  it("defaults to <cwd>/.flow-tmp/ci-wait-result.json when --out is omitted", async () => {
    const defaultPath = path.join(globalCwd, ".flow-tmp", "ci-wait-result.json");
    expect(fs.existsSync(defaultPath)).toBe(false);
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
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    expect(exit).toBe(0);
    const stdoutResult = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(fs.existsSync(defaultPath)).toBe(true);
    const fileResult = JSON.parse(fs.readFileSync(defaultPath, "utf8")) as RunResult;
    expect(fileResult).toEqual(stdoutResult);
    expect(fileResult.decision).toBe("merged-externally");
  });

  it("a persist-write failure does not suppress stdout or change the exit code", async () => {
    // Point --out at a path whose parent is a regular FILE, so fs.mkdirSync
    // throws ENOTDIR. The write-failure try/catch in emitResult must swallow
    // it: stdout JSON and exit 0 stay intact, a stderr line is emitted, and
    // no verdict file is created.
    const blocker = path.join(globalCwd, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const outPath = path.join(blocker, "result.json");
    const clock = makeFakeClock();
    const gh = makeGhSequence([
      { matches: isReviewRequests, response: reviewRequestsResponse([]) },
      { matches: isPrView, response: prViewResponse("MERGED") },
    ]);
    const cap = captureStreams();
    const exit = await run(["100", "--out", outPath], {
      gh,
      now: clock.now,
      sleep: clock.sleep,
      readWorkflowsDir: () => false,
      readMergeState: () => ({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
      readCopilotLogin: () => "copilot-pull-request-reviewer",
      readHistoricalBotReview: () => false,
    });
    cap.restore();
    // (a) exit code unchanged.
    expect(exit).toBe(0);
    // (b) verdict JSON still emitted to stdout.
    const stdoutResult = JSON.parse(cap.stdout.join("")) as RunResult;
    expect(stdoutResult.decision).toBe("merged-externally");
    // (c) a stderr line reports the persist failure.
    expect(cap.stderr.join("")).toMatch(/failed to persist verdict/);
    // (d) no verdict file was created.
    expect(fs.existsSync(outPath)).toBe(false);
  });
});
