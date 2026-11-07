/**
 * The executive's decision envelope: parse the child's JSON, then normalize it
 * into the action the pipeline actually takes. Pure — no I/O.
 *
 * The model proposes; these rules dispose. An approval or a reorder applies
 * only with `confidence: high`, a two-way door, no one-way action, and a
 * mechanically re-verifiable evidence anchor; everything else defers (plan) or
 * continues (wave).
 */

import { isClosedFormAnchor } from "./deliberate-prompt";
import { parseStructured } from "./structured-response";

export type Challenge = {
  id: string;
  text: string;
  decisionItChanges: string;
  evidenceToSettle: string;
  costOfBeingWrong: string;
};

export type ExecEnvelope = {
  decision:
    | "approve"
    | "challenge"
    | "defer"
    | "continue"
    | "reorder"
    | "propose"
    | "escalate";
  doorType: "two-way" | "one-way";
  confidence: "high" | "medium" | "low";
  rationale: string;
  evidence: string[];
  challenges: Challenge[];
  notes: string[];
  recommendation: string;
  recommendationAction?: "approve" | "redirect";
  undo: string;
  priorChallenges?: Array<{
    id: string;
    closed: boolean;
    actedOn: boolean;
    evidence: string;
  }>;
  oneWayActions?: string[];
  order?: string[];
  proposal?: {
    kind: "defer" | "cut" | "add" | "goal";
    featureId?: string;
    text: string;
  };
};

/** Reviews 1..MAX may challenge; the review after that must approve or defer. */
export const MAX_CHALLENGE_ROUNDS = 4;

const PLAN_DECISIONS = ["approve", "challenge", "defer"];
const WAVE_DECISIONS = ["continue", "reorder", "propose", "escalate"];

type R<T> = { ok: true; value: T } | { ok: false; reason: string };

function str(v: unknown, key: string, required = false): R<string> {
  if (v === undefined || v === null) {
    return required
      ? { ok: false, reason: `"${key}" is required` }
      : { ok: true, value: "" };
  }
  if (typeof v !== "string") {
    return { ok: false, reason: `"${key}" must be a string` };
  }
  if (required && v.trim() === "") {
    return { ok: false, reason: `"${key}" must be non-empty` };
  }
  return { ok: true, value: v };
}

function strList(v: unknown, key: string): R<string[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    return { ok: false, reason: `"${key}" must be an array of strings` };
  }
  return { ok: true, value: v as string[] };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseEnvelope(
  raw: string,
  kind: "plan" | "wave",
): { ok: true; envelope: ExecEnvelope } | { ok: false; reason: string } {
  const parsed = parseStructured(raw, {
    required: ["decision"],
    properties: { decision: { type: "string" } },
  });
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const o = parsed.value as Record<string, unknown>;

  const allowed = kind === "plan" ? PLAN_DECISIONS : WAVE_DECISIONS;
  if (!allowed.includes(o.decision as string)) {
    return {
      ok: false,
      reason: `decision "${String(o.decision)}" is not valid for a ${kind} review (expected ${allowed.join("|")})`,
    };
  }
  if (o.doorType !== "two-way" && o.doorType !== "one-way") {
    return { ok: false, reason: `"doorType" must be two-way|one-way` };
  }
  if (
    o.confidence !== "high" &&
    o.confidence !== "medium" &&
    o.confidence !== "low"
  ) {
    return { ok: false, reason: `"confidence" must be high|medium|low` };
  }
  const rationale = str(o.rationale, "rationale", true);
  if (!rationale.ok) return rationale;
  const evidence = strList(o.evidence, "evidence");
  if (!evidence.ok) return evidence;
  const notes = strList(o.notes, "notes");
  if (!notes.ok) return notes;
  const recommendation = str(o.recommendation, "recommendation");
  if (!recommendation.ok) return recommendation;
  const undo = str(o.undo, "undo");
  if (!undo.ok) return undo;
  const oneWay = strList(o.oneWayActions, "oneWayActions");
  if (!oneWay.ok) return oneWay;
  const order = strList(o.order, "order");
  if (!order.ok) return order;

  const challenges: Challenge[] = [];
  if (o.challenges !== undefined && o.challenges !== null) {
    if (!Array.isArray(o.challenges)) {
      return { ok: false, reason: `"challenges" must be an array` };
    }
    for (const [i, c] of o.challenges.entries()) {
      if (!isObj(c)) {
        return { ok: false, reason: `challenges[${i}] must be an object` };
      }
      const text = str(c.text, `challenges[${i}].text`, true);
      if (!text.ok) return text;
      const fields: Record<string, string> = {};
      for (const k of [
        "id",
        "decisionItChanges",
        "evidenceToSettle",
        "costOfBeingWrong",
      ]) {
        const v = str(c[k], `challenges[${i}].${k}`);
        if (!v.ok) return v;
        fields[k] = v.value;
      }
      challenges.push({
        id: fields.id.trim() || `c${i + 1}`,
        text: text.value,
        decisionItChanges: fields.decisionItChanges,
        evidenceToSettle: fields.evidenceToSettle,
        costOfBeingWrong: fields.costOfBeingWrong,
      });
    }
  }

  let priorChallenges: ExecEnvelope["priorChallenges"];
  if (o.priorChallenges !== undefined && o.priorChallenges !== null) {
    if (!Array.isArray(o.priorChallenges)) {
      return { ok: false, reason: `"priorChallenges" must be an array` };
    }
    priorChallenges = [];
    for (const [i, p] of o.priorChallenges.entries()) {
      if (
        !isObj(p) ||
        typeof p.id !== "string" ||
        typeof p.closed !== "boolean" ||
        typeof p.actedOn !== "boolean"
      ) {
        return {
          ok: false,
          reason: `priorChallenges[${i}] needs string id and boolean closed/actedOn`,
        };
      }
      priorChallenges.push({
        id: p.id,
        closed: p.closed,
        actedOn: p.actedOn,
        evidence: typeof p.evidence === "string" ? p.evidence : "",
      });
    }
  }

  let proposal: ExecEnvelope["proposal"];
  if (o.proposal !== undefined && o.proposal !== null) {
    const p = o.proposal;
    if (
      !isObj(p) ||
      !["defer", "cut", "add", "goal"].includes(p.kind as string) ||
      typeof p.text !== "string" ||
      p.text.trim() === ""
    ) {
      return {
        ok: false,
        reason: `"proposal" needs kind defer|cut|add|goal and non-empty text`,
      };
    }
    proposal = {
      kind: p.kind as "defer" | "cut" | "add" | "goal",
      text: p.text,
      ...(typeof p.featureId === "string" ? { featureId: p.featureId } : {}),
    };
  }

  const action = o.recommendationAction;
  return {
    ok: true,
    envelope: {
      decision: o.decision as ExecEnvelope["decision"],
      doorType: o.doorType,
      confidence: o.confidence,
      rationale: rationale.value,
      evidence: evidence.value,
      challenges,
      notes: notes.value,
      recommendation: recommendation.value,
      // An unknown action keeps the recommendation text but offers no `accept`.
      ...(action === "approve" || action === "redirect"
        ? { recommendationAction: action }
        : {}),
      undo: undo.value,
      ...(priorChallenges ? { priorChallenges } : {}),
      ...(oneWay.value.length > 0 ? { oneWayActions: oneWay.value } : {}),
      ...(order.value.length > 0 ? { order: order.value } : {}),
      ...(proposal ? { proposal } : {}),
    },
  };
}

