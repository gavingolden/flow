/**
 * `flow feature <create|resume>` — the feature-pipeline verb, a mini-dispatcher
 * mirroring `flow epic`.
 *
 * `flow feature create <description>` — slugify, create a tmux window, write
 * initial state. The supervisor skill takes over from there. Does not
 * auto-attach by default; the user runs `flow attach <slug>` separately.
 *
 * `flow feature resume <name> [<name> ...]` — re-launch one or more crashed
 * supervisor sessions in their existing tmux windows (or recreate the window
 * if tmux died too) using the resume seed prompt. Refuses if there is no state
 * for `<name>` or if the existing pane has a live process. With >=2 names it
 * previews the list and confirms once (unless `-y/--yes`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { argsContainHelp, isHelpFlag, printVerbHelp } from "./help";
import { slugify, isValidSlug } from "./slug";
import { confirmStdin } from "./confirm";
import { toDirSuffix, MAX_SUFFIX_ATTEMPTS } from "./worktree-slot";
import {
  createWindowVerified,
  respawnWindowVerified,
  windowExists,
  isPaneAlive,
  panePid,
  FLOW_SESSION,
  type VerifiedLaunchResult,
} from "./tmux";
import { livenessOf, pidStartEpoch } from "./liveness";
import {
  readState,
  writeState,
  deleteState,
  nowIso,
  EFFORT_LEVELS,
  type EffortLevel,
  MODEL_ALIASES,
  type ModelAlias,
  PHASE_MODEL_FLAGS,
  type PipelineState,
} from "./state";
import {
  readDefaultModel,
  collectModelConfigWarnings,
  type ReadConfigFile,
} from "./models-config";
import { sleepSync } from "./sleep";
import { appendLaunchRecord } from "./launch-log";
import { dim } from "./color";
import { withTestSemaphore, resolveLaunchConcurrency } from "./lock";
import {
  FLOW_CLAUDE_HOME,
  FLOW_LAUNCH_SEM_DIR,
  FLOW_LAUNCH_SETTINGS_PATH,
  installedHelperPath,
} from "./paths";
import { installBaseBranchGuard } from "./base-branch-guard";
import { resolveLauncherBackend, type LauncherId } from "./launcher-config";
import { plainLaunch, plainResume, type PlainLaunchDeps } from "./launcher";
import type { LivenessDeps } from "./liveness";

/**
 * Bounded retry budget for the verified window launch. A single transient
 * launch failure (e.g. a momentary tmux/claude hiccup) should self-heal, but
 * the loop must terminate — an unbounded retry would hang `flow feature create` forever
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
): VerifiedLaunchResult & { attempts: number } {
  let last: VerifiedLaunchResult = { status: "failed", stderr: "" };
  let attempts = 0;
  for (let attempt = 0; attempt < WINDOW_CREATE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const ms = retrySleepMs ?? backoffMsForAttempt(attempt);
      if (ms > 0) sleep(ms);
    }
    attempts = attempt + 1;
    last = launch();
    if (last.status !== "failed") return { ...last, attempts };
  }
  return { ...last, attempts };
}

export type FeatureOptions = {
  /** Override the cwd for the new window (default: process.cwd()). */
  cwd?: string;
  /** Override the command launched in the window. */
  command?: string[];
  /** Resume a crashed pipeline rather than start a new one. */
  resume?: boolean;
  /**
   * `--resume --force`: reclaim a live-but-idle pane in place instead of
   * refusing it. The epic orchestrator's autonomous-retry path sets this to
   * relaunch a halted feature whose `claude` pane is alive-but-idle
   * (needs-human / gated / CI-fail). This is a CLEAN lifecycle respawn owned by
   * the resume helper (the same `respawnWindowVerified` path the dead-pane
   * resume already uses) — NOT `send-keys` input injection. Absent ⇒ the
   * existing live-pane refusal stands.
   */
  force?: boolean;
  /** Override the state directory (test seam). */
  stateDir?: string;
  /**
   * Explicit pipeline slug from `--slug <value>`. When set, `runFresh` uses it
   * verbatim instead of deriving one via `slugify(description)`, and keeps the
   * `windowExists` hard-fail on collision (an explicit slug is a caller's
   * assertion of a unique id — see runFresh). Set ONLY by `runCreateCli`;
   * `runResume` is unaffected. Absent ⇒ derive + auto-disambiguate.
   */
  slug?: string;
  /**
   * Explicit epic membership from `--epic <epic-slug>/<feature-id>`. Set by
   * `flow epic launch` (via `bin/lib/epic-launch.ts`'s auto-appended argv) or
   * directly by a human launching an epic feature manually. Persisted
   * verbatim onto `PipelineState.epic`; `/flow-pipeline` step 3 reads it to
   * thread an `EPIC:` marker into the discovery spawn prompt.
   */
  epic?: { slug: string; featureId: string };
  /**
   * Injectable `~/.flow/config.json` reader (test seam only). Threaded into
   * `readDefaultModel` / `collectModelConfigWarnings` so the launch-time
   * `models.default` resolution can be exercised without touching the real
   * config. Production uses the module default (reads via flowConfigPath()).
   */
  readConfig?: ReadConfigFile;
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
   * Per-phase model overrides, set via `flow feature create --model-<phase>
   * <alias>`. Each is persisted onto the matching `PipelineState.model*` field
   * and consumed by the supervisor at its named Task-spawn site — NOT threaded
   * into the launch argv (only the session `--model` reaches claude at launch).
   * Omitted when absent (absent ≡ the phase inherits the session model, with the
   * verify-`sonnet` and scout/coder exceptions documented at their spawn sites).
   */
  modelPlanning?: ModelAlias;
  modelImplement?: ModelAlias;
  modelReview?: ModelAlias;
  modelVerify?: ModelAlias;
  modelFixApplier?: ModelAlias;
  modelConsolidator?: ModelAlias;
  modelMergeResolver?: ModelAlias;
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
   * Launch-breadcrumb log path override (test seam only). Production
   * defaults to ~/.flow/logs/launch.jsonl inside `appendLaunchRecord`.
   */
  launchLogPath?: string;
  /**
   * Path to the flow-scoped `claude --settings` file the launch argv references
   * and `ensureLaunchSettings` writes. Test seam only — production uses
   * FLOW_LAUNCH_SETTINGS_PATH; tests point it at a temp file to avoid touching
   * the real ~/.flow and to assert the argv path.
   */
  launchSettingsPath?: string;
  /**
   * Explicit launcher backend from `--tmux` / `--no-tmux`. Wins over the
   * pipeline's recorded `state.launcher` (resume) and the config `launcher`
   * key. Absent ⇒ state > config > default-plain precedence.
   */
  launcher?: LauncherId;
  /** tmux-on-PATH probe seam for launcher resolution (test only). */
  tmuxOnPath?: () => boolean;
  /** Plain-backend deps seam (spawn/isTTY/liveness — test only). */
  plainDeps?: PlainLaunchDeps & { liveness?: LivenessDeps };
};

