/**
 * `flow epic <create|run|status|ls>` — the epic-designer/orchestrator verb.
 *
 * `flow epic create "<prompt>"` mirrors `flow new`: it mints the epic id +
 * the literal epic directory (CLI-side, R1), spawns a per-pipeline tmux window
 * running the `/epic-create` supervisor skill, and writes initial epic state
 * (`phase: "starting"`). The supervisor drives clarification → designer →
 * validate → commit → open design PR → `epic-design-pending-review` checkpoint.
 *
 * `flow epic create --resume <slug>` re-launches a crashed `/epic-create`
 * session in its existing tmux window (or recreates it if tmux died too) using
 * the epic resume seed prompt — full parity with `flow new --resume`.
 *
 * R1 (the consumer-worktree seam): the CLI is the SOLE evaluator of
 * `epicDirRelative(slug)` + the filename constants — flow's installed code,
 * where the `./epic-manifest-schema` import is fine. It embeds the resolved
 * LITERAL `EPIC_DIR` (e.g. `.flow/epics/<slug>`) in BOTH seed prompts so the
 * spawned window (cwd'd in a consumer worktree where `bin/lib/*` does not
 * exist) never re-derives the path nor imports `bin/lib`.
 *
 * The orchestrator RUN phase: `run` drives an epic to completion via a
 * foreground watch loop (tick → launch the ready frontier as parallel `flow
 * new` windows → sleep → re-tick, exiting on done/blocked), `status` renders
 * the live board read-only, and `ls` lists every epic under `~/.flow/epics/`.
 * All three read the committed `.flow/epics/<slug>/manifest.json` READ-ONLY and
 * keep per-machine runtime state at `~/.flow/epics/<slug>/run.json`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { argsContainHelp, isHelpFlag, printVerbHelp } from "./help";
import { slugify } from "./slug";
import {
  epicDirRelative,
  EPIC_DESIGN_FILENAME,
  EPIC_MANIFEST_FILENAME,
  validateEpicManifest,
  type EpicManifest,
} from "./epic-manifest-schema";
import { validateDag } from "../flow-epic-dag";
import { deriveWorktreePath } from "./new";
import {
  createWindowVerified,
  respawnWindowVerified,
  windowExists,
  isPaneAlive,
  FLOW_SESSION,
  type VerifiedLaunchResult,
} from "./tmux";
import {
  readState,
  writeState,
  deleteState,
  nowIso,
  EFFORT_LEVELS,
  type EffortLevel,
  MODEL_ALIASES,
  type ModelAlias,
} from "./state";
import { sleepSync } from "./sleep";
import { dim } from "./color";
import {
  reconcile,
  classifyEvent,
  HALT_STATUSES,
  type ReadFeatureState,
} from "./epic-reconcile";
import { launchFeature, type SpawnFn } from "./epic-launch";
import {
  readEpicRunState,
  writeEpicRunState,
  listEpicRunStates,
  type EpicRunState,
} from "./epic-run-state";
import { readEpicMaxParallel, readEpicJudgment } from "./epic-config";
import {
  renderBoard,
  renderEpicList,
  renderTickSummary,
  type EpicListRow,
} from "./epic-render";

/** Watch-loop poll interval (the launchd seam for v2 is `--once`). */
const EPIC_POLL_INTERVAL_MS = 30_000;

/**
 * Consecutive all-frontier-launch-failure ticks tolerated before the watch loop
 * bails to `blocked`. A single transient `flow new` failure self-heals on the
 * next tick, but a persistent one (e.g. a minted slug colliding with a
 * pre-existing tmux window) would otherwise spin the loop forever with no
 * progress and no terminal state.
 */
const LAUNCH_STALL_BUDGET = 3;

/**
 * Bounded retry budget for the verified window create — mirrors new.ts. A
 * single transient launch failure self-heals; the loop terminates so a
 * genuinely broken `claude` can't hang the CLI. (Epic intentionally keeps the
 * flat short retry — the new.ts backoff/--settings/concurrency-cap hardening is
 * scoped to `flow new` for now; see PR notes.)
 */
const WINDOW_CREATE_MAX_ATTEMPTS = 3;
const WINDOW_CREATE_RETRY_MS = 150;

function launchWithRetry(
  launch: () => VerifiedLaunchResult,
  retryMs: number = WINDOW_CREATE_RETRY_MS,
): VerifiedLaunchResult {
  let last: VerifiedLaunchResult = { status: "failed", stderr: "" };
  for (let attempt = 0; attempt < WINDOW_CREATE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && retryMs > 0) sleepSync(retryMs);
    last = launch();
    // `started` and `launched-not-confirmed` are both success (never kill/respawn
    // a live-but-slow pane); only `failed` (dead pane) is retryable.
    if (last.status !== "failed") return last;
  }
  return last;
}

