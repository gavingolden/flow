#!/usr/bin/env bun
/**
 * Deterministic evidence helper for the `/epic-run` playbook supervisor.
 *
 * The supervisor runs cwd'd in a consumer worktree where flow's `bin/lib` is
 * absent, so the bounded evidence the LLM reasons over about a single halted
 * feature is assembled HERE — a bare-name PATH command (auto-discovered by
 * `discoverHelpers`, symlinked by `flow install`), invoked like
 * `flow-epic-resume-decide`. This helper is flow's INSTALLED code (resolved
 * through the symlink to the canonical source), so its `./lib` imports are
 * fine — R1 forbids `bin/lib` imports only inside the spawned consumer-worktree
 * window.
 *
 * LLM-FREE and TOLERANT: every path is wrapped so a missing/corrupt input
 * collapses to a tolerant JSON object on stdout (exit 0 for every decision).
 * Only a genuine CLI-usage error exits 2.
 *
 * ONE subcommand (the `record` writer and the `--deadlock` mode were removed
 * with the tick loop + judgment machinery — the playbook reconciles drift with
 * `flow epic bind` / `flow epic launch` and reads the board with
 * `flow epic status --json`):
 *
 *   context  (default)
 *     --slug <epic-slug> --feature <feature-id>   feature evidence
 *     Surfaces status, runRecord, featureState, pr, prReview, a tail-bounded
 *     ciFailure, the manifest neighbourhood, and flags.overridable (a gated
 *     feature is escalate-only — the playbook may never override it).
 *
 * The gh seam mirrors `flow-epic-resume-decide.ts` / `bin/lib/resume-probes.ts`
 * so the helper is fully unit-testable.
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { readState } from "./lib/state";
import { FLOW_STATE_DIR, FLOW_EPICS_DIR } from "./lib/paths";
import { readEpicRunState, type FeatureRunRecord } from "./lib/epic-run-state";
import {
  validateEpicManifest,
  type EpicManifest,
  type Feature,
} from "./lib/epic-manifest-schema";
import {
  reconcile,
  type BoardRow,
  type FeatureStatus,
} from "./lib/epic-reconcile";
import { defaultGh, type GhRunner, type GitRunner } from "./lib/resume-probes";

// --- Budgets ----------------------------------------------------------------

/** Cap the CI-failure log to the failing-check tail: ~100 lines / ~4KB. */
export const CI_LOG_TAIL_LINES = 100;
export const CI_LOG_TAIL_BYTES = 4096;

/** A check state that is NOT one of these is treated as a failure. */
const NON_FAILING_CHECK_STATES = new Set([
  "SUCCESS",
  "PASS",
  "NEUTRAL",
  "SKIPPED",
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
]);

// --- Tail-bounding ----------------------------------------------------------

/**
 * Bound `text` to the failing-check tail: keep the last CI_LOG_TAIL_LINES
 * lines, then clamp to the last CI_LOG_TAIL_BYTES bytes. Marks `truncated`
 * when either clamp fired. A byte clamp may split a multibyte char at the
 * boundary — acceptable for a log tail the LLM only reads.
 */
export function tailBound(text: string): { text: string; truncated: boolean } {
  let out = text;
  let truncated = false;
  const lines = out.split("\n");
  if (lines.length > CI_LOG_TAIL_LINES) {
    out = lines.slice(-CI_LOG_TAIL_LINES).join("\n");
    truncated = true;
  }
  const buf = Buffer.from(out, "utf8");
  if (buf.length > CI_LOG_TAIL_BYTES) {
    out = buf.subarray(buf.length - CI_LOG_TAIL_BYTES).toString("utf8");
    truncated = true;
  }
  return { text: out, truncated };
}

// --- gh probes --------------------------------------------------------------

export type CiFailureEvidence = {
  failingChecks: string[];
  logTail: string;
  truncated: boolean;
};

/**
 * Assemble the bounded CI-failure evidence for a feature's PR: the failing
 * check names (from `gh pr checks --json`) plus a tail-bounded failed-run log
 * (`gh run view <id> --log-failed`, keyed off the first failing check's run
 * link). Tolerant — any gh failure / parse failure degrades to empty fields.
 */
export function fetchCiFailure(pr: number, gh: GhRunner): CiFailureEvidence {
  const failingChecks: string[] = [];
  let runLink: string | undefined;

  const checks = gh(["pr", "checks", String(pr), "--json", "name,state,link"]);
  if (checks.exitCode === 0) {
    try {
      const rows = JSON.parse(checks.stdout) as Array<{
        name?: string;
        state?: string;
        link?: string;
      }>;
      for (const row of rows) {
        const state = (row.state ?? "").toUpperCase();
        if (state.length > 0 && !NON_FAILING_CHECK_STATES.has(state)) {
          if (row.name) failingChecks.push(row.name);
          if (!runLink && row.link) runLink = row.link;
        }
      }
    } catch {
      // tolerant — leave failingChecks empty
    }
  }

  let logTail = "";
  let truncated = false;
  const runId = runLink?.match(/\/runs\/(\d+)/)?.[1];
  if (runId) {
    const log = gh(["run", "view", runId, "--log-failed"]);
    if (log.exitCode === 0 && log.stdout.length > 0) {
      const bounded = tailBound(log.stdout);
      logTail = bounded.text;
      truncated = bounded.truncated;
    }
  }
  return { failingChecks, logTail, truncated };
}

export type PrReviewEvidence = { state?: string; reviewDecision?: string };