export function runNew(
  input: string,
  options: FeatureOptions = {},
): number | Promise<number> {
  if (options.resume) return runResume(input, options);
  return runFresh(input, options);
}

/**
 * CLI shim for `bin/flow`'s `feature` verb — a mini-dispatcher mirroring
 * `runEpicCli`. Guards the verb-position help flag first (`flow feature
 * --help`), then dispatches on the subcommand: `create` (fresh launch) and
 * `resume` (re-launch crashed pipelines). A verb-position help flag must fire
 * ONLY at the verb position — using `argsContainHelp(args)` here would also
 * match a subcommand-level `flow feature create --help` and wrongly print the
 * verb help; instead that falls through to the subcommand's own help guard.
 */
export function runFeatureCli(
  args: string[],
  options: FeatureOptions = {},
): number | Promise<number> {
  if (isHelpFlag(args[0])) {
    printVerbHelp("feature");
    return 0;
  }
  const sub = args[0];
  switch (sub) {
    case "create":
      return runCreateCli(args.slice(1), options);
    case "resume":
      return runResumeCli(args.slice(1), options);
    case undefined:
      console.error("flow feature: a subcommand is required (create|resume).");
      console.error("usage: flow feature <create|resume>");
      return 2;
    default:
      console.error(`flow feature: unknown feature subcommand: ${sub}`);
      console.error("usage: flow feature <create|resume>");
      return 2;
  }
}

/**
 * `flow feature resume <name> [<name> ...]` — re-launch one or more crashed
 * pipelines. Intercepts --help before any side-effect; a single slug routes
 * straight through the byte-identical single-slug path (no preview), two or
 * more slugs preview the list and confirm once (unless -y/--yes).
 */
function runResumeCli(
  rest: string[],
  options: FeatureOptions = {},
): number | Promise<number> {
  if (argsContainHelp(rest)) {
    printVerbHelp("feature");
    return 0;
  }
  // Detect the bypass flag for the multi-slug preview. Strip --yes/-y (and any
  // stray flags) from the positional list; the remainder is the de-duplicated
  // slug list.
  const yes = rest.includes("--yes") || rest.includes("-y");
  // `--force` reclaims a live-but-idle pane in place (the epic orchestrator's
  // autonomous-retry path). It's stripped from the slug list by the
  // `!a.startsWith("-")` filter below; detect it here to thread into options.
  const force = rest.includes("--force");
  // --tmux / --no-tmux: per-run launcher override, mutually exclusive.
  // Validated before any side-effect, mirroring runCreateCli.
  const wantTmux = rest.includes("--tmux");
  const wantNoTmux = rest.includes("--no-tmux");
  if (wantTmux && wantNoTmux) {
    console.error(
      "flow feature resume: --tmux and --no-tmux are mutually exclusive.",
    );
    return 1;
  }
  const launcher: LauncherId | undefined = wantTmux
    ? "tmux"
    : wantNoTmux
      ? "plain"
      : options.launcher;
  const slugs = rest.filter(
    (a) => a !== "--yes" && a !== "-y" && !a.startsWith("-"),
  );
  const seen = new Set<string>();
  const deduped = slugs.filter((s) => !seen.has(s) && seen.add(s));
  if (deduped.length === 0) {
    console.error("flow feature resume: <name> is required.");
    console.error("usage: flow feature resume <name> [<name> ...]");
    return 1;
  }
  // Single-slug resume routes straight through the UNCHANGED single-slug
  // path — no preview, no confirm — so its output stays byte-identical.
  if (deduped.length === 1) {
    return runNew(deduped[0], { ...options, resume: true, force, launcher });
  }
  // Two or more slugs each spawn a Claude Code session: preview the count +
  // names and confirm once (unless --yes) before launching anything.
  if (!yes) {
    console.log(`will resume ${deduped.length} pipeline(s):`);
    for (const slug of deduped) console.log(`  ${slug}`);
    if (!confirmStdin("proceed?")) {
      console.log(dim("flow feature resume: aborted — nothing resumed"));
      return 0;
    }
  }
  // Sequential launch (never concurrent) so tmux window creation stays
  // deterministic; per-slug validation/refusal is inherited from runResume.
  // A plain-backend resume returns a Promise (the foreground child's exit is
  // awaited); the step recursion sequences those without forcing the all-sync
  // tmux path onto a Promise return.
  let failed = 0;
  const iter = deduped[Symbol.iterator]();
  const step = (): number | Promise<number> => {
    const next = iter.next();
    if (next.done) return failed > 0 ? 1 : 0;
    const r = runNew(next.value, { ...options, resume: true, force, launcher });
    if (typeof r === "number") {
      if (r !== 0) failed += 1;
      return step();
    }
    return r.then((code) => {
      if (code !== 0) failed += 1;
      return step();
    });
  };
  return step();
}

