import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeCountsLine,
  parsePlanDeviations,
  renderComment,
  renderDeviations,
  renderFindings,
  renderFollowupIssues,
  renderForeclosedPaths,
  renderIntent,
  renderLenses,
  renderPhases,
  renderReviewCounts,
} from "./pipeline-summary-sources";
import { formatMarkdown } from "./foreclosed-paths-format";

const iso = (s: number) =>
  new Date(Date.UTC(2026, 5, 17, 12, 0, s)).toISOString();

describe(renderPhases, () => {
  it("appends each phase's duration as the gap to the next entry", () => {
    const out = renderPhases([
      { phase: "planning", at: iso(0) },
      { phase: "reviewing", outcome: "clean", at: iso(192) },
      { phase: "merged", at: iso(237) },
    ]);
    // planning lasted 192s (3m12s); reviewing lasted 45s.
    expect(out[0]).toBe("planning (3m12s)");
    expect(out[1]).toBe("reviewing -> clean (45s)");
  });

  it("preserves the `phase -> outcome` text alongside the duration", () => {
    const out = renderPhases([
      { phase: "reviewing", outcome: "clean", at: iso(0) },
      { phase: "merged", at: iso(45) },
    ]);
    expect(out[0]).toBe("reviewing -> clean (45s)");
  });

  it("gives the final entry no duration suffix (no successor)", () => {
    const out = renderPhases([
      { phase: "planning", at: iso(0) },
      { phase: "merged", at: iso(60) },
    ]);
    expect(out[1]).toBe("merged");
  });

  it("renders a single-entry log with no suffix and no crash", () => {
    expect(renderPhases([{ phase: "planning", at: iso(0) }])).toEqual([
      "planning",
    ]);
  });

  it("omits the suffix when an adjacent `at` is unparseable", () => {
    const out = renderPhases([
      { phase: "planning", at: "not-a-date" },
      { phase: "reviewing", outcome: "clean", at: iso(60) },
      { phase: "merged", at: "also-bad" },
    ]);
    // planning: own `at` unparseable → no suffix.
    expect(out[0]).toBe("planning");
    // reviewing: next `at` unparseable → no suffix, text preserved.
    expect(out[1]).toBe("reviewing -> clean");
    // merged: final entry → no suffix.
    expect(out[2]).toBe("merged");
  });

  it("omits the suffix for an out-of-order (negative) delta", () => {
    const out = renderPhases([
      { phase: "planning", at: iso(192) },
      { phase: "reviewing", outcome: "clean", at: iso(0) },
    ]);
    expect(out[0]).toBe("planning");
  });

  it("omits the suffix for a zero-length delta", () => {
    const out = renderPhases([
      { phase: "planning", at: iso(0) },
      { phase: "reviewing", outcome: "clean", at: iso(0) },
    ]);
    expect(out[0]).toBe("planning");
  });

  it("returns `none` for an empty array", () => {
    expect(renderPhases([])).toEqual(["none"]);
  });

  it("returns `none` for a null phaseLog", () => {
    expect(renderPhases(null)).toEqual(["none"]);
  });
});

const fixApplier = JSON.stringify({
  commits: [],
  deferred: [],
  rejected_alternatives: [
    {
      finding_id: "F1",
      considered_approach: "memoize the parser",
      why_rejected: "cache-invalidation complexity",
    },
  ],
  anti_patterns_found: [
    {
      location: "bin/lib/x.ts:42",
      pattern: "swallowed error",
      recommendation: "log and rethrow",
      introduced_by_this_pr: true,
    },
  ],
  summary: "s",
});

// This fixture omits the three optional lens_* keys — it doubles as the
// lens-absent baseline for the cross-surface parity guard at the bottom of
// this file (renders identically across DECISIONS, markdown, and
// plain-text with no lens content).
const consolidator = JSON.stringify({
  consolidated_findings: [],
  dropped_by_validation: [],
  rejected_alternatives: ["kept the two lenses separate"],
  anti_patterns_found: [],
  summary: "s",
});

// Same as `consolidator`, plus the two lens pass-through arrays populated,
// for the cross-surface parity guard.
const consolidatorWithLens = JSON.stringify({
  consolidated_findings: [],
  dropped_by_validation: [],
  rejected_alternatives: ["kept the two lenses separate"],
  anti_patterns_found: [],
  summary: "s",
  lens_rejected_alternatives: [
    {
      considered_approach: "validate inline at each call site",
      why_rejected: "centralizing keeps the rule in one place",
      lens: "security",
    },
  ],
  lens_anti_patterns_found: [
    {
      location: "src/lib/cache.ts:88",
      pattern: "manual TTL bookkeeping duplicated across call sites",
      recommendation: "route through the shared cache helper",
      lens: "bug-detection",
    },
  ],
});