export type EpicOptions = {
  /** Override the cwd for the new window (default: process.cwd()). */
  cwd?: string;
  /** Override the command launched in the window (test seam). */
  command?: string[];
  /** Resume a crashed epic session rather than start a new one. */
  resume?: boolean;
  /** Override the state directory (test seam). */
  stateDir?: string;
  /**
   * Persist the Claude Code reasoning-effort level. Threaded into the launch
   * argv as `--effort <level>` before the prompt. Omitted when absent.
   */
  effort?: EffortLevel;
  /**
   * Persist the Claude Code model alias. Threaded into the launch argv as
   * `--model <alias>` before the prompt (and before `--effort`). Omitted when
   * absent (Claude's default model applies).
   */
  model?: ModelAlias;
  /** Backoff (ms) between bounded window-create retries (test seam). */
  retrySleepMs?: number;
  /** Override the per-machine epic run-state root `~/.flow/epics` (test seam). */
  epicsDir?: string;
  /** Watch-loop sleep seam (default `sleepSync`); keeps `runEpicCli` synchronous. */
  sleep?: (ms: number) => void;
  /** Watch-loop poll interval in ms (default `EPIC_POLL_INTERVAL_MS`). */
  pollIntervalMs?: number;
  /** Feature-launch spawn seam (default spawns the bare `flow new`). */
  spawn?: SpawnFn;
  /** Per-feature live-state read seam (default `state.ts` readState). */
  readFeatureState?: ReadFeatureState;
  /** Clock seam for run-state timestamps (default `nowIso`). */
  now?: () => string;
  /**
   * `epic.maxParallel` config-default reader seam (default reads the real
   * `~/.flow/config.json` via `readEpicMaxParallel`). The lone exception to this
   * module's inject-every-I/O-boundary discipline used to be a bare
   * `readEpicMaxParallel()` call, which let the run/status/ls unit tests read the
   * developer's real config; this seam closes that isolation leak.
   */
  readMaxParallel?: () => number;
  /**
   * `epic.judgment` config-default reader seam (default `readEpicJudgment`).
   * When it returns `true` (the default) AND neither `--once` nor
   * `--no-judgment` is passed, `flow epic run <slug>` spawns the `/epic-run`
   * supervisor window; otherwise it stays on the foreground deterministic loop.
   */
  readJudgment?: () => boolean;
};

export function runEpicCli(args: string[], options: EpicOptions = {}): number {
  // STEP 1: verb-level help guard FIRST, before any side effect. Unlike
  // new.ts (which has no subcommands and so scans the whole args array), this
  // verb dispatches on a subcommand, so the verb-level guard must fire ONLY
  // when the help flag is in the verb position (`flow epic --help`). Using
  // argsContainHelp(args) here would also match a subcommand-level flag like
  // `flow epic create --help` and wrongly print the verb help — instead, let
  // that fall through to the switch so runCreate's own argsContainHelp(rest)
  // serves the create-specific help.
  if (isHelpFlag(args[0])) {
    printVerbHelp("epic");
    return 0;
  }

  // STEP 2: dispatch on the subcommand.
  const sub = args[0];
  switch (sub) {
    case "create":
      return runCreate(args.slice(1), options);
    case "run":
      return runEpicRun(args.slice(1), options);
    case "status":
      return runEpicStatus(args.slice(1), options);
    case "ls":
      return runEpicLs(options);
    case undefined:
      console.error("flow epic: a subcommand is required.");
      console.error("usage: flow epic <create|run|status|ls>");
      return 2;
    default:
      console.error(`flow epic: unknown epic subcommand: ${sub}`);
      console.error("usage: flow epic <create|run|status|ls>");
      return 2;
  }
}

