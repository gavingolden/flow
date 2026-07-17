/**
 * `flow epic <create|run|status|ls>` — the epic-designer/orchestrator verb.
 *
 * `flow epic create "<prompt>"` mirrors `flow feature create`: it mints the epic id +
 * the literal epic directory (CLI-side, R1), spawns a per-pipeline tmux window
 * running the `/flow-epic-create` supervisor skill, and writes initial epic state
 * (`phase: "starting"`). The supervisor drives clarification → designer →
 * validate → commit → open design PR → `epic-design-pending-review` checkpoint.
 *
 * `flow epic create --resume <slug>` re-launches a crashed `/flow-epic-create`
 * session in its existing tmux window (or recreates it if tmux died too) using
 * the epic resume seed prompt — full parity with `flow feature resume`.
 *
 * R1 (the consumer-worktree seam): the CLI is the SOLE evaluator of
 * `epicDirRelative(slug)` + the filename constants — flow's installed code,
 * where the `./epic-manifest-schema` import is fine. It embeds the resolved
 * LITERAL `EPIC_DIR` (e.g. `.flow/epics/<slug>`) in BOTH seed prompts so the
 * spawned window (cwd'd in a consumer worktree where `bin/lib/*` does not
 * exist) never re-derives the path nor imports `bin/lib`.
 *
 * The orchestrator RUN phase: `run` opens a per-pipeline tmux window running
 * the `/flow-epic-run` playbook supervisor (an LLM that reconciles the committed
 * manifest against GitHub/git truth and takes one deliberate step at a time —
 * no tick loop, no judgment sub-agent). `bind` / `launch` are the safe-write
 * primitives the playbook actuates with (repoint a drifted binding; atomic
 * create+bind). `status` renders the live board read-only (or a machine-readable
 * hypothesis with `--json`), and `ls` lists every epic under `~/.flow/epics/`.
 * All read the committed `.flow/epics/<slug>/manifest.json` READ-ONLY and keep
 * per-machine runtime state at `~/.flow/epics/<slug>/run.json` — a recomputable
 * cache, never the source of truth.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { argsContainHelp, isHelpFlag, printVerbHelp } from "./help";
import {
  resolveFlowSource,
  FLOW_LAUNCH_SEM_DIR,
  FLOW_LAUNCH_SETTINGS_PATH,
  FLOW_EPICS_DIR,
} from "./paths";
import { slugify } from "./slug";
import { confirmStdin } from "./confirm";
import {
  epicDirRelative,
  EPIC_DESIGN_FILENAME,
  EPIC_MANIFEST_FILENAME,
  validateEpicManifest,
  type EpicManifest,
} from "./epic-manifest-schema";
import { validateDag } from "../flow-epic-dag";
import {
  deriveWorktreePath,
  backoffMsForAttempt,
  ensureLaunchSettings,
} from "./feature";
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
import {
  readDefaultModel,
  collectModelConfigWarnings,
  type ReadConfigFile,
} from "./models-config";
import { sleepSync } from "./sleep";
import { dim } from "./color";
import { withTestSemaphore, resolveLaunchConcurrency } from "./lock";
import {
  reconcile,
  classifyEvent,
  type ReadFeatureState,
} from "./epic-reconcile";
import {
  launchFeature,
  type SpawnFn,
  type LaunchOverrides,
} from "./epic-launch";
import {
  readEpicRunState,
  writeEpicRunState,
  listEpicRunStates,
  deleteEpicRunState,
  type EpicRunState,
  type FeatureRunRecord,
} from "./epic-run-state";
import { readEpicMaxParallel } from "./epic-config";
import { resolveLauncherBackend } from "./launcher-config";
import { renderBoard, renderEpicList, type EpicListRow } from "./epic-render";

/**
 * Bounded retry budget for the verified window create — mirrors feature.ts. A
 * single transient launch failure self-heals; the loop terminates so a
 * genuinely broken `claude` can't hang the CLI. Between attempts an increasing
 * 1s → 2s → 4s backoff (via `backoffMsForAttempt` from feature.ts) rides out a
 * transient cold-start spike under concurrent load — a flat short retry would
 * land all three tries inside the same degraded window and fail together.
 */
const WINDOW_CREATE_MAX_ATTEMPTS = 3;

/**
 * Resolved absolute path to the product-planning skill, embedded (R1) in both
 * epic seeds so the spawned `/flow-epic-create` supervisor can pass a concrete
 * `SKILL_DIR` into its Task-spawned `MODE: epic` designer. The supervisor runs
 * cwd'd in a consumer worktree without `bin/lib`, so it cannot resolve this
 * itself — the CLI (flow's own installed code) resolves it symlink-aware via
 * `resolveFlowSource()` and threads it through.
 */
const PRODUCT_PLANNING_SKILL_DIR = path.join(
  resolveFlowSource(),
  "skills",
  "pipeline",
  "flow-product-planning",
);

