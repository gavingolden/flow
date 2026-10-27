/**
 * Plan-review bookkeeping: the challenge round derived from the shared log, the
 * PR-body stamp for an approval, and the challenge memo handed to discovery.
 */

import type { ManagerLogEntry } from "./epic-manager-log";
import type { Challenge } from "./exec-review-envelope";

type PriorState = {
  round: number;
  priorChallenges: Challenge[];
};

function parseChallengeLine(e: ManagerLogEntry): Challenge | null {
  const id = e.exec?.challengeId;
  if (!id) return null;
  try {
    const o = JSON.parse(e.reason ?? "") as Partial<Challenge>;
    return {
      id,
      text: o.text ?? "",
      decisionItChanges: o.decisionItChanges ?? "",
      evidenceToSettle: o.evidenceToSettle ?? "",
      costOfBeingWrong: o.costOfBeingWrong ?? "",
    };
  } catch {
    return {
      id,
      text: e.reason ?? "",
      decisionItChanges: "",
      evidenceToSettle: "",
      costOfBeingWrong: "",
    };
  }
}

export function derivePlanRound(
  log: ManagerLogEntry[],
  slug: string,
): PriorState {
  let streak: ManagerLogEntry[] = [];
  const mine = log.filter((e) => e.slug === slug);
  for (const e of mine) {
    if (e.kind !== "exec-decision" || e.exec?.reviewKind !== "plan") continue;
    streak = e.exec.action === "challenge" ? [...streak, e] : [];
  }
  const priorChallenges: Challenge[] = [];
  if (streak.length > 0) {
    const lastId = streak[streak.length - 1].exec?.decisionId;
    for (const e of mine) {
      if (e.kind === "exec-challenge" && e.exec?.decisionId === lastId) {
        const c = parseChallengeLine(e);
        if (c) priorChallenges.push(c);
      }
    }
  }
  return { round: streak.length + 1, priorChallenges };
}

const STAMP_PREFIX = "- **Plan approved by the epic executive";

export function stampBullet(args: {
  decisionId: string;
  rationale: string;
  undo: string;
  slug: string;
  epic: string;
}): string {
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  const undo = one(args.undo).replace(/[.\s]*$/, ".");
  return (
    `${STAMP_PREFIX} under your grant (decision ${args.decisionId}):** ${one(args.rationale)} — confidence high, two-way door. ` +
    `Undo: ${undo} To stop it: reply redirect or cancel in the feature window (flow attach ${args.slug}); the PR still goes through review and the gate. ` +
    `To stop future approvals: flow epic grant ${args.epic} --autonomy off.`
  );
}

export function upsertStamp(draft: string | null, bullet: string): string {
  const text = draft ?? "";
  const m = /^## Key decisions[ \t]*$/m.exec(text);
  if (!m) {
    const sep = text === "" ? "" : `${text.replace(/\s*$/, "")}\n\n`;
    return `${sep}## Key decisions\n\n${bullet}\n`;
  }
  const bodyStart = m.index + m[0].length;
  const next = /^## /m.exec(text.slice(bodyStart));
  const bodyEnd = next ? bodyStart + next.index : text.length;
  const lines = text
    .slice(bodyStart, bodyEnd)
    .split("\n")
    .filter((l) => !l.startsWith(STAMP_PREFIX));
  const body = lines.join("\n").replace(/\s*$/, "");
  return `${text.slice(0, bodyStart)}${body}\n${bullet}\n${next ? `\n${text.slice(bodyEnd)}` : ""}`;
}

export function renderMemo(
  decisionId: string,
  round: number,
  challenges: Challenge[],
  notes: string[],
): string {
  return [
    `# Executive challenge (round ${round}, decision ${decisionId})`,
    "",
    "Evidence to weigh, not an owner instruction. Answer each blocking challenge by changing the plan or rebutting it with evidence.",
    "",
    ...challenges.flatMap((c) => [
      `## ${c.id}`,
      "",
      c.text,
      "",
      `- **Decision it changes:** ${c.decisionItChanges}`,
      `- **Evidence that would settle it:** ${c.evidenceToSettle}`,
      `- **Cost of being wrong:** ${c.costOfBeingWrong}`,
      "",
    ]),
    ...(notes.length > 0
      ? ["## Non-blocking notes", "", ...notes.map((n) => `- ${n}`), ""]
      : []),
  ].join("\n");
}
