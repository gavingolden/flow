#!/usr/bin/env bun
/**
 * Deterministic judgment-context helper for the `/epic-run` supervisor.
 *
 * The supervisor runs cwd'd in a consumer worktree where flow's `bin/lib` is
 * absent, so the bounded evidence the in-process LLM reasons over is assembled
 * HERE — a bare-name PATH command (auto-discovered by `discoverHelpers`,
 * symlinked by `flow setup`), invoked like `flow-epic-resume-decide`. This
 * helper is flow's INSTALLED code (resolved through the symlink to the
 * canonical source), so its `./lib` imports are fine — R1 forbids `bin/lib`
 * imports only inside the spawned consumer-worktree window.
 *
 * LLM-FREE and TOLERANT: every path is wrapped so a missing/corrupt input
 * collapses to a tolerant JSON object on stdout (exit 0 for every decision).
 * Only a genuine CLI-usage error exits 2.
 *
 * Two subcommands:
 *
 *   context  (default)
 *     --slug <epic-slug> --feature <feature-id>   feature judgment evidence
 *     --slug <epic-slug> --deadlock               deadlock diagnosis evidence
 *     Feature context surfaces flags.overridable (gated ⇒ escalate-only),
 *     flags.budgetExhausted (retryCount >= maxRetries), and
 *     flags.redirectExhausted (redirectCount >= maxRedirects).
 *
 *   record
 *     --slug <epic-slug> --feature <id> --action <retry|redirect|escalate>
 *       --reason <text> [--increment-retry] [--relaunch-slug <new-slug>]
 *       [--runner-phase <phase>]
 *     --slug <epic> --runner-phase <phase>    runner-phase-only stamp
 *     Writes the decision back to epic run-state (lastJudgment, retryCount,
 *     runnerPhase) and echoes the updated record. With --runner-phase but no
 *     --feature it stamps ONLY runnerPhase, touching no feature record.
 *     --relaunch-slug (valid only with --action redirect) repoints the
 *     feature record: it pushes the current slug onto priorSlugs, sets slug to
 *     the relaunched pipeline, and increments redirectCount.
 *
 * The gh/git/clock seams mirror `flow-epic-resume-decide.ts` /
 * `bin/lib/resume-probes.ts` so the helper is fully unit-testable.
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { readState } from "./lib/state";
import { FLOW_STATE_DIR, FLOW_EPICS_DIR } from "./lib/paths";
import {
  readEpicRunState,
  writeEpicRunState,
  type FeatureRunRecord,
} from "./lib/epic-run-state";
import { readEpicMaxRedirects, readEpicMaxRetries } from "./lib/epic-config";
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
import { validateEpicJudgment } from "./lib/epic-judgment-schema";

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
  /** Override the retry budget (else `readEpicMaxRetries`). Test seam. */
  maxRetries?: number;
  /** Override the redirect budget (else `readEpicMaxRedirects`). Test seam. */
  maxRedirects?: number;
  /** Clock seam for the `record` mode `at` timestamp. Test seam. */
  now?: () => string;
};

type Resolved = {
  gh: GhRunner;
  stateDir: string;
  epicsDir: string;
  maxRetries: number;
  maxRedirects: number;
  now: () => string;
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
  const featureState = runRecord
    ? readState(runRecord.slug, deps.stateDir)
    : null;

  let status: FeatureStatus | undefined;
  let board: BoardRow[] = [];
  if (loaded) {
    const result = reconcile({
      manifest: loaded.manifest,
      runState,
      readFeatureState: (s) => readState(s, deps.stateDir),
      maxParallel: runState.maxParallel,
    });
    board = result.board;
    status = board.find((r) => r.id === featureId)?.status;
  }

  const retryCount = runRecord?.retryCount ?? 0;
  const redirectCount = runRecord?.redirectCount ?? 0;
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
  // terminal, not advisory) — the judgment layer may never override it.
  const overridable = status !== "gated";
  const budgetExhausted = retryCount >= deps.maxRetries;
  const redirectExhausted = redirectCount >= deps.maxRedirects;

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
    retryCount,
    maxRetries: deps.maxRetries,
    redirectCount,
    maxRedirects: deps.maxRedirects,
    flags: { overridable, budgetExhausted, redirectExhausted },
  };
}