function runCreate(rest: string[], options: EpicOptions): number {
  if (argsContainHelp(rest)) {
    console.log(`flow epic create — design an epic

Usage:
  flow epic create [--effort <low|medium|high|xhigh|max>] [--model <opus|haiku|sonnet|fable>] "<prompt>"
  flow epic create --resume <slug>

Options:
  --effort <low|medium|high|xhigh|max>
                        Claude Code reasoning-effort level for the epic-design session
  --model <opus|haiku|sonnet|fable>
                        Claude Code model alias for the epic-design session (omit for the default)

Mints an epic id from the prompt, opens a per-pipeline tmux window running
the /epic-create supervisor skill (clarify → design → validate → open design
PR → review checkpoint), and writes initial epic state under
.flow/epics/<slug>. --resume re-launches a crashed session in its window.`);
    return 0;
  }

  // Intercept --resume BEFORE the prompt parse (mirrors runNewCli's --resume
  // interception). `flow epic create --resume <slug>` dispatches to the resume
  // path; everything after --resume that isn't a flag is the slug.
  const resumeIdx = rest.indexOf("--resume");
  if (resumeIdx >= 0) {
    const slugArg = [...rest.slice(0, resumeIdx), ...rest.slice(resumeIdx + 1)]
      .filter((a) => !a.startsWith("-"))
      .join(" ")
      .trim();
    return runEpicResume(slugArg, options);
  }

  // --effort / --model are VALUE flags (ported from new.ts's runNewCli). Parse
  // + enum-validate BEFORE the prompt is built, so an invalid value exits with
  // epic's usage-error code (2 — NOT new's 1) and triggers no side-effect. The
  // flag + its value token are both stripped from `rest` before the join.
  let effort: EffortLevel | undefined;
  const effortIdx = rest.indexOf("--effort");
  if (effortIdx >= 0) {
    const value = rest[effortIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error("flow epic create: --effort requires a value.");
      console.error("  expected one of: low, medium, high, xhigh, max");
      return 2;
    }
    if (!(EFFORT_LEVELS as readonly string[]).includes(value)) {
      console.error(`flow epic create: invalid --effort value '${value}'.`);
      console.error("  expected one of: low, medium, high, xhigh, max");
      return 2;
    }
    effort = value as EffortLevel;
  }
  const effortValueToken = effortIdx >= 0 ? rest[effortIdx + 1] : undefined;

  let model: ModelAlias | undefined;
  const modelIdx = rest.indexOf("--model");
  if (modelIdx >= 0) {
    const value = rest[modelIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error("flow epic create: --model requires a value.");
      console.error("  expected one of: opus, haiku, sonnet, fable");
      return 2;
    }
    if (!(MODEL_ALIASES as readonly string[]).includes(value)) {
      console.error(`flow epic create: invalid --model value '${value}'.`);
      console.error("  expected one of: opus, haiku, sonnet, fable");
      return 2;
    }
    model = value as ModelAlias;
  }
  const modelValueToken = modelIdx >= 0 ? rest[modelIdx + 1] : undefined;

  let skipNext = false;
  const promptTokens = rest.filter((a) => {
    if (skipNext) {
      skipNext = false;
      return false;
    }
    if (a === "--effort") {
      skipNext =
        effortValueToken !== undefined && !effortValueToken.startsWith("--");
      return false;
    }
    if (a === "--model") {
      skipNext =
        modelValueToken !== undefined && !modelValueToken.startsWith("--");
      return false;
    }
    return true;
  });

  const prompt = promptTokens.join(" ").trim();
  if (!prompt) {
    console.error("flow epic create: a prompt is required.");
    console.error('usage: flow epic create "<prompt>"');
    return 2;
  }

  const slug = slugify(prompt);
  if (!slug) {
    console.error(`flow epic create: '${prompt}' produces an empty slug.`);
    return 2;
  }

  const cwd = options.cwd ?? process.cwd();
  const repo = resolveRepoRoot(cwd);
  if (!repo) {
    console.error(`flow epic create: ${cwd} is not inside a git repository.`);
    return 2;
  }

  if (windowExists(slug)) {
    console.error(
      `flow epic create: window '${FLOW_SESSION}:${slug}' already exists.`,
    );
    console.error(
      `  attach with \`flow attach ${slug}\`, resume with \`flow epic create --resume ${slug}\`,`,
    );
    console.error("  or pick a different prompt.");
    return 2;
  }

  const worktree = deriveWorktreePath(repo, slug);
  // R1: the CLI is the SOLE evaluator of the epic path contract; embed the
  // resolved LITERAL EPIC_DIR in the seed prompt so the spawned window (cwd'd
  // in a consumer worktree without bin/lib) consumes the literal, never an import.
  const epicDir = epicDirRelative(slug);
  const seed = epicCreateSeed(prompt, epicDir);
  const command = options.command ?? createCommand(worktree, effort, model);

  // Persist-then-verify-then-delete-on-failure (mirrors new.ts runFresh): write
  // epic state(phase=starting) BEFORE the verified launch so the /epic-create
  // supervisor has a file to advance and the `consumed` predicate has a
  // baseline. The no-orphan guarantee is preserved by deleting this file on
  // EVERY launch-failure exit (launch !ok, Mode-2 vanish).
  const existing = readState(slug, options.stateDir);

  // Re-establish the `starting` baseline at the START of EVERY launch attempt
  // (inside the retry closure), not once before the loop — mirrors new.ts
  // runFresh. `launchWithRetry` reuses one closure across attempts and
  // createWindowVerified kills its window on failure, so an attempt that
  // advanced the phase then died would otherwise leave state non-`starting`,
  // making the next attempt's `consumed()` short-circuit true over a brand-new
  // idle window (false-success orphan). Rewriting `starting` per attempt scopes
  // consumption to THAT attempt; a retry only fires after a killed/dead window,
  // so no live supervisor races this rewrite.
  const launch = () => {
    writeState(
      {
        slug,
        phase: "starting",
        repo,
        worktree: existing?.worktree,
        effort,
        model,
        updatedAt: nowIso(),
      },
      options.stateDir,
    );
    // Verify the window's process stayed up AND consumed the seed (the
    // supervisor advanced epic state.json past `starting`) before keeping that
    // state (the intermittent `flow new` orphan bug). createWindowVerified owns
    // seed delivery and kills its own half-created window on failure; the
    // delete-on-failure below removes the up-front state file.
    return createWindowVerified(slug, repo, command, seed, {
      consumed: () => {
        const s = readState(slug, options.stateDir);
        return s != null && s.phase !== "starting";
      },
    });
  };
  const result = launchWithRetry(launch, options.retrySleepMs);
  if (result.status === "failed") {
    deleteState(slug, options.stateDir);
    console.error(
      "flow epic create: claude exited immediately after launch — the tmux window did not stay up.",
    );
    console.error(
      "  Check your Claude Code install (try running `claude` manually in this repo), then retry.",
    );
    if (result.stderr) console.error(`  ${result.stderr}`);
    return 2;
  }

  // Mode-2 backstop (mirrors new.ts runFresh): the verified launch confirmed a
  // live, seeded window, but a window can still vanish between that check and now
  // (a racing kill, a tmux bounce). Never keep epic state for a window that is
  // already gone — delete the up-front file so no orphaned `phase: "starting"`
  // state survives.
  if (!windowExists(slug)) {
    deleteState(slug, options.stateDir);
    console.error(
      "flow epic create: the tmux window vanished after launch — not writing state.",
    );
    console.error(
      "  retry `flow epic create`; if it persists, check tmux/claude health.",
    );
    return 2;
  }

  // State was written up front and survived verification; the /epic-create
  // supervisor overwrites worktree + phase + pr at each transition from here.
  // First line is the machine-read contract token — raw, never colorized.
  console.log(`${FLOW_SESSION}:${slug}`);
  console.log(
    dim(`flow epic create: created — attach with \`flow attach ${slug}\``),
  );
  return 0;
}