function launchWithRetry(
  launch: () => VerifiedLaunchResult,
  retrySleepMs?: number,
  sleep: (ms: number) => void = sleepSync,
): VerifiedLaunchResult {
  let last: VerifiedLaunchResult = { status: "failed", stderr: "" };
  for (let attempt = 0; attempt < WINDOW_CREATE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // `retrySleepMs` is the test seam: 0 disables real sleep entirely;
      // undefined applies the increasing 1s → 2s → 4s schedule.
      const ms = retrySleepMs ?? backoffMsForAttempt(attempt);
      if (ms > 0) sleep(ms);
    }
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
   * Dead field: no production caller sets it and no reader consumes it
   * (epic-run's effort now flows through the explicit `runEffort` parameter
   * on `spawnEpicRunSupervisor` instead). Kept as a possible future test
   * seam; do not rely on this to drive epic-run effort — use the CLI
   * `--effort` flag.
   */
  effort?: EffortLevel;
  /**
   * Persist the Claude Code model alias. Threaded into the launch argv as
   * `--model <alias>` before the prompt (and before `--effort`). Omitted when
   * absent (Claude's default model applies).
   */
  model?: ModelAlias;
  /**
   * Backoff (ms) between bounded window-create retries. Test seam only — when 0
   * it disables real sleep entirely (the orphan-repro harness passes 0 so its
   * loop accrues no sleep); when undefined the increasing backoff schedule
   * (1s → 2s → 4s) applies.
   */
  retrySleepMs?: number;
  /**
   * Injectable sleep fn for the retry backoff. Test seam only (a spy that
   * asserts the 1s → 2s → 4s schedule without real sleeping); production uses
   * the spawn-free `sleepSync` default.
   */
  retrySleep?: (ms: number) => void;
  /**
   * Acquire timeout (ms) for the host-wide launch-concurrency semaphore. Test
   * seam only — production uses `withTestSemaphore`'s long default; the
   * fail-open test passes a short value so an over-subscribed cap proceeds fast.
   */
  launchSemTimeoutMs?: number;
  /**
   * Path to the flow-scoped `claude --settings` file the launch argv references
   * and `ensureLaunchSettings` writes. Test seam only — production uses
   * FLOW_LAUNCH_SETTINGS_PATH; tests point it at a temp file to avoid touching
   * the real ~/.flow and to assert the argv path.
   */
  launchSettingsPath?: string;
  /** Override the per-machine epic run-state root `~/.flow/epics` (test seam). */
  epicsDir?: string;
  /** Confirmation prompt seam (default reads stdin synchronously); test seam. */
  confirm?: (prompt: string) => boolean;
  /** Feature-launch spawn seam (default spawns the bare `flow feature create`). */
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
   * Injectable `~/.flow/config.json` reader (test seam only). Threaded into
   * `readDefaultModel` / `collectModelConfigWarnings` at epic-create launch so
   * the `models.default` resolution can be exercised without touching the real
   * config. Production uses the module default (reads via flowConfigPath()).
   */
  readConfig?: ReadConfigFile;
  /** tmux-on-PATH probe seam for the launcher-backend guard (test only). */
  tmuxOnPath?: () => boolean;
};

export function runEpicCli(args: string[], options: EpicOptions = {}): number {
  // STEP 1: verb-level help guard FIRST, before any side effect. Like
  // feature.ts, this verb dispatches on a subcommand, so the verb-level guard
  // must fire ONLY when the help flag is in the verb position
  // (`flow epic --help`). Using
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
    case "bind":
      return runEpicBind(args.slice(1), options);
    case "launch":
      return runEpicLaunch(args.slice(1), options);
    case "ls":
      return runEpicLs(options);
    case "done":
      return runEpicDone(args.slice(1), options);
    case undefined:
      console.error("flow epic: a subcommand is required.");
      console.error("usage: flow epic <create|run|status|bind|launch|ls|done>");
      return 2;
    default:
      console.error(`flow epic: unknown epic subcommand: ${sub}`);
      console.error("usage: flow epic <create|run|status|bind|launch|ls|done>");
      return 2;
  }
}

/**
 * Shared enum-value-flag parser for `--effort`/`--model`/`--model-planning`
 * (epic-create) and `--model`/`--effort` (epic-launch overrides). Owns the
 * missing-value guard, the enum check, and the two-line error message shape
 * (`flow epic <verb>: <flag> requires a value.` / `flow epic <verb>: invalid
 * <flag> value '<v>'.`, each followed by `  expected one of: <expected>`) —
 * the exact shape epic-create's original inline blocks printed. Returns the
 * flag's `flagIndex` (the position of the flag token itself, so a caller can
 * strip BOTH the flag and its value token by index) alongside the parsed
 * `value`; a flag that is absent from `rest` returns `{}`; a missing/invalid
 * value prints the error and returns `{ error: true }` — the caller must
 * exit 2 before any side effect (manifest load, spawn, state write).
 */
