/**
 * `flow new <description>` — slugify, create a tmux window, write initial
 * state. The supervisor skill (PR 2) takes over from there. Does not
 * auto-attach by default; the user runs `flow attach <slug>` separately.
 *
 * `flow new --resume <name>` — re-launch a crashed supervisor session in
 * its existing tmux window (or recreate the window if tmux died too) using
 * the resume seed prompt. Refuses if there is no state for `<name>` or if
 * the existing pane has a live process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { argsContainHelp, printVerbHelp } from "./help";
import { slugify } from "./slug";
import { toDirSuffix } from "./worktree-slot";
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
import { withTestSemaphore, resolveLaunchConcurrency } from "./lock";
import { FLOW_LAUNCH_SEM_DIR, FLOW_LAUNCH_SETTINGS_PATH } from "./paths";
import { installBaseBranchGuard } from "./base-branch-guard";

/**
 * Bounded retry budget for the verified window launch. A single transient
 * launch failure (e.g. a momentary tmux/claude hiccup) should self-heal, but
 * the loop must terminate — an unbounded retry would hang `flow new` forever
 * against a genuinely broken `claude` install.
 */
const WINDOW_CREATE_MAX_ATTEMPTS = 3;

/**
 * Increasing backoff (ms) between verified-launch retries: 1s → 2s → 4s. The
 * old flat 150ms landed all three retries inside the SAME degraded cold-start
 * window under concurrent load, so all three failed together; an increasing
 * schedule rides out a transient spike. Index `n-1` is the delay BEFORE
 * attempt `n` (attempts are 0-based); clamped so a future MAX_ATTEMPTS bump
 * never reads past the end.
 */
const WINDOW_CREATE_BACKOFF_MS = [1000, 2000, 4000];

export function backoffMsForAttempt(attempt: number): number {
  const idx = Math.min(
    Math.max(0, attempt - 1),
    WINDOW_CREATE_BACKOFF_MS.length - 1,
  );
  return WINDOW_CREATE_BACKOFF_MS[idx];
}

/**
 * Runs `launch` (a verified create or respawn) up to WINDOW_CREATE_MAX_ATTEMPTS
 * times with an increasing backoff between tries, returning the first
 * non-`failed` result (`started` / `launched-not-confirmed` are both success and
 * short-circuit the loop) or the last failure. Only a `failed` status retries.
 * `retrySleepMs` is the test seam: when 0 it disables real sleep entirely; when
 * undefined the per-attempt backoff schedule applies. `sleep` is the injectable
 * sleep fn (a spy in tests) so the schedule is assertable. The verified launcher
 * cleans up its own half-created window on `failed`, so an exhausted retry leaves
 * nothing behind.
 */
function launchWithRetry(
  launch: () => VerifiedLaunchResult,
  retrySleepMs?: number,
  sleep: (ms: number) => void = sleepSync,
): VerifiedLaunchResult {
  let last: VerifiedLaunchResult = { status: "failed", stderr: "" };
  for (let attempt = 0; attempt < WINDOW_CREATE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const ms = retrySleepMs ?? backoffMsForAttempt(attempt);
      if (ms > 0) sleep(ms);
    }
    last = launch();
    if (last.status !== "failed") return last;
  }
  return last;
}

