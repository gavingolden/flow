import { describe, expect, it } from "vitest";
import {
  composeCountsLine,
  parsePlanDeviations,
  renderComment,
  renderDeviations,
  renderFindings,
  renderForeclosedPaths,
  renderIntent,
  renderPhases,
  renderReviewCounts,
} from "./pipeline-summary-sources";

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

const consolidator = JSON.stringify({
  consolidated_findings: [],
  dropped_by_validation: [],
  rejected_alternatives: ["kept the two lenses separate"],
  anti_patterns_found: [],
  summary: "s",
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
