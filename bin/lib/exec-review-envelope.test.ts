import { describe, expect, it } from "vitest";
import {
  MAX_CHALLENGE_ROUNDS,
  normalizePlan,
  normalizeWave,
  parseEnvelope,
  type Challenge,
  type ExecEnvelope,
} from "./exec-review-envelope";

const env = (over: Partial<ExecEnvelope> = {}): ExecEnvelope => ({
  decision: "approve",
  doorType: "two-way",
  confidence: "high",
  rationale: "r",
  evidence: ["bin/lib/state.ts:10"],
  challenges: [],
  notes: [],
  recommendation: "",
  undo: "u",
  ...over,
});

const ch = (over: Partial<Challenge> = {}): Challenge => ({
  id: "c1",
  text: "press this",
  decisionItChanges: "d",
  evidenceToSettle: "e",
  costOfBeingWrong: "c",
  ...over,
});

const plan = (e: ExecEnvelope, round = 1, priorBlockingIds: string[] = []) =>
  normalizePlan(e, { round, priorBlockingIds });

describe("parseEnvelope", () => {
  const good = {
    decision: "approve",
    doorType: "two-way",
    confidence: "high",
    rationale: "because",
    evidence: ["a/b.ts:1"],
  };

  it("parses a fenced JSON object with defaults filled in", () => {
    const r = parseEnvelope(
      "text\n```json\n" + JSON.stringify(good) + "\n```",
      "plan",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.challenges).toEqual([]);
      expect(r.envelope.notes).toEqual([]);
      expect(r.envelope.undo).toBe("");
    }
  });

  it("rejects missing, wrong-typed, or out-of-enum fields with a named reason", () => {
    const bad = (o: object, kind: "plan" | "wave" = "plan") =>
      parseEnvelope(JSON.stringify({ ...good, ...o }), kind);
    expect(parseEnvelope("no json here", "plan")).toMatchObject({ ok: false });
    expect(bad({ confidence: "sure" })).toMatchObject({ ok: false });
    expect(bad({ doorType: undefined })).toMatchObject({ ok: false });
    expect(bad({ rationale: "" })).toMatchObject({ ok: false });
    expect(bad({ evidence: "x" })).toMatchObject({ ok: false });
    expect(bad({ decision: "reorder" })).toMatchObject({ ok: false });
    expect(bad({ decision: "approve" }, "wave")).toMatchObject({ ok: false });
    expect(bad({ challenges: [{ id: "x" }] })).toMatchObject({ ok: false });
    expect(
      bad({ proposal: { kind: "nope", text: "t" } }, "wave"),
    ).toMatchObject({ ok: false });
    expect(bad({ priorChallenges: [{ id: "a" }] })).toMatchObject({
      ok: false,
    });
  });

  it("keeps recommendation text but drops an invalid recommendationAction", () => {
    const r = parseEnvelope(
      JSON.stringify({
        ...good,
        decision: "defer",
        recommendation: "do x",
        recommendationAction: "maybe",
      }),
      "plan",
    );
    expect(r.ok && r.envelope.recommendation).toBe("do x");
    expect(r.ok && r.envelope.recommendationAction).toBeUndefined();
  });

  it("assigns ids to challenges that lack one", () => {
    const r = parseEnvelope(
      JSON.stringify({
        ...good,
        decision: "challenge",
        challenges: [{ text: "t" }],
      }),
      "plan",
    );
    expect(r.ok && r.envelope.challenges[0].id).toBe("c1");
  });
});

