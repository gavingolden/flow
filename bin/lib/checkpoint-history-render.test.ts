import { describe, expect, it } from "vitest";
import { parseNoteItems } from "./checkpoint-decisions";
import {
  HOOK_CONTEXT_MAX_CHARS,
  renderBrief,
  renderHistory,
  type HistoryInputs,
} from "./checkpoint-history-render";
import type { HistoryEvent } from "./checkpoint-history";
import type { PipelineState } from "./state";

const HIST = "/home/u/.flow/state/checkpoints/demo/history.md";

function state(over: Partial<PipelineState> = {}): PipelineState {
  return {
    slug: "demo",
    repo: "me/flow",
    phase: "reviewing",
    pr: 12,
    prUrl: "https://github.com/me/flow/pull/12",
    phaseLog: [
      { phase: "planning", at: "2026-11-01T00:00:00Z" },
      { phase: "reviewing", at: "2026-11-01T01:00:00Z" },
    ],
    ...over,
  } as PipelineState;
}

function noteEvent(
  n: number,
  body: string,
  phase = "implementing",
): HistoryEvent {
  return {
    type: "note",
    at: `2026-11-01T0${n % 10}:00:00Z`,
    phase,
    site: "manual",
    sha: `sha${n}`,
    body,
    items: parseNoteItems(body),
  };
}

function inputs(over: Partial<HistoryInputs> = {}): HistoryInputs {
  return {
    kind: "feature",
    state: state(),
    events: [],
    liveNote: null,
    liveNoteUsable: false,
    pipelineEnded: false,
    resumeSeed: "RESUME demo",
    artifactDir: null,
    artifacts: {},
    requestText: "make the thing",
    planDoc: null,
    prDoc: null,
    epic: null,
    historyPath: HIST,
    ...over,
  };
}

const PLAN = [
  "# PRD",
  "**Goal:** Survive every clear.",
  "## Request vetting",
  "- **Verdict:** adopt-with-conditions: facts from sources",
  "## Decision analysis",
  "- Verdict: **A4** — facts plus journal",
  "## Recommendation",
  "**Proceed** — build it",
  "# Task breakdown",
  "### Task 1: Tagged decisions",
  "# Candidate follow-up issues",
  "- [ ] file the cleanup",
  "- [x] already filed",
].join("\n");

const PR = [
  "## User-facing changes",
  "- the clear carries a brief",
  "## System changes",
  "- new log",
  "## Key decisions",
  "- chose render-on-read",
].join("\n");