describe("renderForeclosedPaths", () => {
  it("returns prose lines for present artifacts (both shapes)", () => {
    const lines = renderForeclosedPaths({
      fixApplierRaw: fixApplier,
      consolidatorRaw: consolidator,
    });
    const joined = lines.join("\n");
    expect(joined).toContain("memoize the parser");
    expect(joined).toContain("cache-invalidation complexity");
    expect(joined).toContain("swallowed error");
    expect(joined).toContain("(new)");
    expect(joined).toContain("kept the two lenses separate");
    // Plain-text mode: no markdown heading line.
    expect(lines).not.toContain("## Foreclosed Paths");
  });

  it("returns ['none'] for empty inputs", () => {
    expect(
      renderForeclosedPaths({ fixApplierRaw: "", consolidatorRaw: "" }),
    ).toEqual(["none"]);
  });

  it("returns ['none'] for artifacts with empty arrays", () => {
    const empty = JSON.stringify({
      commits: [],
      deferred: [],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "s",
    });
    expect(
      renderForeclosedPaths({ fixApplierRaw: empty, consolidatorRaw: "" }),
    ).toEqual(["none"]);
  });

  it("degrades a malformed artifact to (unreadable) while the other source renders", () => {
    const lines = renderForeclosedPaths({
      fixApplierRaw: "{not json",
      consolidatorRaw: consolidator,
    });
    const joined = lines.join("\n");
    expect(joined).toContain("fix-applier: (unreadable)");
    expect(joined).toContain("kept the two lenses separate");
  });
});

// A well-formed fix-applier artifact with non-zero counts and every
// anti_patterns_found entry carrying introduced_by_this_pr (Story 1).
const fixApplierFull = JSON.stringify({
  commits: [
    {
      sha: "a1b2c3d",
      files: ["bin/lib/x.ts"],
      finding_id: "F1",
      reasoning: "added guard",
      verify_status: "pass",
    },
    {
      sha: "e4f5a6b",
      files: ["bin/lib/y.ts"],
      finding_id: "F2",
      reasoning: "renamed symbol",
      verify_status: "pass",
    },
  ],
  deferred: [
    {
      finding_id: "F3",
      tracker_entry_url: "",
      reason: "cross-cutting refactor",
    },
  ],
  rejected_alternatives: [
    {
      finding_id: "F1",
      considered_approach: "memoize the parser",
      why_rejected: "cache-invalidation complexity",
    },
  ],
  anti_patterns_found: [
    {
      location: "bin/lib/x.ts:42",
      pattern: "swallowed error",
      recommendation: "log and rethrow",
      introduced_by_this_pr: true,
    },
  ],
  summary: "s",
});

// Valid commits/deferred/rejected_alternatives; one anti_patterns_found entry
// is missing introduced_by_this_pr (the econ-data #346 regression, Story 2).
const fixApplierOneBadEntry = JSON.stringify({
  commits: [
    {
      sha: "a1b2c3d",
      files: ["bin/lib/x.ts"],
      finding_id: "F1",
      reasoning: "added guard",
      verify_status: "pass",
    },
  ],
  deferred: [
    {
      finding_id: "F3",
      tracker_entry_url: "",
      reason: "cross-cutting refactor",
    },
  ],
  rejected_alternatives: [
    {
      finding_id: "F1",
      considered_approach: "memoize the parser",
      why_rejected: "cache-invalidation complexity",
    },
  ],
  anti_patterns_found: [
    {
      location: "bin/lib/x.ts:42",
      pattern: "swallowed error",
      recommendation: "log and rethrow",
      // introduced_by_this_pr intentionally absent.
    },
  ],
  summary: "s",
});

// A well-formed consolidator artifact whose one finding carries a lens-name
// label ("consistency") instead of a real VALID_LABELS entry — the shape
// `normalizeParsedFindings` is meant to coerce before validation runs.
const consolidatorLensLabel = JSON.stringify({
  consolidated_findings: [
    {
      file: "bin/lib/x.ts",
      line: 10,
      label: "consistency",
      decoration: "non-blocking",
      confidence: 0.8,
      subject: "inconsistent naming",
      body: "rename to match sibling functions",
    },
  ],
  dropped_by_validation: [],
  rejected_alternatives: ["kept the two lenses separate"],
  anti_patterns_found: [],
  summary: "s",
});