function runEpicResume(name: string, options: EpicOptions): number {
  if (!name || name.trim() === "") {
    console.error("flow epic create --resume: <slug> is required.");
    console.error("usage: flow epic create --resume <slug>");
    return 2;
  }

  const slug = slugify(name);
  if (!slug || slug !== name) {
    console.error(
      `flow epic create --resume: '${name}' is not a valid epic slug.`,
    );
    console.error("  pass the slug as printed by `flow ls`.");
    return 2;
  }

  const state = readState(slug, options.stateDir);
  if (!state) {
    console.error(`flow epic create --resume: no epic state for '${slug}'.`);
    console.error('  run `flow epic create "<prompt>"` to start a fresh epic.');
    return 2;
  }

  if (!state.repo || !fs.existsSync(state.repo)) {
    console.error(
      `flow epic create --resume: epic '${slug}' was launched against`,
    );
    console.error(`  ${state.repo || "(no repo recorded)"}`);
    console.error(`  but that path no longer exists. Move the repo back, or`);
    console.error(
      `  run \`flow done ${slug}\` and start fresh with \`flow epic create\`.`,
    );
    return 2;
  }

  const exists = windowExists(slug);
  if (exists && isPaneAlive(slug)) {
    console.error(
      `flow epic create --resume: epic '${slug}' is still running.`,
    );
    console.error(`  attach with \`flow attach ${slug}\` instead of resuming.`);
    return 2;
  }

  const repo = state.repo;
  const worktree = state.worktree ?? deriveWorktreePath(repo, slug);
  // R1: recompute the literal EPIC_DIR CLI-side on resume too, so the resumed
  // window never re-derives the path nor imports bin/lib.
  const epicDir = epicDirRelative(slug);
  const seed = epicResumeSeed(slug, epicDir);
  const command =
    options.command ?? resumeCommand(worktree, state.effort, state.model);
  // Resume consumption baseline (mirrors new.ts runResume): on resume the phase
  // is already past `starting` (`epic-designing`), so consumption is "the
  // resumed supervisor bumped `updatedAt` past this pre-respawn value". Re-read
  // the baseline at the START of each attempt (inside the closure), not once
  // before the loop: `launchWithRetry` reuses the closure, so an attempt that
  // bumped `updatedAt` then died would otherwise satisfy the next attempt's
  // predicate immediately (false-success orphan). This path never writes or
  // deletes state — the window pre-existed the resume — so the read is
  // non-mutating.
  const launch = () => {
    const baseline = readState(slug, options.stateDir)?.updatedAt;
    const consumed = () => {
      const s = readState(slug, options.stateDir);
      return s != null && s.updatedAt !== baseline;
    };
    return exists
      ? respawnWindowVerified(slug, repo, command, seed, { consumed })
      : createWindowVerified(slug, repo, command, seed, { consumed });
  };
  const result = launchWithRetry(launch, options.retrySleepMs);
  if (result.status === "failed") {
    console.error(
      "flow epic create --resume: claude exited immediately after launch — the tmux window did not stay up.",
    );
    console.error(
      "  Check your Claude Code install (try running `claude` manually in this repo), then retry.",
    );
    if (result.stderr) console.error(`  ${result.stderr}`);
    return 2;
  }

  // Phase + worktree + pr stay as the crash left them. The supervisor's first
  // real transition is what updates state.json.
  console.log(`${FLOW_SESSION}:${slug}`);
  console.log(
    dim(`flow epic create: resumed — attach with \`flow attach ${slug}\``),
  );
  return 0;
}

// ── Run phase: run / status / ls ────────────────────────────────────────────

type RunArgs = {
  slug: string;
  once: boolean;
  /** `--json` — structured single-tick output. VALID ONLY with `--once`. */
  json: boolean;
  /** `--no-judgment` — keep the foreground LLM-free loop (no supervisor spawn). */
  noJudgment: boolean;
  maxParallel?: number;
  error?: string;
};

/**
 * Parse `<slug>` + `--once` + `--json` + `--no-judgment` + `--max-parallel <N>`
 * from the run arm's args. `--json` is rejected without `--once` (the
 * continuous loop stays human-rendered; only a single tick emits JSON).
 */