describe("normalizePlan", () => {
  it("approves only on high confidence, a two-way door, no one-way action, and a closed-form anchor", () => {
    expect(plan(env()).action).toBe("approve");
    expect(plan(env({ confidence: "medium" })).action).toBe("defer");
    expect(plan(env({ confidence: "low" })).action).toBe("defer");
    expect(plan(env({ doorType: "one-way" })).action).toBe("defer");
    expect(plan(env({ oneWayActions: ["db push"] })).action).toBe("defer");
    expect(plan(env({ evidence: [] })).action).toBe("defer");
    expect(plan(env({ evidence: ["weighing: gut feel"] })).action).toBe(
      "defer",
    );
  });

  it("keeps a well-formed challenge and demotes one missing a required part to a note", () => {
    const e = env({
      decision: "challenge",
      challenges: [ch(), ch({ id: "c2", text: "vague", costOfBeingWrong: "" })],
    });
    const n = plan(e);
    expect(n.action).toBe("challenge");
    expect(n.challenges.map((c) => c.id)).toEqual(["c1"]);
    expect(n.notes).toContain("vague");
    expect(n.demotions[0]).toContain("c2");
    expect(n.demotions[0]).toContain("costOfBeingWrong");
  });

  it("never starts a round for notes alone: a challenge with no blocking items re-evaluates", () => {
    const vague = [ch({ decisionItChanges: "" })];
    expect(plan(env({ decision: "challenge", challenges: vague })).action).toBe(
      "approve",
    );
    expect(
      plan(
        env({ decision: "challenge", challenges: vague, confidence: "medium" }),
      ).action,
    ).toBe("defer");
    expect(plan(env({ decision: "challenge", challenges: [] })).action).toBe(
      "approve",
    );
  });

  it("defers an approve that still carries a blocking challenge", () => {
    const n = plan(env({ challenges: [ch()] }));
    expect(n.action).toBe("defer");
    expect(n.openPoints).toEqual(["press this"]);
  });

  it("stops pressing when a round closes none of the prior blocking challenges", () => {
    const e = env({
      decision: "challenge",
      challenges: [ch({ id: "c9", text: "new" })],
      priorChallenges: [
        { id: "c1", closed: false, actedOn: true, evidence: "" },
      ],
    });
    const n = plan(e, 2, ["c1"]);
    expect(n.action).toBe("defer");
    expect(n.backstop).toBe(false);
    expect(n.openPoints).toContain("new");
    expect(n.openPoints).toContain("prior challenge c1 still open");
  });

  it("keeps pressing in round 2+ while at least one prior challenge closed", () => {
    const e = env({
      decision: "challenge",
      challenges: [ch({ id: "c9" })],
      priorChallenges: [
        { id: "c1", closed: true, actedOn: true, evidence: "" },
        { id: "c2", closed: false, actedOn: false, evidence: "" },
      ],
    });
    expect(plan(e, 2, ["c1", "c2"]).action).toBe("challenge");
  });

  it("round 1 never applies the no-progress stop", () => {
    expect(
      plan(env({ decision: "challenge", challenges: [ch()] }), 1, []).action,
    ).toBe("challenge");
  });

  it("flags a backstop deferral on the fifth challenging review", () => {
    expect(MAX_CHALLENGE_ROUNDS).toBe(4);
    const e = env({
      decision: "challenge",
      challenges: [ch()],
      priorChallenges: [
        { id: "c0", closed: true, actedOn: true, evidence: "" },
      ],
    });
    expect(plan(e, 4, ["c0"]).action).toBe("challenge");
    const n = plan(e, 5, ["c0"]);
    expect(n.action).toBe("defer");
    expect(n.backstop).toBe(true);
  });

  it("passes an explicit defer through", () => {
    expect(plan(env({ decision: "defer" })).action).toBe("defer");
  });
});

describe("normalizeWave", () => {
  const wave = (e: Partial<ExecEnvelope>, unstarted = ["a", "b", "c"]) =>
    normalizeWave(env({ decision: "reorder", ...e }), {
      unstartedIds: unstarted,
    });

  it("applies a high-confidence two-way reorder that permutes exactly the unstarted ids", () => {
    const n = wave({ order: ["c", "a", "b"] });
    expect(n.action).toBe("reorder");
    expect(n.order).toEqual(["c", "a", "b"]);
  });

  it("escalates a reorder that adds, drops, or duplicates an id", () => {
    expect(wave({ order: ["a", "b"] }).action).toBe("escalate");
    expect(wave({ order: ["a", "b", "c", "d"] }).action).toBe("escalate");
    expect(wave({ order: ["a", "a", "b"] }).action).toBe("escalate");
    expect(wave({}).action).toBe("escalate");
  });

  it("continues, keeping the proposed order as a note, when the reorder is not eligible", () => {
    const n = wave({ order: ["c", "a", "b"], confidence: "medium" });
    expect(n.action).toBe("continue");
    expect(n.order).toBeUndefined();
    expect(n.notes.join(" ")).toContain("c, a, b");
    expect(wave({ order: ["c", "a", "b"], doorType: "one-way" }).action).toBe(
      "continue",
    );
    expect(wave({ order: ["c", "a", "b"], evidence: [] }).action).toBe(
      "continue",
    );
  });

  it("passes continue, propose, and escalate through; a propose needs a proposal", () => {
    expect(wave({ decision: "continue" }).action).toBe("continue");
    expect(wave({ decision: "escalate" }).action).toBe("escalate");
    expect(
      wave({ decision: "propose", proposal: { kind: "cut", text: "drop f9" } })
        .action,
    ).toBe("propose");
    expect(wave({ decision: "propose" }).action).toBe("escalate");
  });
});