describe("renderFindings — consolidator lens-name label", () => {
  it("renders real counts (not (unreadable)) for a lens-name-labelled finding", () => {
    const findings = renderFindings({
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: consolidatorLensLabel,
      ciWaitRaw: "",
    }).join("\n");
    expect(findings).toContain("consolidator: 1 findings, 0 dropped");
    expect(findings).not.toContain("consolidator: (unreadable)");
  });
});

describe("renderComment DECISIONS — consolidator lens-name label", () => {
  it("renders the real rejected decision (not dropped) for a lens-name-labelled finding", () => {
    const comment = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: consolidatorLensLabel,
      ciWaitRaw: "",
      filedIssuesRaw: "",
    });
    expect(comment.dev).toContain("kept the two lenses separate");
  });
});

// A genuinely-malformed consolidator artifact: a finding whose label is an
// unknown token ("xyzzy") that is NOT a lens name, so normalizeParsedFindings
// does not coerce it — validation must still fail and degrade to (unreadable).
const consolidatorUnknownLabel = JSON.stringify({
  consolidated_findings: [
    {
      file: "bin/lib/x.ts",
      line: 10,
      label: "xyzzy",
      decoration: "non-blocking",
      confidence: 0.8,
      subject: "s",
      body: "b",
    },
  ],
  dropped_by_validation: [],
  rejected_alternatives: ["kept the two lenses separate"],
  anti_patterns_found: [],
  summary: "s",
});

describe("renderFindings — genuinely-malformed consolidator still degrades", () => {
  it("renders (unreadable) for an unknown (non-lens) label — normalization does not mask real malformation", () => {
    const findings = renderFindings({
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: consolidatorUnknownLabel,
      ciWaitRaw: "",
    }).join("\n");
    expect(findings).toContain("consolidator: (unreadable)");
  });
});

describe("renderFindings — fix-applier resilience", () => {
  const base = { prReviewRaw: "", consolidatorRaw: "", ciWaitRaw: "" };

  it("renders real fix counts and FORECLOSED prose for a well-formed artifact (Story 1)", () => {
    const findings = renderFindings({
      ...base,
      fixApplierRaw: fixApplierFull,
    }).join("\n");
    expect(findings).toContain(
      "fixes: 2 fixed in-cycle, 1 deferred, 1 anti-patterns noted",
    );
    expect(findings).not.toContain("(unreadable)");

    const foreclosed = renderForeclosedPaths({
      fixApplierRaw: fixApplierFull,
      consolidatorRaw: "",
    }).join("\n");
    expect(foreclosed).toContain("memoize the parser");
    expect(foreclosed).not.toContain("(unreadable)");
  });

  it("renders valid counts + a residual marker for the one-bad-entry artifact (Story 2)", () => {
    const findings = renderFindings({
      ...base,
      fixApplierRaw: fixApplierOneBadEntry,
    }).join("\n");
    // The valid commits/deferred counts survive; the off-shape anti-pattern is
    // dropped (0 anti-patterns counted) and surfaced as a residual marker.
    expect(findings).toContain(
      "fixes: 1 fixed in-cycle, 1 deferred, 0 anti-patterns noted (1 unreadable)",
    );
    expect(findings).not.toContain("fixes: (unreadable)");

    const foreclosed = renderForeclosedPaths({
      fixApplierRaw: fixApplierOneBadEntry,
      consolidatorRaw: "",
    }).join("\n");
    expect(foreclosed).toContain("memoize the parser");
    expect(foreclosed).toContain("(1 unreadable)");
    expect(foreclosed).not.toContain("fix-applier: (unreadable)");
  });

  it("degrades a non-JSON fix-applier artifact to (unreadable) (Story 3)", () => {
    const findings = renderFindings({
      ...base,
      fixApplierRaw: "{not json",
    }).join("\n");
    expect(findings).toContain("fixes: (unreadable)");
  });

  it("degrades a fix-applier artifact missing a required top-level key to (unreadable) (Story 3)", () => {
    const missingKey = JSON.stringify({
      commits: [],
      deferred: [],
      rejected_alternatives: [],
      // anti_patterns_found absent → genuinely broken.
      summary: "s",
    });
    const findings = renderFindings({
      ...base,
      fixApplierRaw: missingKey,
    }).join("\n");
    expect(findings).toContain("fixes: (unreadable)");
  });
});