export type NewOptions = {
  /** Override the cwd for the new window (default: process.cwd()). */
  cwd?: string;
  /** Override the command launched in the window. */
  command?: string[];
  /** Resume a crashed pipeline rather than start a new one. */
  resume?: boolean;
  /** Override the state directory (test seam). */
  stateDir?: string;
  /** Persist `autoMerge: false` so the supervisor stops at gated. */
  noAutoMerge?: boolean;
  /**
   * Persist `waitForCopilot: true` so flow-ci-wait waits the full
   * 10-min Copilot timeout (suppresses the auto-detect skips).
   */
  waitForCopilot?: boolean;
  /**
   * Persist `forceResearch: true` so discovery Step 1.5 forces the
   * web-grounded research pre-check on, bypassing the relevance gate and the
   * research.discovery config opt-in.
   */
  forceResearch?: boolean;
  /**
   * Persist the tri-state Copilot-review opt-in (`auto` | `always` |
   * `never`). Omitted when absent (absent ≡ `auto`).
   */
  copilotReview?: "auto" | "always" | "never";
  /**
   * Persist the Claude Code reasoning-effort level. Threaded into the
   * launch argv as `--effort <level>` before the prompt. Omitted when
   * absent (no `--effort` flag passed to claude).
   */
  effort?: EffortLevel;
  /**
   * Persist the Claude Code model alias. Threaded into the launch argv as
   * `--model <alias>` before the prompt (and before `--effort`). Omitted when
   * absent (no `--model` flag passed to claude — Claude's default applies).
   */
  model?: ModelAlias;
  /**
   * Backoff (ms) between bounded window-launch retries. Test seam only — when 0
   * it disables real sleep entirely (the orphan-repro harness passes 0 so its
   * N>=20 loop accrues no sleep); when undefined the increasing backoff schedule
   * (WINDOW_CREATE_BACKOFF_MS) applies.
   */
  retrySleepMs?: number;
  /**
   * Injectable sleep fn for the retry backoff. Test seam only (a spy that
   * asserts the 1s→2s→4s schedule without real sleeping); production uses the
   * spawn-free `sleepSync` default.
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
};

export function runNew(input: string, options: NewOptions = {}): number {
  if (options.resume) return runResume(input, options);
  return runFresh(input, options);
}

/**
 * CLI shim for `bin/flow`'s `new` verb. Intercepts --help / -h before any
 * side-effect (slug computation, tmux window create, state file write),
 * then dispatches the parsed args to `runNew`. The previous inline
 * `dispatchNew` lived in `bin/flow`; moving it here makes the help-flag
 * short-circuit unit-testable and avoids the catastrophic
 * `flow new --help` → phantom 'help' pipeline regression.
 */
export function runNewCli(args: string[], options: NewOptions = {}): number {
  if (argsContainHelp(args)) {
    printVerbHelp("new");
    return 0;
  }
  const resumeIdx = args.indexOf("--resume");
  if (resumeIdx >= 0) {
    // The resume branch returns before the later --yes/-y parse, so detect the
    // bypass flag here for the multi-slug preview. Strip --yes/-y and --resume
    // from the positional list; the remainder is the de-duplicated slug list.
    const yes = args.includes("--yes") || args.includes("-y");
    const slugs = [
      ...args.slice(0, resumeIdx),
      ...args.slice(resumeIdx + 1),
    ].filter((a) => a !== "--yes" && a !== "-y" && !a.startsWith("-"));
    const seen = new Set<string>();
    const deduped = slugs.filter((s) => !seen.has(s) && seen.add(s));
    if (deduped.length === 0) {
      console.error("flow new --resume: <name> is required.");
      console.error("usage: flow new --resume <name> [<name> ...]");
      return 1;
    }
    // Single-slug resume routes straight through the UNCHANGED single-slug
    // path — no preview, no confirm — so its output stays byte-identical.
    if (deduped.length === 1) {
      return runNew(deduped[0], { ...options, resume: true });
    }
    // Two or more slugs each spawn a Claude Code session: preview the count +
    // names and confirm once (unless --yes) before launching anything.
    if (!yes) {
      console.log(`will resume ${deduped.length} pipeline(s):`);
      for (const slug of deduped) console.log(`  ${slug}`);
      if (!confirmResume("proceed?")) {
        console.log(dim("flow new --resume: aborted — nothing resumed"));
        return 0;
      }
    }
    // Sequential launch (never concurrent) so tmux window creation stays
    // deterministic; per-slug validation/refusal is inherited from runResume.
    let failed = 0;
    for (const slug of deduped) {
      if (runNew(slug, { ...options, resume: true }) !== 0) failed += 1;
    }
    return failed > 0 ? 1 : 0;
  }
  const noAutoMerge = args.includes("--no-auto-merge");
  const waitForCopilot = args.includes("--wait-for-copilot");
  const forceResearch = args.includes("--research");

  // --copilot-review <auto|always|never> is a VALUE flag. Validate the enum
  // here, before any side-effect (slug, tmux, writeState), so an invalid
  // value exits non-zero and writes no state. The flag + its value token are
  // both stripped from the description args.
  const COPILOT_REVIEW_VALUES = ["auto", "always", "never"] as const;
  let copilotReview: "auto" | "always" | "never" | undefined;
  const crIdx = args.indexOf("--copilot-review");
  if (crIdx >= 0) {
    const value = args[crIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error("flow new: --copilot-review requires a value.");
      console.error("  expected one of: auto, always, never");
      return 1;
    }
    if (!(COPILOT_REVIEW_VALUES as readonly string[]).includes(value)) {
      console.error(`flow new: invalid --copilot-review value '${value}'.`);
      console.error("  expected one of: auto, always, never");
      return 1;
    }
    copilotReview = value as "auto" | "always" | "never";
  }
  const crValueToken = crIdx >= 0 ? args[crIdx + 1] : undefined;

  // --effort <low|medium|high|xhigh|max> is a VALUE flag mirroring
  // --copilot-review. Validate the enum here, before any side-effect, so an
  // invalid value exits non-zero and writes no state. The flag + its value
  // token are both stripped from the description args.
  let effort: EffortLevel | undefined;
  const effortIdx = args.indexOf("--effort");
  if (effortIdx >= 0) {
    const value = args[effortIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error("flow new: --effort requires a value.");
      console.error("  expected one of: low, medium, high, xhigh, max");
      return 1;
    }
    if (!(EFFORT_LEVELS as readonly string[]).includes(value)) {
      console.error(`flow new: invalid --effort value '${value}'.`);
      console.error("  expected one of: low, medium, high, xhigh, max");
      return 1;
    }
    effort = value as EffortLevel;
  }
  const effortValueToken = effortIdx >= 0 ? args[effortIdx + 1] : undefined;

  // --model <opus|haiku|sonnet|fable> is a VALUE flag mirroring --effort.
  // Validate the enum here, before any side-effect, so an invalid value exits
  // non-zero and writes no state. The flag + its value token are both stripped
  // from the description args.
  let model: ModelAlias | undefined;
  const modelIdx = args.indexOf("--model");
  if (modelIdx >= 0) {
    const value = args[modelIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error("flow new: --model requires a value.");
      console.error("  expected one of: opus, haiku, sonnet, fable");
      return 1;
    }
    if (!(MODEL_ALIASES as readonly string[]).includes(value)) {
      console.error(`flow new: invalid --model value '${value}'.`);
      console.error("  expected one of: opus, haiku, sonnet, fable");
      return 1;
    }
    model = value as ModelAlias;
  }
  const modelValueToken = modelIdx >= 0 ? args[modelIdx + 1] : undefined;

  // Drop a leading `--` end-of-options sentinel so descriptions written
  // with `flow new -- fix the -h crash` round-trip without the literal
  // `--` token. Pairs with `argsContainHelp`'s POSIX `--` stop semantics.
  const ddIdx = args.indexOf("--");
  const descriptionArgs =
    ddIdx >= 0 ? [...args.slice(0, ddIdx), ...args.slice(ddIdx + 1)] : args;
  let skipNext = false;
  const description = descriptionArgs
    .filter((a) => {
      if (skipNext) {
        skipNext = false;
        return false;
      }
      if (a === "--copilot-review") {
        // Strip the flag and mark its value token for removal too.
        skipNext = crValueToken !== undefined && !crValueToken.startsWith("--");
        return false;
      }
      if (a === "--effort") {
        // Strip the flag and mark its value token for removal too.
        skipNext =
          effortValueToken !== undefined && !effortValueToken.startsWith("--");
        return false;
      }
      if (a === "--model") {
        // Strip the flag and mark its value token for removal too.
        skipNext =
          modelValueToken !== undefined && !modelValueToken.startsWith("--");
        return false;
      }
      return (
        a !== "--no-auto-merge" &&
        a !== "--wait-for-copilot" &&
        a !== "--research"
      );
    })
    .join(" ");
  return runNew(description, {
    ...options,
    noAutoMerge,
    waitForCopilot,
    forceResearch,
    copilotReview,
    effort,
    model,
  });
}

function runFresh(description: string, options: NewOptions): number {
  if (!description || description.trim() === "") {
    console.error("flow new: description is required.");
    console.error(
      "usage: flow new [--no-auto-merge] [--wait-for-copilot] [--research] [--copilot-review <auto|always|never>] [--effort <low|medium|high|xhigh|max>] [--model <opus|haiku|sonnet|fable>] <description>",
    );
    return 1;
  }

  const slug = slugify(description);
  if (!slug) {
    console.error(`flow new: '${description}' produces an empty slug.`);
    return 1;
  }

  const cwd = options.cwd ?? process.cwd();
  const repo = resolveRepoRoot(cwd);
  if (!repo) {
    console.error(`flow new: ${cwd} is not inside a git repository.`);
    return 1;
  }

  if (windowExists(slug)) {
    console.error(`flow new: window '${FLOW_SESSION}:${slug}' already exists.`);
    console.error(
      `  attach with \`flow attach ${slug}\`, resume with \`flow new --resume ${slug}\`,`,
    );
    console.error("  or pick a different description.");
    return 1;
  }

  // Mechanical base-branch guard: install the env-gated pre-commit hook on the
  // main repo (best-effort, idempotent) so a future supervisor bug cannot land
  // pipeline work directly on the base branch. The hook is inert outside a flow
  // session, and a guard-install hiccup must never abort the launch.
  try {
    installBaseBranchGuard(repo);
  } catch (err) {
    console.error(
      dim(
        `flow new: could not install base-branch guard: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  const worktree = deriveWorktreePath(repo, slug);
  const settingsPath = launchSettingsPathFor(options);
  const seed = flowPipelineSeed(description);
  const command =
    options.command ??
    buildLaunchCommand(worktree, options.effort, settingsPath, options.model);

  // Persist-then-verify-then-delete-on-failure: write state(phase=starting)
  // BEFORE the verified launch so the supervisor has a file to advance (its
  // first `flow-state-update` exits non-zero with no state file) and the
  // `consumed` predicate below has a baseline to compare against. The no-orphan
  // guarantee is preserved by deleting this file on EVERY launch-failure exit
  // (launch !ok, Mode-2 vanish) rather than by the old write-after-verify order.
  // Pre-existing state for the same slug shouldn't happen because windowExists()
  // blocked above; if it does (e.g. external tmux reset), this write supersedes.
  const existing = readState(slug, options.stateDir);

  // Re-establish the `starting` baseline at the START of EVERY launch attempt
  // (inside the retry closure), not once before the loop. `launchWithRetry`
  // reuses one closure across attempts, and `createWindowVerified` kills its
  // window on failure, so an attempt that advanced the phase (e.g. to
  // `triaging`) then died would otherwise leave state non-`starting` — making
  // the next attempt's `consumed()` short-circuit true over a brand-new idle
  // window (the double-submit guard skips the seed send and `pollUntilConsumed`
  // latches on its first probe), a false-success orphan. Rewriting `starting`
  // per attempt scopes consumption to THAT attempt. A retry only fires after a
  // killed/dead window, so no live supervisor races this rewrite.
  const launch = () => {
    writeState(
      {
        slug,
        phase: "starting",
        repo,
        worktree: existing?.worktree,
        autoMerge: options.noAutoMerge ? false : undefined,
        waitForCopilot: options.waitForCopilot ? true : undefined,
        forceResearch: options.forceResearch ? true : undefined,
        copilotReview: options.copilotReview,
        effort: options.effort,
        model: options.model,
        updatedAt: nowIso(),
      },
      options.stateDir,
    );
    // Verify the window's process actually stayed up AND consumed the seed (the
    // supervisor advanced state.json past `starting`) before keeping that
    // state. A bare `createWindow` only proves tmux forked the shell, and a
    // `claude` idle at an empty input box passes a liveness probe, so a
    // dead-on-arrival pipeline would otherwise leave an orphaned state file (the
    // intermittent `flow new` bug). createWindowVerified owns seed delivery and
    // kills its own half-created window on failure, so an exhausted retry leaves
    // no window behind; the delete-on-failure below removes the up-front state.
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
      onProgress: makeLaunchProgressWriter(),
    });
  };
  const result = withLaunchSlot(
    () => launchWithRetry(launch, options.retrySleepMs, options.retrySleep),
    options,
  );
  if (result.status === "failed") {
    deleteState(slug, options.stateDir);
    console.error(
      "flow new: claude exited immediately after launch — the tmux window did not stay up.",
    );
    console.error(
      "  Check your Claude Code install (try running `claude` manually in this repo), then retry.",
    );
    if (result.stderr) console.error(`  ${result.stderr}`);
    return 1;
  }

  // Mode-2 backstop: the verified launch confirmed a live, seeded window, but a
  // window can still vanish between that check and now (a racing kill, a tmux
  // bounce). Never keep state for a window that is already gone — delete the
  // up-front file so no orphaned `phase=starting` pipeline survives.
  if (!windowExists(slug)) {
    deleteState(slug, options.stateDir);
    console.error(
      "flow new: the tmux window vanished after launch — not writing state.",
    );
    console.error(
      "  retry `flow new`; if it persists, check tmux/claude health.",
    );
    return 1;
  }

  // State was written up front and survived verification; the supervisor (PR 2)
  // overwrites worktree + phase + pr at each transition from here.
  // First line is the machine-read contract token — raw, never colorized.
  console.log(`${FLOW_SESSION}:${slug}`);
  if (result.status === "launched-not-confirmed") {
    // Non-destructive timeout: the pane is alive, the supervisor just hasn't
    // confirmed the seed within the short budget (its first phase write lands
    // ~60s out). Leave it running; the lazy reaper backstops a true never-start.
    console.error(
      dim("flow new: launched; supervisor still starting — attach to verify"),
    );
  } else {
    console.log(dim(`flow new: created — attach with \`flow attach ${slug}\``));
  }
  return 0;
}

function runResume(name: string, options: NewOptions): number {
  if (!name || name.trim() === "") {
    console.error("flow new --resume: <name> is required.");
    console.error("usage: flow new --resume <name>");
    return 1;
  }

  const slug = slugify(name);
  if (!slug || slug !== name) {
    console.error(`flow new --resume: '${name}' is not a valid pipeline name.`);
    console.error("  pass the slug as printed by `flow ls`.");
    return 1;
  }

  const state = readState(slug, options.stateDir);
  if (!state) {
    console.error(`flow new --resume: no pipeline state for '${slug}'.`);
    console.error("  run `flow new <description>` to start a fresh pipeline.");
    return 1;
  }

  if (!state.repo || !fs.existsSync(state.repo)) {
    // The repo path recorded at `flow new` time has moved or been deleted.
    // tmux would surface this as an opaque "-c: no such directory" — give
    // the user the actual cause so they can decide to recreate the state.
    console.error(`flow new --resume: pipeline '${slug}' was launched against`);
    console.error(`  ${state.repo || "(no repo recorded)"}`);
    console.error(`  but that path no longer exists. Move the repo back, or`);
    console.error(
      `  run \`flow done ${slug}\` and start fresh with \`flow new\`.`,
    );
    return 1;
  }

  const exists = windowExists(slug);
  if (exists && isPaneAlive(slug)) {
    console.error(`flow new --resume: pipeline '${slug}' is still running.`);
    console.error(`  attach with \`flow attach ${slug}\` instead of resuming.`);
    return 1;
  }

  // The repo non-null guard above already returned; bind it so the launch
  // closure below keeps the narrowing (TS drops it across the arrow body).
  const repo = state.repo;
  // Prefer the actual worktree path recorded at create-time; fall back to the
  // deterministic derivation when state predates the worktree write (or when
  // the pipeline crashed before step 2). Either way the resumed session
  // re-pre-authorizes the worktree as an MCP workspace root.
  const worktree = state.worktree ?? deriveWorktreePath(repo, slug);
  const settingsPath = launchSettingsPathFor(options);
  const seed = flowPipelineResumeSeed(slug);
  const command =
    options.command ??
    buildLaunchCommand(worktree, state.effort, settingsPath, state.model);
  // Verify the relaunched process stays up AND consumes the resume seed, same as
  // the fresh path — a bare respawn/create exit code only proves tmux forked the
  // shell, and a claude idle at an empty input box passes a liveness probe. The
  // verified launcher owns seed delivery. Bounded retry so a transient hiccup
  // self-heals; the timeout is non-destructive (a live-but-slow resume is
  // `launched-not-confirmed`, never respawn-killed).
  //
  // Resume consumption baseline: on resume the phase is already past `starting`,
  // so consumption is "the resumed session RE-STAMPED the seed-ingested marker OR
  // the resumed supervisor bumped `updatedAt` past this pre-respawn value". BOTH
  // baselines are captured ONCE before the retry loop (not per-attempt): paired
  // with the non-destructive timeout, a late advance no longer respawn-kills a
  // live session. The marker baseline is load-bearing — the original fresh launch
  // stamped `seedIngestedAt` and `runResume` never clears it (writeState is not
  // called here), so a bare `seedIngestedAt != null` check would short-circuit
  // `consumed()` true on the FIRST probe off the STALE marker, skip the
  // resume-seed send-keys (the double-submit guard), and latch a false-success
  // resume that never delivered the seed. Requiring `seedIngestedAt` to DIFFER
  // from the pre-resume value means only a fresh re-stamp by the resumed session
  // counts. ACCEPTED rare trade-off: a dead-then-retried resume whose prior dead
  // attempt bumped `updatedAt` reads "consumed" over the fresh respawn — but that
  // only means the supervisor DID start at some point, and resume-over-it is the
  // user's intent. runResume never writes or deletes state, so the read is
  // non-mutating; the window pre-existed the resume.
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
  const launch = () => {
    const deps = { consumed, onProgress: makeLaunchProgressWriter() };
    return exists
      ? respawnWindowVerified(slug, repo, command, seed, deps)
      : createWindowVerified(slug, repo, command, seed, deps);
  };
  const result = withLaunchSlot(
    () => launchWithRetry(launch, options.retrySleepMs, options.retrySleep),
    options,
  );
  if (result.status === "failed") {
    console.error(
      "flow new --resume: claude exited immediately after launch — the tmux window did not stay up.",
    );
    console.error(
      "  Check your Claude Code install (try running `claude` manually in this repo), then retry.",
    );
    if (result.stderr) console.error(`  ${result.stderr}`);
    return 1;
  }

  // Phase + worktree + pr stay as the crash left them. The supervisor's
  // first real transition is what updates state.json.
  // First line is the machine-read contract token — raw, never colorized.
  console.log(`${FLOW_SESSION}:${slug}`);
  if (result.status === "launched-not-confirmed") {
    console.error(
      dim("flow new: launched; supervisor still starting — attach to verify"),
    );
  } else {
    console.log(dim(`flow new: resumed — attach with \`flow attach ${slug}\``));
  }
  return 0;
}

/**
 * Derive the deterministic worktree path the supervisor's step 2 will pass
 * to `flow-new-worktree` for this slug. Mirrors `flow-new-worktree.ts`'s rule
 * (`path.dirname(repo)/<repoName>-<toDirSuffix(branch)>`, with `branch ===
 * slug`); `toDirSuffix` is a no-op for a slash-free slug but is reused here so
 * the two derivations cannot drift. This is the COMMON-CASE path only — when
 * `<repo>-<slug>` already exists (parallel pipelines, stale worktrees),
 * `flow-new-worktree`'s `findAvailableSlot` auto-suffixes (`-2`/`-3`/…), so the
 * actual worktree may diverge from this value. `/flow-pipeline` step 2's
 * best-effort runtime `/add-dir` of the actual path covers that divergence.
 */
export function deriveWorktreePath(repo: string, slug: string): string {
  return path.join(
    path.dirname(repo),
    `${path.basename(repo)}-${toDirSuffix(slug)}`,
  );
}

/**
 * Prepend `--add-dir <worktree>` so the chrome-devtools MCP treats the
 * per-pipeline worktree as a workspace root, letting `take_screenshot
 * --filePath` write UI evidence into `<worktree>/.flow-tmp/ui-evidence/`
 * instead of falling back to the session cwd (issue #317). The worktree does
 * not exist yet at launch — it is created later by step 2 — and that is fine:
 * `claude --add-dir <nonexistent-path>` does not error at launch (verified
 * against claude 2.1.183), so pre-authorizing the path is safe. The a11y
 * snapshot remains the evidence gate regardless; this only makes the
 * supplementary screenshot artifact land in the documented preferred path.
 * NOTE: `--add-dir` is documented to grant Claude Code's own file-tool access;
 * its propagation to the MCP server's screenshot sandbox is the load-bearing
 * (and externally unverified) assumption behind this fix — confirm via a live
 * dogfood. Best-effort either way: a bad value degrades to today's session-cwd
 * fallback, never blocking the pipeline.
 */
function launchArgv(
  worktree: string,
  effort: EffortLevel | undefined,
  settingsPath: string,
  model?: ModelAlias,
): string[] {
  // `env FLOW_PIPELINE=1` prefix: there is no env object on this launch path
  // (the spawned claude inherits the parent env via tmux new-window), so the
  // marker is injected as an argv prefix. It lets leaf skills like
  // `/flow-research` detect they are running inside the supervisor and suppress
  // their standalone-only `claude -p` fallback tier — the no-nested-LLM
  // boundary the supervisor must never cross.
  //
  // No positional seed: the seed is delivered ONLY via send-keys (the verified
  // launcher owns it), since claude does not auto-run a positional prompt — the
  // old positional was dead weight that plausibly slowed the TUI cold-start.
  // `--settings <flow-scoped file>` registers the UserPromptSubmit seed-ingested
  // hook; it is ADDITIVE (the user's global settings still apply).
  //
  // `--model` precedes `--effort` (both before `--settings`) in a deterministic
  // order so the argv assertions stay stable. Each is omitted when unset.
  const base = ["env", "FLOW_PIPELINE=1", "claude", "--add-dir", worktree];
  const withModel = model ? [...base, "--model", model] : base;
  const withEffort = effort ? [...withModel, "--effort", effort] : withModel;
  return [...withEffort, "--settings", settingsPath];
}

/** Absolute path to the seed-ingested hook script, resolved relative to THIS
 * module so it works from a worktree smoke test AND the global install (Bun
 * resolves import.meta through symlinks to the canonical source file). */
function hookScriptPath(): string {
  const here =
    (import.meta as { dir?: string }).dir ??
    path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "flow-seed-ingested-hook.ts");
}

