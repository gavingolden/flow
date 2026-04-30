import { describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  parseReviewSummary,
  renderSummarySubsection,
  type ReviewSummary,
} from "./review.js";
import type { Task } from "../../state/task-file.js";

function makeTask(overrides: Partial<Task["frontmatter"]> = {}, body = ""): Task {
  return {
    path: "/tmp/task.md",
    frontmatter: {
      id: "2026-04-29-test",
      status: "reviewing",
      created: "2026-04-29T00:00:00.000Z",
      updated: "2026-04-29T00:00:00.000Z",
      target_repo: "/tmp",
      worktree: "/tmp/wt",
      branch: "test-branch",
      pr: 42,
      manual_validation: null,
      merge_commit: null,
      ...overrides,
    },
    body,
  };
}

const cleanSummary: ReviewSummary = {
  mode: "review",
  committed: false,
  escalate: false,
  reason: "",
  addressed: [],
  deferred: [],
};

describe("parseReviewSummary", () => {
  it("accepts a minimum well-formed payload", () => {
    const json = JSON.stringify(cleanSummary);
    const r = parseReviewSummary(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(cleanSummary);
    }
  });

  it("accepts an Address-mode payload that committed and addressed findings", () => {
    const summary: ReviewSummary = {
      mode: "address",
      committed: true,
      escalate: false,
      reason: "",
      addressed: [
        { file: "src/foo.ts", line: 42, summary: "fixed null deref" },
        { file: "src/bar.ts", line: 7, summary: "added missing await" },
      ],
      deferred: [],
    };
    const r = parseReviewSummary(JSON.stringify(summary));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.mode).toBe("address");
      expect(r.value.committed).toBe(true);
      expect(r.value.addressed).toHaveLength(2);
    }
  });

  it("accepts an architectural-deferred payload that escalates", () => {
    const summary: ReviewSummary = {
      mode: "review",
      committed: false,
      escalate: true,
      reason: "architectural-concern",
      addressed: [],
      deferred: [
        {
          file: "src/foo.ts",
          line: 1,
          summary: "wrong layer doing the work",
          kind: "architectural",
          tracker_ref: "docs/roadmap.md#followup-relocate",
        },
      ],
    };
    const r = parseReviewSummary(JSON.stringify(summary));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.escalate).toBe(true);
      expect(r.value.reason).toBe("architectural-concern");
      expect(r.value.deferred[0]!.kind).toBe("architectural");
    }
  });

  it("accepts a non-architectural deferral that does not escalate", () => {
    const summary: ReviewSummary = {
      mode: "review",
      committed: false,
      escalate: false,
      reason: "",
      addressed: [],
      deferred: [
        {
          file: "src/bar.ts",
          line: 73,
          summary: "needs new test harness",
          kind: "code",
          tracker_ref: "gh:repo#42",
        },
      ],
    };
    const r = parseReviewSummary(JSON.stringify(summary));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.escalate).toBe(false);
      expect(r.value.deferred[0]!.kind).toBe("code");
    }
  });

  it("rejects malformed JSON without throwing", () => {
    const r = parseReviewSummary("{ not valid json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("JSON.parse");
  });

  it("rejects missing mode field", () => {
    const { mode: _mode, ...rest } = cleanSummary;
    const r = parseReviewSummary(JSON.stringify(rest));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("mode");
  });

  it("rejects an unknown mode value", () => {
    const r = parseReviewSummary(
      JSON.stringify({ ...cleanSummary, mode: "hybrid" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("mode");
  });

  it("rejects non-boolean committed", () => {
    const r = parseReviewSummary(
      JSON.stringify({ ...cleanSummary, committed: "true" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("committed");
  });

  it("rejects non-boolean escalate", () => {
    const r = parseReviewSummary(
      JSON.stringify({ ...cleanSummary, escalate: 1 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("escalate");
  });

  it("rejects an addressed entry with non-numeric line", () => {
    const r = parseReviewSummary(
      JSON.stringify({
        ...cleanSummary,
        addressed: [{ file: "f", line: "1", summary: "s" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("line");
  });

  it("rejects a deferred entry without kind", () => {
    const r = parseReviewSummary(
      JSON.stringify({
        ...cleanSummary,
        deferred: [{ file: "f", line: 1, summary: "s", tracker_ref: "x" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("kind");
  });

  it("rejects a deferred entry with unknown kind value", () => {
    const r = parseReviewSummary(
      JSON.stringify({
        ...cleanSummary,
        deferred: [
          { file: "f", line: 1, summary: "s", kind: "infra", tracker_ref: "x" },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("kind");
  });

  it("rejects a deferred entry without tracker_ref", () => {
    const r = parseReviewSummary(
      JSON.stringify({
        ...cleanSummary,
        deferred: [{ file: "f", line: 1, summary: "s", kind: "code" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("tracker_ref");
  });

  it("rejects a top-level array", () => {
    const r = parseReviewSummary("[]");
    expect(r.ok).toBe(false);
  });
});

describe("buildReviewPrompt", () => {
  const baseArgs = {
    resultJsonPath: "/tmp/.orchestrator/tasks/abc/review/summary.json",
  };

  it("includes the PR number, RESULT_JSON_PATH, and the orchestrator-output-mode invocation", () => {
    const task = makeTask({ pr: 99 });
    const prompt = buildReviewPrompt({ ...baseArgs, task, ciExcerpts: null });
    expect(prompt).toContain("/pr-review 99");
    expect(prompt).toContain(`RESULT_JSON_PATH=${baseArgs.resultJsonPath}`);
    expect(prompt).toContain("orchestrator output mode");
  });

  it("does not suppress auto-fix, commits, pushes, or address-mode flows", () => {
    // Pin the absence of the old machine-mode preamble. Without these
    // negations, a regression that re-introduces the suppressions would
    // pass typecheck and silently break the round trip again.
    const task = makeTask();
    const prompt = buildReviewPrompt({ ...baseArgs, task, ciExcerpts: null });
    expect(prompt).not.toContain("Force Review mode");
    expect(prompt).not.toContain("Do NOT auto-fix");
    expect(prompt).not.toContain("do NOT commit");
    expect(prompt).not.toContain("do NOT push");
    expect(prompt).not.toContain("Skip Step");
  });

  it("describes the summary.json fields the skill must populate", () => {
    const task = makeTask();
    const prompt = buildReviewPrompt({ ...baseArgs, task, ciExcerpts: null });
    expect(prompt).toContain('"mode"');
    expect(prompt).toContain('"committed"');
    expect(prompt).toContain('"escalate"');
    expect(prompt).toContain('"addressed"');
    expect(prompt).toContain('"deferred"');
  });

  it("inlines bot review excerpts verbatim when present", () => {
    const task = makeTask();
    const excerpts = "Copilot says: this looks fine.\nLine 42 has a typo.";
    const prompt = buildReviewPrompt({ ...baseArgs, task, ciExcerpts: excerpts });
    expect(prompt).toContain(excerpts);
  });

  it("omits the bot-context section entirely when ciExcerpts is null", () => {
    const task = makeTask();
    const prompt = buildReviewPrompt({ ...baseArgs, task, ciExcerpts: null });
    expect(prompt).not.toContain("Bot review excerpts");
  });

  it("references the plan deliverables so the skill can compare against the spec", () => {
    const task = makeTask({ id: "abc-task", target_repo: "/repo" });
    const prompt = buildReviewPrompt({ ...baseArgs, task, ciExcerpts: null });
    expect(prompt).toContain("/repo/.orchestrator/tasks/abc-task-plan/prd.md");
    expect(prompt).toContain("/repo/.orchestrator/tasks/abc-task-plan/task-breakdown.md");
  });
});

describe("renderSummarySubsection", () => {
  it("renders a clean review with no addressed or deferred", () => {
    const out = renderSummarySubsection(cleanSummary);
    expect(out).toContain("mode: review");
    expect(out).toContain("committed: false");
    expect(out).toContain("escalate: false");
    expect(out).toContain("addressed: (none)");
    expect(out).toContain("deferred: (none)");
  });

  it("renders an Address-mode committed summary with an addressed list", () => {
    const summary: ReviewSummary = {
      mode: "address",
      committed: true,
      escalate: false,
      reason: "",
      addressed: [
        { file: "src/foo.ts", line: 42, summary: "null deref" },
      ],
      deferred: [],
    };
    const out = renderSummarySubsection(summary);
    expect(out).toContain("mode: address");
    expect(out).toContain("committed: true");
    expect(out).toContain("src/foo.ts:42 — null deref");
  });

  it("renders an architectural-deferred escalation with the reason", () => {
    const summary: ReviewSummary = {
      mode: "review",
      committed: false,
      escalate: true,
      reason: "architectural-concern",
      addressed: [],
      deferred: [
        {
          file: "src/foo.ts",
          line: 1,
          summary: "wrong layer",
          kind: "architectural",
          tracker_ref: "docs/roadmap.md#x",
        },
      ],
    };
    const out = renderSummarySubsection(summary);
    expect(out).toContain("escalate: true (architectural-concern)");
    expect(out).toContain("(architectural)");
    expect(out).toContain("[tracker: docs/roadmap.md#x]");
  });
});