describe(renderIntent, () => {
  it("returns none for empty/whitespace input", () => {
    expect(renderIntent("")).toEqual(["none"]);
    expect(renderIntent("   ")).toEqual(["none"]);
  });

  it("returns (unreadable) for non-JSON input", () => {
    expect(renderIntent("{not json")).toEqual(["(unreadable)"]);
  });

  it("returns (unreadable) for JSON non-object/null", () => {
    expect(renderIntent("null")).toEqual(["(unreadable)"]);
    expect(renderIntent("42")).toEqual(["(unreadable)"]);
    expect(renderIntent("[1,2]")).toEqual(["(unreadable)"]);
  });

  it("renders '<verdict>: <resolution>' when both fields are strings", () => {
    expect(
      renderIntent(
        JSON.stringify({ verdict: "match", resolution: "matches request" }),
      ),
    ).toEqual(["match: matches request"]);
  });

  it("degrades to '<verdict>: (resolution unreadable)' when only verdict is a string", () => {
    expect(
      renderIntent(JSON.stringify({ verdict: "scope-drift", resolution: 42 })),
    ).toEqual(["scope-drift: (resolution unreadable)"]);
    expect(renderIntent(JSON.stringify({ verdict: "scope-drift" }))).toEqual([
      "scope-drift: (resolution unreadable)",
    ]);
  });

  it("degrades to '(verdict unreadable): <resolution>' when only resolution is a string", () => {
    expect(
      renderIntent(JSON.stringify({ verdict: 1, resolution: "note only" })),
    ).toEqual(["(verdict unreadable): note only"]);
    expect(renderIntent(JSON.stringify({ resolution: "note only" }))).toEqual([
      "(verdict unreadable): note only",
    ]);
  });

  it("returns (unreadable) when neither field is readable", () => {
    expect(renderIntent(JSON.stringify({ foo: 1 }))).toEqual(["(unreadable)"]);
  });

  it("appends cross-model agreement when at least one primary field rendered", () => {
    expect(
      renderIntent(
        JSON.stringify({
          verdict: "fundamental",
          cross_model: { ran: true, agreement: "agree" },
        }),
      ),
    ).toEqual(["fundamental: (resolution unreadable)", "cross-model: agree"]);
  });

  it("pins the documented snapshot-only asymmetry: renderComment omits INTENT for a resolution-only artifact", () => {
    const commentInputs = {
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: "",
      ciWaitRaw: "",
      filedIssuesRaw: "",
    };
    const block = renderComment({
      ...commentInputs,
      intentResolutionRaw: JSON.stringify({
        resolution: "resolution-only, no verdict",
      }),
    });
    expect(block.dev).not.toContain("INTENT:");
  });

  it("renders the degraded INTENT body in the comment when the verdict is readable but the resolution is not", () => {
    const commentInputs = {
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: "",
      ciWaitRaw: "",
      filedIssuesRaw: "",
    };
    const block = renderComment({
      ...commentInputs,
      intentResolutionRaw: JSON.stringify({ verdict: "scope-drift" }),
    });
    expect(block.dev).toContain(
      "INTENT:\n  scope-drift: (resolution unreadable)",
    );
  });
});

const fixApplierTwoFixedOneDeferred = JSON.stringify({
  commits: [
    {
      sha: "a",
      files: ["x"],
      finding_id: "F1",
      reasoning: "r",
      verify_status: "pass",
    },
    {
      sha: "b",
      files: ["y"],
      finding_id: "F2",
      reasoning: "r",
      verify_status: "pass",
    },
  ],
  deferred: [
    { finding_id: "F3", tracker_entry_url: "https://x/3", reason: "later" },
  ],
  rejected_alternatives: [],
  anti_patterns_found: [],
  summary: "s",
});