function mayAct(env: ExecEnvelope): boolean {
  return (
    env.confidence === "high" &&
    env.doorType === "two-way" &&
    (env.oneWayActions ?? []).length === 0 &&
    env.evidence.some(isClosedFormAnchor)
  );
}

export function normalizePlan(
  env: ExecEnvelope,
  ctx: { round: number; priorBlockingIds: string[] },
): {
  action: "approve" | "challenge" | "defer";
  challenges: Challenge[];
  notes: string[];
  demotions: string[];
  backstop: boolean;
  openPoints: string[];
} {
  const notes = [...env.notes];
  const demotions: string[] = [];
  const blocking: Challenge[] = [];
  for (const c of env.challenges) {
    const missing = (
      [
        ["decisionItChanges", c.decisionItChanges],
        ["evidenceToSettle", c.evidenceToSettle],
        ["costOfBeingWrong", c.costOfBeingWrong],
      ] as const
    )
      .filter(([, v]) => v.trim() === "")
      .map(([k]) => k);
    if (missing.length === 0) {
      blocking.push(c);
    } else {
      demotions.push(`${c.id}: missing ${missing.join(", ")}`);
      notes.push(c.text);
    }
  }

  const done = (
    action: "approve" | "challenge" | "defer",
    extra: { backstop?: boolean; openPoints?: string[] } = {},
  ) => ({
    action,
    challenges: action === "challenge" ? blocking : [],
    notes,
    demotions,
    backstop: extra.backstop ?? false,
    openPoints: extra.openPoints ?? [],
  });
  const openFrom = (): string[] => [
    ...blocking.map((c) => c.text),
    ...(env.priorChallenges ?? [])
      .filter((p) => !p.closed && ctx.priorBlockingIds.includes(p.id))
      .map((p) => `prior challenge ${p.id} still open`),
  ];

  if (env.decision === "defer") return done("defer");

  if (env.decision === "approve") {
    if (blocking.length > 0) return done("defer", { openPoints: openFrom() });
    return done(mayAct(env) ? "approve" : "defer");
  }

  // challenge
  if (blocking.length === 0) return done(mayAct(env) ? "approve" : "defer");
  if (ctx.round > MAX_CHALLENGE_ROUNDS) {
    return done("defer", { backstop: true, openPoints: openFrom() });
  }
  if (ctx.round >= 2 && ctx.priorBlockingIds.length > 0) {
    const closed = (env.priorChallenges ?? []).filter(
      (p) => p.closed && ctx.priorBlockingIds.includes(p.id),
    );
    if (closed.length === 0) return done("defer", { openPoints: openFrom() });
  }
  return done("challenge");
}

export function normalizeWave(
  env: ExecEnvelope,
  ctx: { unstartedIds: string[] },
): {
  action: "continue" | "reorder" | "propose" | "escalate";
  order?: string[];
  notes: string[];
  demotions: string[];
} {
  const notes = [...env.notes];
  const demotions: string[] = [];
  switch (env.decision) {
    case "reorder": {
      if (!mayAct(env)) {
        demotions.push("reorder: not high-confidence two-way with evidence");
        if (env.order)
          notes.push(`proposed order (not applied): ${env.order.join(", ")}`);
        return { action: "continue", notes, demotions };
      }
      const order = env.order ?? [];
      const a = [...order].sort();
      const b = [...ctx.unstartedIds].sort();
      const permutation =
        a.length === b.length && a.every((id, i) => id === b[i]);
      if (!permutation) {
        demotions.push(
          "reorder: order is not a permutation of the unstarted features",
        );
        return { action: "escalate", notes, demotions };
      }
      return { action: "reorder", order, notes, demotions };
    }
    case "propose":
      if (!env.proposal) {
        demotions.push("propose: no proposal given");
        return { action: "escalate", notes, demotions };
      }
      return { action: "propose", notes, demotions };
    case "escalate":
      return { action: "escalate", notes, demotions };
    default:
      return { action: "continue", notes, demotions };
  }
}