describe("renderHistory", () => {
  it("should keep every timeline entry, note, journal body and the whole request", () => {
    // Arrange
    const log = Array.from({ length: 400 }, (_, i) => ({
      phase: `phase-${i}`,
      at: `2026-11-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    }));
    const request = "r".repeat(4000);
    const events: HistoryEvent[] = [
      ...Array.from({ length: 30 }, (_, i) => noteEvent(i, `note body ${i}`)),
      ...Array.from(
        { length: 20 },
        (_, i): HistoryEvent => ({
          type: "journal",
          at: `2026-11-02T00:00:${i}Z`,
          phase: "reviewing",
          body: `journal body ${i}`,
        }),
      ),
    ];
    // Act
    const doc = renderHistory(
      inputs({
        state: state({ phaseLog: log }),
        events,
        requestText: request,
      }),
    );
    // Assert
    expect(doc.text).toContain(request);
    for (let i = 0; i < 400; i++) expect(doc.text).toContain(`phase-${i}`);
    for (let i = 0; i < 30; i++) expect(doc.text).toContain(`note body ${i}`);
    for (let i = 0; i < 20; i++)
      expect(doc.text).toContain(`journal body ${i}`);
  });

  it("should cover shipped, decided and deferred from the sources", () => {
    const doc = renderHistory(
      inputs({
        planDoc: PLAN,
        prDoc: PR,
        artifacts: {
          "followups-block.txt": "run: flow install --upgrade",
          "intent-resolution.json": JSON.stringify({
            verdict: "mismatch",
            resolution: "kept the plan",
          }),
        },
      }),
    );
    const section = (k: string) =>
      doc.sections.find((s) => s.key === k)?.body ?? "";
    expect(section("shipped")).toContain("the clear carries a brief");
    expect(section("shipped")).toContain("new log");
    expect(section("decided")).toContain("chose render-on-read");
    expect(section("decided")).toContain("mismatch: kept the plan");
    expect(section("deferred")).toContain("flow install --upgrade");
    expect(section("deferred")).toContain("file the cleanup");
    expect(section("deferred")).not.toContain("already filed");
    expect(section("plan")).toContain("Goal: Survive every clear.");
    expect(section("plan")).toContain("Task 1: Tagged decisions");
  });

  it("should list a standing item under Active instructions and none once ended", () => {
    const events = [noteEvent(1, "- [standing] wait for Copilot")];
    const live = renderHistory(inputs({ events }));
    expect(live.active).toContain("[standing S1] wait for Copilot");
    const ended = renderHistory(
      inputs({
        events,
        pipelineEnded: true,
        state: state({ phase: "merged" }),
      }),
    );
    expect(ended.active).toMatch(/## Active instructions\n\nnone/);
    expect(ended.text).toContain("ended");
  });

  it("should state the current status first and label an earlier gate", () => {
    const events: HistoryEvent[] = [
      { type: "gate", at: "2026-11-01T02:00:00Z", status: "gated", tldr: "t" },
    ];
    const doc = renderHistory(
      inputs({
        events,
        state: state({ phase: "merged" }),
        pipelineEnded: true,
      }),
    );
    const outcome = doc.sections.find((s) => s.key === "outcome")?.body ?? "";
    expect(outcome.split("\n")[0]).toBe("Current status: merged");
    expect(outcome).toContain("earlier outcome");
  });

  it("should name the resume seed and say the record drives nothing", () => {
    const doc = renderHistory(inputs());
    expect(doc.status).toContain("RESUME demo");
    expect(doc.status).toContain("drives nothing on its own");
  });

  it("should degrade a missed journal to none while facts still render", () => {
    const doc = renderHistory(inputs({ planDoc: PLAN, prDoc: PR }));
    expect(doc.sections.find((s) => s.key === "journal")?.body).toBe("none");
    expect(doc.sections.find((s) => s.key === "shipped")?.body).toContain(
      "new log",
    );
  });

  it("should label the journal the supervisor's account", () => {
    const doc = renderHistory(inputs());
    expect(doc.text).toContain("supervisor's own account");
    expect(doc.text).toContain("the fact wins");
    expect(doc.sections.find((s) => s.key === "journal")?.title).toContain(
      "supervisor's account",
    );
  });

  it("should show a live note nothing logged as live, not yet logged", () => {
    const doc = renderHistory(
      inputs({
        liveNote: { sha: "live1", body: "- [one-time] approve" },
        liveNoteUsable: true,
      }),
    );
    expect(doc.active).toContain("approve");
    expect(doc.text).toContain("live, not yet logged");
  });

  it("should read epic design sources and label run.json a cache", () => {
    const design = renderHistory(
      inputs({
        kind: "epic-design",
        planDoc: PLAN,
        prDoc: PR,
        epic: {
          designPath: "/repo/.flow/epics/e/design.md",
          board: null,
          cache: null,
        },
      }),
    );
    expect(design.sections.find((s) => s.key === "plan")?.body).toContain(
      "Survive every clear.",
    );
    expect(design.sections.find((s) => s.key === "decided")?.body).toContain(
      "chose render-on-read",
    );
    const run = renderHistory(
      inputs({
        kind: "epic-run",
        epic: {
          designPath: "/repo/.flow/epics/e/design.md",
          board: {
            version: 1,
            epicId: "e",
            features: { f1: { status: "merged", pr: 5 } },
          },
          cache: {
            epicSlug: "e",
            features: { f1: { slug: "f1-slug", lastStatus: "reviewing" } },
          } as never,
        },
      }),
    );
    const epic = run.sections.find((s) => s.key === "epic")?.body ?? "";
    expect(epic).toContain("f1: merged PR #5");
    expect(epic).toContain("per-machine cache, may lag");
  });
});

describe("renderBrief", () => {
  it("should fit the hook limit and index every section by heading line", () => {
    const doc = renderHistory(
      inputs({
        planDoc: PLAN,
        prDoc: PR,
        events: [noteEvent(1, "- [standing] keep going")],
      }),
    );
    const brief = renderBrief(doc, HIST);
    expect(brief.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    expect(brief.startsWith("<pipeline-history>")).toBe(true);
    expect(brief).toContain(doc.active);
    expect(brief).toContain("RESUME demo");
    const lines = doc.text.split("\n");
    for (const s of doc.sections) {
      expect(brief).toContain(`- ${s.title} — line ${s.line}`);
      expect(lines[s.line - 1]).toBe(`### ${s.title}`);
    }
    expect(lines[doc.activeLine - 1]).toBe("## Active instructions");
  });

  it("should cut on a section boundary and name the first omitted line", () => {
    const events: HistoryEvent[] = Array.from({ length: 40 }, (_, i) => ({
      type: "journal",
      at: `2026-11-02T00:00:${i}Z`,
      phase: "reviewing",
      body: "j".repeat(400),
    }));
    const doc = renderHistory(
      inputs({ events, requestText: "q".repeat(4000) }),
    );
    const brief = renderBrief(doc, HIST);
    expect(brief.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    const m = /\[continued: (.+?) — Read (\S+) offset (\d+)\]/.exec(brief);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBe(HIST);
    const journal = doc.sections.find((s) => s.key === "journal");
    expect(Number(m?.[3])).toBe(journal?.line);
    expect(brief).toContain("## Index of history.md");
  });

  it("should cut an oversized active section on a line boundary", () => {
    const body = Array.from(
      { length: 400 },
      (_, i) => `- [standing] rule number ${i} ${"x".repeat(30)}`,
    ).join("\n");
    const doc = renderHistory(inputs({ events: [noteEvent(1, body)] }));
    const brief = renderBrief(doc, HIST);
    expect(brief.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    expect(brief).toContain(`offset ${doc.activeLine}]`);
  });

  it("should name every feature id at epic-run scale", () => {
    const features: Record<
      string,
      { status: "merged" | "not-started"; pr?: number }
    > = {};
    for (let i = 0; i < 25; i++)
      features[`f${i}-feature`] = { status: "merged", pr: i };
    const events: HistoryEvent[] = [
      ...Array.from({ length: 15 }, (_, i) =>
        noteEvent(i, `note ${i} ${"n".repeat(1500)}`),
      ),
      ...Array.from(
        { length: 25 },
        (_, i): HistoryEvent => ({
          type: "journal",
          at: `2026-11-02T00:00:${i}Z`,
          phase: "epic-running",
          body: `j${i} ${"j".repeat(150)}`,
        }),
      ),
    ];
    const doc = renderHistory(
      inputs({
        kind: "epic-run",
        events,
        requestText: "q".repeat(4300),
        epic: {
          designPath: "/repo/.flow/epics/e/design.md",
          board: { version: 1, epicId: "e", features },
          cache: null,
        },
      }),
    );
    const brief = renderBrief(doc, HIST);
    expect(brief.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    for (const id of Object.keys(features)) expect(brief).toContain(id);
  });
});