describe(renderReviewCounts, () => {
  it("renders none when prReview/fixApplier/ciWait are all absent", () => {
    expect(
      renderReviewCounts({ prReviewRaw: "", fixApplierRaw: "", ciWaitRaw: "" }),
    ).toEqual(["none"]);
  });

  it("composes status + counts, then CI/Copilot on a second line", () => {
    const out = renderReviewCounts({
      prReviewRaw: JSON.stringify({
        status: "clean",
        completed_steps: [],
        missed_steps: [],
        escalation_tag: null,
        summary: "ok",
      }),
      fixApplierRaw: fixApplierTwoFixedOneDeferred,
      ciWaitRaw: JSON.stringify({
        decision: "proceed-to-review",
        copilotConfigured: false,
      }),
    });
    expect(out).toEqual([
      "clean — 2 findings fixed, 1 deferred",
      "CI: proceed-to-review · Copilot: not configured",
    ]);
  });

  it("never renders a behavior-changed clause (Q8 dropped behavior_changed)", () => {
    const out = renderReviewCounts({
      prReviewRaw: JSON.stringify({
        status: "clean",
        completed_steps: [],
        missed_steps: [],
        escalation_tag: null,
        summary: "ok",
      }),
      fixApplierRaw: fixApplierTwoFixedOneDeferred,
      ciWaitRaw: "",
    }).join("\n");
    expect(out).not.toContain("changed behavior");
  });

  it("degrades an unreadable pr-review artifact to (unreadable) status without dropping counts", () => {
    const out = renderReviewCounts({
      prReviewRaw: "{not json",
      fixApplierRaw: fixApplierTwoFixedOneDeferred,
      ciWaitRaw: "",
    });
    expect(out[0]).toBe("(unreadable) — 2 findings fixed, 1 deferred");
  });
});

describe(composeCountsLine, () => {
  it("is bare 'N findings fixed, M deferred', no status prefix", () => {
    expect(composeCountsLine(fixApplierTwoFixedOneDeferred)).toBe(
      "2 findings fixed, 1 deferred",
    );
  });

  it("is 0/0 when fix-applier is absent", () => {
    expect(composeCountsLine("")).toBe("0 findings fixed, 0 deferred");
  });

  it("degrades to 0/0 — not a thrown error — on unparsable fix-applier JSON", () => {
    expect(composeCountsLine("{not valid json")).toBe(
      "0 findings fixed, 0 deferred",
    );
  });

  it("degrades to 0/0 on well-formed JSON missing the commits/deferred arrays", () => {
    expect(composeCountsLine(JSON.stringify({ summary: "ok" }))).toBe(
      "0 findings fixed, 0 deferred",
    );
  });
});

describe(parsePlanDeviations, () => {
  it("extracts PLAN-DEVIATION bullets under ## open_questions", () => {
    const scoutMd = [
      "# Scout report",
      "",
      "## affected_modules",
      "- some module",
      "",
      "## open_questions",
      "",
      "- PLAN-DEVIATION: Task 6 names the wrong file for renderComment.",
      "- Assumption: something unrelated, not a deviation.",
      "- PLAN-DEVIATION: Task 2 overcounts wired-skill files.",
      "",
      "## recommended_strategy",
      "- PLAN-DEVIATION: this one is under the WRONG heading, excluded.",
    ].join("\n");
    expect(parsePlanDeviations(scoutMd)).toEqual([
      "Task 6 names the wrong file for renderComment.",
      "Task 2 overcounts wired-skill files.",
    ]);
  });

  it("returns an empty array when there is no ## open_questions heading", () => {
    expect(
      parsePlanDeviations("# Scout report\n\nno such heading here\n"),
    ).toEqual([]);
  });

  it("returns an empty array for an empty scout.md", () => {
    expect(parsePlanDeviations("")).toEqual([]);
  });
});

describe(renderDeviations, () => {
  const empty = { intentResolutionRaw: "", fixApplierRaw: "", scoutRaw: "" };

  it("renders none when all three sources are empty", () => {
    expect(renderDeviations(empty)).toEqual(["none"]);
  });

  it("includes the intent verdict only when non-match", () => {
    expect(
      renderDeviations({
        ...empty,
        intentResolutionRaw: JSON.stringify({
          verdict: "scope-drift",
          resolution: "guess narrower than request",
        }),
      }),
    ).toEqual(["intent: scope-drift — guess narrower than request"]);
    expect(
      renderDeviations({
        ...empty,
        intentResolutionRaw: JSON.stringify({
          verdict: "match",
          resolution: "matches",
        }),
      }),
    ).toEqual(["none"]);
  });

  it("includes fix-applier deferrals that carry a tracker_entry_url, excludes unfiled ones", () => {
    const fixApplierRaw = JSON.stringify({
      commits: [],
      deferred: [
        { finding_id: "F1", tracker_entry_url: "https://x/1", reason: "later" },
        { finding_id: "F2", tracker_entry_url: "", reason: "no url yet" },
      ],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "s",
    });
    expect(renderDeviations({ ...empty, fixApplierRaw })).toEqual([
      "deferred → https://x/1 (later)",
    ]);
  });

  it("includes scout PLAN-DEVIATION bullets", () => {
    const scoutRaw =
      "## open_questions\n\n- PLAN-DEVIATION: renderComment lives in sources.ts not the helper.\n";
    expect(renderDeviations({ ...empty, scoutRaw })).toEqual([
      "renderComment lives in sources.ts not the helper.",
    ]);
  });

  it("degrades an absent scout file silently to no contribution (not (unreadable))", () => {
    expect(renderDeviations({ ...empty, scoutRaw: "" })).toEqual(["none"]);
  });

  it("combines all three sources in order: intent, deferrals, scout", () => {
    const out = renderDeviations({
      intentResolutionRaw: JSON.stringify({
        verdict: "fundamental",
        resolution: "diverges",
      }),
      fixApplierRaw: JSON.stringify({
        commits: [],
        deferred: [
          {
            finding_id: "F1",
            tracker_entry_url: "https://x/1",
            reason: "later",
          },
        ],
        rejected_alternatives: [],
        anti_patterns_found: [],
        summary: "s",
      }),
      scoutRaw: "## open_questions\n\n- PLAN-DEVIATION: scope note.\n",
    });
    expect(out).toEqual([
      "intent: fundamental — diverges",
      "deferred → https://x/1 (later)",
      "scope note.",
    ]);
  });
});

