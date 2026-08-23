import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  allMergeCommitsBetween,
  fetchHistoricalBotReview,
  fetchRequestedReviewers,
  isSmallFollowup,
  observeCopilotRuleset,
  observeMergeState,
  observePr,
  registrySelfCheck,
  resolveCopilotConfigured,
  retriggerCopilotReview,
  type GhRunner,
} from "./ci-observe";
import { deriveConflictState } from "./ci-decision";
import { matchesCopilot } from "./copilot-config";
import { appendRow, type ProcRegistryRow } from "./proc-registry";

// `resolveCopilotConfigured` consults `bots.copilotAutoReview` via the default
// (file-backed) ReadConfigFile, which has no injectable seam at the call site.
// Mock only that one export so the config tier is deterministic; everything
// else in copilot-config stays real. `setAutoReview` drives the override per test.
const autoReviewHolder = vi.hoisted(() => ({
  value: undefined as boolean | undefined,
}));
vi.mock("./copilot-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./copilot-config")>();
  return { ...actual, readCopilotAutoReview: () => autoReviewHolder.value };
});
function setAutoReview(value: boolean | undefined): void {
  autoReviewHolder.value = value;
}
afterEach(() => setAutoReview(undefined));

describe(observeMergeState, () => {
  it("returns the parsed object on a zero-exit gh call", () => {
    const gh: GhRunner = () => ({
      stdout: JSON.stringify({
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      }),
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
    const gh: GhRunner = () => ({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
    });
    expect(observeMergeState(100, gh)).toBeNull();
  });

  it('coerces non-string fields to "" on valid-JSON-but-wrong-shape payloads', () => {
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
    expect(
      deriveConflictState(coerced!.mergeable, coerced!.mergeStateStatus)
        .conflicting,
    ).toBe(false);
  });
});

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
    expect(calls[0]).toEqual([
      "pr",
      "edit",
      "161",
      "--add-reviewer",
      "@copilot",
    ]);
  });

  it("returns ok:false with stderr propagated on non-zero exit", () => {
    const gh: GhRunner = () => ({
      stdout: "",
      stderr: "HTTP 422: Unprocessable",
      exitCode: 1,
    });
    const out = retriggerCopilotReview(161, gh);
    expect(out).toEqual({ ok: false, stderr: "HTTP 422: Unprocessable" });
  });
});

describe(fetchRequestedReviewers, () => {
  const PR = 100;
  const COPILOT = "copilot-pull-request-reviewer";
  // Matcher-style stub: respond to the GraphQL reviewRequests read and the
  // REST requested_reviewers read independently. `graphql`/`rest` are the
  // raw CmdResult each call returns.
  function ghWith(opts: {
    graphql: { stdout: string; exitCode: number };
    rest: { stdout: string; exitCode: number };
  }): GhRunner {
    return (argv) => {
      if (
        argv[0] === "api" &&
        typeof argv[1] === "string" &&
        argv[1].endsWith("/requested_reviewers")
      ) {
        return {
          stdout: opts.rest.stdout,
          stderr: "",
          exitCode: opts.rest.exitCode,
        };
      }
      // GraphQL reviewRequests read.
      return {
        stdout: opts.graphql.stdout,
        stderr: "",
        exitCode: opts.graphql.exitCode,
      };
    };
  }
  const reviewRequestsJson = (logins: string[]) =>
    JSON.stringify({ reviewRequests: logins.map((login) => ({ login })) });

  it("detects a Copilot reviewer visible only via REST (GraphQL reviewRequests empty)", () => {
    const gh = ghWith({
      graphql: { stdout: reviewRequestsJson([]), exitCode: 0 },
      rest: { stdout: JSON.stringify(["Copilot"]), exitCode: 0 },
    });
    const result = fetchRequestedReviewers(PR, gh);
    expect(result.some((l) => matchesCopilot(l, COPILOT))).toBe(true);
  });

  it("unions GraphQL and REST logins (neither source dropped)", () => {
    const gh = ghWith({
      graphql: { stdout: reviewRequestsJson(["alice"]), exitCode: 0 },
      rest: { stdout: JSON.stringify(["Copilot"]), exitCode: 0 },
    });
    const result = fetchRequestedReviewers(PR, gh);
    expect(result).toContain("alice");
    expect(result).toContain("copilot");
  });

  it("de-dups a login present in BOTH sources to a single entry", () => {
    // GraphQL "Copilot" and REST "copilot" both lowercase to the same login;
    // unionLogins' Set must collapse them. A regression dropping the Set
    // (plain `[...a, ...b]`) would emit two "copilot" entries and still pass
    // the disjoint-inputs spec above, so assert the dedup directly.
    const gh = ghWith({
      graphql: { stdout: reviewRequestsJson(["Copilot"]), exitCode: 0 },
      rest: { stdout: JSON.stringify(["copilot"]), exitCode: 0 },
    });
    const result = fetchRequestedReviewers(PR, gh);
    expect(result.filter((l) => l === "copilot")).toHaveLength(1);
  });

  it("lowercases the REST login", () => {
    const gh = ghWith({
      graphql: { stdout: reviewRequestsJson([]), exitCode: 0 },
      rest: { stdout: JSON.stringify(["Copilot"]), exitCode: 0 },
    });
    expect(fetchRequestedReviewers(PR, gh)).toContain("copilot");
    expect(fetchRequestedReviewers(PR, gh)).not.toContain("Copilot");
  });

  it("fails open to GraphQL-only logins when the REST call exits non-zero", () => {
    const gh = ghWith({
      graphql: { stdout: reviewRequestsJson(["alice"]), exitCode: 0 },
      rest: { stdout: "", exitCode: 1 },
    });
    expect(fetchRequestedReviewers(PR, gh)).toEqual(["alice"]);
  });

  it("fails open to GraphQL-only logins when the REST call returns malformed JSON", () => {
    const gh = ghWith({
      graphql: { stdout: reviewRequestsJson(["alice"]), exitCode: 0 },
      rest: { stdout: "not-json{", exitCode: 0 },
    });
    expect(fetchRequestedReviewers(PR, gh)).toEqual(["alice"]);
  });

  it("still surfaces a REST-only Copilot when the GraphQL read itself fails (independent fail-open)", () => {
    const gh = ghWith({
      graphql: { stdout: "", exitCode: 1 },
      rest: { stdout: JSON.stringify(["Copilot"]), exitCode: 0 },
    });
    expect(
      fetchRequestedReviewers(PR, gh).some((l) => matchesCopilot(l, COPILOT)),
    ).toBe(true);
  });
});