function parseRunArgs(rest: string[]): RunArgs {
  let once = false;
  let json = false;
  let noJudgment = false;
  let maxParallel: number | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--once") {
      once = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--no-judgment") {
      noJudgment = true;
      continue;
    }
    if (a === "--max-parallel") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("-")) {
        return {
          slug: "",
          once,
          json,
          noJudgment,
          error: "--max-parallel requires a value",
        };
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        return {
          slug: "",
          once,
          json,
          noJudgment,
          error: `--max-parallel must be a positive integer (got '${v}')`,
        };
      }
      maxParallel = n;
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      return {
        slug: "",
        once,
        json,
        noJudgment,
        error: `unknown option '${a}'`,
      };
    }
    positionals.push(a);
  }
  if (json && !once) {
    return {
      slug: "",
      once,
      json,
      noJudgment,
      error: "--json requires --once",
    };
  }
  return {
    slug: positionals.join(" ").trim(),
    once,
    json,
    noJudgment,
    maxParallel,
  };
}

/**
 * Read + shape-validate + DAG-validate the committed manifest READ-ONLY. The
 * orchestrator never writes `.flow/epics/<slug>/manifest.json`.
 */
function loadCommittedManifest(
  manifestPath: string,
):
  | { ok: true; manifest: EpicManifest; sha: string }
  | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return { ok: false, reason: "not-found" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      reason: `manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const shape = validateEpicManifest(parsed);
  if (!shape.ok)
    return { ok: false, reason: `invalid manifest — ${shape.reason}` };
  const dag = validateDag(shape.value.features);
  if (!dag.ok) {
    return {
      ok: false,
      reason: `manifest DAG is malformed:\n${dag.violations.map((v) => `  ${v.message}`).join("\n")}`,
    };
  }
  return {
    ok: true,
    manifest: shape.value,
    sha: createHash("sha256").update(raw).digest("hex"),
  };
}

const RUN_USAGE =
  "usage: flow epic run <slug> [--once] [--json] [--no-judgment] [--max-parallel <N>]";

function runEpicRun(rest: string[], options: EpicOptions): number {
  const parsed = parseRunArgs(rest);
  if (parsed.error) {
    console.error(`flow epic run: ${parsed.error}`);
    console.error(RUN_USAGE);
    return 2;
  }
  if (!parsed.slug) {
    console.error("flow epic run: a slug is required.");
    console.error(RUN_USAGE);
    return 2;
  }
  const { slug, once, json, noJudgment } = parsed;

  const cwd = options.cwd ?? process.cwd();
  const repo = resolveRepoRoot(cwd);
  if (!repo) {
    console.error(`flow epic run: ${cwd} is not inside a git repository.`);
    return 2;
  }

  const manifestPath = path.join(
    repo,
    epicDirRelative(slug),
    EPIC_MANIFEST_FILENAME,
  );
  const loaded = loadCommittedManifest(manifestPath);
  if (!loaded.ok) {
    if (loaded.reason === "not-found") {
      console.error(
        `flow epic run: manifest not found at ${manifestPath} — merge the design PR first.`,
      );
    } else {
      console.error(`flow epic run: ${loaded.reason}`);
    }
    return 2;
  }

  // Default path (judgment on, no --once, no --no-judgment): spawn the
  // /epic-run supervisor window. --once / --no-judgment / `epic.judgment:false`
  // all keep the existing foreground LLM-free loop. The manifest is loaded
  // FIRST (above) so a missing/invalid design surfaces the same usage error on
  // every path, before any window is spawned.
  const judgmentOn = (options.readJudgment ?? readEpicJudgment)();
  if (!once && !noJudgment && judgmentOn) {
    return spawnEpicRunSupervisor(slug, repo, options);
  }

  const now = options.now ?? nowIso;
  const maxParallel =
    parsed.maxParallel ?? (options.readMaxParallel ?? readEpicMaxParallel)();

  // Load-or-init runtime state; refresh drift-tracking fields on resume.
  const existing = readEpicRunState(slug, options.epicsDir);
  const runState: EpicRunState = existing ?? {
    epicSlug: slug,
    repo,
    manifestPath,
    manifestSha: loaded.sha,
    maxParallel,
    createdAt: now(),
    updatedAt: now(),
    features: {},
  };
  runState.repo = repo;
  runState.manifestPath = manifestPath;
  runState.manifestSha = loaded.sha;
  runState.maxParallel = maxParallel;

  return runWatchLoop(
    slug,
    loaded.manifest,
    runState,
    maxParallel,
    once,
    json,
    options,
    now,
  );
}

/**
 * Spawn the `/epic-run` supervisor in a per-pipeline tmux window — the default
 * `flow epic run <slug>` path when judgment is on. Mirrors `runCreate`'s
 * verify-then-delete-on-failure launch scaffolding, but keyed on the epic
 * run-state `runnerPhase` (the supervisor stamps it `running` on first entry)
 * rather than a `state.json` phase machine (epic run has none). The supervisor
 * itself drives ticks via `flow epic run <slug> --once --json`; this function
 * only opens the window and proves it consumed the seed.
 */
function spawnEpicRunSupervisor(
  slug: string,
  repo: string,
  options: EpicOptions,
): number {
  if (windowExists(slug)) {
    console.error(
      `flow epic run: window '${FLOW_SESSION}:${slug}' already exists.`,
    );
    console.error(
      `  attach with \`flow attach ${slug}\`, or run \`flow epic run ${slug} --no-judgment\``,
    );
    console.error("  for the foreground deterministic loop instead.");
    return 2;
  }

  const worktree = deriveWorktreePath(repo, slug);
  const epicDir = epicDirRelative(slug);
  const seed = epicRunSeed(slug, epicDir);
  const command = options.command ?? launchArgv(worktree);

  // Consumption = the supervisor advanced run-state `runnerPhase` to `running`
  // on first entry (its documented first action). Re-read every attempt inside
  // the closure so a killed-then-retried window can't satisfy the next
  // attempt's predicate against a stale `running` marker.
  const launch = () =>
    createWindowVerified(slug, repo, command, seed, {
      consumed: () => {
        const rs = readEpicRunState(slug, options.epicsDir);
        return rs != null && rs.runnerPhase === "running";
      },
    });
  const result = launchWithRetry(launch, options.retrySleepMs);
  if (result.status === "failed") {
    console.error(
      "flow epic run: claude exited immediately after launch — the tmux window did not stay up.",
    );
    console.error(
      "  Check your Claude Code install (try running `claude` manually in this repo), then retry.",
    );
    if (result.stderr) console.error(`  ${result.stderr}`);
    return 2;
  }

  // Mode-2 backstop (mirrors runCreate): never report a started supervisor for
  // a window that vanished between the verified launch and now.
  if (!windowExists(slug)) {
    console.error(
      "flow epic run: the tmux window vanished after launch — the supervisor did not start.",
    );
    console.error(
      "  retry `flow epic run`; if it persists, check tmux/claude health.",
    );
    return 2;
  }

  // First line is the machine-read contract token — raw, never colorized.
  console.log(`${FLOW_SESSION}:${slug}`);
  console.log(
    dim(
      `flow epic run: supervisor started — attach with \`flow attach ${slug}\``,
    ),
  );
  return 0;
}