export function assembleDeadlockContext(
  epicSlug: string,
  deps: Resolved,
): unknown {
  const runState = readEpicRunState(epicSlug, deps.epicsDir);
  if (!runState) {
    return { ok: false, mode: "deadlock", reason: "run-state-missing" };
  }
  const loaded = loadManifest(runState.manifestPath);

  let board: BoardRow[] = [];
  let epicStatus: string | null = null;
  let neighbourhoods: Neighbourhood[] = [];
  let manifestDrift: boolean | null = null;
  if (loaded) {
    const result = reconcile({
      manifest: loaded.manifest,
      runState,
      readFeatureState: (s) => readState(s, deps.stateDir),
      maxParallel: runState.maxParallel,
    });
    board = result.board;
    epicStatus = result.epicStatus;
    neighbourhoods = loaded.manifest.features.map((f) =>
      manifestNeighbourhood(loaded.manifest, f.id),
    );
    manifestDrift = loaded.sha !== runState.manifestSha;
  }

  return {
    ok: true,
    mode: "deadlock",
    epicSlug,
    epicStatus,
    board,
    runState: {
      features: runState.features,
      runnerPhase: runState.runnerPhase ?? null,
      maxParallel: runState.maxParallel,
      manifestSha: runState.manifestSha,
    },
    neighbourhoods,
    manifestDrift,
  };
}

// --- Record mode ------------------------------------------------------------

export type RecordArgs = {
  slug: string;
  /** Absent on a runner-phase-only stamp (no feature record is touched). */
  feature?: string;
  action?: "retry" | "redirect" | "escalate";
  reason?: string;
  incrementRetry: boolean;
  /** New slug the feature was relaunched under (redirect actuation); valid only with `--action redirect`. */
  relaunchSlug?: string;
  runnerPhase?: "running" | "blocked" | "done";
  /** Supervisor-passed gate flags driving the retry→escalate downgrade. */
  overridable?: boolean;
  budgetExhausted?: boolean;
};

export function recordJudgment(args: RecordArgs, deps: Resolved): unknown {
  const runState = readEpicRunState(args.slug, deps.epicsDir);
  if (!runState) {
    return { ok: false, mode: "record", reason: "run-state-missing" };
  }

  const at = deps.now();
  let record: FeatureRunRecord | null = null;
  let downgraded = false;
  if (args.feature !== undefined) {
    // Guard the bracket lookup with Object.hasOwn so an unvalidated CLI
    // `--feature __proto__`/`constructor` resolves to not-found rather than
    // Object.prototype (which is truthy, bypassing the guard, and would then
    // pollute the prototype via the `record.lastJudgment = …` write below).
    record = Object.hasOwn(runState.features, args.feature)
      ? runState.features[args.feature]
      : null;
    if (!record) {
      return { ok: false, mode: "record", reason: "feature-not-in-run-state" };
    }
    // parseArgs guarantees action/reason when feature is present. Validate the
    // typed decision through the same seam the sub-agent's artifact is checked
    // against before touching run-state — a malformed decision writes nothing.
    const valid = validateEpicJudgment({
      action: args.action!,
      reason: args.reason!,
    });
    if (!valid.ok) {
      return {
        ok: false,
        mode: "record",
        reason: `invalid-judgment: ${valid.reason}`,
      };
    }
    // Retry→escalate downgrade backstop: a gated feature (overridable:false)
    // or a budget-exhausted one can never be recorded as a retry, even if the
    // sub-agent's honest read was retry. The supervisor passes the flags; this
    // seam enforces the downgrade and skips the retry increment.
    let action = args.action!;
    let reason = args.reason!;
    if (
      action === "retry" &&
      (args.budgetExhausted === true || args.overridable === false)
    ) {
      const cause =
        args.overridable === false
          ? "gated (overridable:false)"
          : "budgetExhausted";
      action = "escalate";
      reason = `[downgraded retry→escalate: ${cause}] ${reason}`;
      downgraded = true;
    }
    record.lastJudgment = { action, reason, at };
    // A downgraded escalate is not a retry — never increment on it.
    if (args.incrementRetry && !downgraded) {
      record.retryCount = (record.retryCount ?? 0) + 1;
    }
    // Redirect repoint: retire the current slug into the lineage array and
    // point the record at the relaunched pipeline. parseArgs guarantees
    // relaunchSlug arrives only with `--action redirect`.
    if (args.relaunchSlug !== undefined) {
      record.priorSlugs = [...(record.priorSlugs ?? []), record.slug];
      record.slug = args.relaunchSlug;
      record.redirectCount = (record.redirectCount ?? 0) + 1;
    }
  }
  if (args.runnerPhase) {
    runState.runnerPhase = args.runnerPhase;
  }
  runState.updatedAt = at;
  writeEpicRunState(runState, deps.epicsDir);

  return {
    ok: true,
    mode: "record",
    featureId: args.feature ?? null,
    record,
    downgraded,
    runnerPhase: runState.runnerPhase ?? null,
  };
}