describe(observePr, () => {
  const PR = 100;
  // Matcher-style gh stub recording every call so we can spy on whether the
  // REST requested_reviewers endpoint was hit. `prView` is returned for the
  // `gh pr view --json …` projection; `rest` for the REST union read.
  function ghWith(opts: {
    prView: { stdout: string; exitCode: number };
    rest: { stdout: string; exitCode: number };
  }): GhRunner & { calls: string[][] } {
    const calls: string[][] = [];
    const fn = ((argv: string[]) => {
      calls.push(argv);
      if (
        argv[0] === "api" &&
        typeof argv[1] === "string" &&
        argv[1].endsWith("/requested_reviewers")
      ) {
        return {
          stdout: opts.rest.stdout,
          stderr: "",
          exitCode: opts.rest.exitCode,
        };
      }
      return {
        stdout: opts.prView.stdout,
        stderr: "",
        exitCode: opts.prView.exitCode,
      };
    }) as GhRunner & { calls: string[][] };
    fn.calls = calls;
    return fn;
  }
  const prViewResponse = (reviewRequests: string[]) =>
    JSON.stringify({
      state: "OPEN",
      url: "https://github.com/o/r/pull/100",
      reviews: [],
      headRefOid: "abc123",
      reviewRequests: reviewRequests.map((login) => ({ login })),
    });

  it("unions a REST-only Copilot reviewer into requestedReviewers", () => {
    const gh = ghWith({
      prView: { stdout: prViewResponse([]), exitCode: 0 },
      rest: { stdout: JSON.stringify(["Copilot"]), exitCode: 0 },
    });
    expect(observePr(PR, gh, true)!.requestedReviewers).toContain("copilot");
  });

  it("fails open to GraphQL-only logins when the REST union exits non-zero", () => {
    const gh = ghWith({
      prView: { stdout: prViewResponse(["alice"]), exitCode: 0 },
      rest: { stdout: "", exitCode: 1 },
    });
    expect(observePr(PR, gh, true)!.requestedReviewers).toEqual(["alice"]);
  });

  it("skips the REST endpoint entirely when includeRestReviewers is false", () => {
    const gh = ghWith({
      prView: { stdout: prViewResponse(["alice"]), exitCode: 0 },
      rest: { stdout: JSON.stringify(["Copilot"]), exitCode: 0 },
    });
    const result = observePr(PR, gh, false)!;
    expect(result.requestedReviewers).toEqual(["alice"]);
    expect(
      gh.calls.some(
        (argv) =>
          argv[0] === "api" &&
          typeof argv[1] === "string" &&
          argv[1].endsWith("/requested_reviewers"),
      ),
    ).toBe(false);
  });
});

