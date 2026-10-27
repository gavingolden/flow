/**
 * `flow-exec-review review --kind wave` and `order`: one executive review per
 * batch of newly merged features of a granted epic. A reorder of the
 * UNSTARTED features is logged as applied (and `orderFrontier` honours it);
 * deferring, cutting, or adding a feature or changing the goal is only ever
 * proposed. This module has no manifest write path.
 */

import * as path from "node:path";
import { loadManifestFromRepo, readGrant } from "./epic-grant";
import {
  appendManagerLog,
  readManagerLog,
  type ManagerLogEntry,
} from "./epic-manager-log";
import { epicDirRelative } from "./epic-manifest-schema";
import { readEpicRunState } from "./epic-run-state";
import { readCommittedStatus } from "./epic-status-schema";
import { readCharter } from "./exec-charter";
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
  normalizeWave,
  parseEnvelope,
  type ExecEnvelope,
} from "./exec-review-envelope";
import { buildWavePacket, loadReviewPrompt } from "./exec-review-packet";
import { resolveProductBrief } from "../flow-product-brief";
import { listStates } from "./state";

export type WaveReviewResult =
  | {
      ran: false;
      skipReason: string;
      decisionId?: string;
      mergedFeatureIds?: string[];
    }
  | {
      ran: true;
      decisionId: string;
      mergedFeatureIds: string[];
      action: "continue" | "reorder" | "propose" | "escalate";
      order?: string[];
      proposal?: ExecEnvelope["proposal"];
      rationale: string;
      recommendation: string;
    };

/** Merged ids already covered: the earliest grant's baseline plus every wave decision. */
function reviewedIds(log: ManagerLogEntry[]): Set<string> {
  const done = new Set<string>();
  const firstGrant = log.find(
    (e) => e.kind === "grant" && e.exec?.baselineMerged,
  );
  for (const id of firstGrant?.exec?.baselineMerged ?? []) done.add(id);
  for (const e of log) {
    if (e.kind === "exec-decision" && e.exec?.reviewKind === "wave") {
      for (const id of e.exec.mergedFeatureIds ?? []) done.add(id);
    }
  }
  return done;
}

