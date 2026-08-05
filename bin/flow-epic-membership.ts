#!/usr/bin/env bun
/**
 * `flow-epic-membership --slug <feature-slug> --terminal-state <state>`
 *
 * LLM-free helper: when a finished feature belongs to an epic
 * (`state.epic.slug` set by `flow epic launch`), reconcile the owning epic
 * against live feature state and print a membership header, a status board,
 * and a state-aware next-phase footer. Non-epic features print nothing —
 * this is called unconditionally at every `/flow-pipeline` terminal-state
 * render site.
 *
 * NEVER emits a `flow-stop-guard` sentinel (`MERGED`, `GATED:`,
 * `NEEDS HUMAN:`, `cancelled`) — that sentinel is owned solely by
 * `flow-gate-summary`'s byte-exact final stdout line.
 */

import * as path from "node:path";
import { readState } from "./lib/state";
import { readEpicRunState, type EpicRunState } from "./lib/epic-run-state";
import { reconcile } from "./lib/epic-reconcile";
import type { ReconcileResult } from "./lib/epic-reconcile";
import { renderBoard } from "./lib/epic-render";
import { loadCommittedManifest } from "./lib/epic";
import { resolveRepoRoot } from "./lib/repo-root";
import {
  epicDirRelative,
  EPIC_MANIFEST_FILENAME,
} from "./lib/epic-manifest-schema";
import {
  readCommittedStatus,
  type EpicStatusFile,
} from "./lib/epic-status-schema";

type TerminalState = "merged" | "merged-externally" | "gated" | "needs-human";
const TERMINAL_STATES: readonly TerminalState[] = [
  "merged",
  "merged-externally",
  "gated",
  "needs-human",
];

function degradationBlock(epicSlug: string): string {
  return [`Part of epic ${epicSlug}`, "(epic status unavailable)"].join("\n");
}

/**
 * CONSTRAINT: this helper is invoked at the four terminal sites of
 * flow-pipeline/SKILL.md, cwd'd INSIDE THE FEATURE WORKTREE. A naive
 * committed-board read there picks up THIS PR's own optimistic `merged`
 * self-mark (written by `flow-epic-sync`'s selfFeatureId branch) and would
 * render the feature as merged even at a `gated` / `needs-human` /
 * `cancelled` terminal state — the exact failure the design's "read the
 * board from the base branch, never from an in-flight feature worktree"
 * constraint forbids. Only the self-row can be branch-local-false — every
 * other row is GitHub-derived and accurate on the branch — so suppress just
 * that one row unless the terminal state proves it actually landed.
 */
function suppressUnprovenSelfRow(
  committedStatus: EpicStatusFile | null,
  selfFeatureId: string | undefined,
  terminalState: TerminalState,
): EpicStatusFile | null {
  if (!committedStatus || !selfFeatureId) return committedStatus;
  if (terminalState === "merged" || terminalState === "merged-externally") {
    return committedStatus;
  }
  if (!(selfFeatureId in committedStatus.features)) return committedStatus;
  const features = { ...committedStatus.features };
  delete features[selfFeatureId];
  return { ...committedStatus, features };
}

/** Pure: renders the membership header + board + a state-aware footer. */
export function renderEpicBlock(input: {
  epicSlug: string;
  result: ReconcileResult;
  terminalState: TerminalState;
}): string {
  const { epicSlug, result, terminalState } = input;
  const lines = [
    `Part of epic ${epicSlug}`,
    `EPIC ${epicSlug} — ${result.epicStatus} (${result.summary.merged}/${result.summary.total} merged)`,
    renderBoard(result.board, result.summary),
  ];

  if (terminalState === "gated") {
    lines.push(
      `This feature is gated; clear its Test Steps to unblock the epic, then \`flow epic run ${epicSlug}\`.`,
    );
  } else if (terminalState === "needs-human") {
    lines.push(
      `Resolve this feature's escalation first; the epic cannot advance past it, then \`flow epic run ${epicSlug}\`.`,
    );
  } else {
    // terminalState is "merged" or "merged-externally" — footer depends on
    // the reconciled epicStatus, not on which of the two merge flavors fired.
    if (result.epicStatus === "done") {
      lines.push(`Epic ${epicSlug} is complete.`);
      lines.push(`Archive it with \`flow epic done ${epicSlug}\`.`);
    } else if (result.epicStatus === "blocked") {
      lines.push(
        `Next: \`flow epic run ${epicSlug}\` — epic is blocked (likely a deadlock); inspect the board above.`,
      );
    } else {
      lines.push(`Next: \`flow epic run ${epicSlug}\``);
    }
  }

  return lines.join("\n");
}