describe(fetchHistoricalBotReview, () => {
  const LOGIN = "copilot-pull-request-reviewer";

  function ghFromQueue(
    queue: Array<{ stdout: string; exitCode: number }>,
  ): GhRunner & {
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
      {
        stdout: JSON.stringify({ reviews: [{ author: { login: "alice" } }] }),
        exitCode: 0,
      },
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
          reviews: [
            { author: { login: "copilot-pull-request-reviewer[bot]" } },
          ],
        }),
        exitCode: 0,
      },
    ]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(true);
  });

  it("short-circuits on the first match (does not view PRs past the hit)", () => {
    const gh = ghFromQueue([
      {
        stdout: JSON.stringify([{ number: 1 }, { number: 2 }, { number: 3 }]),
        exitCode: 0,
      },
      // Pr 1 already matches
      {
        stdout: JSON.stringify({ reviews: [{ author: { login: LOGIN } }] }),
        exitCode: 0,
      },
    ]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(true);
    // 1 list call + 1 view call; PR 2 / PR 3 never queried.
    expect(gh.calls).toHaveLength(2);
  });

  it("returns false when no merged PR has a review by the configured login", () => {
    const gh = ghFromQueue([
      { stdout: JSON.stringify([{ number: 1 }, { number: 2 }]), exitCode: 0 },
      {
        stdout: JSON.stringify({ reviews: [{ author: { login: "alice" } }] }),
        exitCode: 0,
      },
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
      {
        stdout: JSON.stringify({ reviews: [{ author: { login: LOGIN } }] }),
        exitCode: 0,
      },
    ]);
    expect(fetchHistoricalBotReview(LOGIN, gh)).toBe(true);
  });

  it("skips PRs whose 'gh pr view' returns malformed JSON and continues scanning", () => {
    const gh = ghFromQueue([
      { stdout: JSON.stringify([{ number: 1 }, { number: 2 }]), exitCode: 0 },
      { stdout: "not-json{", exitCode: 0 },
      {
        stdout: JSON.stringify({ reviews: [{ author: { login: LOGIN } }] }),
        exitCode: 0,
      },
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

describe(observeCopilotRuleset, () => {
  function ghFromQueue(
    queue: Array<{ stdout: string; exitCode: number }>,
  ): GhRunner & {
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
      {
        stdout: JSON.stringify([{ type: "copilot_code_review" }]),
        exitCode: 0,
      },
    ]);
    expect(observeCopilotRuleset(gh)).toBe(true);
    expect(gh.calls[1]).toEqual([
      "api",
      "repos/{owner}/{repo}/rules/branches/main",
    ]);
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

describe(resolveCopilotConfigured, () => {
  const LOGIN = "copilot-pull-request-reviewer";

  function ghFromQueue(
    queue: Array<{ stdout: string; exitCode: number }>,
  ): GhRunner & {
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
      {
        stdout: JSON.stringify({ reviews: [{ author: { login: LOGIN } }] }),
        exitCode: 0,
      },
    ]);
    expect(resolveCopilotConfigured(LOGIN, gh)).toBe(true);
    // The heuristic pr-list call must have been issued.
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(true);
  });

  it("override unset + authoritative-true ruleset → true WITHOUT the pr-list heuristic", () => {
    setAutoReview(undefined);
    const gh = ghFromQueue([
      { stdout: "main", exitCode: 0 },
      {
        stdout: JSON.stringify([{ type: "copilot_code_review" }]),
        exitCode: 0,
      },
    ]);
    expect(resolveCopilotConfigured(LOGIN, gh)).toBe(true);
    expect(gh.calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(false);
  });
});

describe(allMergeCommitsBetween, () => {
  function ghFromQueue(
    queue: Array<{ stdout: string; exitCode: number }>,
  ): GhRunner & {
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
        stdout: JSON.stringify([
          { sha: "a", parents: [{ sha: "p1" }, { sha: "p2" }] },
        ]),
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

describe(isSmallFollowup, () => {
  function ghFromQueue(
    queue: Array<{ stdout: string; exitCode: number }>,
  ): GhRunner & {
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
          messages: [
            "fix(x): thing (pr-review #97)",
            "chore(y): z (pr-review #97)",
          ],
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

describe(registrySelfCheck, () => {
  const VALID_SLUG = "flow-spawn-site-adoption";
  let baseDir: string;

  function buildRow(overrides: Partial<ProcRegistryRow> = {}): ProcRegistryRow {
    return {
      pgid: 99999,
      pid: 99999,
      startEpoch: 1000,
      slug: VALID_SLUG,
      class: "default",
      argv: ["echo", "hi"],
      recordedAt: Date.now(),
      sessionPid: null,
      sessionStartEpoch: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ci-wait-registry-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns a non-null warning string when FLOW_SLUG resolves and no row in <baseDir>/<slug>.jsonl matches the given pid", () => {
    // A row exists (proving the registry mechanism is live under this slug)
    // for a DIFFERENT pid, so the target pid's absence is positive evidence
    // of a bypassed wrapper, not just an empty/never-written registry.
    appendRow(buildRow({ pid: 11111, pgid: 11111 }), baseDir);
    const warning = registrySelfCheck(
      { FLOW_SLUG: VALID_SLUG },
      22222,
      baseDir,
    );
    expect(warning).not.toBeNull();
    expect(warning).toMatch(/flow-spawn/);
  });

  it("returns null when a row with a matching pid exists", () => {
    appendRow(buildRow({ pid: 33333, pgid: 33333 }), baseDir);
    const warning = registrySelfCheck(
      { FLOW_SLUG: VALID_SLUG },
      33333,
      baseDir,
    );
    expect(warning).toBeNull();
  });

  it("returns null when env has no FLOW_SLUG", () => {
    const warning = registrySelfCheck({}, 44444, baseDir);
    expect(warning).toBeNull();
  });

  it("returns null (silently) when the registry file does not exist at all", () => {
    const warning = registrySelfCheck(
      { FLOW_SLUG: VALID_SLUG },
      55555,
      baseDir,
    );
    expect(warning).toBeNull();
  });
});