export function runWaveReview(
  input: { epic: string; repoRoot: string },
  deps: ExecReviewDeps,
): WaveReviewResult {
  const { epic, repoRoot } = input;
  if (!readGrant(epic, deps.stateDir)) {
    return { ran: false, skipReason: "no-grant" };
  }
  const epicDir = path.join(repoRoot, epicDirRelative(epic));
  const board = readCommittedStatus(epicDir);
  const manifest = loadManifestFromRepo(epic, repoRoot);
  if (!board || !manifest) return { ran: false, skipReason: "status-missing" };

  const log = readManagerLog(epic, deps.stateDir);
  const reviewed = reviewedIds(log);
  const mergedAll = manifest.features
    .map((f) => f.id)
    .filter((id) => board.features[id]?.status === "merged");
  const newlyMerged = mergedAll.filter((id) => !reviewed.has(id));
  if (newlyMerged.length === 0)
    return { ran: false, skipReason: "nothing-new" };

  const decisionId = makeDecisionId("wave", deps);
  const skip = (skipReason: string, cost?: number): WaveReviewResult => {
    appendManagerLog(
      epic,
      {
        ts: deps.now().toISOString(),
        kind: "exec-skip",
        reason: skipReason,
        exec: {
          decisionId,
          reviewKind: "wave",
          mergedFeatureIds: newlyMerged,
          ...(cost ? { costUsd: cost } : {}),
        },
      },
      deps.stateDir,
    );
    deps.recordEvent("exec.review", {
      kind: "wave",
      skip_reason: skipReason,
      decision_id: decisionId,
      ...(cost ? { cost_usd: cost } : {}),
    });
    return {
      ran: false,
      skipReason,
      decisionId,
      mergedFeatureIds: newlyMerged,
    };
  };

  const charter = readCharter({
    homeDir: deps.homeDir,
    readFile: deps.readFile,
  });
  if (!charter.found) {
    return skip(
      charter.reason === "too-long" ? "charter-too-long" : "charter-missing",
    );
  }

  const run = readEpicRunState(epic, deps.epicsDir);
  const launched = new Set<string>();
  for (const [id, rec] of Object.entries(run?.features ?? {})) {
    if (rec.slug || rec.external) launched.add(id);
  }
  for (const s of listStates(deps.stateDir)) {
    if (s.epic?.slug === epic) launched.add(s.epic.featureId);
  }
  const unstartedIds = manifest.features
    .filter((f) => {
      const waitFor = (f as unknown as { waitFor?: unknown }).waitFor;
      return (
        board.features[f.id]?.status !== "merged" &&
        !launched.has(f.id) &&
        (waitFor === undefined || waitFor === null || waitFor === false)
      );
    })
    .map((f) => f.id);

  let designText: string | null = null;
  try {
    designText = deps.readFile(path.join(epicDir, "design.md"));
  } catch {
    designText = null;
  }
  const brief = resolveProductBrief({
    cwd: repoRoot,
    homeDir: deps.homeDir,
    readFile: deps.readFile,
  });
  const statuses: Record<string, string> = {};
  for (const f of manifest.features) {
    statuses[f.id] =
      board.features[f.id]?.status === "merged"
        ? "merged"
        : launched.has(f.id)
          ? "in-flight"
          : "not-started";
  }
  const merged = newlyMerged.map((id) => {
    const pr = board.features[id]?.pr ?? null;
    const info = pr !== null && deps.fetchPr ? deps.fetchPr(pr) : null;
    return {
      featureId: id,
      pr,
      title:
        info?.title ?? manifest.features.find((f) => f.id === id)?.title ?? id,
      body: info?.body ?? "",
    };
  });

  let packet: string;
  try {
    packet = buildWavePacket({
      prompt: loadReviewPrompt(deps.readFile),
      charter: charter.text,
      brief: brief.found ? brief.text : null,
      designExcerpt: designExcerpt(designText),
      manifest,
      statuses,
      unstartedIds,
      merged,
      priorDecisions: log,
    });
  } catch {
    return skip("prompt-unavailable");
  }

  const { model, effort } = resolveExecModel(epic, deps);
  const scratch = deps.mkdtemp();
  let envelope: HeadlessEnvelope;
  let text: string | null = null;
  try {
    const promptPath = path.join(scratch, "prompt.md");
    const out = path.join(scratch, "result.json");
    deps.writeFile(promptPath, packet);
    envelope = deps.spawnHeadless(
      execHeadlessArgv({ promptPath, out, decisionId, model, effort }),
      { cwd: repoRoot },
    );
    if (envelope.ran === true) {
      text = readHeadlessResult(envelope, out, deps.readFile);
    }
  } finally {
    deps.removeDir(scratch);
  }
  const costUsd = envelope.total_cost_usd;
  if (envelope.ran !== true) {
    return skip(envelope.skipReason ?? "headless-error", costUsd);
  }
  const parsed = text === null ? null : parseEnvelope(text, "wave");
  if (!parsed || !parsed.ok) return skip("envelope-invalid", costUsd);
  const env = parsed.envelope;
  const norm = normalizeWave(env, { unstartedIds });

  appendManagerLog(
    epic,
    {
      ts: deps.now().toISOString(),
      kind: "exec-decision",
      exec: {
        decisionId,
        reviewKind: "wave",
        decision: env.decision,
        action: norm.action,
        doorType: env.doorType,
        confidence: env.confidence,
        rationale: env.rationale,
        recommendation: env.recommendation,
        undo: env.undo,
        mergedFeatureIds: newlyMerged,
        ...(norm.action === "reorder" && norm.order
          ? { order: norm.order }
          : {}),
        ...(norm.action === "propose" && env.proposal
          ? { proposal: env.proposal }
          : {}),
        model,
        effort,
        ...(costUsd !== undefined ? { costUsd } : {}),
      },
    },
    deps.stateDir,
  );
  deps.recordEvent("exec.review", {
    kind: "wave",
    decision_id: decisionId,
    action: norm.action,
    model,
    effort,
    ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
  });

  return {
    ran: true,
    decisionId,
    mergedFeatureIds: newlyMerged,
    action: norm.action,
    ...(norm.order ? { order: norm.order } : {}),
    ...(norm.action === "propose" && env.proposal
      ? { proposal: env.proposal }
      : {}),
    rationale: env.rationale,
    recommendation: env.recommendation,
  };
}

/**
 * Sorts a ready frontier by the newest APPLIED wave reorder. Ids the reorder
 * does not name keep the caller's (manifest) order, after the named ones.
 */
export function orderFrontier(
  epic: string,
  frontier: string[],
  stateDir?: string,
): string[] {
  const applied = readManagerLog(epic, stateDir)
    .filter(
      (e) =>
        e.kind === "exec-decision" &&
        e.exec?.reviewKind === "wave" &&
        e.exec.action === "reorder" &&
        Array.isArray(e.exec.order),
    )
    .at(-1);
  const order = applied?.exec?.order;
  if (!order) return [...frontier];
  const named = order.filter((id) => frontier.includes(id));
  const rest = frontier.filter((id) => !order.includes(id));
  return [...named, ...rest];
}