function parseEnumValueFlag<T extends string>(
  rest: string[],
  flag: string,
  allowed: readonly T[],
  verb: string,
  expected: string,
): { value?: T; valueToken?: string; flagIndex?: number; error?: true } {
  const idx = rest.indexOf(flag);
  if (idx < 0) return {};
  if (rest.indexOf(flag, idx + 1) >= 0) {
    console.error(`flow epic ${verb}: ${flag} may only be specified once.`);
    return { error: true };
  }
  const value = rest[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`flow epic ${verb}: ${flag} requires a value.`);
    console.error(`  expected one of: ${expected}`);
    return { error: true };
  }
  if (!(allowed as readonly string[]).includes(value)) {
    console.error(`flow epic ${verb}: invalid ${flag} value '${value}'.`);
    console.error(`  expected one of: ${expected}`);
    return { error: true };
  }
  return { value: value as T, valueToken: value, flagIndex: idx };
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
the /flow-epic-create supervisor skill (clarify → design → validate → open design
PR → review checkpoint), and writes initial epic state under
.flow/epics/<slug>. --resume re-launches a crashed session in its window.`);
    return 0;
  }

  // Intercept --resume BEFORE the prompt parse (mirrors runFeatureCli's resume-subcommand
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

  // --effort / --model are VALUE flags (ported from feature.ts's runCreateCli). Parse
  // + enum-validate BEFORE the prompt is built, so an invalid value exits with
  // epic's usage-error code (2 — NOT new's 1) and triggers no side-effect. The
  // flag + its value token are both stripped from `rest` before the join.
  const effortResult = parseEnumValueFlag(
    rest,
    "--effort",
    EFFORT_LEVELS,
    "create",
    "low, medium, high, xhigh, max",
  );
  if (effortResult.error) return 2;
  const effort = effortResult.value;
  const effortValueToken = effortResult.valueToken;

  const modelResult = parseEnumValueFlag(
    rest,
    "--model",
    MODEL_ALIASES,
    "create",
    "opus, haiku, sonnet, fable",
  );
  if (modelResult.error) return 2;
  const model = modelResult.value;
  const modelValueToken = modelResult.valueToken;

  // --model-planning is the epic-create per-phase override. The epic DESIGN
  // phase and the feature PLANNING phase share ONE flag/field (the shared
  // `modelPlanning` PipelineState field from Task 1) — there is no separate
  // --model-design. Same enum-before-side-effect + exit-2 contract as --model.
  const modelPlanningResult = parseEnumValueFlag(
    rest,
    "--model-planning",
    MODEL_ALIASES,
    "create",
    "opus, haiku, sonnet, fable",
  );
  if (modelPlanningResult.error) return 2;
  const modelPlanning = modelPlanningResult.value;
  const modelPlanningValueToken = modelPlanningResult.valueToken;

  const wantTmux = rest.includes("--tmux");

  let skipNext = false;
  const promptTokens = rest.filter((a) => {
    if (skipNext) {
      skipNext = false;
      return false;
    }
    if (a === "--tmux") return false;
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
    if (a === "--model-planning") {
      skipNext =
        modelPlanningValueToken !== undefined &&
        !modelPlanningValueToken.startsWith("--");
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

  // Epic orchestration is tmux-only (parallel feature windows are the whole
  // point): resolve the backend BEFORE any state/window side-effect and
  // refuse a plain resolution with the named opt-in notice. `--tmux` is the
  // per-run override.
  const backend = resolveLauncherBackend({
    flag: wantTmux ? "tmux" : undefined,
    read: options.readConfig,
    tmuxOnPath: options.tmuxOnPath,
  });
  if (backend.id !== "tmux") {
    // Don't print backend.notice here: when a tmux resolution degrades
    // (tmux not on PATH), the notice claims "falling back to the plain
    // launcher" — contradictory alongside the error below, since epic
    // orchestration then refuses to proceed on the plain backend at all.
    console.error(
      backend.notice
        ? "flow epic: epic orchestration requires the tmux launcher — tmux is not installed or not on PATH"
        : "flow epic: epic orchestration requires the tmux launcher — opt in with --tmux, the flow install Q&A, or 'flow config launcher tmux'",
    );
    return 1;
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
  const seed = epicCreateSeed(prompt, epicDir, PRODUCT_PLANNING_SKILL_DIR);
  const settingsPath = launchSettingsPathFor(options);

  // Whole-session model resolved at launch: --model wins over config
  // models.default; absent both, no --model reaches claude. Best-effort-warn
  // on any present-but-invalid models.* config value, then fall back.
  for (const w of collectModelConfigWarnings(options.readConfig)) {
    console.error(dim(`flow epic create: ${w}`));
  }
  const sessionModel = model ?? readDefaultModel(options.readConfig);

  const command =
    options.command ??
    createCommand(worktree, effort, settingsPath, sessionModel);

  // Persist-then-verify-then-delete-on-failure (mirrors feature.ts runFresh): write
  // epic state(phase=starting) BEFORE the verified launch so the /flow-epic-create
  // supervisor has a file to advance and the `consumed` predicate has a
  // baseline. The no-orphan guarantee is preserved by deleting this file on
  // EVERY launch-failure exit (launch !ok, Mode-2 vanish).
  const existing = readState(slug, options.stateDir);

  // Re-establish the `starting` baseline at the START of EVERY launch attempt
  // (inside the retry closure), not once before the loop — mirrors feature.ts
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
        model: sessionModel,
        modelPlanning,
        updatedAt: nowIso(),
      },
      options.stateDir,
    );
    // Verify the window's process stayed up AND consumed the seed (the
    // supervisor advanced epic state.json past `starting`) before keeping that
    // state (the intermittent `flow feature create` orphan bug). createWindowVerified owns
    // seed delivery and kills its own half-created window on failure; the
    // delete-on-failure below removes the up-front state file.
    return createWindowVerified(slug, repo, command, seed, {
      // Marker-aware consumed(): the seed-ingested hook stamping `seedIngestedAt`
      // confirms ingestion at launch time; absent the marker, fall back to the
      // phase advancing past `starting`. (consumed() is only probed while the
      // pane is alive, so "marker present" already implies a live pane.)
      consumed: () => {
        const s = readState(slug, options.stateDir);
        if (s == null) return false;
        if (s.seedIngestedAt != null) return true;
        return s.phase !== "starting";
      },
    });
  };
  const result = withLaunchSlot(
    () => launchWithRetry(launch, options.retrySleepMs, options.retrySleep),
    options,
  );
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

  // Mode-2 backstop (mirrors feature.ts runFresh): the verified launch confirmed a
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

  // State was written up front and survived verification; the /flow-epic-create
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
  const seed = epicResumeSeed(slug, epicDir, PRODUCT_PLANNING_SKILL_DIR);
  const settingsPath = launchSettingsPathFor(options);
  const command =
    options.command ??
    resumeCommand(worktree, state.effort, settingsPath, state.model);
  // Resume consumption baseline (mirrors feature.ts runResume): on resume the phase
  // is already past `starting` (`epic-designing`), so consumption is "the
  // resumed session RE-STAMPED the seed-ingested marker OR the resumed
  // supervisor bumped `updatedAt` past this pre-respawn value". BOTH baselines
  // are captured ONCE before the retry loop (not per-attempt): paired with the
  // non-destructive launched-not-confirmed timeout, a late advance no longer
  // respawn-kills a live session. The marker baseline is load-bearing — the
  // original fresh launch stamped `seedIngestedAt` and `runEpicResume` never
  // clears it (writeState is not called here), so a bare `seedIngestedAt != null`
  // check would short-circuit `consumed()` true on the FIRST probe off the STALE
  // marker, skip the resume-seed send-keys (the double-submit guard), and latch a
  // false-success resume that never delivered the seed. Requiring `seedIngestedAt`
  // to DIFFER from the pre-resume value means only a fresh re-stamp counts. This
  // path never writes or deletes state — the window pre-existed the resume — so
  // the read is non-mutating.
  const preResume = readState(slug, options.stateDir);
  const baseline = preResume?.updatedAt;
  const markerBaseline = preResume?.seedIngestedAt;
  const consumed = () => {
    const s = readState(slug, options.stateDir);
    if (s == null) return false;
    if (s.seedIngestedAt != null && s.seedIngestedAt !== markerBaseline)
      return true;
    return s.updatedAt !== baseline;
  };
  const launch = () =>
    exists
      ? respawnWindowVerified(slug, repo, command, seed, { consumed })
      : createWindowVerified(slug, repo, command, seed, { consumed });
  const result = withLaunchSlot(
    () => launchWithRetry(launch, options.retrySleepMs, options.retrySleep),
    options,
  );
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
  /**
   * `--model <alias>` — the epic-run supervisor session model (parity with
   * `flow feature create --model`). Threaded into `createCommand` at launch.
   */
  model?: ModelAlias;
  /**
   * `--effort <level>` — the epic-run supervisor session reasoning effort
   * (parity with `flow feature create --effort`). Threaded into
   * `createCommand` at launch.
   */
  effort?: EffortLevel;
  error?: string;
};

/**
 * Parse `<slug>` + `--model <alias>` + `--effort <level>` from the run arm's
 * args. Every loop-era flag (`--once`, `--json`, `--no-judgment`,
 * `--no-auto-redirect`, `--max-parallel`, `--model-judge`) is gone — an
 * unknown option is a usage error (exit 2). Exported so a unit test can
 * assert the flag parse directly.
 */
export function parseRunArgs(rest: string[]): RunArgs {
  let model: ModelAlias | undefined;
  let effort: EffortLevel | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--model") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("-")) {
        return { slug: "", error: `${a} requires a value` };
      }
      if (!(MODEL_ALIASES as readonly string[]).includes(v)) {
        return {
          slug: "",
          error: `invalid ${a} value '${v}' (expected one of: opus, haiku, sonnet, fable)`,
        };
      }
      model = v as ModelAlias;
      i++;
      continue;
    }
    if (a === "--effort") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("-")) {
        return { slug: "", error: `${a} requires a value` };
      }
      if (!(EFFORT_LEVELS as readonly string[]).includes(v)) {
        return {
          slug: "",
          error: `invalid ${a} value '${v}' (expected one of: low, medium, high, xhigh, max)`,
        };
      }
      effort = v as EffortLevel;
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      return { slug: "", error: `unknown option '${a}'` };
    }
    positionals.push(a);
  }
  return { slug: positionals.join(" ").trim(), model, effort };
}

/**
 * Read + shape-validate + DAG-validate the committed manifest READ-ONLY. The
 * orchestrator never writes `.flow/epics/<slug>/manifest.json`.
 */
export function loadCommittedManifest(
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
  "usage: flow epic run <slug> [--model <alias>] [--effort <level>]";

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
  const { slug } = parsed;

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

  // The manifest is loaded FIRST (above) so a missing/invalid design surfaces
  // the usage error before any window is spawned. Then open the /flow-epic-run
  // playbook window — that is the only run path now (the deterministic tick
  // loop + judgment machinery are gone).
  return spawnEpicRunSupervisor(
    slug,
    repo,
    options,
    parsed.model,
    parsed.effort,
  );
}

/**
 * Open the `/flow-epic-run` playbook supervisor in a per-pipeline tmux window.
 * Mirrors `runCreate`'s launch scaffolding but keeps NO per-machine phase
 * machine — with `runnerPhase` gone, the launch uses `createWindowVerified`'s
 * default fail-closed never-consumed predicate: a dead pane still retries/fails
 * loudly, a live pane returns `launched-not-confirmed` (a non-retry success).
 * Weaker than the old seed-consumption proof, but zero new machinery — the
 * playbook is human-in-the-loop (the user attaches to the window they opened).
 */
function spawnEpicRunSupervisor(
  slug: string,
  repo: string,
  options: EpicOptions,
  runModel?: ModelAlias,
  runEffort?: EffortLevel,
): number {
  if (windowExists(slug)) {
    console.error(
      `flow epic run: window '${FLOW_SESSION}:${slug}' already exists.`,
    );
    console.error(
      `  attach with \`flow attach ${slug}\`, or drive the playbook directly`,
    );
    console.error(`  in any existing session with \`/flow-epic-run ${slug}\`.`);
    return 2;
  }

  const worktree = deriveWorktreePath(repo, slug);
  const epicDir = epicDirRelative(slug);
  const seed = epicRunSeed(slug, epicDir);
  // Mirror runCreate's launch: resolve the flow-scoped settings file and build
  // the verified-launch argv through the shared builder. The supervisor session
  // model is `--model > config.models.default > inherited` (parity with
  // `flow feature create` / `flow epic create`); absent both, no --model reaches
  // claude. `--effort <level>` threads straight from the CLI flag — unlike
  // model, effort has no `config.models.default`-style config fallback.
  const settingsPath = launchSettingsPathFor(options);
  for (const w of collectModelConfigWarnings(options.readConfig)) {
    console.error(dim(`flow epic run: ${w}`));
  }
  const runSessionModel = runModel ?? readDefaultModel(options.readConfig);
  const command =
    options.command ??
    createCommand(worktree, runEffort, settingsPath, runSessionModel);

  // No run.json pre-seed and no `runnerPhase` reset — the default never-consumed
  // predicate (`createWindowVerified` with no `consumed`) verifies pane survival
  // only. A dead pane is `failed` (retry via launchWithRetry, then a loud
  // error); a live pane is `launched-not-confirmed` (a non-retry success).
  const launch = () => createWindowVerified(slug, repo, command, seed);
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