describe("renderComment — pm lens", () => {
  it("returns {pm, dev} with pm carrying REVIEW counts + DEVIATIONS + UNTRACKED, never the review: narrative", () => {
    const { pm, dev } = renderComment({
      prChangesRaw: "",
      prReviewRaw: JSON.stringify({
        status: "clean",
        completed_steps: [],
        missed_steps: [],
        escalation_tag: null,
        summary: "narrative text that must not leak into pm",
      }),
      fixApplierRaw: fixApplierTwoFixedOneDeferred,
      consolidatorRaw: "",
      ciWaitRaw: "",
      filedIssuesRaw: "",
    });
    expect(pm).toContain("clean — 2 findings fixed, 1 deferred");
    expect(pm).not.toContain("narrative text that must not leak into pm");
    expect(pm).toContain("DEVIATIONS:");
    expect(pm).toContain("UNTRACKED:");
    expect(dev).toContain("narrative text that must not leak into pm");
  });
});

describe("cross-surface parity — lens entries reach DECISIONS, markdown, and plain-text identically", () => {
  // The third rendered surface (DECISIONS, inside `renderComment`'s `dev`
  // block) must never be fed a lens entry that the other two (the PR-body
  // markdown `## Foreclosed Paths` section and the terminal-snapshot plain
  // text) already render — and vice versa. `rejectedDecisionLines` is
  // module-private, so DECISIONS is driven through `renderComment`, not a
  // direct import.
  it("surfaces the same lens rejected-alternative token in all three surfaces", () => {
    const inputs = { fixApplierRaw: "", consolidatorRaw: consolidatorWithLens };
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: consolidatorWithLens,
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    const plainText = renderForeclosedPaths(inputs).join("\n");
    const markdown = formatMarkdown(inputs).join("\n");

    const lensToken = "validate inline at each call site";
    // A lens entry present in two surfaces and absent from the third must
    // fail this assertion — each surface is checked independently.
    expect(decisions).toContain(lensToken);
    expect(plainText).toContain(lensToken);
    expect(markdown).toContain(lensToken);
    // DECISIONS tags the entry with its source lens per the
    // `lens(<name>): <considered_approach> - <why_rejected>` format.
    expect(decisions).toContain("lens(security): validate inline");
  });

  it("surfaces the same lens anti-pattern token in all three surfaces", () => {
    const inputs = { fixApplierRaw: "", consolidatorRaw: consolidatorWithLens };
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: consolidatorWithLens,
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    const plainText = renderForeclosedPaths(inputs).join("\n");
    const markdown = formatMarkdown(inputs).join("\n");

    const lensToken = "manual TTL bookkeeping duplicated across call sites";
    expect(decisions).toContain(lensToken);
    expect(plainText).toContain(lensToken);
    expect(markdown).toContain(lensToken);
    expect(decisions).toContain("(lens: bug-detection)");
  });

  it("renders no lens content in any of the three surfaces when the consolidator artifact omits the lens keys (regression guard)", () => {
    const inputs = { fixApplierRaw: "", consolidatorRaw: consolidator };
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: consolidator,
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    const plainText = renderForeclosedPaths(inputs).join("\n");
    const markdown = formatMarkdown(inputs).join("\n");
    for (const surface of [decisions, plainText, markdown]) {
      expect(surface).not.toContain("lens(");
      expect(surface).not.toContain("lens:");
    }
    // The lens-absent baseline still renders its pre-existing content.
    expect(decisions).toContain("kept the two lenses separate");
    expect(plainText).toContain("kept the two lenses separate");
    expect(markdown).toContain("kept the two lenses separate");
  });

  it("renders a fix-applier anti-pattern under the DECISIONS anti-patterns sub-part", () => {
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: fixApplier,
      consolidatorRaw: "",
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    expect(decisions).toContain("bin/lib/x.ts:42");
    expect(decisions).toContain("swallowed error");
    expect(decisions).toContain("log and rethrow");
    expect(decisions).toContain(" (new)");
  });

  it("renders a consolidator string anti-pattern under the DECISIONS anti-patterns sub-part", () => {
    const consolidatorWithAntiPattern = JSON.stringify({
      consolidated_findings: [],
      dropped_by_validation: [],
      rejected_alternatives: [],
      anti_patterns_found: ["duplicated retry logic across two call sites"],
      summary: "s",
    });
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: consolidatorWithAntiPattern,
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    expect(decisions).toContain(
      "consolidation: duplicated retry logic across two call sites",
    );
  });

  it("renders an explicit `none` when no source contributes an anti-pattern", () => {
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: consolidator,
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    expect(decisions).toContain("  anti-patterns:\n    none");
    // `rejected:` still renders exactly as before.
    expect(decisions).toContain(
      "  rejected:\n    kept the two lenses separate",
    );
  });

  it("positions `anti-patterns:` after `rejected:` in DECISIONS", () => {
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: fixApplier,
      consolidatorRaw: consolidator,
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    expect(decisions.indexOf("  rejected:")).toBeGreaterThan(-1);
    expect(decisions.indexOf("  anti-patterns:")).toBeGreaterThan(
      decisions.indexOf("  rejected:"),
    );
  });

  it("renders `(unreadable)` under DECISIONS anti-patterns for a malformed fix-applier artifact, not `none`", () => {
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "{not json",
      consolidatorRaw: "",
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    expect(decisions).toContain(
      "  anti-patterns:\n    fix-applier: (unreadable)",
    );
  });

  it("renders `(unreadable)` under DECISIONS anti-patterns for a malformed consolidator artifact, not `none`", () => {
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: "{not json",
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    expect(decisions).toContain(
      "  anti-patterns:\n    consolidator: (unreadable)",
    );
  });

  it("surfaces the fix-applier residual `(N unreadable)` marker under DECISIONS anti-patterns", () => {
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: fixApplierOneBadEntry,
      consolidatorRaw: "",
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    expect(decisions).toContain(
      "  anti-patterns:\n    fix-applier: (1 unreadable)",
    );
  });

  it("surfaces the lens-missing marker under DECISIONS anti-patterns", () => {
    const consolidatorWithMissingLenses = JSON.stringify({
      consolidated_findings: [],
      dropped_by_validation: [],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "s",
      lens_negatives_missing: ["performance"],
    });
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw: consolidatorWithMissingLenses,
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    expect(decisions).toContain(
      "lenses did not populate negative findings: performance",
    );
  });
});

