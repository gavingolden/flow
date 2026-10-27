/**
 * Builds the bounded decision packet the executive's headless call reads: the
 * review prompt, the owner's charter, and the evidence for one plan or one
 * wave. Sections are ordered by priority; past `PACKET_CHAR_LIMIT` the LOWEST
 * priority sections are truncated first, with a visible marker. The prompt
 * (hard rules) and the charter are never cut.
 *
 * Untrusted text (plan, PR bodies, log) sits inside `<packet-section>` tags
 * whose closing tag is neutralised in the body, so it cannot restructure the
 * packet.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Neighbourhood } from "../flow-epic-judge-context";
import type { Challenge } from "./exec-review-envelope";
import type { EpicManifest } from "./epic-manifest-schema";
import type { ManagerLogEntry } from "./epic-manager-log";
import { resolveFlowSource } from "./paths";

export const PACKET_CHAR_LIMIT = 90_000;
export const CROSS_MODEL_CHAR_LIMIT = 12_000;
export const PR_BODY_CHAR_LIMIT = 4_000;
const DESIGN_CHAR_LIMIT = 20_000;
const PLAN_EXCERPT_CHAR_LIMIT = 45_000;
const BRIEF_CHAR_LIMIT = 4_000;
const PRIOR_DECISION_COUNT = 20;
const PROMPT_RELATIVE = path.join("references", "executive-review.md");

type Section = { name: string; body: string; neverCut?: boolean };

export function loadReviewPrompt(
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
): string {
  const roots = [resolveFlowSource(), path.resolve(__dirname, "..", "..")];
  let lastError: unknown;
  for (const root of roots) {
    try {
      return readFile(path.join(root, PROMPT_RELATIVE));
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `executive-review prompt not found (${PROMPT_RELATIVE}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function clip(text: string, limit: number, label: string): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n… [${label} truncated at ${limit} chars]`;
}

function neutralise(body: string): string {
  return body.replace(/<\s*(\/?)\s*packet-section/gi, "<\\$1packet-section");
}

function render(s: Section): string {
  return `<packet-section name="${s.name}">\n${neutralise(s.body).trim()}\n</packet-section>`;
}

/** Truncate from the END of the list (lowest priority) until the packet fits. */
function assemble(sections: Section[], limit = PACKET_CHAR_LIMIT): string {
  const work = sections.map((s) => ({ ...s }));
  const size = () => work.reduce((n, s) => n + render(s).length + 2, 0);
  let excess = size() - limit;
  for (let i = work.length - 1; i >= 0 && excess > 0; i--) {
    const s = work[i];
    if (s.neverCut) continue;
    const marker = `\n… [section truncated to fit the ${limit}-char packet limit]`;
    if (s.body.length <= marker.length) continue;
    const cut = Math.min(excess + marker.length, s.body.length);
    const before = render(s).length;
    s.body = s.body.slice(0, s.body.length - cut) + marker;
    excess -= before - render(s).length;
  }
  return work.map(render).join("\n\n");
}

