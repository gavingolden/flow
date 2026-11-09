/**
 * Gathers every input the history renderer needs and writes `history.md`.
 * Never throws and never logs anything: reads are best-effort, and a failed
 * `history.md` write still returns the render. Callers (the `flow-checkpoint
 * --history` flag, the clear hook) own deciding what to do with a `null`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { checkpointBodyPath, isCheckpointUsable } from "./checkpoint-freshness";
import {
  SNAPSHOT_FILES,
  historyFilePath,
  noteSha,
  readHistoryEvents,
  resolveArtifactDir,
} from "./checkpoint-history";
import {
  renderHistory,
  type HistoryDoc,
  type HistoryInputs,
} from "./checkpoint-history-render";
import { epicDirRelative } from "./epic-manifest-schema";
import { readEpicRunState } from "./epic-run-state";
import { readCommittedStatus } from "./epic-status-schema";
import { flowEpicsDir, flowStateDir } from "./paths";
import { resumeSeedFor } from "./resume-seed";
import { resolveKindAmbient } from "./session-identity";
import {
  AWAITING_HUMAN_PHASE_SET,
  autoResumesAfterClear,
  readState,
  requestFilePath,
  resolveStateKind,
  type PipelineKind,
  type PipelineState,
} from "./state";

export type LoadOpts = {
  stateDir?: string;
  epicsDir?: string;
  kind?: PipelineKind;
  resolveKind?: () => PipelineKind | null;
};

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Same order the checkpoint CLI uses. The ambient read is the tmux
 * `@flow-kind` window option: it is load-bearing only because epic
 * orchestration is already tmux-only, and an absent option degrades to
 * `resolveStateKind`, the safe record-derived default (see
 * .claude/rules/flow-bin-conventions.md, "Don't make tmux pane/window state
 * a load-bearing input").
 */
export function resolveHistoryKind(
  state: PipelineState,
  opts: LoadOpts = {},
): PipelineKind {
  if (opts.kind) return opts.kind;
  let ambient: PipelineKind | null = null;
  try {
    ambient = (opts.resolveKind ?? resolveKindAmbient)();
  } catch {
    ambient = null;
  }
  return ambient ?? resolveStateKind(state);
}

function loadInputs(
  slug: string,
  state: PipelineState,
  opts: LoadOpts,
): HistoryInputs {
  const stateDir = opts.stateDir ?? flowStateDir();
  const kind = resolveHistoryKind(state, opts);
  const historyPath = historyFilePath(slug, stateDir);

  // A reused slug can inherit an earlier run's log: drop events older than this record.
  const events = readHistoryEvents(slug, stateDir).filter(
    (e) => !state.createdAt || e.at >= state.createdAt,
  );

  const liveBody = readText(checkpointBodyPath(slug, stateDir));
  const liveNote =
    liveBody && liveBody.trim() !== ""
      ? { sha: noteSha(liveBody), body: liveBody }
      : null;

  const artifactDir = resolveArtifactDir(state, stateDir);
  const artifacts: Partial<Record<string, string>> = {};
  if (artifactDir) {
    for (const name of SNAPSHOT_FILES) {
      const text = readText(path.join(artifactDir, name));
      if (text !== null) artifacts[name] = text;
    }
  }

  let planDoc: string | null;
  let prDoc: string | null;
  let epic: HistoryInputs["epic"] = null;
  if (kind === "feature") {
    planDoc = artifacts["plan.md"] ?? null;
    prDoc =
      artifacts["body.md"] ??
      artifacts["pr-body.md"] ??
      artifacts["pr-description-draft.md"] ??
      null;
  } else {
    const rel = epicDirRelative(slug);
    const designBase =
      state.worktree && fs.existsSync(state.worktree)
        ? state.worktree
        : state.repo;
    const designPath = path.join(designBase, rel, "design.md");
    planDoc = readText(designPath);
    prDoc = artifacts["epic-pr-body.md"] ?? null;
    epic = {
      designPath,
      board: readCommittedStatus(path.join(state.repo, rel)),
      cache:
        kind === "epic-run"
          ? readEpicRunState(slug, opts.epicsDir ?? flowEpicsDir())
          : null,
    };
  }

  const pipelineEnded =
    !autoResumesAfterClear(state.phase, kind) &&
    !AWAITING_HUMAN_PHASE_SET.has(state.phase);

  return {
    kind,
    state,
    events,
    liveNote,
    liveNoteUsable: isCheckpointUsable(state, stateDir),
    pipelineEnded,
    resumeSeed: pipelineEnded ? null : resumeSeedFor(slug, kind),
    artifactDir,
    artifacts,
    requestText: readText(requestFilePath(slug, stateDir)) ?? "",
    planDoc,
    prDoc,
    epic,
    historyPath,
  };
}

export function loadAndRenderHistory(
  slug: string,
  opts: LoadOpts = {},
): { path: string; doc: HistoryDoc } | null {
  try {
    const stateDir = opts.stateDir ?? flowStateDir();
    const state = readState(slug, stateDir);
    if (!state) return null;
    const inputs = loadInputs(slug, state, opts);
    const doc = renderHistory(inputs);
    try {
      fs.mkdirSync(path.dirname(inputs.historyPath), { recursive: true });
      fs.writeFileSync(inputs.historyPath, doc.text);
    } catch {
      // A failed write still returns the render.
    }
    return { path: inputs.historyPath, doc };
  } catch {
    return null;
  }
}