/**
 * `flow feature create <description>` — fresh launch. Intercepts --help before
 * any side-effect (slug computation, tmux window create, state file write),
 * parses + enum-validates the value flags, then dispatches to `runNew`.
 */
function runCreateCli(
  args: string[],
  options: FeatureOptions = {},
): number | Promise<number> {
  if (argsContainHelp(args)) {
    printVerbHelp("feature");
    return 0;
  }
  const noAutoMerge = args.includes("--no-auto-merge");
  const waitForCopilot = args.includes("--wait-for-copilot");
  const forceResearch = args.includes("--research");

  // --tmux / --no-tmux: per-run launcher override, mutually exclusive.
  // Validated here, before any side-effect (slug, state write), mirroring
  // --slug's validate-before-state discipline.
  const wantTmux = args.includes("--tmux");
  const wantNoTmux = args.includes("--no-tmux");
  if (wantTmux && wantNoTmux) {
    console.error(
      "flow feature create: --tmux and --no-tmux are mutually exclusive.",
    );
    return 1;
  }
  const launcher: LauncherId | undefined = wantTmux
    ? "tmux"
    : wantNoTmux
      ? "plain"
      : options.launcher;

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
      console.error("flow feature create: --copilot-review requires a value.");
      console.error("  expected one of: auto, always, never");
      return 1;
    }
    if (!(COPILOT_REVIEW_VALUES as readonly string[]).includes(value)) {
      console.error(
        `flow feature create: invalid --copilot-review value '${value}'.`,
      );
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
      console.error("flow feature create: --effort requires a value.");
      console.error("  expected one of: low, medium, high, xhigh, max");
      return 1;
    }
    if (!(EFFORT_LEVELS as readonly string[]).includes(value)) {
      console.error(`flow feature create: invalid --effort value '${value}'.`);
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
      console.error("flow feature create: --model requires a value.");
      console.error("  expected one of: opus, haiku, sonnet, fable");
      return 1;
    }
    if (!(MODEL_ALIASES as readonly string[]).includes(value)) {
      console.error(`flow feature create: invalid --model value '${value}'.`);
      console.error("  expected one of: opus, haiku, sonnet, fable");
      return 1;
    }
    model = value as ModelAlias;
  }
  const modelValueToken = modelIdx >= 0 ? args[modelIdx + 1] : undefined;

  // --slug <value> is a VALUE flag mirroring --effort/--model. Validate the
  // slug SHAPE here (via isValidSlug — not slugify round-trip, which caps at 5
  // tokens/40 chars and would reject a legitimately longer explicit slug),
  // before any side-effect, so a malformed value exits non-zero and writes no
  // state. The flag + its value token are both stripped from the description.
  let slug: string | undefined;
  const slugIdx = args.indexOf("--slug");
  if (slugIdx >= 0) {
    const value = args[slugIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(
        "flow feature create: invalid --slug — a value is required.",
      );
      console.error("  expected a lowercase kebab slug, e.g. my-explicit-slug");
      return 1;
    }
    if (!isValidSlug(value)) {
      console.error(`flow feature create: invalid --slug value '${value}'.`);
      console.error(
        "  expected lowercase kebab-case (a-z, 0-9, single hyphens), max 60 chars",
      );
      return 1;
    }
    slug = value;
  }
  const slugValueToken = slugIdx >= 0 ? args[slugIdx + 1] : undefined;

  // --epic <epic-slug>/<feature-id> is a VALUE flag mirroring --slug: a single
  // slash-separated token keeps the strip-from-description logic identical.
  // Validate BEFORE any side-effect (slug half via isValidSlug, id half
  // non-empty, exactly one `/` separator) — mirroring --slug's
  // validate-before-state discipline exactly; invalid ⇒ exit 1, no state
  // write. `flow epic launch` passes this automatically (bin/lib/epic-launch.ts);
  // a human can also pass it directly for a manually launched epic feature.
  let epic: { slug: string; featureId: string } | undefined;
  const epicIdx = args.indexOf("--epic");
  if (epicIdx >= 0) {
    const value = args[epicIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(
        "flow feature create: invalid --epic — a value is required.",
      );
      console.error(
        "  expected <epic-slug>/<feature-id>, e.g. my-epic/feature-a",
      );
      return 1;
    }
    const parts = value.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      console.error(`flow feature create: invalid --epic value '${value}'.`);
      console.error(
        "  expected exactly one '/' separator: <epic-slug>/<feature-id>",
      );
      return 1;
    }
    const [epicSlugPart, featureIdPart] = parts;
    if (!isValidSlug(epicSlugPart)) {
      console.error(
        `flow feature create: invalid --epic slug '${epicSlugPart}'.`,
      );
      console.error(
        "  expected lowercase kebab-case (a-z, 0-9, single hyphens), max 60 chars",
      );
      return 1;
    }
    epic = { slug: epicSlugPart, featureId: featureIdPart };
  }
  const epicValueToken = epicIdx >= 0 ? args[epicIdx + 1] : undefined;

  // --model-<phase> value flags (planning / implement / review / verify /
  // fix-applier / consolidator / merge-resolver), each mirroring --model:
  // enum-validate here before any side-effect (invalid ⇒ exit 1, no state
  // write), and strip flag+value from the description. Unlike --model, these
  // are NOT threaded into the launch argv — they persist onto PipelineState
  // for the supervisor to resolve at each named Task-spawn site. Any subset
  // may be passed. PHASE_MODEL_FLAGS is state.ts's single source of truth,
  // so a new phase flag is added in exactly one place.
  const phaseModels: Partial<Record<string, ModelAlias>> = {};
  const phaseModelValueTokens = new Map<string, string | undefined>();
  for (const { flag, field } of PHASE_MODEL_FLAGS) {
    const idx = args.indexOf(flag);
    if (idx < 0) continue;
    const value = args[idx + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`flow feature create: ${flag} requires a value.`);
      console.error("  expected one of: opus, haiku, sonnet, fable");
      return 1;
    }
    if (!(MODEL_ALIASES as readonly string[]).includes(value)) {
      console.error(`flow feature create: invalid ${flag} value '${value}'.`);
      console.error("  expected one of: opus, haiku, sonnet, fable");
      return 1;
    }
    phaseModels[field] = value as ModelAlias;
    phaseModelValueTokens.set(flag, value);
  }

  // Drop a leading `--` end-of-options sentinel so descriptions written
  // with `flow feature create -- fix the -h crash` round-trip without the literal
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
      if (a === "--slug") {
        // Strip the flag and mark its value token for removal too.
        skipNext =
          slugValueToken !== undefined && !slugValueToken.startsWith("--");
        return false;
      }
      if (a === "--epic") {
        // Strip the flag and mark its value token for removal too.
        skipNext =
          epicValueToken !== undefined && !epicValueToken.startsWith("--");
        return false;
      }
      if (phaseModelValueTokens.has(a)) {
        // A --model-<phase> flag: strip it and its value token.
        const vt = phaseModelValueTokens.get(a);
        skipNext = vt !== undefined && !vt.startsWith("--");
        return false;
      }
      return (
        a !== "--no-auto-merge" &&
        a !== "--wait-for-copilot" &&
        a !== "--research" &&
        a !== "--tmux" &&
        a !== "--no-tmux"
      );
    })
    .join(" ");
  return runNew(description, {
    ...options,
    launcher,
    noAutoMerge,
    waitForCopilot,
    forceResearch,
    copilotReview,
    effort,
    model,
    slug,
    epic,
    ...phaseModels,
  });
}

