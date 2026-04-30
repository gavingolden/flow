import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigInvalidError,
  DEFAULT_CONFIG,
  GhPermanentError,
  type GhCheck,
  type GhOps,
  type GhReview,
  botsCollected,
  isChecksTerminal,
  isPermanentGhStderr,
  loadConfig,
  pendingCheckNames,
  pollUntilTerminal,
  renderCiSection,
  truncateReviewBody,
} from "./ci-wait";

// --- Fixtures ---

function check(name: string, state: string): GhCheck {
  return { name, state };
}

function review(login: string, overrides: Partial<GhReview> = {}): GhReview {
  return {
    id: 12345,
    author: { login },
    body: "looks good",
    state: "COMMENTED",
    submittedAt: "2026-04-29T22:35:00Z",
    ...overrides,
  };
}

function makeGhOps(overrides: Partial<GhOps>): GhOps {
  return {
    prChecks: () => [],
    prReviews: () => [],
    prUrl: () => "https://github.com/owner/repo/pull/184",
    ...overrides,
  };
}

// --- loadConfig ---

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ci-wait-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when the file is missing", () => {
    expect(loadConfig(join(dir, "missing.json"))).toEqual(DEFAULT_CONFIG);
  });

  it("merges user fields over defaults (per-field)", () => {
    const p = join(dir, "ci-wait.json");
    writeFileSync(p, JSON.stringify({ bots: ["Copilot", "Codecov"] }));
    expect(loadConfig(p)).toEqual({
      ...DEFAULT_CONFIG,
      bots: ["Copilot", "Codecov"],
    });
  });

  it("honours all three fields when supplied", () => {
    const p = join(dir, "ci-wait.json");
    writeFileSync(
      p,
      JSON.stringify({
        bots: ["Copilot", "Codecov"],
        cadenceMs: 15_000,
        hardCapMs: 1_800_000,
      }),
    );
    expect(loadConfig(p)).toEqual({
      bots: ["Copilot", "Codecov"],
      cadenceMs: 15_000,
      hardCapMs: 1_800_000,
    });
  });

  it("throws ConfigInvalidError on parse error", () => {
    const p = join(dir, "ci-wait.json");
    writeFileSync(p, "{ bots: [Copilot");
    expect(() => loadConfig(p)).toThrow(ConfigInvalidError);
  });

  it("throws ConfigInvalidError when bots is empty", () => {
    const p = join(dir, "ci-wait.json");
    writeFileSync(p, JSON.stringify({ bots: [] }));
    expect(() => loadConfig(p)).toThrow(ConfigInvalidError);
  });

  it("throws ConfigInvalidError when cadenceMs >= hardCapMs", () => {
    const p = join(dir, "ci-wait.json");
    writeFileSync(p, JSON.stringify({ cadenceMs: 60_000, hardCapMs: 60_000 }));
    expect(() => loadConfig(p)).toThrow(ConfigInvalidError);
  });

  it("throws ConfigInvalidError when cadenceMs is non-positive", () => {
    const p = join(dir, "ci-wait.json");
    writeFileSync(p, JSON.stringify({ cadenceMs: 0 }));
    expect(() => loadConfig(p)).toThrow(ConfigInvalidError);
  });

  it("throws ConfigInvalidError on a non-object payload", () => {
    const p = join(dir, "ci-wait.json");
    writeFileSync(p, JSON.stringify(["x"]));
    expect(() => loadConfig(p)).toThrow(ConfigInvalidError);
  });
});

// --- isChecksTerminal / pendingCheckNames ---

describe("isChecksTerminal", () => {
  it("treats an empty array as terminal", () => {
    expect(isChecksTerminal([])).toBe(true);
  });
  it("returns false when any check is IN_PROGRESS", () => {
    expect(isChecksTerminal([check("lint", "IN_PROGRESS")])).toBe(false);
  });
  it("returns false when any check is QUEUED or PENDING", () => {
    expect(isChecksTerminal([check("a", "QUEUED")])).toBe(false);
    expect(isChecksTerminal([check("b", "PENDING")])).toBe(false);
  });
  it("returns true when all checks have settled", () => {
    expect(isChecksTerminal([check("a", "SUCCESS"), check("b", "FAILURE")])).toBe(true);
  });
  it("returns false when any one of many checks is in-progress", () => {
    expect(
      isChecksTerminal([
        check("a", "SUCCESS"),
        check("b", "QUEUED"),
        check("c", "SUCCESS"),
      ]),
    ).toBe(false);
  });
});

