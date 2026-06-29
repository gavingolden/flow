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
 * The orchestrator RUN phase (run/status/ls) is deferred — those subcommands
 * surface a loud deferred message and exit 2.
 */

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { argsContainHelp, isHelpFlag, printVerbHelp } from "./help";
import { slugify } from "./slug";
import {
  epicDirRelative,
  EPIC_DESIGN_FILENAME,
  EPIC_MANIFEST_FILENAME,
} from "./epic-manifest-schema";
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
      console.error(
        "flow epic run: the epic orchestrator run phase is deferred — out of scope for this skeleton.",
      );
      return 2;
    case "status":
      console.error(
        "flow epic status is deferred — out of scope for this skeleton.",
      );
      return 2;
    case "ls":
      console.error(
        "flow epic ls is deferred — out of scope for this skeleton.",
      );
      return 2;
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
