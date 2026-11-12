/**
 * `flow-exec-review review --kind plan`: orchestrate one executive review of a
 * granted pipeline's plan (an epic feature or a loose pipeline). A grant and
 * the charter gate the work;
 * mechanical preconditions run before any spend; one budget-capped headless
 * call returns an envelope that `exec-review-envelope.ts` normalizes into
 * approve / challenge / defer. Every outcome is logged to the manager log;
 * an approval also stamps the draft PR body.
 */

import * as path from "node:path";
import { manifestNeighbourhood } from "../flow-epic-judge-context";
import { resolveProductBrief } from "../flow-product-brief";
import { grantForSlug } from "./manager-grants";
import { alertBudgetOnce, budgetReached } from "./manager-spend";
import {
  appendManagerLog,
  readManagerLog,
  type ExecLogPayload,
  type ManagerLogEntry,
} from "./manager-log";
import { readNotes, type ManagerNote } from "./manager-notes";
import { identityForState, repoNameForPath } from "./manager-scope";
import { enteredAt } from "./manager-wait";
import { epicDirRelative, loadManifestFromRepo } from "./epic-manifest-schema";
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
import {
  FINISHED_PHASE_SET,
  listStates,
  readState,
  type PipelineState,
} from "./state";

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

const MAX_PACKET_NOTES = 10;

/**
 * The note lines for the packet: live notes naming this pipeline (any author),
 * newest last.
 */
function packetNotes(notes: ManagerNote[], slug: string): string[] {
  return notes
    .filter((n) => n.about.includes(slug))
    .slice(-MAX_PACKET_NOTES)
    .map(
      (n) => `- ${n.ts} (by ${n.author ?? "unknown"}) ${n.text.slice(0, 300)}`,
    );
}

/**
 * Has anything outside the manager happened since the executive last looked at
 * this pipeline's plan in the current phase entry? Only a note written by
 * another session (never the manager, never the pipeline itself; author-less
 * legacy notes do not count) that names this pipeline or a sibling, or a
 * sibling's own state transition, opens the gate. A prior hard-precondition
 * skip or one-way-door decision keeps it shut: more context cannot change
 * those.
 */
function noNewEvidence(a: {
  slug: string;
  phaseEnteredAt: string;
  log: ManagerLogEntry[];
  notes: ManagerNote[];
  siblings: PipelineState[];
}): boolean {
  const since = Date.parse(a.phaseEnteredAt);
  const prior = a.log
    .filter(
      (e) =>
        e.slug === a.slug &&
        (e.kind === "exec-decision" || e.kind === "exec-skip") &&
        e.exec?.reviewKind === "plan" &&
        e.reason !== "no-new-evidence" &&
        e.reason !== "daily-budget-reached" &&
        Date.parse(e.ts) >= since,
    )
    .at(-1);
  if (!prior) return false;
  if (
    prior.reason === "precondition-failed" ||
    prior.exec?.doorType === "one-way"
  ) {
    return true;
  }
  const after = Date.parse(prior.ts);
  const named = new Set([a.slug, ...a.siblings.map((s) => s.slug)]);
  const noteOpens = a.notes.some(
    (n) =>
      n.author !== undefined &&
      n.author !== "manager" &&
      n.author !== a.slug &&
      Date.parse(n.ts) > after &&
      n.about.some((x) => named.has(x)),
  );
  const siblingMoved = a.siblings.some((s) => Date.parse(enteredAt(s)) > after);
  return !(noteOpens || siblingMoved);
}