function runFresh(
  description: string,
  options: FeatureOptions,
): number | Promise<number> {
  if (!description || description.trim() === "") {
    console.error("flow feature create: description is required.");
    console.error(
      "usage: flow feature create [--no-auto-merge] [--wait-for-copilot] [--research] [--copilot-review <auto|always|never>] [--effort <low|medium|high|xhigh|max>] [--model <opus|haiku|sonnet|fable>] [--model-planning|--model-implement|--model-review|--model-verify|--model-fix-applier|--model-consolidator|--model-merge-resolver <alias>] [--slug <slug>] [--epic <epic-slug>/<feature-id>] <description>",
    );
    return 1;
  }

  // Resolve the final slug BEFORE any state write so the persist-then-verify-
  // then-delete-on-failure no-orphan ordering below writes exactly one file for
  // it. An explicit --slug is used verbatim and still hard-fails on collision (a
  // caller asserting a unique id wants that error surfaced, not papered over). A
  // derived slug auto-disambiguates: a collided slugify(...) mints the first
  // free -2/-3/… suffix instead of crashing.
  let slug: string;
  if (options.slug) {
    slug = options.slug;
    // Dual window+state collision check, mirroring the derived path's
    // `firstAvailableSlug`: an explicit `--slug` still hard-fails (never
    // auto-suffixes), but must also reject a slug whose tmux window died while
    // its `<slug>.json` state survives — otherwise the launch closure's
    // `writeState(phase:"starting")` below would silently clobber a
    // crashed-but-recorded pipeline's `phase`/`pr`.
    const existingState = readState(slug, options.stateDir);
    if (windowExists(slug) || existingState != null) {
      const hint = collisionHint(existingState);
      if (hint === "attach") {
        console.error(
          `flow feature create: pipeline '${slug}' already exists and is still running.`,
        );
        console.error(
          `  attach with \`flow attach ${slug}\`, or pick a different --slug.`,
        );
      } else if (hint === "resume") {
        console.error(
          `flow feature create: pipeline '${slug}' already exists but isn't running.`,
        );
        console.error(
          `  resume it with \`flow feature resume ${slug}\`, or pick a different --slug.`,
        );
      } else {
        // Unknown liveness (no state, or an old-format state file predating
        // `pid`/`procStartedAt`) — today's exact message, unchanged.
        console.error(
          `flow feature create: pipeline '${slug}' already exists (window or recorded state).`,
        );
        console.error(
          `  attach with \`flow attach ${slug}\`, resume with \`flow feature resume ${slug}\`,`,
        );
        console.error("  or pick a different --slug.");
      }
      return 1;
    }
  } else {
    const derived = slugify(description);
    if (!derived) {
      console.error(
        `flow feature create: '${description}' produces an empty slug.`,
      );
      return 1;
    }
    const available = firstAvailableSlug(derived, options.stateDir);
    if (available == null) {
      console.error(
        `flow feature create: no available slug after ${MAX_SUFFIX_ATTEMPTS} attempts starting from '${derived}'.`,
      );
      console.error(
        "  clean up stale pipelines with `flow ls` / `flow done`, or pass an explicit --slug.",
      );
      return 1;
    }
    slug = available;
    if (slug !== derived) {
      // Stderr ONLY — the stdout first line must stay the raw `flow:<slug>`
      // contract token parsed by epic-launch.ts:parseMintedSlug.
      console.error(
        `flow feature create: slug '${derived}' in use; using '${slug}'`,
      );
    }
  }

  const cwd = options.cwd ?? process.cwd();
  const repo = resolveRepoRoot(cwd);
  if (!repo) {
    console.error(
      `flow feature create: ${cwd} is not inside a git repository.`,
    );
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
        `flow feature create: could not install base-branch guard: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  const worktree = deriveWorktreePath(repo, slug);
  const settingsPath = launchSettingsPathFor(options);
  const seed = flowPipelineSeed(slug, description);

  // Whole-session model, resolved at launch: the --model flag wins over the
  // config `models.default`; absent both, no --model reaches claude (its
  // default applies). Best-effort-warn on any present-but-invalid models.*
  // config value, then fall back — mirrors ensureLaunchSettings' non-fatal
  // warn pattern.
  for (const w of collectModelConfigWarnings(options.readConfig)) {
    console.error(dim(`flow feature create: ${w}`));
  }
  const sessionModel = options.model ?? readDefaultModel(options.readConfig);

  const makeBaseState = (launcher: LauncherId): PipelineState => ({
    slug,
    phase: "starting",
    repo,
    worktree: existing?.worktree,
    autoMerge: options.noAutoMerge ? false : undefined,
    waitForCopilot: options.waitForCopilot ? true : undefined,
    forceResearch: options.forceResearch ? true : undefined,
    copilotReview: options.copilotReview,
    effort: options.effort,
    model: sessionModel,
    modelPlanning: options.modelPlanning,
    modelImplement: options.modelImplement,
    modelReview: options.modelReview,
    modelVerify: options.modelVerify,
    modelFixApplier: options.modelFixApplier,
    modelConsolidator: options.modelConsolidator,
    modelMergeResolver: options.modelMergeResolver,
    epic: options.epic,
    launcher,
    updatedAt: nowIso(),
  });
  const existing = readState(slug, options.stateDir);

  // Launcher dispatch: flag > config > default-plain (no state on a fresh
  // launch). The collision detection above ran off the file signal, before
  // either backend touched anything.
  const backend = resolveLauncherBackend({
    flag: options.launcher,
    read: options.readConfig,
    tmuxOnPath: options.tmuxOnPath,
  });
  if (backend.notice) console.error(dim(backend.notice));
  if (backend.id === "plain") {
    const plainCommand =
      options.command ??
      buildPlainCommand(worktree, options.effort, settingsPath, sessionModel);
    writeState(makeBaseState("plain"), options.stateDir);
    // plainLaunch owns the TTY guard, the flow:<slug> contract line, the
    // pid/procStartedAt capture, and delete-on-fast-fail.
    return plainLaunch(
      { slug, repo, command: plainCommand, seed, stateDir: options.stateDir },
      options.plainDeps,
    ).then((r) => (r.status === "failed" ? 1 : 0));
  }

  const command =
    options.command ??
    buildLaunchCommand(
      slug,
      worktree,
      options.effort,
      settingsPath,
      sessionModel,
    );

  // Persist-then-verify-then-delete-on-failure: write state(phase=starting)
  // BEFORE the verified launch so the supervisor has a file to advance (its
  // first `flow-state-update` exits non-zero with no state file) and the
  // `consumed` predicate below has a baseline to compare against. The no-orphan
  // guarantee is preserved by deleting this file on EVERY launch-failure exit
  // (launch !ok, Mode-2 vanish) rather than by the old write-after-verify order.
  // Pre-existing state for the same slug shouldn't happen because windowExists()
  // blocked above; if it does (e.g. external tmux reset), this write supersedes.
  // (`existing` was read above, before the launcher dispatch.)

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
    writeState(makeBaseState("tmux"), options.stateDir);
    // Verify the window's process actually stayed up AND consumed the seed (the
    // supervisor advanced state.json past `starting`) before keeping that
    // state. A bare `createWindow` only proves tmux forked the shell, and a
    // `claude` idle at an empty input box passes a liveness probe, so a
    // dead-on-arrival pipeline would otherwise leave an orphaned state file (the
    // intermittent `flow feature create` bug). createWindowVerified owns seed delivery and
    // kills its own half-created window on failure, so an exhausted retry leaves
    // no window behind; the delete-on-failure below removes the up-front state.
    const result = createWindowVerified(slug, repo, command, seed, {
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
    // Crash-safe liveness signal: only once the window is confirmed up (never
    // on `failed` — createWindowVerified already killed its own half-created
    // window on that path) capture the pane's OS-level pid and its start time.
    // Re-read the CURRENT on-disk state and fold pid/procStartedAt into it —
    // never `baseState` — so a supervisor/seed-ingested-hook write that landed
    // during this launch attempt (the very thing `consumed()` above latched
    // on) is never clobbered. Mirrors runResume's launch closure below. A null
    // `panePid` (pane lookup race) leaves pid/procStartedAt absent — callers
    // degrade to legacy window-existence-based liveness for this launch.
    if (result.status !== "failed") {
      const pid = panePid(slug);
      if (pid != null) {
        const current = readState(slug, options.stateDir);
        if (current != null) {
          const procStartedAt = pidStartEpoch(pid) ?? undefined;
          writeState({ ...current, pid, procStartedAt }, options.stateDir);
        }
      }
    }
    return result;
  };
  const result = withLaunchSlot(
    () => launchWithRetry(launch, options.retrySleepMs, options.retrySleep),
    options,
  );
  if (result.status === "failed") {
    deleteState(slug, options.stateDir);
    console.error(
      "flow feature create: claude exited immediately after launch — the tmux window did not stay up.",
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
      "flow feature create: the tmux window vanished after launch — not writing state.",
    );
    console.error(
      "  retry `flow feature create`; if it persists, check tmux/claude health.",
    );
    return 1;
  }

  // Launch breadcrumb: fold attempts/outcome into the CURRENT on-disk state
  // (re-read after withLaunchSlot returned — never baseState; the final
  // attempt count doesn't exist inside the per-attempt closure, and a
  // supervisor write that already landed must not be clobbered), then append
  // the durable log line. appendLaunchRecord is fail-open — it never fails
  // the launch.
  {
    const current = readState(slug, options.stateDir);
    if (current != null) {
      writeState(
        {
          ...current,
          launchAttempts: result.attempts,
          launchOutcome: result.status,
        },
        options.stateDir,
      );
    }
    appendLaunchRecord(
      {
        slug,
        at: nowIso(),
        attempts: result.attempts,
        outcome: result.status,
        launcher: "tmux",
      },
      options.launchLogPath,
    );
    if (result.attempts > 1) {
      process.stderr.write(
        dim(
          `flow feature create: launch succeeded on attempt ${result.attempts}\n`,
        ),
      );
    }
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
      dim(
        "flow feature create: launched; supervisor still starting — attach to verify",
      ),
    );
  } else {
    console.log(
      dim(`flow feature create: created — attach with \`flow attach ${slug}\``),
    );
  }
  return 0;
}

