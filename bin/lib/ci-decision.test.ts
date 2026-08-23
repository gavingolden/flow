import { describe, expect, it } from "vitest";
import {
  QUALIFYING_PR_TRIGGERS,
  decideOnPoll,
  deriveBlockedState,
  deriveCheckState,
  deriveConflictState,
  deriveCopilotPosted,
  deriveCopilotRulesetEnabled,
  deriveCopilotSkipReason,
  extractLatestCopilotReviewCommit,
  hasQualifyingWorkflowTrigger,
  isCopilotReviewStale,
  type Check,
  type PollState,
  type Review,
} from "./ci-decision";

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
    expect(deriveConflictState("UNKNOWN", "CONFLICTING").conflicting).toBe(
      false,
    );
  });
});

describe(deriveBlockedState, () => {
  it("flags blocked=true for mergeStateStatus=BLOCKED", () => {
    expect(deriveBlockedState("MERGEABLE", "BLOCKED").blocked).toBe(true);
  });

  // The inverse of deriveConflictState's list: a conflict (CONFLICTING/DIRTY)
  // is NOT a block (it routes to pr-conflicted, not pr-blocked), and the
  // benign states never block either.
  it.each([
    "CLEAN",
    "BEHIND",
    "UNSTABLE",
    "HAS_HOOKS",
    "CONFLICTING",
    "DIRTY",
    "UNKNOWN",
  ])("does NOT flag blocked for mergeStateStatus=%s", (status) => {
    expect(deriveBlockedState("MERGEABLE", status).blocked).toBe(false);
  });

  it("does NOT flag blocked while GitHub is still computing (mergeable=UNKNOWN, mergeStateStatus=UNKNOWN)", () => {
    expect(deriveBlockedState("UNKNOWN", "UNKNOWN").blocked).toBe(false);
  });

  it("does NOT flag blocked on a stale BLOCKED status while mergeable is still recomputing (mergeable=UNKNOWN)", () => {
    expect(deriveBlockedState("UNKNOWN", "BLOCKED").blocked).toBe(false);
  });
});

describe(hasQualifyingWorkflowTrigger, () => {
  it("exports the qualifying-trigger set with the three GitHub-PR triggers", () => {
    expect(QUALIFYING_PR_TRIGGERS).toEqual(
      new Set(["pull_request", "pull_request_target", "merge_group"]),
    );
  });

  // Scalar form
  it("scalar form: 'on: pull_request' → true", () => {
    expect(hasQualifyingWorkflowTrigger("on: pull_request\njobs: {}\n")).toBe(
      true,
    );
  });
  it("scalar form: 'on: schedule' → false", () => {
    expect(hasQualifyingWorkflowTrigger("on: schedule\njobs: {}\n")).toBe(
      false,
    );
  });
  it("scalar form: 'on: push' → false", () => {
    expect(hasQualifyingWorkflowTrigger("on: push\njobs: {}\n")).toBe(false);
  });

  // List form
  it("list form: 'on: [pull_request, push]' → true", () => {
    expect(
      hasQualifyingWorkflowTrigger("on: [pull_request, push]\njobs: {}\n"),
    ).toBe(true);
  });
  it("list form: 'on: [schedule, push]' → false", () => {
    expect(
      hasQualifyingWorkflowTrigger("on: [schedule, push]\njobs: {}\n"),
    ).toBe(false);
  });
  it("list form: 'on: [merge_group]' → true", () => {
    expect(hasQualifyingWorkflowTrigger("on: [merge_group]\njobs: {}\n")).toBe(
      true,
    );
  });

  // Map form
  it("map form: bare 'pull_request:' child key → true", () => {
    expect(
      hasQualifyingWorkflowTrigger("on:\n  pull_request:\njobs: {}\n"),
    ).toBe(true);
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
    expect(hasQualifyingWorkflowTrigger("on:\n  pull_request_target:\n")).toBe(
      true,
    );
  });
  it("map form: bare 'merge_group:' child key → true", () => {
    expect(hasQualifyingWorkflowTrigger("on:\n  merge_group:\n")).toBe(true);
  });

  // Block-sequence form (`on:` followed by `- trigger` dash items).
  it("block-sequence form: '- pull_request' → true", () => {
    expect(
      hasQualifyingWorkflowTrigger("on:\n  - pull_request\njobs: {}\n"),
    ).toBe(true);
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
    expect(hasQualifyingWorkflowTrigger("on:\n  - pull_request_target\n")).toBe(
      true,
    );
  });
  it("block-sequence form: '- \"pull_request\"' (quoted) → true", () => {
    expect(hasQualifyingWorkflowTrigger('on:\n  - "pull_request"\n')).toBe(
      true,
    );
  });

  // Known limitation: inline-flow map (`on: { pull_request: foo }`) is
  // intentionally out of scope; document the conservative false return.
  it("inline-flow map (known limitation): 'on: { pull_request: foo }' → false", () => {
    expect(hasQualifyingWorkflowTrigger("on: { pull_request: foo }\n")).toBe(
      false,
    );
  });

  // Each qualifying trigger individually
  it("pull_request_target alone → true", () => {
    expect(hasQualifyingWorkflowTrigger("on: pull_request_target\n")).toBe(
      true,
    );
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
    expect(hasQualifyingWorkflowTrigger("on:\npull_request:\njobs: {}\n")).toBe(
      false,
    );
  });
});

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
      {
        author: { login: LOGIN },
        state: "DISMISSED",
        commitOid: "sha-dismissed",
      },
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