describe("renderComment DECISIONS — artifactDir disk-fallback threading", () => {
  let tmpRoot!: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pipeline-summary-sources-"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = path.join(tmpRoot, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it("threads artifactDir into `rejected:`, not just `anti-patterns:`, so a disk-rescued lens rejected-alternative doesn't render beside `rejected: none`", () => {
    write(
      "agent-output-security.json",
      JSON.stringify({
        rejected_alternatives: [
          {
            considered_approach: "store the token in localStorage",
            why_rejected: "XSS-exposed; used an httpOnly cookie instead",
          },
        ],
        anti_patterns_found: [],
      }),
    );
    const consolidatorRaw = JSON.stringify({
      consolidated_findings: [],
      dropped_by_validation: [],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "s",
    });
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw,
      ciWaitRaw: "",
      filedIssuesRaw: "",
      artifactDir: tmpRoot,
    }).dev;
    expect(decisions).toContain("store the token in localStorage");
    expect(decisions).not.toContain("rejected:\n    none");
  });

  it("does NOT print the total-lens-drop warning under anti-patterns when the sibling rejected: sub-part just rendered a live lens entry", () => {
    // The consolidator artifact directly carries a live
    // `lens_rejected_alternatives` entry AND a non-empty
    // `lens_negatives_missing` (one lens's negatives slot was absent, an
    // entirely separate lens from the one that rendered live). Before the
    // fix, `antiPatternDecisionLines` filtered to `category ===
    // "anti-pattern"` BEFORE checking `isTotalLensDrop` — the
    // missing-lenses marker survives that filter (it's tagged
    // `category: "anti-pattern"`) while the live rejected-alternative does
    // not, so the filtered view alone looked like a genuine total drop.
    const consolidatorRaw = JSON.stringify({
      consolidated_findings: [],
      dropped_by_validation: [],
      rejected_alternatives: [],
      anti_patterns_found: [],
      summary: "s",
      lens_rejected_alternatives: [
        {
          considered_approach: "store the token in localStorage",
          why_rejected: "XSS-exposed; used an httpOnly cookie instead",
          lens: "security",
        },
      ],
      lens_negatives_missing: ["performance"],
    });
    const decisions = renderComment({
      prChangesRaw: "",
      prReviewRaw: "",
      fixApplierRaw: "",
      consolidatorRaw,
      ciWaitRaw: "",
      filedIssuesRaw: "",
    }).dev;
    expect(decisions).toContain("store the token in localStorage");
    expect(decisions).not.toContain("0 entries reached this report");
    // The missing-lenses marker itself is suppressed in THIS sub-part when
    // it isn't a genuine total drop — standalone under `anti-patterns:` (no
    // `rejected:` entries visible from this sub-part's own vantage) it
    // would misleadingly read as a total loss when `rejected:` above it
    // just rendered a live entry.
    expect(decisions).not.toContain("lenses did not populate");
  });
});

