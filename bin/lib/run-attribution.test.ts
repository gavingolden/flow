import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectSegment } from "./session-discovery";
import { collectRunAttribution } from "./run-attribution";
import { roleFromMeta } from "./run-attribution-spawns";
import type { PipelineState } from "./state";

const REPO = "/Users/test/code/me/flow";
const WORKTREE = "/Users/test/code/me/flow-feat-x";
const SLUG = "feat-x";
const START = "2026-11-06T10:00:00.000Z";
const MARK = `[pipeline-slug: ${SLUG}] Use the /flow-pipeline skill.`;

let root: string;
let eventsLog: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-runattr-test-"));
  eventsLog = path.join(root, "events.jsonl");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function dirFor(cwd: string): string {
  const d = path.join(root, "projects", encodeProjectSegment(cwd));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function user(content: string, extra: object = {}): object {
  return { type: "user", message: { role: "user", content }, ...extra };
}

const USAGE = { input_tokens: 1_000_000, output_tokens: 0 };

function turn(
  id: string,
  model: string,
  effort: string | undefined,
  ts: string,
  usage: object = USAGE,
): object {
  return {
    type: "assistant",
    timestamp: ts,
    ...(effort ? { effort } : {}),
    message: { id, model, usage },
  };
}

function writeLines(file: string, lines: object[]): void {
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
}

function state(extra: Partial<PipelineState> = {}): PipelineState {
  return {
    slug: SLUG,
    phase: "merged",
    repo: REPO,
    worktree: WORKTREE,
    updatedAt: START,
    phaseLog: [{ phase: "triaging", at: START }],
    ...extra,
  };
}

function collect(s: PipelineState = state()) {
  return collectRunAttribution(s, {
    projectsRoot: path.join(root, "projects"),
    eventsLogPath: eventsLog,
  });
}

function seedFixture(): void {
  const repoDir = dirFor(REPO);
  writeLines(path.join(repoDir, "sess-a.jsonl"), [
    user(MARK),
    turn("a1", "claude-opus-5-5", "low", "2026-11-06T10:01:00Z"),
    turn("a2", "claude-opus-5-5", "low", "2026-11-06T10:02:00Z"),
    turn("a3", "claude-opus-5-5", "high", "2026-11-06T10:03:00Z"),
    turn("a4", "<synthetic>", undefined, "2026-11-06T10:04:00Z"),
  ]);
  writeLines(path.join(repoDir, "sess-b.jsonl"), [
    user("meta", { isMeta: true }),
    user("<command-name>/clear</command-name>"),
    user(`note: ${MARK}`),
    turn("b1", "claude-opus-5-5", "high", "2026-11-06T11:01:00Z"),
    turn("b2", "claude-sonnet-5-5", "medium", "2026-11-06T11:02:00Z"),
  ]);
  writeLines(path.join(dirFor(WORKTREE), "sess-c.jsonl"), [
    user(MARK),
    turn("c1", "claude-opus-5-5", undefined, "2026-11-06T12:01:00Z"),
  ]);
  writeLines(path.join(repoDir, "sess-old.jsonl"), [
    user(MARK),
    turn("o1", "claude-opus-5-5", "low", "2026-11-01T10:00:00Z"),
  ]);
  const sub = path.join(repoDir, "sess-a", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  writeLines(path.join(sub, "agent-1.jsonl"), [
    turn("s1", "claude-sonnet-5-5", "medium", "2026-11-06T10:02:30Z"),
    turn("s2", "claude-sonnet-5-5", "medium", "2026-11-06T10:02:40Z"),
  ]);
  fs.writeFileSync(
    path.join(sub, "agent-1.meta.json"),
    JSON.stringify({ agentType: "flow-module-core:flow-coder" }),
  );
}

describe(collectRunAttribution, () => {
  it("collects /clear-started, worktree-dir and plain sessions in time order and drops the stale one", () => {
    seedFixture();
    const a = collect();
    expect(a.sessions.map((s) => s.session_id)).toEqual([
      "sess-a",
      "sess-b",
      "sess-c",
    ]);
  });

  it("keeps ordered effort runs and ignores <synthetic> turns", () => {
    seedFixture();
    const a = collect().sessions[0];
    expect(a.turns).toBe(3);
    expect(a.runs).toEqual([
      ["claude-opus-5-5", "low", 2],
      ["claude-opus-5-5", "high", 1],
    ]);
  });

  it("starts a new run on a mid-session model switch and prices each turn at its own model", () => {
    seedFixture();
    const b = collect().sessions[1];
    expect(b.runs).toEqual([
      ["claude-opus-5-5", "high", 1],
      ["claude-sonnet-5-5", "medium", 1],
    ]);
    // 1M input at opus-5-5 ($4) + 1M input at sonnet-5-5 ($2)
    expect(b.cost_usd).toBeCloseTo(6, 6);
    expect(b.run_costs).toEqual([4, 2]);
  });

  it("counts a turn without effort as unknown", () => {
    seedFixture();
    const a = collect();
    expect(a.sessions[2].runs).toEqual([["claude-opus-5-5", "unknown", 1]]);
    expect(a.totals.unattributed_effort_turns).toBe(1);
  });

  it("attributes a Sonnet sub-agent at medium with its flow-stripped role", () => {
    seedFixture();
    const spawn = collect().spawns[0];
    expect(spawn).toMatchObject({
      role: "coder",
      agent_type: "flow-module-core:flow-coder",
      parent_session_id: "sess-a",
      model: "claude-sonnet-5-5",
      turns: 2,
    });
    expect(spawn.runs).toEqual([["claude-sonnet-5-5", "medium", 2]]);
  });

  it("rolls totals up by model and effort including sub-agent spend", () => {
    seedFixture();
    const t = collect().totals;
    // opus: 3 turns * $4 (a1-a3) + b1 + c1 = 5 * $4; sonnet: b2 + 2 spawn turns = 3 * $2
    expect(t.cost_usd).toBeCloseTo(26, 6);
    const sonnet = t.by_model_effort.find(
      (r) => r.model === "claude-sonnet-5-5" && r.effort === "medium",
    );
    expect(sonnet).toMatchObject({ turns: 3, cost_usd: 6 });
    expect(t.unpriced_models).toEqual([]);
  });

  it("keeps a slug-tagged delegated call from an uncollected session and drops one from before the run", () => {
    seedFixture();
    writeLines(eventsLog, [
      {
        ts: "2026-11-06T11:00:00Z",
        event: "explain.judge",
        slug: SLUG,
        session_id: "sess-pruned",
        attrs: { site: "pr", ran: true, total_cost_usd: 1 },
      },
      {
        ts: "2026-11-01T10:00:00Z",
        event: "deliberate.call",
        slug: SLUG,
        session_id: "sess-old",
        attrs: { task: "old", ran: true, total_cost_usd: 9 },
      },
    ]);
    const a = collect();
    expect(a.delegated.map((d) => d.task)).toEqual(["pr"]);
    expect(a.totals.cost_usd).toBeCloseTo(27, 6);
  });

  it("joins a null-slug delegated call on a collected session id and carries its cost", () => {
    seedFixture();
    const lines = [
      {
        ts: "2026-11-06T11:30:00Z",
        event: "deliberate.call",
        slug: null,
        session_id: "sess-b",
        attrs: {
          task: "oq1",
          ran: true,
          model: "opus",
          effort: "high",
          total_cost_usd: 0.5,
        },
      },
      {
        ts: "2026-11-06T11:31:00Z",
        event: "deliberate.call",
        slug: null,
        session_id: "sess-other",
        attrs: { task: "x", ran: true, total_cost_usd: 9 },
      },
    ];
    writeLines(eventsLog, lines);
    const a = collect();
    expect(a.delegated).toEqual([
      expect.objectContaining({
        event: "deliberate.call",
        task: "oq1",
        model: "opus",
        effort: "high",
        ran: true,
        cost_usd: 0.5,
      }),
    ]);
    expect(a.totals.cost_usd).toBeCloseTo(26.5, 6);
  });

  it("attributes a plan-review.fallback call and carries its cost", () => {
    seedFixture();
    writeLines(eventsLog, [
      {
        ts: "2026-11-06T11:30:00Z",
        event: "plan-review.fallback",
        slug: SLUG,
        session_id: "sess-b",
        attrs: {
          task: "plan-review-r2-claude",
          ran: true,
          model: "claude-opus",
          effort: "high",
          total_cost_usd: 0.42,
        },
      },
    ]);
    const a = collect();
    expect(a.delegated).toEqual([
      expect.objectContaining({
        event: "plan-review.fallback",
        task: "plan-review-r2-claude",
        cost_usd: 0.42,
      }),
    ]);
    expect(a.totals.cost_usd).toBeCloseTo(26.42, 6);
  });

  it("finds a session only through an events.jsonl session_id", () => {
    seedFixture();
    writeLines(path.join(dirFor(REPO), "sess-e.jsonl"), [
      user("a plain follow-up with no slug marker"),
      turn("e1", "claude-opus-5-5", "low", "2026-11-06T13:00:00Z"),
    ]);
    writeLines(eventsLog, [
      {
        ts: "2026-11-06T13:00:01Z",
        event: "phase.transition",
        slug: null,
        session_id: "sess-e",
        attrs: { unmatched_slug: SLUG },
      },
    ]);
    expect(collect().sessions.map((s) => s.session_id)).toContain("sess-e");
  });

  it("drops nothing when there is no phaseLog or timestamp to compare", () => {
    seedFixture();
    const a = collect(state({ phaseLog: undefined }));
    expect(a.sessions.map((s) => s.session_id)).toContain("sess-old");
  });

  it("counts a transcript it cannot read in skipped_files", () => {
    const repoDir = dirFor(REPO);
    writeLines(path.join(repoDir, "sess-a.jsonl"), [user(MARK)]);
    const sub = path.join(repoDir, "sess-a", "subagents");
    fs.mkdirSync(path.join(sub, "agent-x.jsonl"), { recursive: true });
    fs.writeFileSync(path.join(sub, "agent-x.meta.json"), "{}");
    expect(collect().totals.skipped_files).toBe(1);
  });

  it("returns empty arrays for an absent projects dir or events log", () => {
    const a = collect(state({ repo: "/nowhere", worktree: undefined }));
    expect(a.sessions).toEqual([]);
    expect(a.spawns).toEqual([]);
    expect(a.delegated).toEqual([]);
    expect(a.totals.cost_usd).toBe(0);
  });

  it("lists an unpriced model instead of costing it at zero", () => {
    writeLines(path.join(dirFor(REPO), "sess-h.jsonl"), [
      user(MARK),
      turn("h1", "claude-haiku-5-5", "low", "2026-11-06T10:05:00Z"),
    ]);
    const a = collect();
    expect(a.totals.unpriced_models).toEqual(["claude-haiku-5-5"]);
    expect(a.sessions[0].cost_usd).toBeNull();
  });
});

describe(roleFromMeta, () => {
  it("strips the plugin prefix and a leading flow-", () => {
    expect(
      roleFromMeta({ agentType: "flow-module-core:flow-review-correctness" }),
    ).toEqual({
      role: "review-correctness",
      agentType: "flow-module-core:flow-review-correctness",
    });
  });

  it("labels general-purpose with its description capped at 80 chars", () => {
    const { role } = roleFromMeta({
      agentType: "general-purpose",
      description: "x".repeat(120),
    });
    expect(role).toBe("x".repeat(80));
  });

  it("falls back to unknown without metadata", () => {
    expect(roleFromMeta({})).toEqual({ role: "unknown", agentType: null });
  });
});