/**
 * One reconcile tick: classify, terminate on done/blocked, else launch the
 * capped frontier and persist. Returns `{ done, code }` — `done` true means the
 * caller should stop the loop and return `code`.
 */
function runEpicTick(
  slug: string,
  manifest: EpicManifest,
  runState: EpicRunState,
  maxParallel: number,
  json: boolean,
  options: EpicOptions,
  now: () => string,
): {
  done: boolean;
  code: number;
  running: number;
  attempted: number;
  launched: number;
  launchFailedIds: string[];
} {
  const result = reconcile({
    manifest,
    runState,
    readFeatureState: options.readFeatureState,
    maxParallel,
  });

  // `--once --json`: emit the structured tick the /epic-run supervisor parses
  // (board/summary/epicStatus/toLaunch + the event classification, plus the
  // per-feature deadlock evidence). Human renders are suppressed below so
  // stdout carries exactly this one JSON object the supervisor `jq`s.
  if (json) {
    const event = classifyEvent(result);
    const payload: Record<string, unknown> = {
      epicSlug: slug,
      event,
      epicStatus: result.epicStatus,
      summary: result.summary,
      board: result.board,
      toLaunch: result.toLaunch,
    };
    if (event.kind === "deadlock") {
      // A deadlock has no halted blocker, so the actionable evidence is the
      // set of non-merged features + their unsatisfied deps the supervisor
      // reasons over to name a probable cause.
      payload.deadlock = result.board
        .filter((r) => r.status !== "merged")
        .map((r) => ({ id: r.id, status: r.status, dependsOn: r.dependsOn }));
    }
    console.log(JSON.stringify(payload));
  }

  if (result.epicStatus === "done") {
    if (!json) {
      console.log(renderBoard(result.board, result.summary));
      console.log(
        `epic complete: ${result.summary.merged}/${result.summary.total} features merged.`,
      );
    }
    return {
      done: true,
      code: 0,
      running: result.summary.running,
      attempted: 0,
      launched: 0,
      launchFailedIds: [],
    };
  }

  if (result.epicStatus === "blocked") {
    if (!json) {
      const blockers = result.board
        .filter((r) => HALT_STATUSES.has(r.status))
        .map((r) => r.id);
      console.error(renderBoard(result.board, result.summary));
      console.error(
        blockers.length > 0
          ? `epic blocked — ${blockers.join(", ")} halted (gated/needs-human/orphan); clear via their own pipelines, then re-run \`flow epic run ${slug}\`.`
          : `epic blocked — the frontier is empty but not all features merged; re-run \`flow epic run ${slug}\` after resolving.`,
      );
    }
    return {
      done: true,
      code: 1,
      running: result.summary.running,
      attempted: 0,
      launched: 0,
      launchFailedIds: [],
    };
  }

  // Running: launch the capped frontier, recording each minted slug.
  const launched: { id: string; slug: string }[] = [];
  const launchFailedIds: string[] = [];
  for (const feature of result.toLaunch) {
    const lr = launchFeature(feature, { spawn: options.spawn });
    if (!lr.ok) {
      // Surface, never swallow (the slug-drift stall is the #1 failure mode).
      // Stays on stderr so it never corrupts the stdout JSON in --json mode.
      console.error(
        `flow epic run: could not launch ${feature.id}: ${lr.error}`,
      );
      launchFailedIds.push(feature.id);
      continue;
    }
    runState.features[feature.id] = { slug: lr.slug, launchedAt: now() };
    launched.push({ id: feature.id, slug: lr.slug });
  }
  runState.updatedAt = now();
  writeEpicRunState(runState, options.epicsDir);

  if (!json) {
    const line = renderTickSummary(launched, {
      used: result.summary.running + launched.length,
      max: maxParallel,
    });
    if (line) console.log(line);
  }

  return {
    done: false,
    code: 0,
    running: result.summary.running + launched.length,
    attempted: result.toLaunch.length,
    launched: launched.length,
    launchFailedIds,
  };
}