/**
 * Idempotently writes the flow-scoped `claude --settings` file registering the
 * UserPromptSubmit seed-ingested hook by absolute path. Writes ONLY this
 * flow-owned file — NEVER the user's global ~/.claude/settings.json (the
 * `--settings` flag is additive, so global settings still apply). Skips the
 * write when the on-disk content already matches (no mtime churn).
 */
export function ensureLaunchSettings(
  settingsPath: string = FLOW_LAUNCH_SETTINGS_PATH,
): void {
  const desired =
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: hookScriptPath() }] },
          ],
        },
      },
      null,
      2,
    ) + "\n";
  try {
    if (fs.readFileSync(settingsPath, "utf8") === desired) return;
  } catch {
    // absent / unreadable — fall through to write
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  // Atomic publish: write a per-PID temp file then rename onto the target, so a
  // concurrent `claude --settings` read during a parallel-launch burst never
  // observes a torn (half-written) file. rename(2) is atomic on POSIX.
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, desired);
  fs.renameSync(tmp, settingsPath);
}

// The seed text is defined ONCE in these helpers and delivered ONLY via
// send-keys by the verified launcher (no positional argv copy), so there is no
// second definition to drift from.
function flowPipelineSeed(description: string): string {
  const slug = slugify(description);
  return `[pipeline-slug: ${slug}]\nUse the /flow-pipeline skill for: ${description}`;
}

