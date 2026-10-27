/**
 * `flow-exec-review review --kind plan`: orchestrate one executive review of a
 * granted epic feature's plan. Grant scope and the charter gate the work;
 * mechanical preconditions run before any spend; one budget-capped headless
 * call returns an envelope that `exec-review-envelope.ts` normalizes into
 * approve / challenge / defer. Every outcome is logged to the shared epic log;
 * an approval also stamps the draft PR body.
 */

import * as path from "node:path";
import { manifestNeighbourhood } from "../flow-epic-judge-context";
import { resolveProductBrief } from "../flow-product-brief";
import { grantScopeForSlug, loadManifestFromRepo } from "./epic-grant";
import {
  appendManagerLog,
  readManagerLog,
  type ExecLogPayload,
  type ManagerLogEntry,
} from "./epic-manager-log";
import { epicDirRelative } from "./epic-manifest-schema";
import { readCharter } from "./exec-charter";
import {
  normalizePlan,
  parseEnvelope,
  type Challenge,
} from "./exec-review-envelope";
import { buildPlanPacket, loadReviewPrompt } from "./exec-review-packet";
import {
  checkPlanPreconditions,
  evidenceAnchorResolves,
  type PreconditionId,
} from "./exec-review-preconditions";
import {
  derivePlanRound,
  renderMemo,
  stampBullet,
  upsertStamp,
} from "./exec-review-record";
import {
  designExcerpt,
  execHeadlessArgv,
  makeDecisionId,
  readHeadlessResult,
  resolveExecModel,
  type ExecReviewDeps,
  type HeadlessEnvelope,
} from "./exec-review-shared";
import {
  skipTextFor,
  UNANCHORED_APPROVE_DEFER_TEXT,
} from "./exec-review-skip-text";
import { listStates, readState } from "./state";

export type PlanReviewResult =
  | {
      ran: true;
      decisionId: string;
      kind: "plan";
      round: number;
      action: "approve" | "challenge" | "defer";
      doorType: string;
      confidence: string;
      rationale: string;
      recommendation: string;
      recommendationAction?: "approve" | "redirect";
      challenges: Challenge[];
      notes: string[];
      demotions: string[];
      backstop: boolean;
      deferText?: string;
      memoPath?: string;
      disclosure?: string;
      costUsd?: number;
    }
  | {
      ran: false;
      decisionId: string;
      kind: "plan";
      skipReason: string;
      skipText: string;
      failedPrecondition?: PreconditionId;
      detail?: string;
    };