/**
 * The fixed hypothesis-framing sentence the `--json` payload carries so the
 * playbook LLM never mistakes the board for verified truth: run.json is a
 * per-machine, possibly-stale cache to reconcile against GitHub/git.
 */
const STATUS_SOURCE_NOTE =
  "run.json is a per-machine, recomputable cache (a stale hint, never the source of truth). Reconcile this board against GitHub (merged/open PRs) and git (branches, worktrees) before acting on it.";

function runEpicStatus(rest: string[], options: EpicOptions): number {
  const json = rest.includes("--json");
  const slug = rest
    .filter((a) => !a.startsWith("-"))
    .join(" ")
    .trim();
  if (!slug) {
    console.error("flow epic status: a slug is required.");
    console.error("usage: flow epic status <slug> [--json]");
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
    maxParallel:
      rs.maxParallel ?? (options.readMaxParallel ?? readEpicMaxParallel)(),
  });

  if (json) {
    // Exactly ONE JSON object on stdout (jq-parseable). `event` is the board
    // summary hint; `source` is the machine-visible hypothesis framing.
    console.log(
      JSON.stringify({
        epicSlug: slug,
        epicStatus: result.epicStatus,
        event: classifyEvent(result),
        summary: result.summary,
        board: result.board,
        source: STATUS_SOURCE_NOTE,
      }),
    );
    return 0;
  }

  console.log(
    `EPIC ${slug} — ${result.epicStatus} (${result.summary.merged}/${result.summary.total} merged)`,
  );
  console.log(renderBoard(result.board, result.summary));
  return 0;
}