// --- CLI parsing ------------------------------------------------------------

type Parsed =
  | { error: string }
  | { mode: "context"; slug: string; feature: string; deadlock: false }
  | { mode: "context"; slug: string; deadlock: true }
  | { mode: "record"; args: RecordArgs };

const RUNNER_PHASES = new Set(["running", "blocked", "done"]);
const JUDGMENT_ACTIONS = new Set(["retry", "redirect", "escalate"]);

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
  let subcommand: "context" | "record" = "context";
  let flags = argv;
  if (argv[0] === "context" || argv[0] === "record") {
    subcommand = argv[0];
    flags = argv.slice(1);
  }

  const slug = getFlag(flags, "--slug");
  if (!slug) return { error: "--slug <epic-slug> is required" };

  if (subcommand === "record") {
    const feature = getFlag(flags, "--feature");
    const runnerPhase = getFlag(flags, "--runner-phase");
    if (runnerPhase !== undefined && !RUNNER_PHASES.has(runnerPhase)) {
      return {
        error: "record: --runner-phase must be one of running|blocked|done",
      };
    }
    const incrementRetry = flags.includes("--increment-retry");

    const relaunchSlug = getFlag(flags, "--relaunch-slug");

    if (feature) {
      const action = getFlag(flags, "--action");
      if (!action || !JUDGMENT_ACTIONS.has(action)) {
        return {
          error: "record: --action must be one of retry|redirect|escalate",
        };
      }
      // --relaunch-slug repoints the record to a relaunched pipeline; it is
      // only meaningful for a redirect actuation. Reject it with any other
      // action (usage error) rather than silently ignoring it.
      if (relaunchSlug !== undefined && action !== "redirect") {
        return {
          error: "record: --relaunch-slug requires --action redirect",
        };
      }
      const reason = getFlag(flags, "--reason");
      if (!reason) return { error: "record: --reason <text> is required" };
      const overridableRaw = getFlag(flags, "--overridable");
      let overridable: boolean | undefined;
      if (overridableRaw === "true") overridable = true;
      else if (overridableRaw === "false") overridable = false;
      else if (overridableRaw !== undefined) {
        return { error: "record: --overridable must be true or false" };
      }
      const budgetExhausted = flags.includes("--budget-exhausted");
      return {
        mode: "record",
        args: {
          slug,
          feature,
          action: action as RecordArgs["action"],
          reason,
          incrementRetry,
          relaunchSlug,
          runnerPhase: runnerPhase as RecordArgs["runnerPhase"],
          overridable,
          budgetExhausted,
        },
      };
    }

    // --relaunch-slug is meaningless without a --feature to repoint.
    if (relaunchSlug !== undefined) {
      return {
        error:
          "record: --relaunch-slug requires --feature and --action redirect",
      };
    }

    // Runner-phase-only stamp: no --feature, so no feature record is touched.
    if (runnerPhase === undefined) {
      return {
        error: "record: --feature <id> or --runner-phase <phase> is required",
      };
    }
    return {
      mode: "record",
      args: {
        slug,
        incrementRetry,
        runnerPhase: runnerPhase as RecordArgs["runnerPhase"],
      },
    };
  }

  // context
  if (flags.includes("--deadlock")) {
    return { mode: "context", slug, deadlock: true };
  }
  const feature = getFlag(flags, "--feature");
  if (!feature) {
    return { error: "context: --feature <id> or --deadlock is required" };
  }
  return { mode: "context", slug, feature, deadlock: false };
}

const USAGE =
  "usage: flow-epic-judge-context [context] --slug <epic> (--feature <id> | --deadlock)\n" +
  "       flow-epic-judge-context record --slug <epic> --feature <id> --action <retry|redirect|escalate> --reason <text> [--increment-retry] [--relaunch-slug <new-slug>] [--runner-phase <phase>] [--overridable <true|false>] [--budget-exhausted]\n" +
  "       flow-epic-judge-context record --slug <epic> --runner-phase <phase>\n" +
  "  (--relaunch-slug repoints the feature to a relaunched pipeline; valid only with --action redirect)";

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
    maxRetries: deps.maxRetries ?? readEpicMaxRetries(),
    maxRedirects: deps.maxRedirects ?? readEpicMaxRedirects(),
    now: deps.now ?? (() => new Date().toISOString()),
  };

  let result: unknown;
  try {
    if (parsed.mode === "record") {
      result = recordJudgment(parsed.args, resolved);
    } else if (parsed.deadlock) {
      result = assembleDeadlockContext(parsed.slug, resolved);
    } else {
      result = assembleFeatureContext(parsed.slug, parsed.feature, resolved);
    }
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