describe("pendingCheckNames", () => {
  it("returns the names of every non-terminal check", () => {
    expect(
      pendingCheckNames([
        check("lint", "IN_PROGRESS"),
        check("test", "SUCCESS"),
        check("build", "QUEUED"),
      ]),
    ).toEqual(["lint", "build"]);
  });
});

// --- isPermanentGhStderr ---

describe("isPermanentGhStderr", () => {
  it("flags 'Unknown JSON field' as permanent", () => {
    expect(
      isPermanentGhStderr(
        'Unknown JSON field: "conclusion"\nAvailable fields:\n  bucket\n  state',
      ),
    ).toBe(true);
  });
  it("flags 'unknown flag' as permanent", () => {
    expect(isPermanentGhStderr("unknown flag: --bogus")).toBe(true);
  });
  it("flags 'unknown command' as permanent", () => {
    expect(isPermanentGhStderr("unknown command \"frobnicate\" for \"gh pr\"")).toBe(true);
  });
  it("does not flag generic network errors as permanent", () => {
    expect(isPermanentGhStderr("HTTP 502: bad gateway")).toBe(false);
    expect(isPermanentGhStderr("rate limit exceeded; try again later")).toBe(false);
    expect(isPermanentGhStderr("")).toBe(false);
  });
});

// --- DEFAULT_CONFIG ---

describe("DEFAULT_CONFIG", () => {
  it("uses Copilot's actual GitHub login", () => {
    // The reviewer login on real PRs is `copilot-pull-request-reviewer`.
    // `botsCollected` matches by exact (case-insensitive) login, so the
    // default must match the real login or every default-config run
    // hangs to hard cap. See ci-hang on PR #23 (2026-04-30).
    expect(DEFAULT_CONFIG.bots).toEqual(["copilot-pull-request-reviewer"]);
  });
});

// --- botsCollected ---

describe("botsCollected", () => {
  it("matches case-insensitively", () => {
    const r = [review("copilot")];
    const result = botsCollected(r, ["Copilot"]);
    expect(result.collected).toHaveLength(1);
    expect(result.missing).toEqual([]);
  });
  it("places a bot with no review in `missing`", () => {
    const result = botsCollected([review("Copilot")], ["Copilot", "Codecov"]);
    expect(result.collected.map((r) => r.author.login)).toEqual(["Copilot"]);
    expect(result.missing).toEqual(["Codecov"]);
  });
  it("counts a bot as collected after a single review (multiple don't double-count)", () => {
    const r = [review("Copilot", { id: 1 }), review("Copilot", { id: 2 })];
    const result = botsCollected(r, ["Copilot"]);
    expect(result.collected).toHaveLength(1);
    expect(result.collected[0]?.id).toBe(1);
  });
  it("ignores reviews from non-bot logins", () => {
    const result = botsCollected([review("alice"), review("Copilot")], ["Copilot"]);
    expect(result.collected.map((r) => r.author.login)).toEqual(["Copilot"]);
  });
});

// --- truncateReviewBody ---