function sectionByHeading(text: string, name: string): string | null {
  const m = new RegExp(
    `^#{1,2} ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "m",
  ).exec(text);
  if (!m) return null;
  const rest = text.slice(m.index);
  const afterHeading = rest.slice(m[0].length);
  const next = /^#{1,2} /m.exec(afterHeading);
  return rest
    .slice(0, m[0].length + (next ? next.index : afterHeading.length))
    .trimEnd();
}

const PLAN_EXCERPT_SECTIONS = [
  "Problem Statement",
  "Request vetting",
  "Epic context",
  "Scope Boundary",
  "Open Questions",
  "Decision analysis",
  "Recommendation",
  "Plan risks",
  "Cut list",
  "Candidate follow-up issues",
];

function planExcerpt(planText: string): string {
  const parts: string[] = [];
  const goal = /^\*\*Goal:\*\*.*$/m.exec(planText);
  if (goal) parts.push(goal[0]);
  for (const name of PLAN_EXCERPT_SECTIONS) {
    const s = sectionByHeading(planText, name);
    if (s) parts.push(s);
  }
  const titles = [...planText.matchAll(/^### Task \d+:.*$/gm)].map((m) => m[0]);
  if (titles.length > 0) parts.push(`## Task titles\n\n${titles.join("\n")}`);
  return clip(parts.join("\n\n"), PLAN_EXCERPT_CHAR_LIMIT, "plan excerpt");
}

function renderDecisions(entries: ManagerLogEntry[]): string {
  const rows = entries
    .filter((e) => e.kind === "exec-decision")
    .slice(-PRIOR_DECISION_COUNT)
    .map((e) => {
      const x = e.exec;
      return `- ${e.ts} ${e.slug ?? e.featureId ?? "epic"} ${x?.reviewKind ?? ""} ${x?.action ?? x?.decision ?? ""} (${x?.confidence ?? "?"}, ${x?.doorType ?? "?"}): ${(x?.rationale ?? e.reason ?? "").slice(0, 300)}`;
    });
  return rows.length > 0 ? rows.join("\n") : "(no prior executive decisions)";
}

function renderChallenges(challenges: Challenge[]): string {
  if (challenges.length === 0) return "(none: this is the first review)";
  return [
    "Report each of these in `priorChallenges` (closed? actedOn?):",
    ...challenges.map(
      (c) =>
        `- ${c.id}: ${c.text}\n  changes: ${c.decisionItChanges}\n  settles: ${c.evidenceToSettle}\n  cost: ${c.costOfBeingWrong}`,
    ),
  ].join("\n");
}

export function buildPlanPacket(input: {
  prompt: string;
  charter: string;
  brief: string | null;
  designExcerpt: string;
  neighbourhood: Neighbourhood;
  siblings: Array<{
    featureId: string;
    slug: string;
    phase: string;
    pr: number | null;
  }>;
  priorDecisions: ManagerLogEntry[];
  priorChallenges: Challenge[];
  planText: string;
  planReview: string | null;
  worktree: string;
  round: number;
}): string {
  const sections: Section[] = [
    { name: "review-prompt", body: input.prompt, neverCut: true },
    { name: "task", body: `kind: plan\nround: ${input.round}`, neverCut: true },
    { name: "charter", body: input.charter, neverCut: true },
    {
      name: "product-brief",
      body: clip(
        input.brief ?? "(no product brief)",
        BRIEF_CHAR_LIMIT,
        "brief",
      ),
    },
    {
      name: "epic-goal-and-design",
      body: clip(input.designExcerpt, DESIGN_CHAR_LIMIT, "design excerpt"),
    },
    {
      name: "manifest-neighbourhood",
      body: JSON.stringify(input.neighbourhood, null, 2),
    },
    {
      name: "sibling-pipelines",
      body:
        input.siblings.length > 0
          ? input.siblings
              .map(
                (s) =>
                  `- ${s.featureId} (${s.slug}) phase=${s.phase} pr=${s.pr ?? "none"}`,
              )
              .join("\n")
          : "(no sibling pipelines)",
    },
    { name: "prior-decisions", body: renderDecisions(input.priorDecisions) },
    { name: "prior-challenges", body: renderChallenges(input.priorChallenges) },
    { name: "plan", body: planExcerpt(input.planText) },
    {
      name: "cross-model-review",
      body: clip(
        input.planReview ?? "(the cross-model review text is not available)",
        CROSS_MODEL_CHAR_LIMIT,
        "cross-model review",
      ),
    },
    {
      name: "readable-files",
      body: [
        "You may Read these in your working directory for full text:",
        `- ${path.join(input.worktree, ".flow-tmp", "plan.md")}`,
        `- ${path.join(input.worktree, ".flow-tmp", "plan-review.md")}`,
        `- ${path.join(input.worktree, ".flow-tmp", "product-critique.md")}`,
      ].join("\n"),
      neverCut: true,
    },
  ];
  return `${assemble(sections)}\n\nReply with the JSON object only.\n`;
}

export function buildWavePacket(input: {
  prompt: string;
  charter: string;
  brief: string | null;
  designExcerpt: string;
  manifest: EpicManifest;
  statuses: Record<string, string>;
  unstartedIds: string[];
  merged: Array<{
    featureId: string;
    pr: number | null;
    title: string;
    body: string;
  }>;
  priorDecisions: ManagerLogEntry[];
}): string {
  const features = input.manifest.features
    .map(
      (f) =>
        `- ${f.id} [${input.statuses[f.id] ?? "unknown"}] ${f.title} (dependsOn: ${f.dependsOn.join(", ") || "none"})`,
    )
    .join("\n");
  const merged = input.merged
    .map(
      (m) =>
        `### ${m.featureId} — PR ${m.pr ?? "?"}: ${m.title}\n\n${clip(m.body, PR_BODY_CHAR_LIMIT, "PR body")}`,
    )
    .join("\n\n");
  const sections: Section[] = [
    { name: "review-prompt", body: input.prompt, neverCut: true },
    {
      name: "task",
      body: `kind: wave\nunstarted feature ids (the only ids a reorder may contain): ${input.unstartedIds.join(", ") || "(none)"}`,
      neverCut: true,
    },
    { name: "charter", body: input.charter, neverCut: true },
    {
      name: "product-brief",
      body: clip(
        input.brief ?? "(no product brief)",
        BRIEF_CHAR_LIMIT,
        "brief",
      ),
    },
    {
      name: "epic-goal-and-design",
      body: clip(input.designExcerpt, DESIGN_CHAR_LIMIT, "design excerpt"),
    },
    { name: "features-and-statuses", body: features },
    { name: "prior-decisions", body: renderDecisions(input.priorDecisions) },
    { name: "newly-merged", body: merged || "(none)" },
  ];
  return `${assemble(sections)}\n\nReply with the JSON object only.\n`;
}