// ── bind / launch: the safe-write actuators ─────────────────────────────────

/**
 * Reject a slug that isn't a single safe path segment before it feeds
 * `path.join(epicsDir, slug)` (mirrors runEpicDone's traversal guard).
 */
function isSafeEpicSlug(slug: string): boolean {
  return !(
    slug.includes("/") ||
    slug.includes("\\") ||
    slug === "." ||
    slug === ".." ||
    path.basename(slug) !== slug
  );
}

/**
 * Resolve + read + shape/DAG-validate the committed manifest for an actuator
 * (`bind` / `launch`), READ-ONLY. Prints its own `flow epic <verb>:` errors and
 * returns the failure code so the caller just `return`s it.
 */
function loadActuatorManifest(
  slug: string,
  verb: "bind" | "launch",
  options: EpicOptions,
):
  | {
      ok: true;
      repo: string;
      manifestPath: string;
      manifest: EpicManifest;
      sha: string;
    }
  | { ok: false; code: number } {
  const cwd = options.cwd ?? process.cwd();
  const repo = resolveRepoRoot(cwd);
  if (!repo) {
    console.error(`flow epic ${verb}: ${cwd} is not inside a git repository.`);
    return { ok: false, code: 2 };
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
        `flow epic ${verb}: manifest not found at ${manifestPath} — merge the design PR first.`,
      );
    } else {
      console.error(`flow epic ${verb}: ${loaded.reason}`);
    }
    return { ok: false, code: 2 };
  }
  return {
    ok: true,
    repo,
    manifestPath,
    manifest: loaded.manifest,
    sha: loaded.sha,
  };
}

/**
 * Load the per-machine run-state, or initialize a fresh one from the committed
 * manifest when absent. run.json is a recomputable per-machine cache, so a new
 * machine or a `flow epic done`-swept epic is a normal starting state — bind /
 * launch init rather than erroring.
 */
function loadOrInitRunState(
  slug: string,
  repo: string,
  manifestPath: string,
  sha: string,
  options: EpicOptions,
): EpicRunState {
  const existing = readEpicRunState(slug, options.epicsDir);
  if (existing) return existing;
  const now = options.now ?? nowIso;
  return {
    epicSlug: slug,
    repo,
    manifestPath,
    manifestSha: sha,
    maxParallel: (options.readMaxParallel ?? readEpicMaxParallel)(),
    createdAt: now(),
    updatedAt: now(),
    features: {},
  };
}