function runResume(
  name: string,
  options: FeatureOptions,
): number | Promise<number> {
  if (!name || name.trim() === "") {
    console.error("flow feature resume: <name> is required.");
    console.error("usage: flow feature resume <name>");
    return 1;
  }

  const slug = slugify(name);
  if (!slug || slug !== name) {
    console.error(
      `flow feature resume: '${name}' is not a valid pipeline name.`,
    );
    console.error("  pass the slug as printed by `flow ls`.");
    return 1;
  }

  const state = readState(slug, options.stateDir);
  if (!state) {
    console.error(`flow feature resume: no pipeline state for '${slug}'.`);
    console.error(
      "  run `flow feature create <description>` to start a fresh pipeline.",
    );
    return 1;
  }

  if (!state.repo || !fs.existsSync(state.repo)) {
    // The repo path recorded at `flow feature create` time has moved or been deleted.
    // tmux would surface this as an opaque "-c: no such directory" — give
    // the user the actual cause so they can decide to recreate the state.
    console.error(
      `flow feature resume: pipeline '${slug}' was launched against`,
    );
    console.error(`  ${state.repo || "(no repo recorded)"}`);
    console.error(`  but that path no longer exists. Move the repo back, or`);
    console.error(
      `  run \`flow done ${slug}\` and start fresh with \`flow feature create\`.`,
    );
    return 1;
  }

  // Launcher dispatch: flag > the pipeline's recorded state.launcher >
  // config > default-plain. Resolved before any tmux window probe so a
  // plain pipeline resumes without tmux on PATH at all.
  const backend = resolveLauncherBackend({
    flag: options.launcher,
    state: state.launcher,
    read: options.readConfig,
    tmuxOnPath: options.tmuxOnPath,
  });
  if (backend.notice) console.error(dim(backend.notice));
  if (backend.id === "plain") {
    const plainWorktree =
      state.worktree ?? deriveWorktreePath(state.repo, slug);
    const plainSettings = launchSettingsPathFor(options);
    const plainCommand =
      options.command ??
      buildPlainCommand(
        plainWorktree,
        state.effort,
        plainSettings,
        state.model,
      );
    // plainResume owns the alive-refusal (a plain terminal cannot be
    // reclaimed, --force included), the TTY guard, and the contract line.
    return plainResume(
      {
        slug,
        repo: state.repo,
        command: plainCommand,
        seed: flowPipelineResumeSeed(slug),
        stateDir: options.stateDir,
      },
      { ...options.plainDeps, force: options.force },
    ).then((r) => (r.status === "failed" ? 1 : 0));
  }

  const exists = windowExists(slug);
  if (exists && isPaneAlive(slug)) {
    if (!options.force) {
      console.error(
        `flow feature resume: pipeline '${slug}' is still running.`,
      );
      console.error(
        `  attach with \`flow attach ${slug}\` instead of resuming.`,
      );
      return 1;
    }
    // --force: reclaim the live-idle pane IN PLACE by falling through to the
    // SAME `respawnWindowVerified` branch the dead-pane path uses (a clean
    // lifecycle respawn, never `send-keys`). The notice goes to stderr so the
    // machine-read `flow:<slug>` first stdout line stays the contract token.
    console.error(
      `flow feature resume --force: reclaiming live-idle pane for ${slug}`,
    );
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
    buildLaunchCommand(slug, worktree, state.effort, settingsPath, state.model);
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
  // user's intent. This baseline read is non-mutating; the window pre-existed
  // the resume. (`launch` below DOES now write once on success — see the
  // pid/procStartedAt capture — but that write is unrelated to this baseline.)
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
    const result = exists
      ? respawnWindowVerified(slug, repo, command, seed, deps)
      : createWindowVerified(slug, repo, command, seed, deps);
    // Crash-safe liveness signal, same capture as the fresh-launch closure:
    // once the (re)launch is confirmed up, record the pane's pid + start time
    // by re-reading the CURRENT state and folding pid/procStartedAt into it —
    // never the pre-resume `preResume` snapshot above, so a supervisor write
    // that landed during this (re)launch attempt (e.g. a phase advance) is
    // never clobbered. Deliberately does NOT touch `updatedAt` (unlike the
    // fresh-launch closure's write): `updatedAt`/`seedIngestedAt` are the
    // `consumed` baseline this SAME closure gates the resume's own success
    // on, above — stamping a fresh `updatedAt` here would falsely satisfy
    // that baseline comparison for any caller that re-probes `consumed()`
    // after this closure returns. No write at all when the current state has
    // vanished (never happens in practice: the window pre-existed the
    // resume) or the pane's pid can't be resolved.
    if (result.status !== "failed") {
      const pid = panePid(slug);
      if (pid != null) {
        const current = readState(slug, options.stateDir);
        if (current != null) {
          const procStartedAt = pidStartEpoch(pid) ?? undefined;
          writeState(
            { ...current, pid, procStartedAt, launcher: "tmux" },
            options.stateDir,
          );
        }
      }
    }
    return result;
  };
  const result = withLaunchSlot(
    () => launchWithRetry(launch, options.retrySleepMs, options.retrySleep),
    options,
  );
  if (result.status === "failed") {
    console.error(
      "flow feature resume: claude exited immediately after launch — the tmux window did not stay up.",
    );
    console.error(
      "  Check your Claude Code install (try running `claude` manually in this repo), then retry.",
    );
    if (result.stderr) console.error(`  ${result.stderr}`);
    return 1;
  }

  // Launch breadcrumb, mirroring runFresh: fold attempts/outcome into the
  // CURRENT on-disk state after withLaunchSlot returned (the final attempt
  // count doesn't exist inside the per-attempt closure), append the durable
  // log line (fail-open), and emit one dim retry notice on attempts > 1.
  // Safe re updatedAt: writeState never stamps it, so the resume closure's
  // consumed() baseline comparison is untouched.
  {
    const current = readState(slug, options.stateDir);
    if (current != null) {
      writeState(
        {
          ...current,
          launchAttempts: result.attempts,
          launchOutcome: result.status,
        },
        options.stateDir,
      );
    }
    appendLaunchRecord(
      {
        slug,
        at: nowIso(),
        attempts: result.attempts,
        outcome: result.status,
        launcher: "tmux",
      },
      options.launchLogPath,
    );
    if (result.attempts > 1) {
      process.stderr.write(
        dim(
          `flow feature resume: launch succeeded on attempt ${result.attempts}\n`,
        ),
      );
    }
  }

  // Phase + worktree + pr stay as the crash left them. The supervisor's
  // first real transition is what updates state.json.
  // First line is the machine-read contract token — raw, never colorized.
  console.log(`${FLOW_SESSION}:${slug}`);
  if (result.status === "launched-not-confirmed") {
    console.error(
      dim(
        "flow feature resume: launched; supervisor still starting — attach to verify",
      ),
    );
  } else {
    console.log(
      dim(`flow feature resume: resumed — attach with \`flow attach ${slug}\``),
    );
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
  slug: string,
  worktree: string,
  effort: EffortLevel | undefined,
  settingsPath: string,
  model?: ModelAlias,
): string[] {
  // `env FLOW_PIPELINE=1 FLOW_SLUG=<slug>` prefix: there is no env object on
  // this launch path (the spawned claude inherits the parent env via tmux
  // new-window), so the markers are injected as an argv prefix. FLOW_PIPELINE
  // lets leaf skills like `/flow-research` detect they are running inside the
  // supervisor and suppress their standalone-only `claude -p` fallback tier —
  // the no-nested-LLM boundary the supervisor must never cross. FLOW_SLUG is
  // the backend-agnostic ambient slug for helpers/hooks
  // (`resolveSlugAmbient`), env-first over the tmux pane's `@flow-slug`.
  //
  // No positional seed: the seed is delivered ONLY via send-keys (the verified
  // launcher owns it), since claude does not auto-run a positional prompt — the
  // old positional was dead weight that plausibly slowed the TUI cold-start.
  // `--settings <flow-scoped file>` registers the UserPromptSubmit seed-ingested
  // hook; it is ADDITIVE (the user's global settings still apply).
  //
  // `--model` precedes `--effort` (both before `--settings`) in a deterministic
  // order so the argv assertions stay stable. Each is omitted when unset.
  return [
    "env",
    "FLOW_PIPELINE=1",
    `FLOW_SLUG=${slug}`,
    ...claudeArgv(worktree, effort, settingsPath, model),
  ];
}

/**
 * The bare claude argv (no `env` prefix) shared by both backends: the tmux
 * path wraps it in the `env FLOW_PIPELINE=1 FLOW_SLUG=<slug>` argv prefix
 * (launchArgv above); the plain path passes it to `plainLaunch`, which sets
 * the same markers via a real env object on the spawned child.
 *
 * Two `--add-dir` entries, deterministic order (worktree first, skills home
 * second): the worktree is the pipeline's working dir; the skills home
 * (`~/.flow/claude-home`) is where flow's skills now live (no longer in the
 * global `~/.claude/skills/`), so every launched session must add it to keep
 * `/flow-pipeline` and the sub-skills it loads.
 */
function claudeArgv(
  worktree: string,
  effort: EffortLevel | undefined,
  settingsPath: string,
  model?: ModelAlias,
): string[] {
  const base = ["claude", "--add-dir", worktree, "--add-dir", FLOW_CLAUDE_HOME];
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
 * Resolves the seed-hook command to record in launch-settings.json. Order:
 *   0. `FLOW_SEED_HOOK_COMMAND` env override — used verbatim, no existence
 *      check (a deliberate override is never second-guessed), and it
 *      suppresses the divergence warning below.
 *   1. The installed `~/.local/bin/flow-seed-ingested-hook`, when it exists
 *      on disk. Uses `fs.existsSync` (NOT `lstatSync`) deliberately:
 *      `existsSync` follows symlinks, so a dangling install symlink falls
 *      through to (2) instead of being recorded as a broken command.
 *   2. The module-relative `hookScriptPath()` (worktree / dev checkout).
 *
 * Recording the installed path over the module-relative one is the fix for
 * the bug this resolver exists to close: a worktree-relative path recorded
 * at launch time dangles once that worktree is removed.
 */
export function resolveSeedHookCommand(): string {
  const override = process.env.FLOW_SEED_HOOK_COMMAND;
  if (override && override.trim() !== "") return override;

  const installed = installedHelperPath("flow-seed-ingested-hook");
  const script = hookScriptPath();
  if (fs.existsSync(installed)) {
    warnOnHookDivergence(installed, script);
    return installed;
  }
  return script;
}

/**
 * Warns once to stderr when the resolver picked the installed hook but the
 * module-relative dev script also exists with DIFFERENT contents — signal
 * that local edits to `bin/flow-seed-ingested-hook.ts` are not being
 * exercised by launched sessions. Diagnostic only — never a failure; silent
 * when either file is unreadable or the contents match.
 */
function warnOnHookDivergence(installedPath: string, scriptPath: string): void {
  try {
    if (!fs.existsSync(scriptPath)) return;
    const installedContent = fs.readFileSync(installedPath, "utf8");
    const scriptContent = fs.readFileSync(scriptPath, "utf8");
    if (installedContent === scriptContent) return;
    process.stderr.write(
      `warning: running from ${scriptPath}, but the seed hook registered is the installed ${installedPath} — your local edits to bin/flow-seed-ingested-hook.ts will not be exercised (set FLOW_SEED_HOOK_COMMAND to override)\n`,
    );
  } catch {
    // unreadable — stay silent, diagnostic only
  }
}

/**
 * Idempotently writes the flow-scoped `claude --settings` file registering the
 * UserPromptSubmit seed-ingested hook by absolute path. Writes ONLY this
 * flow-owned file — NEVER the user's global ~/.claude/settings.json (the
 * `--settings` flag is additive, so global settings still apply). Skips the
 * write when the on-disk content already matches the desired command AND
 * that command still exists on disk (self-heals a stale recorded path even
 * when the JSON text hasn't changed shape, e.g. after the target file was
 * deleted out from under an already-correct settings file).
 */
export function ensureLaunchSettings(
  settingsPath: string = FLOW_LAUNCH_SETTINGS_PATH,
): void {
  const desired =
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: resolveSeedHookCommand() }] },
          ],
        },
      },
      null,
      2,
    ) + "\n";
  try {
    const current = fs.readFileSync(settingsPath, "utf8");
    if (current === desired) {
      const parsed = JSON.parse(current) as {
        hooks?: {
          UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }>;
        };
      };
      const recorded = parsed.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
      if (recorded && fs.existsSync(recorded)) return;
    }
  } catch {
    // absent / unreadable / malformed — fall through to write
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
function flowPipelineSeed(slug: string, description: string): string {
  // The pipeline-slug marker must be the RESOLVED slug (an explicit --slug, or a
  // suffixed derived slug), not slugify(description) — otherwise the supervisor
  // reads a marker that mismatches its own window/state basename.
  return `[pipeline-slug: ${slug}]\nUse the /flow-pipeline skill for: ${description}`;
}

export function flowPipelineResumeSeed(slug: string): string {
  return `[pipeline-slug: ${slug}]\nUse the /flow-pipeline skill in --resume mode for: ${slug}`;
}

/**
 * Resolves the flow-scoped `claude --settings` path: the explicit option, then
 * a `FLOW_LAUNCH_SETTINGS_PATH` env override (tests redirect it off the real
 * ~/.flow), then the default constant.
 */
function launchSettingsPathFor(options: FeatureOptions): string {
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
  slug: string,
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
        `flow feature create: could not write launch settings: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
  }
  return launchArgv(slug, worktree, effort, settingsPath, model);
}

/**
 * The plain-backend launch argv: same hook registration side-effect as
 * buildLaunchCommand, but the bare claude argv — `plainLaunch` sets
 * FLOW_PIPELINE/FLOW_SLUG via a real env object on the spawned child, so no
 * `env` argv prefix is needed.
 */
function buildPlainCommand(
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
        `flow feature create: could not write launch settings: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
  }
  return claudeArgv(worktree, effort, settingsPath, model);
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
        `flow feature create: waiting for supervisor to start (${Math.round(elapsedMs / 1000)}s)…\n`,
      ),
    );
  };
}

