import { describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  parseReviewResult,
  renderFailureLogFromReview,
  renderReviewSubsection,
  REVIEW_CYCLE_CAP,
  type ReviewCycleRecord,
  type ReviewResult,
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
      review_cycles: null,
      ...overrides,
    },
    body,
  };
}

describe("parseReviewResult", () => {
  it("accepts a clean review with no findings", () => {
    const json = JSON.stringify({ summary: "Looks good.", critical: [], minor: [] });
    const r = parseReviewResult(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toBe("Looks good.");
      expect(r.value.critical).toEqual([]);
      expect(r.value.minor).toEqual([]);
    }
  });

  it("accepts a critical-code finding with all required fields", () => {
    const json = JSON.stringify({
      summary: "One issue.",
      critical: [
        { kind: "code", file: "src/foo.ts", line: 42, summary: "Null deref", body: "issue (blocking): nullable" },
      ],
      minor: [],
    });
    const r = parseReviewResult(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.critical).toHaveLength(1);
      expect(r.value.critical[0]!.kind).toBe("code");
      expect(r.value.critical[0]!.file).toBe("src/foo.ts");
      expect(r.value.critical[0]!.line).toBe(42);
    }
  });

  it("accepts a critical-architectural finding", () => {
    const json = JSON.stringify({
      summary: "Wrong layer.",
      critical: [
        { kind: "architectural", file: "src/foo.ts", line: 1, summary: "Wrong layer", body: "..." },
      ],
      minor: [],
    });
    const r = parseReviewResult(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.critical[0]!.kind).toBe("architectural");
    }
  });

  it("accepts minor findings without a kind discriminator", () => {
    // Minor findings don't carry kind — only critical findings need it for
    // the loop-back vs escalate decision.
    const json = JSON.stringify({
      summary: "Nits.",
      critical: [],
      minor: [{ file: "src/bar.ts", line: 73, summary: "nit", body: "..." }],
    });
    const r = parseReviewResult(json);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.minor).toHaveLength(1);
  });

  it("rejects malformed JSON without throwing", () => {
    const r = parseReviewResult("{ not valid json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("JSON.parse");
  });

  it("rejects missing summary", () => {
    const r = parseReviewResult(JSON.stringify({ critical: [], minor: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("summary");
  });

  it("rejects missing critical array", () => {
    const r = parseReviewResult(JSON.stringify({ summary: "x", minor: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("critical");
  });

  it("rejects critical entry missing the kind discriminator", () => {
    const json = JSON.stringify({
      summary: "x",
      critical: [{ file: "f", line: 1, summary: "s", body: "b" }],
      minor: [],
    });
    const r = parseReviewResult(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("kind");
  });

  it("rejects an unknown kind value", () => {
    // `kind: "infra"` would silently advance through the orchestrator's
    // architectural-vs-code branching with neither label firing, looping
    // forever. Tight rejection up front prevents that.
    const json = JSON.stringify({
      summary: "x",
      critical: [{ kind: "infra", file: "f", line: 1, summary: "s", body: "b" }],
      minor: [],
    });
    const r = parseReviewResult(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("kind");
  });

  it("rejects a non-numeric line", () => {
    const json = JSON.stringify({
      summary: "x",
      critical: [{ kind: "code", file: "f", line: "42", summary: "s", body: "b" }],
      minor: [],
    });
    const r = parseReviewResult(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("line");
  });

  it("rejects a top-level array", () => {
    const r = parseReviewResult("[]");
    expect(r.ok).toBe(false);
  });
});

describe("buildReviewPrompt", () => {
  const baseArgs = {
    resultJsonPath: "/tmp/.orchestrator/tasks/abc/review/result-0.json",
    cycleNum: 1,
  };

  it("includes the PR number, RESULT_JSON_PATH, and inline-comments instruction", () => {
    const task = makeTask({ pr: 99 });
    const prompt = buildReviewPrompt({ ...baseArgs, task, ciExcerpts: null });
    expect(prompt).toContain("/pr-review 99");
    expect(prompt).toContain(`RESULT_JSON_PATH=${baseArgs.resultJsonPath}`);
    expect(prompt).toContain("comments endpoint");
    expect(prompt).toContain("never the reviews endpoint");
  });

  it("includes the kind discriminator rubric", () => {
    const task = makeTask();
    const prompt = buildReviewPrompt({ ...baseArgs, task, ciExcerpts: null });
    expect(prompt).toContain("kind");
    expect(prompt).toContain("architectural");
    expect(prompt).toContain("code");
  });

  it("inlines bot review excerpts verbatim when present", () => {
    const task = makeTask();
    const excerpts = "Copilot says: this looks fine.\nLine 42 has a typo.";
    const prompt = buildReviewPrompt({ ...baseArgs, task, ciExcerpts: excerpts });
    expect(prompt).toContain(excerpts);
  });

  it("omits the bot-context section entirely when ciExcerpts is null (no placeholder)", () => {
    // A "no excerpts" placeholder reads as missing context and could nudge
    // the LLM to fabricate findings; omit cleanly instead.
    const task = makeTask();
    const prompt = buildReviewPrompt({ ...baseArgs, task, ciExcerpts: null });
    expect(prompt).not.toContain("Bot review excerpts");
    expect(prompt).not.toContain("no excerpts");
  });

  it("references the cycle number and the cap so the LLM sees the budget", () => {
    const task = makeTask();
    const prompt = buildReviewPrompt({ ...baseArgs, task, cycleNum: 2, ciExcerpts: null });
    expect(prompt).toContain("review cycle 2");
    expect(prompt).toContain(String(REVIEW_CYCLE_CAP + 1));
  });
});

describe("renderFailureLogFromReview", () => {
  it("includes summary, every critical finding's file:line and body, and minor names", () => {
    const result: ReviewResult = {
      summary: "two issues",
      critical: [
        { kind: "code", file: "src/a.ts", line: 10, summary: "null deref", body: "fix it" },
      ],
      minor: [{ file: "src/b.ts", line: 20, summary: "nit", body: "rename" }],
    };
    const log = renderFailureLogFromReview(result);
    expect(log).toContain("two issues");
    expect(log).toContain("src/a.ts:10");
    expect(log).toContain("(code)");
    expect(log).toContain("fix it");
    expect(log).toContain("src/b.ts:20");
  });

  it("handles an empty critical array (clean review still renders)", () => {
    const result: ReviewResult = { summary: "clean", critical: [], minor: [] };
    const log = renderFailureLogFromReview(result);
    expect(log).toContain("clean");
    // No "Critical findings" section when there are none.
    expect(log).not.toContain("Critical findings");
  });
});

describe("renderReviewSubsection", () => {
  function fakeRecord(cycleNumber: number, criticalKinds: ("code" | "architectural")[] = []): ReviewCycleRecord {
    return {
      cycleNumber,
      timestamp: `2026-04-30T01:0${cycleNumber}:00Z`,
      resultJsonPath: `/tmp/review/result-${cycleNumber - 1}.json`,
      result: {
        summary: `cycle-${cycleNumber} summary`,
        critical: criticalKinds.map((kind, i) => ({
          kind,
          file: `src/f${i}.ts`,
          line: 10 + i,
          summary: `crit-${i}`,
          body: "...",
        })),
        minor: [],
      },
    };
  }

  it("renders one cycle with a clean decision", () => {
    const out = renderReviewSubsection([fakeRecord(1)], { kind: "clean" });
    expect(out).toContain('cycle 1 (2026-04-30T01:01:00Z): summary "cycle-1 summary"');
    expect(out).toContain("decision: clean — advancing");
    expect(out).toContain("JSON: /tmp/review/result-0.json");
  });

  it("renders multiple cycles with the needs-human decision and final JSON pointer", () => {
    const out = renderReviewSubsection(
      [fakeRecord(1, ["code"]), fakeRecord(2, ["code"])],
      { kind: "needs-human", reason: "review-cycles-exhausted" },
    );
    expect(out).toContain("cycle 1");
    expect(out).toContain("cycle 2");
    expect(out).toContain("critical (code): src/f0.ts:10 — crit-0");
    expect(out).toContain("decision: needs-human (review-cycles-exhausted)");
    // JSON pointer is the LATEST cycle's path, not the first.
    expect(out).toContain("JSON: /tmp/review/result-1.json");
  });

  it("renders an architectural decision distinctly", () => {
    const out = renderReviewSubsection(
      [fakeRecord(1, ["architectural"])],
      { kind: "needs-human", reason: "architectural-concern" },
    );
    expect(out).toContain("critical (architectural):");
    expect(out).toContain("decision: needs-human (architectural-concern)");
  });

  it("renders a pending decision while mid-loop (cycle complete, fix not yet started)", () => {
    const out = renderReviewSubsection([fakeRecord(1, ["code"])], { kind: "pending" });
    expect(out).toContain("decision: in progress");
  });
});