describe(deriveCopilotSkipReason, () => {
  const LOGIN = "copilot-pull-request-reviewer";
  const HEAD = "sha-head";
  const OLDER = "sha-older";

  function baseArgs(
    overrides: Partial<Parameters<typeof deriveCopilotSkipReason>[0]> = {},
  ) {
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
    expect(deriveCopilotSkipReason(baseArgs({ reviews }))).toBe(
      "self-dismissed",
    );
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
      deriveCopilotSkipReason(
        baseArgs({ ciTerminalAt: null, elapsedSec: 600 }),
      ),
    ).toBeNull();
  });

  it("returns null when the deadline has not yet elapsed", () => {
    expect(
      deriveCopilotSkipReason(
        baseArgs({ ciTerminalAt: 0, elapsedSec: 30, claimDeadlineSec: 60 }),
      ),
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
        baseArgs({
          reviews: [],
          ciTerminalAt: 0,
          elapsedSec: 600,
          waitForCopilot: true,
        }),
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
    expect(deriveCopilotSkipReason(baseArgs({ reviews }))).toBe(
      "self-dismissed",
    );
  });

  it("matches a [bot]-suffixed review author against the bare configured login", () => {
    const reviews: Review[] = [
      {
        author: { login: "copilot-pull-request-reviewer[bot]" },
        state: "DISMISSED",
        commitOid: HEAD,
      },
    ];
    expect(deriveCopilotSkipReason(baseArgs({ reviews }))).toBe(
      "self-dismissed",
    );
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
        baseArgs({
          reviews,
          ciTerminalAt: 0,
          elapsedSec: 600,
          claimDeadlineSec: 60,
        }),
      ),
    ).toBe("self-dismissed");
  });

  it("returns null when headRefOid is empty (transient gh projection miss)", () => {
    expect(deriveCopilotSkipReason(baseArgs({ headRefOid: "" }))).toBeNull();
  });
});

describe(deriveCopilotRulesetEnabled, () => {
  it("returns true when a copilot_code_review rule is present", () => {
    expect(deriveCopilotRulesetEnabled([{ type: "copilot_code_review" }])).toBe(
      true,
    );
  });

  it("returns true when copilot_code_review appears alongside other rules", () => {
    expect(
      deriveCopilotRulesetEnabled([
        { type: "pull_request" },
        { type: "copilot_code_review" },
      ]),
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
    const v = decideOnPoll(
      makePollState({ ci: { kind: "failed", failedChecks } }),
    );
    expect(v).toEqual({
      verdict: "exit",
      decision: "ci-failed",
      ciFailedChecks: failedChecks,
    });
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
    expect(v).toEqual({
      verdict: "exit",
      decision: "proceed-to-review-no-bot",
    });
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

describe("decideOnPoll — looping cadence (flat)", () => {
  it("loops with flat cadence 60s on poll 1 when ci is still pending", () => {
    const v = decideOnPoll(
      makePollState({ pollNum: 1, ci: { kind: "pending" } }),
    );
    expect(v).toEqual({ verdict: "loop", cadenceSec: 60 });
  });
  it("loops with flat cadence 60s on poll 6 when ci is still pending", () => {
    const v = decideOnPoll(
      makePollState({ pollNum: 6, ci: { kind: "pending" } }),
    );
    expect(v).toEqual({ verdict: "loop", cadenceSec: 60 });
  });
  it("loops with flat cadence 60s on poll 11 when ci is still pending", () => {
    const v = decideOnPoll(
      makePollState({ pollNum: 11, ci: { kind: "pending" } }),
    );
    expect(v).toEqual({ verdict: "loop", cadenceSec: 60 });
  });
});