describe("truncateReviewBody", () => {
  it("returns short bodies unchanged", () => {
    const r = truncateReviewBody("a\nb\nc", 12345, "https://example/x");
    expect(r.truncated).toBe(false);
    expect(r.body).toBe("a\nb\nc");
  });
  it("truncates 60 lines to 50 + the marker", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line${i}`);
    const r = truncateReviewBody(lines.join("\n"), 999, "https://example/r/999");
    expect(r.truncated).toBe(true);
    const out = r.body.split("\n");
    expect(out).toHaveLength(51);
    expect(out[49]).toBe("line49");
    expect(out[50]).toBe("[...truncated, full body in PR review 999 at https://example/r/999]");
  });
  it("respects an explicit maxLines override", () => {
    const r = truncateReviewBody("a\nb\nc\nd", 1, "u", 2);
    expect(r.truncated).toBe(true);
    expect(r.body).toBe("a\nb\n[...truncated, full body in PR review 1 at u]");
  });
});

// --- pollUntilTerminal ---

describe("pollUntilTerminal", () => {
  function makeDeps(args: {
    gh: GhOps;
    cadenceMs?: number;
    hardCapMs?: number;
  }): {
    config: ReturnType<typeof makeConfig>;
    deps: Parameters<typeof pollUntilTerminal>[0]["deps"];
    events: Array<{ event: string; payload: Record<string, unknown> }>;
    sleepCalls: number[];
  } {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const sleepCalls: number[] = [];
    let virtualNow = 0;
    const config = makeConfig(args.cadenceMs, args.hardCapMs);
    const deps = {
      gh: args.gh,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        virtualNow += ms;
      },
      now: () => virtualNow,
      emit: (event: string, payload: Record<string, unknown>) => {
        events.push({ event, payload });
      },
    };
    return { config, deps, events, sleepCalls };
  }

  function makeConfig(cadenceMs = 1000, hardCapMs = 60_000) {
    return { bots: ["Copilot"], cadenceMs, hardCapMs };
  }

  it("happy path: terminal checks + bot present → outcome ok, polls=1", async () => {
    const { config, deps, events } = makeDeps({
      gh: makeGhOps({
        prChecks: () => [check("lint", "SUCCESS")],
        prReviews: () => [review("Copilot")],
      }),
    });
    const r = await pollUntilTerminal({ pr: 184, config, deps });
    expect(r.outcome).toBe("ok");
    expect(r.polls).toBe(1);
    expect(r.missingBots).toEqual([]);
    expect(events.find((e) => e.event === "ci-wait.poll")).toBeDefined();
  });

  it("ci-hang: pending check that never resolves → hard cap → outcome ci-hang", async () => {
    const { config, deps } = makeDeps({
      cadenceMs: 100,
      hardCapMs: 500,
      gh: makeGhOps({
        prChecks: () => [check("lint", "IN_PROGRESS")],
        prReviews: () => [],
      }),
    });
    const r = await pollUntilTerminal({ pr: 184, config, deps });
    expect(r.outcome).toBe("ci-hang");
    expect(r.pendingChecks).toEqual(["lint"]);
  });

  it("bot timeout: terminal checks at first poll, bot never posts → ok with missingBots", async () => {
    const { config, deps } = makeDeps({
      cadenceMs: 100,
      hardCapMs: 500,
      gh: makeGhOps({
        prChecks: () => [check("lint", "SUCCESS")],
        prReviews: () => [],
      }),
    });
    const r = await pollUntilTerminal({ pr: 184, config, deps });
    expect(r.outcome).toBe("ok");
    expect(r.missingBots).toEqual(["Copilot"]);
  });

  it("rate-limit retry: first call throws, retry succeeds → polling continues", async () => {
    let attempts = 0;
    const { config, deps, events } = makeDeps({
      gh: makeGhOps({
        prChecks: () => {
          attempts++;
          if (attempts === 1) throw new Error("rate limit hit");
          return [check("lint", "SUCCESS")];
        },
        prReviews: () => [review("Copilot")],
      }),
    });
    const r = await pollUntilTerminal({ pr: 184, config, deps });
    expect(r.outcome).toBe("ok");
    expect(events.some((e) => e.event === "ci-wait.gh_retry")).toBe(true);
  });

  it("rate-limit retry: both attempts fail → no-progress poll, loop continues to hard cap", async () => {
    const { config, deps, events } = makeDeps({
      cadenceMs: 100,
      hardCapMs: 500,
      gh: makeGhOps({
        prChecks: () => {
          throw new Error("sustained outage");
        },
        prReviews: () => {
          throw new Error("sustained outage");
        },
      }),
    });
    const r = await pollUntilTerminal({ pr: 184, config, deps });
    expect(r.outcome).toBe("ci-hang");
    expect(r.ciHangNoChecksFetched).toBe(true);
    const noProgress = events.filter(
      (e) => e.event === "ci-wait.poll" && e.payload.noProgress === true,
    );
    expect(noProgress.length).toBeGreaterThan(0);
  });

  it("propagates GhPermanentError out of the loop instead of retrying", async () => {
    // Regression: an "Unknown JSON field" error from gh used to be retried
    // every 30s for the full hour. It must escape the loop on the first
    // poll so main() can fail fast with outcome=gh-permanent.
    const { config, deps } = makeDeps({
      cadenceMs: 50,
      hardCapMs: 5_000,
      gh: makeGhOps({
        prChecks: () => {
          throw new GhPermanentError("Unknown JSON field: \"conclusion\"");
        },
        prReviews: () => [],
      }),
    });
    await expect(pollUntilTerminal({ pr: 184, config, deps })).rejects.toBeInstanceOf(
      GhPermanentError,
    );
  });

  it("does not advance past CI when checks fetch never succeeds (reviews ok, bots present)", async () => {
    // Regression for the early-return that used to read `isChecksTerminal([])`
    // — true by default — and would advance to outcome=ok if the reviews call
    // succeeded and bots happened to be present, even though no check data
    // was ever observed. With the everFetchedChecks guard, the loop must
    // ride to hard cap and report ci-hang.
    const { config, deps } = makeDeps({
      cadenceMs: 50,
      hardCapMs: 250,
      gh: makeGhOps({
        prChecks: () => {
          throw new Error("checks endpoint down");
        },
        prReviews: () => [review("Copilot")],
      }),
    });
    const r = await pollUntilTerminal({ pr: 184, config, deps });
    expect(r.outcome).toBe("ci-hang");
    expect(r.ciHangNoChecksFetched).toBe(true);
  });
});

// --- renderCiSection ---

describe("renderCiSection", () => {
  const PR_URL = "https://github.com/owner/repo/pull/184";

  it("matches the documented format for a happy path", () => {
    const out = renderCiSection({
      bots: ["Copilot", "Codecov"],
      reviews: [
        review("Copilot", {
          id: 100,
          state: "COMMENTED",
          submittedAt: "2026-04-29T22:35:00Z",
          body: "Looks good\nminor nit on line 4",
        }),
        review("Codecov", {
          id: 101,
          state: "APPROVED",
          submittedAt: "2026-04-29T22:34:12Z",
          body: "Coverage 99%",
        }),
      ],
      prUrl: PR_URL,
    });
    expect(out).toContain("| bot | state | submitted_at |");
    expect(out).toContain("| Copilot | COMMENTED | 2026-04-29T22:35:00Z |");
    expect(out).toContain("| Codecov | APPROVED | 2026-04-29T22:34:12Z |");
    expect(out).toContain("#### Copilot");
    expect(out).toContain("> Looks good");
    expect(out).toContain("> minor nit on line 4");
    expect(out).toContain("#### Codecov");
    expect(out).toContain("> Coverage 99%");
    // No leading frontmatter delimiter that would confuse gray-matter.
    expect(out.startsWith("---")).toBe(false);
  });

  it("renders TIMEOUT row + placeholder body for missing bots", () => {
    const out = renderCiSection({
      bots: ["Copilot", "SonarCloud"],
      reviews: [review("Copilot", { id: 1 })],
      prUrl: PR_URL,
    });
    expect(out).toContain("| SonarCloud | TIMEOUT | - |");
    expect(out).toContain("> _(no review posted within hard cap)_");
  });

  it("prepends a pendingChecks paragraph for ci-hang", () => {
    const out = renderCiSection({
      bots: ["Copilot"],
      reviews: [],
      prUrl: PR_URL,
      pendingChecks: ["lint", "build"],
    });
    expect(out).toContain("**Checks still pending at hard cap:** lint, build");
  });

  it("renders a sustained-outage paragraph when ci-hang fired with no successful checks fetch", () => {
    const out = renderCiSection({
      bots: ["Copilot"],
      reviews: [],
      prUrl: PR_URL,
      ciHangNoChecksFetched: true,
    });
    expect(out).toContain(
      "**Checks could not be fetched within the hard cap (sustained gh failure).**",
    );
  });

  it("truncates a 60-line bot review body", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line${i}`);
    const out = renderCiSection({
      bots: ["Copilot"],
      reviews: [review("Copilot", { id: 999, body: lines.join("\n") })],
      prUrl: PR_URL,
    });
    expect(out).toContain(
      `> [...truncated, full body in PR review 999 at ${PR_URL}#pullrequestreview-999]`,
    );
  });
});