export function runPlanReview(
  input: { slug: string; epic?: string; contextText?: string },
  deps: ExecReviewDeps,
): PlanReviewResult {
  const decisionId = makeDecisionId("plan", deps);
  const state = readState(input.slug, deps.stateDir);
  const epic = state?.epic?.slug;
  const repo = state ? repoNameForPath(state.repo) : "unknown";
  const who = { ...(epic ? { epic } : {}), repo };
  const skip = (
    skipReason: string,
    extra: { failedPrecondition?: PreconditionId; detail?: string } = {},
    log = true,
    cost?: number,
    round?: number,
  ): PlanReviewResult => {
    if (log) {
      appendManagerLog(
        {
          ts: deps.now().toISOString(),
          kind: "exec-skip",
          ...who,
          slug: input.slug,
          reason: skipReason,
          exec: {
            decisionId,
            reviewKind: "plan",
            round,
            ...(cost ? { costUsd: cost } : {}),
          },
        },
        { home: deps.managerHome },
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

  const scope = grantForSlug(input.slug, {
    stateDir: deps.stateDir,
    home: deps.managerHome,
    now: deps.now,
    expectedEpic: input.epic,
  });
  if (!scope.granted) return skip(scope.reason, {}, false);
  if (!scope.classes.includes("plan")) return skip("no-grant", {}, false);

  const log = readManagerLog(epic ? { epic } : { repo }, deps.managerHome);
  const siblingStates = listStates(deps.stateDir).filter((s) =>
    s.slug === input.slug
      ? false
      : epic
        ? s.epic?.slug === epic
        : !FINISHED_PHASE_SET.has(s.phase) && identityForState(s).repo === repo,
  );
  const notes = readNotes(deps.managerHome);
  if (
    input.contextText !== undefined &&
    state &&
    noNewEvidence({
      slug: input.slug,
      phaseEnteredAt: enteredAt(state),
      log,
      notes,
      siblings: siblingStates,
    })
  ) {
    return skip("no-new-evidence");
  }

  if (
    budgetReached(deps.now(), { read: deps.readConfig, home: deps.managerHome })
      .reached
  ) {
    alertBudgetOnce(deps.now(), deps.notify, deps.managerHome, deps.readConfig);
    return skip("daily-budget-reached");
  }

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

  const { round, priorChallenges } = derivePlanRound(log, input.slug);
  const priorBlockingIds = priorChallenges.map((c) => c.id);

  let manifest: ReturnType<typeof loadManifestFromRepo> = null;
  let designText: string | null = null;
  if (epic) {
    manifest = loadManifestFromRepo(epic, worktree);
    if (!manifest)
      return skip("plan-unreadable", { detail: "epic manifest not found" });
    try {
      designText = deps.readFile(
        path.join(worktree, epicDirRelative(epic), "design.md"),
      );
    } catch {
      designText = null;
    }
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

  const siblings = siblingStates.map((s) => ({
    featureId: s.epic?.featureId ?? "loose",
    slug: s.slug,
    phase: s.phase,
    pr: s.pr ?? null,
  }));

  const epicCtx =
    manifest && scope.featureId
      ? { manifest, featureId: scope.featureId }
      : null;

  let packet: string;
  try {
    packet = buildPlanPacket({
      prompt: loadReviewPrompt(deps.readFile),
      charter: charter.text,
      brief: brief.found ? brief.text : null,
      designExcerpt: epicCtx
        ? designExcerpt(designText, epicCtx.featureId)
        : null,
      neighbourhood: epicCtx
        ? manifestNeighbourhood(epicCtx.manifest, epicCtx.featureId)
        : null,
      siblings,
      priorDecisions: log,
      priorChallenges,
      planText,
      planReview,
      worktree,
      round,
      notes: packetNotes(notes, input.slug),
      ...(input.contextText ? { managerContext: input.contextText } : {}),
    });
  } catch (e) {
    return skip("prompt-unavailable", {
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const { model, effort } = resolveExecModel(epic, deps);
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
  const line = (e: Omit<ManagerLogEntry, "repo">) =>
    appendManagerLog({ ...who, ...e }, { home: deps.managerHome });

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
    ...(scope.featureId ? { featureId: scope.featureId } : {}),
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
  if (norm.action === "approve" && input.contextText === undefined) {
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
          scope: scope.scope,
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