function printUsage(): void {
  console.error(
    "usage: flow-epic-membership --slug <feature-slug> --terminal-state <merged|merged-externally|gated|needs-human>",
  );
}

function parseArgs(
  argv: string[],
): { slug: string; terminalState: TerminalState } | null {
  let slug = "";
  let terminalState = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slug") {
      slug = argv[i + 1] ?? "";
      i++;
      continue;
    }
    if (a === "--terminal-state") {
      terminalState = argv[i + 1] ?? "";
      i++;
      continue;
    }
  }
  if (!slug) return null;
  if (!TERMINAL_STATES.includes(terminalState as TerminalState)) return null;
  return { slug, terminalState: terminalState as TerminalState };
}

export function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (!parsed) {
    printUsage();
    return 2;
  }
  const { slug, terminalState } = parsed;

  const state = readState(slug);
  const epicSlug = state?.epic?.slug;
  if (!epicSlug) return 0; // non-epic feature: silent no-op
  const selfFeatureId = state?.epic?.featureId;

  const runState = readEpicRunState(epicSlug);

  if (runState) {
    const loaded = loadCommittedManifest(runState.manifestPath);
    if (!loaded.ok) {
      console.log(degradationBlock(epicSlug));
      return 0;
    }
    const committedStatus = suppressUnprovenSelfRow(
      readCommittedStatus(path.dirname(runState.manifestPath)),
      selfFeatureId,
      terminalState,
    );
    try {
      // maxParallel only feeds the unused `toLaunch` slice here — this
      // helper never launches anything, so any positive value is safe.
      const result = reconcile({
        manifest: loaded.manifest,
        runState,
        maxParallel: runState.maxParallel ?? 1,
        committedStatus,
      });
      console.log(renderEpicBlock({ epicSlug, result, terminalState }));
      return 0;
    } catch {
      console.log(degradationBlock(epicSlug));
      return 0;
    }
  }

  // CONTRACT ADJUSTMENT #1: `runState` is null on exactly this branch, so a
  // committed-board read can only proceed by replicating runEpicStatus's
  // repo-root fallback (bin/lib/epic.ts's `resolveRepoRoot` +
  // `epicDirRelative` + `EPIC_MANIFEST_FILENAME`) to build an ephemeral
  // run-state to feed `reconcile`. When nothing usable is found, degrade
  // exactly as before.
  const repo = resolveRepoRoot(process.cwd());
  const manifestPath = repo
    ? path.join(repo, epicDirRelative(epicSlug), EPIC_MANIFEST_FILENAME)
    : null;
  const committedStatus = manifestPath
    ? suppressUnprovenSelfRow(
        readCommittedStatus(path.dirname(manifestPath)),
        selfFeatureId,
        terminalState,
      )
    : null;
  if (!manifestPath || !committedStatus) {
    console.log(degradationBlock(epicSlug));
    return 0;
  }

  const loaded = loadCommittedManifest(manifestPath);
  if (!loaded.ok) {
    console.log(degradationBlock(epicSlug));
    return 0;
  }

  const ephemeralRunState: EpicRunState = {
    epicSlug,
    repo: repo ?? "",
    manifestPath,
    manifestSha: "",
    createdAt: "",
    updatedAt: "",
    features: {},
  };

  try {
    const result = reconcile({
      manifest: loaded.manifest,
      runState: ephemeralRunState,
      maxParallel: 1,
      committedStatus,
    });
    console.log(renderEpicBlock({ epicSlug, result, terminalState }));
    return 0;
  } catch {
    console.log(degradationBlock(epicSlug));
    return 0;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