function runEpicBind(rest: string[], options: EpicOptions): number {
  if (argsContainHelp(rest)) {
    console.log(`flow epic bind — repoint or adopt a feature's run.json binding

Usage:
  flow epic bind <epic-slug> <feature-id> <feature-slug> [--force]
  flow epic bind <epic-slug> <feature-id> --external "<pr-or-issue-ref>" [--force]

Repoints (or adopts) the run.json binding for a feature without hand-editing
JSON. The slug form binds the feature to a live \`flow feature create\` pipeline;
the --external form records a completed out-of-band feature (a PR/issue that
merged with no flow pipeline) with no live slug.

Refuses to overwrite a DIFFERING existing binding without --force. On a forced
repoint the old slug moves to priorSlugs (audit lineage). The slug form also
refuses a target slug with no ~/.flow/state/<slug>.json unless --force (a typo
guard for a cleaned-up pipeline).

Options:
  --external "<ref>"    record a completed out-of-band feature (mutually
                        exclusive with the <feature-slug> positional)
  --force               overwrite a differing binding / bypass the slug guard`);
    return 0;
  }

  const force = rest.includes("--force");
  let external: string | undefined;
  const extIdx = rest.indexOf("--external");
  if (extIdx >= 0) {
    const v = rest[extIdx + 1];
    // Reject a missing, flag-shaped, OR empty/whitespace value. An empty ref
    // (realistic when a shell var expands empty: `--external "$REF"`) would
    // otherwise write a `{ external: "" }` record that fails the run-state type
    // guard on the next read — collapsing the WHOLE run.json to "missing" and
    // silently losing every other feature's binding on the next init.
    if (v === undefined || v.startsWith("--") || v.trim() === "") {
      console.error("flow epic bind: --external requires a non-empty value.");
      return 2;
    }
    external = v;
  }
  const positionals = rest.filter((a, i) => {
    if (a.startsWith("-")) return false;
    // drop the --external value token from the positional stream
    if (external !== undefined && rest[i - 1] === "--external") return false;
    return true;
  });

  const [epicSlug, featureId, featureSlug] = positionals;
  if (!epicSlug || !featureId) {
    console.error("flow epic bind: <epic-slug> and <feature-id> are required.");
    console.error(
      "usage: flow epic bind <epic-slug> <feature-id> <feature-slug> [--force]",
    );
    console.error(
      '       flow epic bind <epic-slug> <feature-id> --external "<ref>" [--force]',
    );
    return 2;
  }
  if (external !== undefined && featureSlug !== undefined) {
    console.error(
      "flow epic bind: <feature-slug> and --external are mutually exclusive.",
    );
    return 2;
  }
  if (external === undefined && featureSlug === undefined) {
    console.error(
      'flow epic bind: a <feature-slug> or --external "<ref>" is required.',
    );
    return 2;
  }
  if (!isSafeEpicSlug(epicSlug)) {
    console.error(`flow epic bind: invalid epic slug '${epicSlug}'.`);
    return 2;
  }

  const loaded = loadActuatorManifest(epicSlug, "bind", options);
  if (!loaded.ok) return loaded.code;
  if (!loaded.manifest.features.some((f) => f.id === featureId)) {
    console.error(
      `flow epic bind: feature '${featureId}' is not in the manifest.`,
    );
    return 2;
  }

  const runState = loadOrInitRunState(
    epicSlug,
    loaded.repo,
    loaded.manifestPath,
    loaded.sha,
    options,
  );
  const now = options.now ?? nowIso;
  const record: FeatureRunRecord | undefined = runState.features[featureId];

  let next: FeatureRunRecord;
  if (external !== undefined) {
    // External form: a differing binding is any existing record (slug-bound, or
    // an external ref that isn't this one). An identical external ref is a
    // no-op-safe re-record.
    const differs = record
      ? record.slug
        ? true
        : record.external !== external
      : false;
    if (differs && !force) {
      console.error(
        `flow epic bind: '${featureId}' is already bound${record?.slug ? ` to slug '${record.slug}'` : ` (external '${record?.external}')`}; pass --force to overwrite.`,
      );
      return 2;
    }
    const priorSlugs = [...(record?.priorSlugs ?? [])];
    if (record?.slug) priorSlugs.push(record.slug);
    next = {
      external,
      completedAt: now(),
      ...(priorSlugs.length > 0 ? { priorSlugs } : {}),
      ...(record?.pr !== undefined ? { pr: record.pr } : {}),
      ...(record?.lastStatus !== undefined
        ? { lastStatus: record.lastStatus }
        : {}),
    };
  } else {
    // Slug form. A differing binding is a record whose slug differs, or one that
    // is external.
    const slug = featureSlug!;
    const differs = record
      ? record.external
        ? true
        : record.slug !== slug
      : false;
    if (differs && !force) {
      console.error(
        `flow epic bind: '${featureId}' is already bound${record?.slug ? ` to slug '${record.slug}'` : ` (external '${record?.external}')`}; pass --force to overwrite.`,
      );
      return 2;
    }
    // Typo guard: a target slug with no pipeline state is likely a typo unless
    // the user explicitly forces (a legitimately cleaned-up pipeline).
    if (readState(slug, options.stateDir) === null && !force) {
      console.error(
        `flow epic bind: no pipeline state for slug '${slug}' (~/.flow/state/${slug}.json).`,
      );
      console.error(
        "  pass --force if the pipeline was cleaned up, or check the slug for a typo.",
      );
      return 2;
    }
    const priorSlugs = [...(record?.priorSlugs ?? [])];
    if (record?.slug && record.slug !== slug) priorSlugs.push(record.slug);
    next = {
      slug,
      launchedAt: now(),
      ...(priorSlugs.length > 0 ? { priorSlugs } : {}),
      ...(record?.pr !== undefined ? { pr: record.pr } : {}),
      ...(record?.lastStatus !== undefined
        ? { lastStatus: record.lastStatus }
        : {}),
    };
  }

  runState.features[featureId] = next;
  runState.updatedAt = now();
  writeEpicRunState(runState, options.epicsDir);
  console.log(JSON.stringify({ featureId, record: next }));
  return 0;
}

const LAUNCH_USAGE =
  "usage: flow epic launch <epic-slug> <feature-id> [--model <alias>] [--effort <level>] [--force]";