/** PR review state via `gh pr view --json state,reviewDecision`. Tolerant. */
export function fetchPrReview(
  pr: number,
  gh: GhRunner,
): PrReviewEvidence | null {
  const r = gh(["pr", "view", String(pr), "--json", "state,reviewDecision"]);
  if (r.exitCode !== 0) return null;
  try {
    const o = JSON.parse(r.stdout) as PrReviewEvidence;
    return { state: o.state, reviewDecision: o.reviewDecision };
  } catch {
    return null;
  }
}

// --- Manifest helpers -------------------------------------------------------

type LoadedManifest = { manifest: EpicManifest; sha: string };

/** Read + shape-validate + sha the committed manifest READ-ONLY. Tolerant. */
function loadManifest(manifestPath: string): LoadedManifest | null {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const shape = validateEpicManifest(parsed);
  if (!shape.ok) return null;
  return {
    manifest: shape.value,
    sha: createHash("sha256").update(raw).digest("hex"),
  };
}

export type Neighbourhood = {
  feature: Feature | null;
  dependsOn: string[];
  dependents: string[];
};

/** The feature's node + its direct dependsOn/dependents in the manifest DAG. */
export function manifestNeighbourhood(
  manifest: EpicManifest,
  id: string,
): Neighbourhood {
  const feature = manifest.features.find((f) => f.id === id) ?? null;
  const dependents = manifest.features
    .filter((f) => f.dependsOn.includes(id))
    .map((f) => f.id);
  return {
    feature,
    dependsOn: feature?.dependsOn ?? [],
    dependents,
  };
}

// --- Resolved deps ----------------------------------------------------------

export type Deps = {
  gh?: GhRunner;
  /** Included for seam parity with the sibling deciders; unused today. */
  git?: GitRunner;
  /** Feature pipeline state dir (`~/.flow/state`). Test seam. */
  stateDir?: string;
  /** Epic run-state root (`~/.flow/epics`). Test seam. */
  epicsDir?: string;
};

type Resolved = {
  gh: GhRunner;
  stateDir: string;
  epicsDir: string;
};

// --- Context assembly -------------------------------------------------------

export function assembleFeatureContext(
  epicSlug: string,
  featureId: string,
  deps: Resolved,
): unknown {
  const runState = readEpicRunState(epicSlug, deps.epicsDir);
  if (!runState) {
    return { ok: false, mode: "feature", reason: "run-state-missing" };
  }
  const loaded = loadManifest(runState.manifestPath);
  const runRecord: FeatureRunRecord | null =
    runState.features[featureId] ?? null;
  const featureState = runRecord?.slug
    ? readState(runRecord.slug, deps.stateDir)
    : null;

  let status: FeatureStatus | undefined;
  let board: BoardRow[] = [];
  if (loaded) {
    const result = reconcile({
      manifest: loaded.manifest,
      runState,
      readFeatureState: (s) => readState(s, deps.stateDir),
      maxParallel: runState.maxParallel ?? 3,
    });
    board = result.board;
    status = board.find((r) => r.id === featureId)?.status;
  }

  const pr =
    board.find((r) => r.id === featureId)?.pr ??
    featureState?.pr ??
    runRecord?.pr;
  const ciFailure = pr !== undefined ? fetchCiFailure(pr, deps.gh) : null;
  const prReview = pr !== undefined ? fetchPrReview(pr, deps.gh) : null;
  const neighbourhood = loaded
    ? manifestNeighbourhood(loaded.manifest, featureId)
    : { feature: null, dependsOn: [], dependents: [] };

  // `gated` is escalate-only (AGENTS.md hard rule: a gated verdict is
  // terminal, not advisory) — the playbook may never override it.
  const overridable = status !== "gated";

  return {
    ok: true,
    mode: "feature",
    epicSlug,
    featureId,
    status: status ?? null,
    runRecord,
    featureState,
    pr: pr ?? null,
    prReview,
    ciFailure,
    neighbourhood,
    flags: { overridable },
  };
}

// --- CLI parsing ------------------------------------------------------------

type Parsed =
  | { error: string }
  | { mode: "context"; slug: string; feature: string };

function getFlag(flags: string[], name: string): string | undefined {
  const i = flags.indexOf(name);
  if (i < 0) return undefined;
  const v = flags[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

export function parseArgs(argv: string[]): Parsed {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { error: "help" };
  }
  let flags = argv;
  if (argv[0] === "context") {
    flags = argv.slice(1);
  }

  const slug = getFlag(flags, "--slug");
  if (!slug) return { error: "--slug <epic-slug> is required" };

  const feature = getFlag(flags, "--feature");
  if (!feature) {
    return { error: "context: --feature <id> is required" };
  }
  return { mode: "context", slug, feature };
}

const USAGE =
  "usage: flow-epic-judge-context [context] --slug <epic> --feature <id>";

export function run(argv: string[], deps: Deps = {}): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      console.log(USAGE);
      return 0;
    }
    console.error(`flow-epic-judge-context: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }

  const resolved: Resolved = {
    gh: deps.gh ?? defaultGh,
    stateDir: deps.stateDir ?? FLOW_STATE_DIR,
    epicsDir: deps.epicsDir ?? FLOW_EPICS_DIR,
  };

  let result: unknown;
  try {
    result = assembleFeatureContext(parsed.slug, parsed.feature, resolved);
  } catch (e) {
    // Tolerant: never throw — emit a tolerant JSON on any failure, exit 0.
    result = {
      ok: false,
      reason: `unexpected-failure: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