function runWatchLoop(
  slug: string,
  manifest: EpicManifest,
  runState: EpicRunState,
  maxParallel: number,
  once: boolean,
  json: boolean,
  options: EpicOptions,
  now: () => string,
): number {
  if (once) {
    return runEpicTick(
      slug,
      manifest,
      runState,
      maxParallel,
      json,
      options,
      now,
    ).code;
  }

  const sleep = options.sleep ?? sleepSync;
  const pollMs = options.pollIntervalMs ?? EPIC_POLL_INTERVAL_MS;

  // Ctrl-C terminates the watch loop via the runtime's DEFAULT SIGINT handling —
  // no handler is registered on purpose. A synchronous `sleepSync` loop
  // (`Atomics.wait`) never yields to the event loop, so a registered SIGINT
  // listener could never be dispatched AND would suppress the default
  // terminate-on-Ctrl-C, leaving the process uninterruptible. Letting the
  // default fire keeps Ctrl-C working: already-launched features keep running in
  // their own tmux windows (separate processes), run-state is persisted every
  // tick, so re-running `flow epic run <slug>` resumes from disk — an abrupt
  // interrupt is functionally equivalent to a graceful stop here.
  let stalledTicks = 0;
  for (;;) {
    // The continuous loop is always human-rendered (--json is rejected without
    // --once), so the tick never emits JSON here.
    const r = runEpicTick(
      slug,
      manifest,
      runState,
      maxParallel,
      false,
      options,
      now,
    );
    if (r.done) return r.code;

    // No-progress guard: a tick that launches nothing, has nothing already
    // running, yet still wanted to launch (frontier non-empty) means every
    // frontier feature failed to launch. A transient failure self-heals on the
    // next tick; a persistent one would otherwise spin forever, so bail to
    // `blocked` after LAUNCH_STALL_BUDGET consecutive stalled ticks.
    if (r.running === 0 && r.launched === 0 && r.attempted > 0) {
      if (++stalledTicks >= LAUNCH_STALL_BUDGET) {
        console.error(
          `epic blocked — ${r.launchFailedIds.join(", ")} failed to launch ${LAUNCH_STALL_BUDGET} consecutive ticks with nothing else in flight; fix the underlying \`flow new\` failure (e.g. a window-name collision), then re-run \`flow epic run ${slug}\`.`,
        );
        return 1;
      }
    } else {
      stalledTicks = 0;
    }

    sleep(pollMs);
  }
}

/** An empty-features runtime state for an epic that has a manifest but no run yet. */
function ephemeralRunState(
  slug: string,
  manifestPath: string,
  readMaxParallel: () => number = readEpicMaxParallel,
): EpicRunState {
  return {
    epicSlug: slug,
    repo: "",
    manifestPath,
    manifestSha: "",
    maxParallel: readMaxParallel(),
    createdAt: "",
    updatedAt: "",
    features: {},
  };
}

function runEpicStatus(rest: string[], options: EpicOptions): number {
  const slug = rest
    .filter((a) => !a.startsWith("-"))
    .join(" ")
    .trim();
  if (!slug) {
    console.error("flow epic status: a slug is required.");
    console.error("usage: flow epic status <slug>");
    return 2;
  }

  const runState = readEpicRunState(slug, options.epicsDir);
  // Prefer the run-state's recorded manifest path (usable from any cwd); else
  // resolve the committed manifest from the current repo.
  let manifestPath: string | null = runState?.manifestPath ?? null;
  if (!manifestPath) {
    const repo = resolveRepoRoot(options.cwd ?? process.cwd());
    if (repo) {
      manifestPath = path.join(
        repo,
        epicDirRelative(slug),
        EPIC_MANIFEST_FILENAME,
      );
    }
  }

  let manifest: EpicManifest | null = null;
  if (manifestPath) {
    const loaded = loadCommittedManifest(manifestPath);
    if (loaded.ok) manifest = loaded.manifest;
  }

  if (!manifest) {
    if (!runState) {
      console.error(`flow epic status: no epic found for '${slug}'.`);
      console.error(
        '  design one with `flow epic create "<prompt>"`, then run it once the design PR merges.',
      );
      return 2;
    }
    console.error(
      `flow epic status: epic '${slug}' has runtime state but its manifest is unreadable${manifestPath ? ` at ${manifestPath}` : ""}.`,
    );
    return 2;
  }

  const rs =
    runState ??
    ephemeralRunState(
      slug,
      manifestPath!,
      options.readMaxParallel ?? readEpicMaxParallel,
    );
  const result = reconcile({
    manifest,
    runState: rs,
    readFeatureState: options.readFeatureState,
    maxParallel: rs.maxParallel,
  });
  console.log(
    `EPIC ${slug} — ${result.epicStatus} (${result.summary.merged}/${result.summary.total} merged)`,
  );
  console.log(renderBoard(result.board, result.summary));
  return 0;
}