/**
 * Wraps the verified launch in the host-wide launch-concurrency semaphore so a
 * burst of parallel `flow feature create` launches stops oversubscribing claude
 * cold-starts. Fail-open (never blocks a launch): on acquire timeout the launch
 * proceeds holding no slot. The sem dir honors a `FLOW_LAUNCH_SEM_DIR` env
 * override (tests redirect it off the real ~/.flow); the cap is
 * `resolveLaunchConcurrency`.
 */
function withLaunchSlot<T extends VerifiedLaunchResult>(
  launch: () => T,
  options: FeatureOptions,
): T {
  const semDir = process.env.FLOW_LAUNCH_SEM_DIR ?? FLOW_LAUNCH_SEM_DIR;
  const slots = resolveLaunchConcurrency(process.env);
  const semOpts =
    options.launchSemTimeoutMs !== undefined
      ? { timeoutMs: options.launchSemTimeoutMs, pollMs: 5 }
      : {};
  return withTestSemaphore(semDir, slots, launch, semOpts).result;
}

/**
 * File-signal-derived hint for a collision message: `attach` for a live
 * pipeline, `resume` for a dead/stale one, `unknown` when there's no
 * liveness signal to derive a verdict from (no recorded state, or an
 * old-format state file predating `pid`/`procStartedAt`). Selects MESSAGE
 * TEXT only — every caller makes its own block/skip decision independently
 * of this verdict. `pidStartEpoch` is threaded through explicitly (rather
 * than relying on `livenessOf`'s own internal default) so callers — and
 * their tests — resolve it through this module's own imported binding.
 */