export function runPlanReview(
  input: { slug: string; epic: string },
  deps: ExecReviewDeps,
): PlanReviewResult {
  const decisionId = makeDecisionId("plan", deps);
  const skip = (
    skipReason: string,
    extra: { failedPrecondition?: PreconditionId; detail?: string } = {},
    log = true,
    cost?: number,
    round?: number,
  ): PlanReviewResult => {
    if (log) {
      appendManagerLog(
        input.epic,
        {
          ts: deps.now().toISOString(),
          kind: "exec-skip",
          slug: input.slug,
          reason: skipReason,
          exec: {
            decisionId,
            reviewKind: "plan",
            round,
            ...(cost ? { costUsd: cost } : {}),
          },
        },
        deps.stateDir,
      );
      deps.recordEvent("exec.review", {
        kind: "plan",
        skip_reason: skipReason,
        decision_id: decisionId,
        ...(extra.failedPrecondition
          ? { precondition: extra.failedPrecondition }
          : {}),
        ...(cost ? { cost_usd: cost } : {}),
      });
    }
    return {
      ran: false,
      decisionId,
      kind: "plan",
      skipReason,
      skipText: skipTextFor(skipReason, extra.failedPrecondition),
      ...extra,
    };
  };

  const scope = grantScopeForSlug(input.slug, {
    stateDir: deps.stateDir,
    expectedEpic: input.epic,
  });
  if (!scope.granted) return skip(scope.reason, {}, false);

  const state = readState(input.slug, deps.stateDir);
  const worktree = state?.worktree;
  if (!worktree)
    return skip("plan-unreadable", { detail: "no worktree in state" });

  const charter = readCharter({
    homeDir: deps.homeDir,
    readFile: deps.readFile,
  });
  if (!charter.found) {
    return skip(
      charter.reason === "too-long" ? "charter-too-long" : "charter-missing",
      { detail: charter.path },
    );
  }

  const flowTmp = path.join(worktree, ".flow-tmp");
  let planText: string;
  try {
    planText = deps.readFile(path.join(flowTmp, "plan.md"));
  } catch {
    return skip("plan-unreadable", { detail: path.join(flowTmp, "plan.md") });
  }
  let runRecordText: string | null = null;
  try {
    runRecordText = deps.readFile(
      path.join(flowTmp, "plan-review.md.run.json"),
    );
  } catch {
    runRecordText = null;
  }

  const pre = checkPlanPreconditions(
    { planText, runRecordText, worktree },
    deps.preconditions,
  );
  if (!pre.ok) {
    return skip("precondition-failed", {
      failedPrecondition: pre.failed,
      detail: pre.detail,
    });
  }

  const log = readManagerLog(input.epic, deps.stateDir);
  const { round, priorChallenges } = derivePlanRound(log, input.slug);
  const priorBlockingIds = priorChallenges.map((c) => c.id);

  const manifest = loadManifestFromRepo(input.epic, worktree);
  if (!manifest)
    return skip("plan-unreadable", { detail: "epic manifest not found" });
  let designText: string | null = null;
  try {
    designText = deps.readFile(
      path.join(worktree, epicDirRelative(input.epic), "design.md"),
    );
  } catch {
    designText = null;
  }
  const brief = resolveProductBrief({
    cwd: worktree,
    homeDir: deps.homeDir,
    readFile: deps.readFile,
  });
  let planReview: string | null = null;
  try {
    planReview = deps.readFile(path.join(flowTmp, "plan-review.md"));
  } catch {
    planReview = null;
  }

  const siblings = listStates(deps.stateDir)
    .filter((s) => s.epic?.slug === input.epic && s.slug !== input.slug)
    .map((s) => ({
      featureId: s.epic?.featureId ?? "?",
      slug: s.slug,
      phase: s.phase,
      pr: s.pr ?? null,
    }));

  let packet: string;
  try {
    packet = buildPlanPacket({
      prompt: loadReviewPrompt(deps.readFile),
      charter: charter.text,
      brief: brief.found ? brief.text : null,
      designExcerpt: designExcerpt(designText, scope.featureId),
      neighbourhood: manifestNeighbourhood(manifest, scope.featureId),
      siblings,
      priorDecisions: log,
      priorChallenges,
      planText,
      planReview,
      worktree,
      round,
    });
  } catch (e) {
    return skip("prompt-unavailable", {
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const { model, effort } = resolveExecModel(input.epic, deps);
  const out = path.join(flowTmp, `exec-review-${decisionId}.json`);
  const scratch = deps.mkdtemp();
  let envelope: HeadlessEnvelope;
  try {
    const promptPath = path.join(scratch, "prompt.md");
    deps.writeFile(promptPath, packet);
    envelope = deps.spawnHeadless(
      execHeadlessArgv({ promptPath, out, decisionId, model, effort }),
      { cwd: worktree },
    );
  } finally {
    deps.removeDir(scratch);
  }
  const costUsd = envelope.total_cost_usd;
  if (envelope.ran !== true) {
    return skip(
      envelope.skipReason ?? "headless-error",
      {},
      true,
      costUsd,
      round,
    );
  }
  const text = readHeadlessResult(envelope, out, deps.readFile);
  const parsed = text === null ? null : parseEnvelope(text, "plan");
  if (!parsed || !parsed.ok) {
    return skip(
      "envelope-invalid",
      {
        detail: parsed
          ? parsed.reason
          : "no result text in the headless artifact",
      },
      true,
      costUsd,
      round,
    );
  }
  const env = parsed.envelope;
  let norm = normalizePlan(env, { round, priorBlockingIds });
  let deferText: string | undefined;
  if (
    norm.action === "approve" &&
    !evidenceAnchorResolves(env.evidence, worktree, deps.preconditions)
  ) {
    norm = {
      ...norm,
      action: "defer",
      demotions: [
        ...norm.demotions,
        "approve: no evidence anchor resolves to a real worktree file and line",
      ],
    };
    deferText = UNANCHORED_APPROVE_DEFER_TEXT;
  }
  const ts = deps.now().toISOString();
  const base = { decisionId, reviewKind: "plan" as const, round };
  const line = (e: ManagerLogEntry) =>
    appendManagerLog(input.epic, e, deps.stateDir);

  for (const p of env.priorChallenges ?? []) {
    if (!priorBlockingIds.includes(p.id)) continue;
    line({
      ts,
      kind: "exec-challenge-outcome",
      slug: input.slug,
      exec: {
        ...base,
        challengeId: p.id,
        closed: p.closed,
        actedOn: p.actedOn,
      },
    });
  }

  const payload: ExecLogPayload = {
    ...base,
    decision: env.decision,
    action: norm.action,
    doorType: env.doorType,
    confidence: env.confidence,
    rationale: env.rationale,
    recommendation: env.recommendation,
    ...(env.recommendationAction
      ? { recommendationAction: env.recommendationAction }
      : {}),
    undo: env.undo,
    model,
    effort,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(norm.backstop ? { backstop: true } : {}),
  };
  line({
    ts,
    kind: "exec-decision",
    slug: input.slug,
    featureId: scope.featureId,
    exec: payload,
  });

  let memoPath: string | undefined;
  if (norm.action === "challenge") {
    for (const c of norm.challenges) {
      line({
        ts,
        kind: "exec-challenge",
        slug: input.slug,
        reason: JSON.stringify({
          text: c.text,
          decisionItChanges: c.decisionItChanges,
          evidenceToSettle: c.evidenceToSettle,
          costOfBeingWrong: c.costOfBeingWrong,
        }),
        exec: { ...base, challengeId: c.id },
      });
    }
    memoPath = path.join(flowTmp, `exec-challenge-${decisionId}.md`);
    deps.writeFile(
      memoPath,
      renderMemo(decisionId, round, norm.challenges, norm.notes),
    );
  }

  let disclosure: string | undefined;
  if (norm.action === "approve") {
    const draftPath = path.join(flowTmp, "pr-description-draft.md");
    let draft: string | null = null;
    try {
      draft = deps.readFile(draftPath);
    } catch {
      draft = null;
    }
    deps.writeFile(
      draftPath,
      upsertStamp(
        draft,
        stampBullet({
          decisionId,
          rationale: env.rationale,
          undo: env.undo,
          slug: input.slug,
          epic: input.epic,
        }),
      ),
    );
    disclosure = `Approved by the epic executive under your grant (decision ${decisionId})`;
  }

  deps.recordEvent("exec.review", {
    kind: "plan",
    decision_id: decisionId,
    action: norm.action,
    round,
    model,
    effort,
    ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
    ...(norm.backstop ? { backstop: true } : {}),
  });

  return {
    ran: true,
    decisionId,
    kind: "plan",
    round,
    action: norm.action,
    doorType: env.doorType,
    confidence: env.confidence,
    rationale: env.rationale,
    recommendation: env.recommendation,
    ...(env.recommendationAction
      ? { recommendationAction: env.recommendationAction }
      : {}),
    challenges: norm.challenges,
    notes: norm.notes,
    demotions: norm.demotions,
    backstop: norm.backstop,
    ...(deferText ? { deferText } : {}),
    ...(memoPath ? { memoPath } : {}),
    ...(disclosure ? { disclosure } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}