describe(renderFollowupIssues, () => {
  it("renders none when there are no filed lines and no deferrals", () => {
    expect(renderFollowupIssues("", "")).toEqual(["none"]);
  });

  it("renders filed and unfiled lines from the sweep file", () => {
    const filedIssuesRaw = "filed\thttps://x/1\nunfiled\tSome Title\n";
    expect(renderFollowupIssues(filedIssuesRaw, "")).toEqual([
      "filed: https://x/1",
      "sweep failed (unfiled): Some Title",
    ]);
  });

  it("renders rejected (exit-3) candidates distinctly from unfiled ones", () => {
    const filedIssuesRaw = "rejected\tBad Candidate\n";
    expect(renderFollowupIssues(filedIssuesRaw, "")).toEqual([
      "rejected (needs repair): Bad Candidate",
    ]);
  });
});

describe(renderLenses, () => {
  const fixture = JSON.stringify({
    scope: { kind: "delta", delta_files: 1 },
    widened: { value: false, reason: null },
    lenses: {
      "bug-detection": {
        ran: true,
        tokens: { total: 100 },
        findings_emitted: 2,
        findings_survived: 1,
        findings_acted: 1,
      },
      performance: {
        ran: false,
        skip_reason: "docs-only diff (1 files)",
      },
    },
  });

  it("renders one dev line per lens plus the scope line from a fixture telemetry JSON", () => {
    const { dev } = renderLenses(fixture);
    expect(dev[0]).toBe("scope: delta (1 files)");
    expect(dev).toContain("bug-detection: ran · 100 tok · 2→1→1");
  });

  it("renders `gated (<reason>)` for a lens with ran:false", () => {
    const { dev } = renderLenses(fixture);
    expect(dev).toContain("performance: gated (docs-only diff (1 files))");
  });

  it("renders n/a for null tokens", () => {
    const raw = JSON.stringify({
      scope: { kind: "full", delta_files: 0 },
      widened: { value: false, reason: null },
      lenses: { "bug-detection": { ran: true, tokens: null, findings_emitted: 0, findings_survived: 0, findings_acted: 0 } },
    });
    const { dev } = renderLenses(raw);
    expect(dev).toContain("bug-detection: ran · n/a tok · 0→0→0");
  });

  it("returns dev ['none'] / pm 'lenses: none' for undefined/empty raw", () => {
    expect(renderLenses(undefined)).toEqual({ dev: ["none"], pm: "lenses: none" });
    expect(renderLenses("")).toEqual({ dev: ["none"], pm: "lenses: none" });
  });

  it("returns '(unreadable)' for non-JSON raw", () => {
    const result = renderLenses("{not json");
    expect(result.dev).toEqual(["(unreadable)"]);
    expect(result.pm).toBe("lenses: (unreadable)");
  });
});