function collisionHint(
  existingState: PipelineState | null,
): "attach" | "resume" | "unknown" {
  if (existingState == null) return "unknown";
  const verdict = livenessOf(existingState, { pidStartEpoch });
  if (verdict === "alive") return "attach";
  if (verdict === "dead" || verdict === "stale") return "resume";
  return "unknown";
}

/**
 * First non-colliding slug starting from the bare `base`, then `base-2`,
 * `base-3`, …, bounded by MAX_SUFFIX_ATTEMPTS (returns null on exhaustion). A
 * candidate collides when its tmux window exists OR a state file for it
 * survives — the dual window+state check mirrors `worktree-slot.ts`'s
 * `findAvailableSlot`, so a suffixed slug never clobbers a crashed-but-recorded
 * pipeline whose window was closed but whose `<slug>.json` state remains. A
 * skipped STATE-carrying candidate (window-only collisions stay silent, same
 * as before) gets a liveness-derived stderr note — control flow (which
 * candidate is chosen, when null is returned) is unchanged either way.
 */
function firstAvailableSlug(base: string, stateDir?: string): string | null {
  for (let i = 1; i <= MAX_SUFFIX_ATTEMPTS; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const existingState = readState(candidate, stateDir);
    if (!windowExists(candidate) && existingState == null) {
      return candidate;
    }
    const hint = collisionHint(existingState);
    if (hint === "attach") {
      console.error(
        dim(
          `flow feature create: slug '${candidate}' is already running; skipping — attach with \`flow attach ${candidate}\` if you meant to use it.`,
        ),
      );
    } else if (hint === "resume") {
      console.error(
        dim(
          `flow feature create: slug '${candidate}' exists but isn't running; skipping — resume it with \`flow feature resume ${candidate}\` if you meant to use it.`,
        ),
      );
    }
  }
  return null;
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