function runEpicLs(options: EpicOptions): number {
  const states = listEpicRunStates(options.epicsDir);
  if (states.length === 0) {
    console.log(renderEpicList([]));
    return 0;
  }
  const rows: EpicListRow[] = states.map((rs) => {
    const loaded = loadCommittedManifest(rs.manifestPath);
    if (!loaded.ok) {
      // Degraded row: manifest unreadable (moved/unmerged). Count launched only.
      const launched = Object.values(rs.features).length;
      return {
        slug: rs.epicSlug,
        ready: 0,
        running: 0,
        blocked: 0,
        merged: 0,
        total: launched,
        status: "running" as const,
      };
    }
    const result = reconcile({
      manifest: loaded.manifest,
      runState: rs,
      readFeatureState: options.readFeatureState,
      maxParallel: rs.maxParallel,
    });
    return {
      slug: rs.epicSlug,
      ready: result.summary.ready,
      running: result.summary.running,
      blocked: result.summary.blocked,
      merged: result.summary.merged,
      total: result.summary.total,
      status: result.epicStatus,
    };
  });
  rows.sort((a, b) => a.slug.localeCompare(b.slug));
  console.log(renderEpicList(rows));
  return 0;
}

/**
 * Just `--add-dir <worktree>` (same rationale as new.ts's launchArgv: the
 * chrome-devtools MCP workspace-root pre-authorization). NO positional seed —
 * the seed is delivered ONLY via send-keys by the verified launcher (claude
 * does not auto-run a positional prompt), mirroring new.ts's launchArgv.
 */
function launchArgv(
  worktree: string,
  effort?: EffortLevel,
  model?: ModelAlias,
): string[] {
  // Bare `claude` base (NO `env FLOW_PIPELINE=1` prefix — that marker is a
  // new.ts-only concern; epic's launch env stays deliberately bare). NO
  // positional seed — the seed is delivered ONLY via send-keys by the verified
  // launcher (claude does not auto-run a positional prompt), mirroring new.ts.
  // `--model` precedes `--effort`, both after `--add-dir <worktree>`, in a
  // deterministic order so the argv assertions stay stable. Each is omitted
  // when unset.
  const argv = ["claude", "--add-dir", worktree];
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  return argv;
}

// The seed text is defined ONCE in these helpers and delivered ONLY via
// send-keys by the verified launcher (no positional argv copy), so there is no
// second definition to drift from. The literal EPIC_DIR is embedded (R1) so the
// /epic-create supervisor + the MODE: epic designer consume it directly rather
// than re-deriving the path via a bin/lib import they can't reach in a consumer
// worktree.
function epicCreateSeed(prompt: string, epicDir: string): string {
  return `Use the /epic-create skill for: ${prompt}\n\nEPIC_DIR: ${epicDir}`;
}

function epicResumeSeed(slug: string, epicDir: string): string {
  // The supervisor parses this prefix to detect resume mode and walk its
  // `# Resume mode` decision via flow-epic-resume-decide.
  return `Use the /epic-create skill in --resume mode for: ${slug}\n\nEPIC_DIR: ${epicDir}`;
}

// The /epic-run supervisor's seed. Mirrors epicCreateSeed: the slug after
// `for:` + the literal EPIC_DIR (R1) on its own line, so the spawned window
// (cwd'd in a consumer worktree without bin/lib) consumes them directly. The
// SKILL parses this prefix to enter the tick loop.
function epicRunSeed(slug: string, epicDir: string): string {
  return `Use the /epic-run skill for: ${slug}\n\nEPIC_DIR: ${epicDir}`;
}

function createCommand(
  worktree: string,
  effort?: EffortLevel,
  model?: ModelAlias,
): string[] {
  return launchArgv(worktree, effort, model);
}

function resumeCommand(
  worktree: string,
  effort?: EffortLevel,
  model?: ModelAlias,
): string[] {
  return launchArgv(worktree, effort, model);
}

function resolveRepoRoot(cwd: string): string | null {
  // node:child_process spawnSync (not Bun.spawnSync) so the vitest cases run
  // under node — Bun.spawnSync is undefined in the vitest worker. Production
  // runs through bin/flow (bun-shebanged), so node-compat here costs nothing.
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  if (!out || !fs.existsSync(out)) return null;
  return out;
}

// Re-exported so a future epic-aware resume helper / test can reference the
// path-contract constants the CLI resolves. (R1: the filename constants are
// CLI-side; the spawned window receives only the resolved literal EPIC_DIR.)
export { EPIC_DESIGN_FILENAME, EPIC_MANIFEST_FILENAME };
