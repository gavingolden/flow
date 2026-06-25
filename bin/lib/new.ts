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
import { argsContainHelp, printVerbHelp } from "./help";
import { slugify } from "./slug";
import { toDirSuffix } from "./worktree-slot";
import {
  createWindowVerified,
  respawnWindowVerified,
  windowExists,
  isPaneAlive,
  FLOW_SESSION,
} from "./tmux";
import {
  readState,
  writeState,
  nowIso,
  EFFORT_LEVELS,
  type EffortLevel,
} from "./state";
import { sleepSync } from "./sleep";
import { dim } from "./color";

/**
 * Bounded retry budget for the verified window create. A single transient
 * launch failure (e.g. a momentary tmux/claude hiccup) should self-heal, but
 * the loop must terminate — an unbounded retry would hang `flow new` forever
 * against a genuinely broken `claude` install. Three attempts trades a brief
 * stall for self-healing without masking a persistent failure.
 */
const WINDOW_CREATE_MAX_ATTEMPTS = 3;
const WINDOW_CREATE_RETRY_MS = 150;

/**
 * Runs `launch` (a verified create or respawn) up to WINDOW_CREATE_MAX_ATTEMPTS
 * times with a short backoff between tries, returning the first `ok` result or
 * the last failure. Bounded so a genuinely broken `claude` can't hang the CLI;
 * a single transient launch failure self-heals on the next attempt. The verified
 * launcher already cleans up its own half-created window per attempt, so an
 * exhausted retry leaves nothing behind.
 */
function launchWithRetry(
  launch: () => { ok: boolean; stderr: string },
  retryMs: number = WINDOW_CREATE_RETRY_MS,
): { ok: boolean; stderr: string } {
  let last = { ok: false, stderr: "" };
  for (let attempt = 0; attempt < WINDOW_CREATE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && retryMs > 0) sleepSync(retryMs);
    last = launch();
    if (last.ok) return last;
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
   * Backoff (ms) between bounded window-create retries. Test seam only —
   * production uses the WINDOW_CREATE_RETRY_MS default; the orphan-repro
   * harness passes 0 so its N>=20 loop doesn't accrue real sleep time.
   */
  retrySleepMs?: number;
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
      return a !== "--no-auto-merge" && a !== "--wait-for-copilot";
    })
    .join(" ");
  return runNew(description, {
    ...options,
    noAutoMerge,
    waitForCopilot,
    copilotReview,
    effort,
  });
}

function runFresh(description: string, options: NewOptions): number {
  if (!description || description.trim() === "") {
    console.error("flow new: description is required.");
    console.error(
      "usage: flow new [--no-auto-merge] [--wait-for-copilot] [--copilot-review <auto|always|never>] [--effort <low|medium|high|xhigh|max>] <description>",
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

  const worktree = deriveWorktreePath(repo, slug);
  const seed = flowPipelineSeed(description);
  const command =
    options.command ?? defaultCommand(description, worktree, options.effort);
  // Verify the window's process actually stayed up AND consumed the seed before
  // persisting state. A bare `createWindow` only proves tmux forked the shell,
  // and a `claude` idle at an empty input box passes a liveness probe, so a
  // dead-on-arrival pipeline would otherwise leave an orphaned state file (the
  // intermittent `flow new` bug). createWindowVerified owns seed delivery and
  // kills its own half-created window on failure, so an exhausted retry leaves
  // nothing behind.
  const result = launchWithRetry(
    () => createWindowVerified(slug, repo, command, seed),
    options.retrySleepMs,
  );
  if (!result.ok) {
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
  // window can still vanish between that check and the state write (a racing
  // kill, a tmux bounce). Never persist state for a window that is already gone.
  if (!windowExists(slug)) {
    console.error(
      "flow new: the tmux window vanished after launch — not writing state.",
    );
    console.error(
      "  retry `flow new`; if it persists, check tmux/claude health.",
    );
    return 1;
  }

  // Write the initial state file. The supervisor (PR 2) overwrites
  // worktree + phase + pr at each transition. Pre-existing state for the
  // same slug shouldn't happen because windowExists() blocked above; if it
  // does (e.g. external tmux reset), the new write supersedes.
  const existing = readState(slug, options.stateDir);
  writeState(
    {
      slug,
      phase: "starting",
      repo,
      worktree: existing?.worktree,
      autoMerge: options.noAutoMerge ? false : undefined,
      waitForCopilot: options.waitForCopilot ? true : undefined,
      copilotReview: options.copilotReview,
      effort: options.effort,
      updatedAt: nowIso(),
    },
    options.stateDir,
  );

  // First line is the machine-read contract token — raw, never colorized.
  console.log(`${FLOW_SESSION}:${slug}`);
  console.log(dim(`flow new: created — attach with \`flow attach ${slug}\``));
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
  const seed = flowPipelineResumeSeed(slug);
  const command =
    options.command ?? resumeCommand(slug, worktree, state.effort);
  // Verify the relaunched process stays up AND consumes the resume seed, same as
  // the fresh path — a bare respawn/create exit code only proves tmux forked the
  // shell, and a claude idle at an empty input box passes a liveness probe.
  // Without this, `--resume` reports a false "resumed" success over a window
  // whose claude died on launch or never picked up the seed. The verified
  // launcher owns seed delivery. Bounded retry so a transient hiccup self-heals.
  const result = launchWithRetry(
    () =>
      exists
        ? respawnWindowVerified(slug, repo, command, seed)
        : createWindowVerified(slug, repo, command, seed),
    options.retrySleepMs,
  );
  if (!result.ok) {
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
  console.log(dim(`flow new: resumed — attach with \`flow attach ${slug}\``));
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
  prompt: string,
  effort?: EffortLevel,
): string[] {
  const base = ["claude", "--add-dir", worktree];
  return effort ? [...base, "--effort", effort, prompt] : [...base, prompt];
}

// The seed text is defined ONCE here and reused for both the hybrid positional
// argv (the zero-cost fallback for claude versions that auto-run a positional
// prompt) AND the send-keys delivery the verified launcher now owns, so the two
// can never drift.
function flowPipelineSeed(description: string): string {
  return `Use the /flow-pipeline skill for: ${description}`;
}

function flowPipelineResumeSeed(slug: string): string {
  return `Use the /flow-pipeline skill in --resume mode for: ${slug}`;
}

function defaultCommand(
  description: string,
  worktree: string,
  effort?: EffortLevel,
): string[] {
  // The supervisor skill is invoked by the chat session itself, not by
  // passing the slash command on the CLI. We launch claude with an initial
  // prompt that tells the user (and the LLM, once active) what to do.
  return launchArgv(worktree, flowPipelineSeed(description), effort);
}

function resumeCommand(
  slug: string,
  worktree: string,
  effort?: EffortLevel,
): string[] {
  // The supervisor parses this prefix to detect resume mode and walk the
  // decision tree in references/failure-recovery.md section (b).
  return launchArgv(worktree, flowPipelineResumeSeed(slug), effort);
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