function runEpicLaunch(rest: string[], options: EpicOptions): number {
  if (argsContainHelp(rest)) {
    console.log(`flow epic launch — atomically create + bind a feature

Usage:
  flow epic launch <epic-slug> <feature-id> [--model <opus|haiku|sonnet|fable>] [--effort <low|medium|high|xhigh|max>] [--force]

Reads the committed manifest, resolves the feature node, spawns
\`flow feature create\` for it, and records the minted slug in run.json before
exiting — so a launch can never half-succeed into a lost binding. Refuses when
the feature is already bound (or recorded external) without --force.

Options:
  --model <opus|haiku|sonnet|fable>
                        per-launch model override — wins over the manifest's
                        flowNewHints for this one launch (never mutates the
                        committed manifest)
  --effort <low|medium|high|xhigh|max>
                        per-launch reasoning-effort override — wins over the
                        manifest's flowNewHints for this one launch
  --force               relaunch even when the feature is already bound`);
    return 0;
  }

  // --model / --effort are launch-time overrides (parity with epic-create's
  // value-flag parsing). Parsed + stripped BY INDEX (never by string-value
  // match) before positionals are computed, so a positional that happens to
  // equal a flag's value (an epic literally slugged 'opus', a feature id
  // 'low') is never corrupted.
  const modelResult = parseEnumValueFlag(
    rest,
    "--model",
    MODEL_ALIASES,
    "launch",
    "opus, haiku, sonnet, fable",
  );
  if (modelResult.error) return 2;
  const effortResult = parseEnumValueFlag(
    rest,
    "--effort",
    EFFORT_LEVELS,
    "launch",
    "low, medium, high, xhigh, max",
  );
  if (effortResult.error) return 2;

  const consumedIndices = new Set<number>();
  if (modelResult.flagIndex !== undefined) {
    consumedIndices.add(modelResult.flagIndex);
    consumedIndices.add(modelResult.flagIndex + 1);
  }
  if (effortResult.flagIndex !== undefined) {
    consumedIndices.add(effortResult.flagIndex);
    consumedIndices.add(effortResult.flagIndex + 1);
  }

  const force = rest.includes("--force");
  const positionals = rest.filter(
    (a, i) => !consumedIndices.has(i) && !a.startsWith("-"),
  );
  const [epicSlug, featureId] = positionals;
  if (!epicSlug || !featureId) {
    console.error(
      "flow epic launch: <epic-slug> and <feature-id> are required.",
    );
    console.error(LAUNCH_USAGE);
    return 2;
  }
  if (!isSafeEpicSlug(epicSlug)) {
    console.error(`flow epic launch: invalid epic slug '${epicSlug}'.`);
    return 2;
  }

  const loaded = loadActuatorManifest(epicSlug, "launch", options);
  if (!loaded.ok) return loaded.code;
  const feature = loaded.manifest.features.find((f) => f.id === featureId);
  if (!feature) {
    console.error(
      `flow epic launch: feature '${featureId}' is not in the manifest.`,
    );
    return 2;
  }

  const runState = loadOrInitRunState(
    epicSlug,
    loaded.repo,
    loaded.manifestPath,
    loaded.sha,
    options,
  );
  const existing = runState.features[featureId];
  if (existing && !force) {
    console.error(
      `flow epic launch: '${featureId}' is already ${existing.slug ? `bound to slug '${existing.slug}'` : `recorded external ('${existing.external}')`}; pass --force to relaunch.`,
    );
    return 2;
  }

  const overrides: LaunchOverrides = {};
  if (modelResult.value) overrides.model = modelResult.value;
  if (effortResult.value) overrides.effort = effortResult.value;
  const lr = launchFeature(feature, {
    spawn: options.spawn,
    epicSlug,
    overrides,
    tmuxOnPath: options.tmuxOnPath,
  });
  if (!lr.ok) {
    // Write nothing on failure — the binding is only recorded once the pipeline
    // actually exists (acceptance scenario 3: a launch never loses its binding).
    console.error(
      `flow epic launch: could not launch ${featureId}: ${lr.error}`,
    );
    return 2;
  }

  const now = options.now ?? nowIso;
  const priorSlugs = [...(existing?.priorSlugs ?? [])];
  if (existing?.slug && existing.slug !== lr.slug)
    priorSlugs.push(existing.slug);
  runState.features[featureId] = {
    slug: lr.slug,
    launchedAt: now(),
    ...(priorSlugs.length > 0 ? { priorSlugs } : {}),
  };
  runState.updatedAt = now();
  writeEpicRunState(runState, options.epicsDir);
  // First line is the machine-read contract token (the minted slug), mirroring
  // `flow feature create` — the playbook parses it to record/verify the binding.
  console.log(`${FLOW_SESSION}:${lr.slug}`);
  console.log(
    dim(
      `flow epic launch: launched ${featureId} → ${lr.slug} (bound in run.json)`,
    ),
  );
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
      maxParallel:
        rs.maxParallel ?? (options.readMaxParallel ?? readEpicMaxParallel)(),
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

function runEpicDone(rest: string[], options: EpicOptions): number {
  if (argsContainHelp(rest)) {
    console.log(`flow epic done — remove an epic's per-machine run-state

Usage:
  flow epic done <slug> [--yes]

Removes the recomputable ~/.flow/epics/<slug>/ runtime state directory (the
orchestrator's run.json cache). Does NOT close the epic's design window or
remove its ~/.flow/state/<slug>.json pipeline state — use \`flow done <slug>\`
for those.

Options:
  --yes, -y             skip the confirmation prompt`);
    return 0;
  }

  const yes = rest.includes("--yes") || rest.includes("-y");
  const slug = rest
    .filter((a) => !a.startsWith("-"))
    .join(" ")
    .trim();
  if (!slug) {
    console.error("flow epic done: a slug is required.");
    console.error("usage: flow epic done <slug> [--yes]");
    return 2;
  }

  // Slug feeds `path.join(epicsDir, slug)` and a recursive rmSync, so a
  // traversal slug (`..`) would escape epicsDir and delete arbitrary state
  // (e.g. `flow epic done .. --yes` resolves to ~/.flow itself). Require a
  // single safe path segment before building the target — mirrors the
  // `flow epic create --resume` slug guard.
  if (
    slug.includes("/") ||
    slug.includes("\\") ||
    slug === "." ||
    slug === ".." ||
    path.basename(slug) !== slug
  ) {
    console.error(`flow epic done: invalid slug '${slug}'.`);
    return 2;
  }

  const epicsDir = options.epicsDir ?? FLOW_EPICS_DIR;
  const target = path.join(epicsDir, slug);
  if (!fs.existsSync(target)) {
    console.error(`flow epic done: no run-state for '${slug}'.`);
    return 1;
  }

  if (!yes) {
    const confirm = options.confirm ?? confirmStdin;
    if (!confirm(`remove epic run-state for '${slug}'?`)) {
      console.log(dim("flow epic done: aborted — nothing removed"));
      return 0;
    }
  }

  if (!deleteEpicRunState(slug, epicsDir)) {
    console.error(`flow epic done: failed to remove run-state for '${slug}'.`);
    return 1;
  }
  console.log(`removed: ~/.flow/epics/${slug}`);

  // Runtime cross-pointer hint: `flow epic done` is scoped to the run-state
  // dir only. If the epic's design window or pipeline-state file still exists,
  // point the user at `flow done` for those. Read-only probes — this verb
  // NEVER kills a window or deletes pipeline state.
  const hasWindow = windowExists(slug);
  const hasState = readState(slug, options.stateDir) !== null;
  if (hasWindow || hasState) {
    console.log(
      dim(
        `note: the epic's design window/state still exists — run \`flow done ${slug}\` to close it too.`,
      ),
    );
  }
  return 0;
}

/**
 * `--add-dir <worktree>` (same rationale as feature.ts's launchArgv: the
 * chrome-devtools MCP workspace-root pre-authorization) plus the trailing
 * `--settings <flow-scoped file>`, which registers the UserPromptSubmit
 * seed-ingested hook and is ADDITIVE (the user's global settings still apply).
 * NO positional seed — the seed is delivered ONLY via send-keys by the verified
 * launcher (claude does not auto-run a positional prompt), mirroring feature.ts's
 * launchArgv.
 */
function launchArgv(
  worktree: string,
  effort: EffortLevel | undefined,
  settingsPath: string,
  model?: ModelAlias,
): string[] {
  // Bare `claude` base (NO `env FLOW_PIPELINE=1` prefix — that marker is a
  // feature.ts-only concern; epic's launch env stays deliberately bare). NO
  // positional seed — the seed is delivered ONLY via send-keys by the verified
  // launcher (claude does not auto-run a positional prompt), mirroring feature.ts.
  // `--model` precedes `--effort` (both before `--settings`), in a deterministic
  // order so the argv assertions stay stable. Each is omitted when unset.
  const base = ["claude", "--add-dir", worktree];
  const withModel = model ? [...base, "--model", model] : base;
  const withEffort = effort ? [...withModel, "--effort", effort] : withModel;
  return [...withEffort, "--settings", settingsPath];
}

// The seed text is defined ONCE in these helpers and delivered ONLY via
// send-keys by the verified launcher (no positional argv copy), so there is no
// second definition to drift from. The literal EPIC_DIR is embedded (R1) so the
// /flow-epic-create supervisor + the MODE: epic designer consume it directly rather
// than re-deriving the path via a bin/lib import they can't reach in a consumer
// worktree.
function epicCreateSeed(
  prompt: string,
  epicDir: string,
  skillDir: string,
): string {
  return `Use the /flow-epic-create skill for: ${prompt}\n\nEPIC_DIR: ${epicDir}\n\nSKILL_DIR: ${skillDir}`;
}

function epicResumeSeed(
  slug: string,
  epicDir: string,
  skillDir: string,
): string {
  // The supervisor parses this prefix to detect resume mode and walk its
  // `# Resume mode` decision via flow-epic-resume-decide.
  return `Use the /flow-epic-create skill in --resume mode for: ${slug}\n\nEPIC_DIR: ${epicDir}\n\nSKILL_DIR: ${skillDir}`;
}

/**
 * Resolves the flow-scoped `claude --settings` path: the explicit option, then
 * a `FLOW_LAUNCH_SETTINGS_PATH` env override (tests redirect it off the real
 * ~/.flow), then the default constant.
 */
function launchSettingsPathFor(options: EpicOptions): string {
  return (
    options.launchSettingsPath ??
    process.env.FLOW_LAUNCH_SETTINGS_PATH ??
    FLOW_LAUNCH_SETTINGS_PATH
  );
}

/**
 * Builds the verified-launch argv, registering the seed-ingested hook in the
 * flow-scoped settings file first (best-effort — a write hiccup degrades to no
 * hook, and the lazy reaper still backstops orphan cleanup).
 */
function buildLaunchCommand(
  worktree: string,
  effort: EffortLevel | undefined,
  settingsPath: string,
  model?: ModelAlias,
): string[] {
  try {
    ensureLaunchSettings(settingsPath);
  } catch (err) {
    process.stderr.write(
      dim(
        `flow epic create: could not write launch settings: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
  }
  return launchArgv(worktree, effort, settingsPath, model);
}

// The /flow-epic-run supervisor's seed. Mirrors epicCreateSeed: the slug after
// `for:` + the literal EPIC_DIR (R1) on its own line, so the spawned window
// (cwd'd in a consumer worktree without bin/lib) consumes them directly. The
// SKILL parses this prefix to enter the playbook. No AUTO_REDIRECT / MODEL_JUDGE
// lines — the playbook has no tick loop, no judgment sub-agent, and no
// autonomous redirect to gate.
function epicRunSeed(slug: string, epicDir: string): string {
  return `Use the /flow-epic-run skill for: ${slug}\n\nEPIC_DIR: ${epicDir}`;
}

function createCommand(
  worktree: string,
  effort: EffortLevel | undefined,
  settingsPath: string,
  model?: ModelAlias,
): string[] {
  return buildLaunchCommand(worktree, effort, settingsPath, model);
}

function resumeCommand(
  worktree: string,
  effort: EffortLevel | undefined,
  settingsPath: string,
  model?: ModelAlias,
): string[] {
  return buildLaunchCommand(worktree, effort, settingsPath, model);
}

/**
 * Wraps the verified launch in the host-wide launch-concurrency semaphore so a
 * burst of parallel launches stops oversubscribing claude cold-starts.
 * Fail-open (never blocks a launch): on acquire timeout the launch proceeds
 * holding no slot. The sem dir honors a `FLOW_LAUNCH_SEM_DIR` env override
 * (tests redirect it off the real ~/.flow); the cap is `resolveLaunchConcurrency`.
 */
function withLaunchSlot(
  launch: () => VerifiedLaunchResult,
  options: EpicOptions,
): VerifiedLaunchResult {
  const semDir = process.env.FLOW_LAUNCH_SEM_DIR ?? FLOW_LAUNCH_SEM_DIR;
  const slots = resolveLaunchConcurrency(process.env);
  const semOpts =
    options.launchSemTimeoutMs !== undefined
      ? { timeoutMs: options.launchSemTimeoutMs, pollMs: 5 }
      : {};
  return withTestSemaphore(semDir, slots, launch, semOpts).result;
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