function flowPipelineResumeSeed(slug: string): string {
  return `[pipeline-slug: ${slug}]\nUse the /flow-pipeline skill in --resume mode for: ${slug}`;
}

/**
 * Resolves the flow-scoped `claude --settings` path: the explicit option, then
 * a `FLOW_LAUNCH_SETTINGS_PATH` env override (tests redirect it off the real
 * ~/.flow), then the default constant.
 */
function launchSettingsPathFor(options: NewOptions): string {
  return (
    options.launchSettingsPath ??
    process.env.FLOW_LAUNCH_SETTINGS_PATH ??
    FLOW_LAUNCH_SETTINGS_PATH
  );
}

/**
 * Builds the verified-launch argv, registering the seed-ingested hook in the
 * flow-scoped settings file first (best-effort — a write hiccup degrades to no
 * hook, and the lazy reaper still backstops orphan cleanup). The supervisor
 * skill is invoked by the chat session itself; this argv just launches claude.
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
        `flow new: could not write launch settings: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
  }
  return launchArgv(worktree, effort, settingsPath, model);
}

/**
 * A dim/stderr progress writer for the residual launch wait, throttled to ~once
 * per 3s so a wait is legible without spamming. NEVER writes stdout — the
 * `flow:<slug>` first line is a machine-read contract token.
 */
function makeLaunchProgressWriter(): (elapsedMs: number) => void {
  let lastBucket = 0;
  return (elapsedMs: number) => {
    const bucket = Math.floor(elapsedMs / 3000);
    if (bucket <= lastBucket) return;
    lastBucket = bucket;
    process.stderr.write(
      dim(
        `flow new: waiting for supervisor to start (${Math.round(elapsedMs / 1000)}s)…\n`,
      ),
    );
  };
}

/**
 * Wraps the verified launch in the host-wide launch-concurrency semaphore so a
 * burst of parallel `flow new` launches stops oversubscribing claude
 * cold-starts. Fail-open (never blocks a launch): on acquire timeout the launch
 * proceeds holding no slot. The sem dir honors a `FLOW_LAUNCH_SEM_DIR` env
 * override (tests redirect it off the real ~/.flow); the cap is
 * `resolveLaunchConcurrency`.
 */
function withLaunchSlot(
  launch: () => VerifiedLaunchResult,
  options: NewOptions,
): VerifiedLaunchResult {
  const semDir = process.env.FLOW_LAUNCH_SEM_DIR ?? FLOW_LAUNCH_SEM_DIR;
  const slots = resolveLaunchConcurrency(process.env);
  const semOpts =
    options.launchSemTimeoutMs !== undefined
      ? { timeoutMs: options.launchSemTimeoutMs, pollMs: 5 }
      : {};
  return withTestSemaphore(semDir, slots, launch, semOpts).result;
}

// Duplicated from done.ts's confirm() rather than extracted to a shared
// bin/lib/confirm.ts: two consumers with distinct gate semantics (destructive
// done-confirm vs. session-spawn resume preview) don't yet justify a shared
// module (No-premature-abstraction). If a third consumer appears, extract then.
function confirmResume(prompt: string): boolean {
  process.stdout.write(`${prompt} [y/N] `);
  const buf = Buffer.alloc(16);
  let len = 0;
  try {
    len = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  const answer = buf.subarray(0, len).toString("utf8").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function resolveRepoRoot(cwd: string): string | null {
  // node:child_process spawnSync, not Bun.spawnSync, so the new vitest cases
  // exercising runFresh's autoMerge persistence run under node — Bun.spawnSync
  // is undefined in the vitest worker. Production runs through bin/flow which
  // is bun-shebanged, so node-compat here costs nothing.
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  if (!out || !fs.existsSync(out)) return null;
  return out;
}
