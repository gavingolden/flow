/**
 * Thin wrappers around the tmux CLI. The `flow` session is the single
 * container for every pipeline window.
 *
 * Identity vs display: every window flow creates carries a `@flow-slug`
 * tmux user option. That option is the canonical pipeline identifier;
 * the `window_name` is purely the user-visible title and may change
 * (the user can `tmux ,` rename it; the supervisor sets a descriptive
 * title during triage). Every helper resolves a slug → `window_id`
 * once, then issues the follow-up tmux command by id, so renames don't
 * unreachable-ify the pipeline. Pre-upgrade windows that don't have
 * the option set fall back to name-matching.
 */

import * as path from "node:path";
import { shortPhase } from "./state";
import { sleepSync } from "./sleep";
import { deliverSeed } from "./seed-delivery";

export const FLOW_SESSION = "flow";
const FLOW_SLUG_OPTION = "@flow-slug";
/**
 * Window option mirroring the pipeline's current phase. Additive and
 * opt-in: flow only ever *publishes* the value onto its own windows — it
 * never writes `~/.tmux.conf` and ships no theme. A user opts in by binding
 * `#{@flow-phase}` into their own status-bar format. `flow ls` stays the
 * canonical status surface; this is a convenience mirror, not a replacement.
 * Hyphenated to match `@flow-slug`.
 */
export const FLOW_PHASE_OPTION = "@flow-phase";
/**
 * Window option holding the basename of the pipeline's root repo (the repo
 * resolved at `flow feature create`, matching the REPO column in `flow ls`). Same
 * additive/opt-in/publish-only contract as `@flow-phase`: flow sets it on its
 * own windows so a status-bar format can bind `#{@flow-repo}` into a compact
 * `[repo phase]` badge, never writing the user's tmux config. Best-effort — a
 * non-zero `set-option` exit is swallowed and never blocks window creation.
 */
export const FLOW_REPO_OPTION = "@flow-repo";
/**
 * Window option mirroring the current phase in compact form — the
 * `shortPhase()` abbreviation of `@flow-phase` (see `PHASE_SHORT` in `./state`,
 * the single source of truth). Same additive/opt-in/publish-only/best-effort
 * contract as `@flow-phase`, which keeps emitting the raw phase string
 * unchanged; `@flow-phase-short` is strictly additive.
 */
export const FLOW_PHASE_SHORT_OPTION = "@flow-phase-short";
/**
 * The phase seeded at window creation, before the first
 * `flow-state-update --phase` lands. Must match the initial phase `flow feature create`
 * writes to `~/.flow/state/<slug>.json` (`STEP_PHASES[0]` in `./state`), so a
 * status bar bound to `@flow-phase` never renders empty for a live pipeline.
 */
const INITIAL_PHASE = "starting";

export type ResolveSlugDeps = {
  env?: NodeJS.ProcessEnv;
  spawnTmux?: (args: string[]) => SpawnResult;
  listWindowsFn?: (session?: string) => TmuxWindow[];
};

/**
 * Resolves the supervisor's pipeline slug from the current tmux pane's
 * `@flow-slug` window option. Helpers that take a slug positionally or
 * via `--slug` use this as a fallback when the caller omits the arg —
 * the supervisor's per-call shell loses any `SLUG=…` between Bash tool
 * calls, but `$TMUX_PANE` and the `@flow-slug` option set by
 * `createWindow()` are immutable for the life of the window.
 *
 * Returns `null` when:
 *   - `$TMUX_PANE` is unset (helper invoked outside tmux),
 *   - `tmux show-options` fails (option unset on the window, which
 *     `-v` reports via non-zero exit, e.g. for non-flow windows), or
 *   - the resolved value is empty / whitespace.
 */
export function resolveSlugFromPane(deps: ResolveSlugDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const spawn = deps.spawnTmux ?? tmux;
  const pane = env.TMUX_PANE;
  if (!pane) return null;
  const r = spawn(["show-options", "-t", pane, "-v", "-w", FLOW_SLUG_OPTION]);
  if (r.exitCode !== 0) return null;
  const slug = r.stdout.trim();
  if (slug.length === 0) return null;

  // Cross-check: verify the slug resolved from this pane's window option is
  // actually owned by THIS pane's window — not a stale option from a prior
  // pipeline whose window was reused. Detects ambient-pane races where two
  // parallel pipelines share a tmux window id momentarily.
  const paneWindowResult = spawn([
    "display-message",
    "-t",
    pane,
    "-p",
    "#{window_id}",
  ]);
  if (paneWindowResult.exitCode !== 0) {
    // Safe degradation: display-message unavailable → trust the slug as-is.
    return slug;
  }
  const paneWindowId = paneWindowResult.stdout.trim();

  const listFn = deps.listWindowsFn ?? listWindows;
  const ownerWindow = listFn().find((w) => w.slug === slug);
  if (ownerWindow !== undefined && ownerWindow.id !== paneWindowId) {
    process.stderr.write(
      `resolveSlugFromPane: warning: @flow-slug resolved to '${slug}' but that slug is owned by window ${ownerWindow.id}, not this pane's window ${paneWindowId} — returning null to avoid cross-pipeline write\n`,
    );
    return null;
  }

  return slug;
}

export type SpawnResult = { stdout: string; stderr: string; exitCode: number };

function tmux(args: string[]): SpawnResult {
  try {
    const r = Bun.spawnSync(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: r.stdout.toString().trim(),
      stderr: r.stderr.toString().trim(),
      exitCode: r.exitCode ?? 1,
    };
  } catch (e: unknown) {
    // tmux not installed at all → spawn throws ENOENT. Surface it cleanly.
    const msg = e instanceof Error ? e.message : String(e);
    return { stdout: "", stderr: msg, exitCode: 127 };
  }
}

export type TmuxWindow = {
  /** Stable tmux window id (e.g. `@7`) — survives renames *and* index shifts. */
  id: string;
  /** User-visible display name. May differ from `slug` after a rename. */
  name: string;
  /** Pipeline slug from the `@flow-slug` user option. Empty for non-flow windows. */
  slug: string;
  /** Unix epoch seconds of last activity in any pane of the window. */
  activity: number;
};

// A bare `-t flow` can resolve against the current *window* depending on
// tmux config and command — `new-window -t flow` then tries to create at
// the active window's index, failing with "index N in use" when N is
// occupied. `flow:` (trailing colon) forces session-target semantics.
const sessionTarget = (s: string) => `${s}:`;

export function sessionExists(session = FLOW_SESSION): boolean {
  return tmux(["has-session", "-t", sessionTarget(session)]).exitCode === 0;
}

const LIST_WINDOWS_FORMAT = `#{window_id}\t#{window_name}\t#{${FLOW_SLUG_OPTION}}\t#{window_activity}`;

/** Lists windows in the flow session. Returns [] when the session doesn't exist. */
export function listWindows(session = FLOW_SESSION): TmuxWindow[] {
  if (!sessionExists(session)) return [];
  const r = tmux([
    "list-windows",
    "-t",
    sessionTarget(session),
    "-F",
    LIST_WINDOWS_FORMAT,
  ]);
  if (r.exitCode !== 0) return [];
  return parseWindowList(r.stdout);
}

export function parseWindowList(stdout: string): TmuxWindow[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [id, name, slug, activityStr] = line.split("\t");
      return {
        id: id ?? "",
        name: name ?? "",
        slug: slug ?? "",
        activity: Number(activityStr) || 0,
      };
    });
}

/**
 * Resolves a slug to the window that owns it. First match wins; the
 * slug-keyed pass runs before the name fallback so a renamed window's
 * old display name can't accidentally shadow a different pipeline.
 */
export function findWindowBySlug(
  windows: TmuxWindow[],
  slug: string,
): TmuxWindow | undefined {
  return (
    windows.find((w) => w.slug && w.slug === slug) ??
    windows.find((w) => !w.slug && w.name === slug)
  );
}

export function windowExists(slug: string, session = FLOW_SESSION): boolean {
  return findWindowBySlug(listWindows(session), slug) !== undefined;
}

/**
 * Creates the named window inside the flow session, creating the session if
 * needed. The window starts with the given command running in its first pane,
 * and carries the `@flow-slug` user option so subsequent lookups survive a
 * display-name rename.
 */
export function createWindow(
  slug: string,
  cwd: string,
  command: string[],
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  const args = sessionExists(session)
    ? buildNewWindowArgs(session, slug, cwd, command)
    : buildNewSessionArgs(session, slug, cwd, command);
  const r = tmux(args);
  if (r.exitCode !== 0) return { ok: false, stderr: r.stderr };
  // Output of `-P -F '#{window_id}'` is the new window's id (e.g. `@7`).
  const windowId = r.stdout.trim();
  if (!windowId) {
    return {
      ok: false,
      stderr: `tmux ${args[0]} succeeded but printed no window id`,
    };
  }
  return seedWindowOptions(windowId, slug, cwd);
}

/**
 * Ready + consumption poll budgets. The seed is delivered by send-keys only
 * after the pane is confirmed READY — a STRING-FREE check: the pane is alive and
 * `capture-pane` is non-empty (claude has drawn *something*), with no TUI
 * substring match. Readiness IS the launch-time liveness verification (it still
 * catches a claude that died on launch), so its budget is WIDE (~30s) to ride
 * out a slow cold-start under concurrent load without failing the launch.
 *
 * Consumption is then probed on a deliberately SHORT (~5s) fast-exit budget via
 * the injected `consumed` predicate, which `feature.ts` / `epic.ts` build from the
 * `~/.flow/state/<slug>.json` signal (the seed-ingested marker, or the
 * supervisor advancing the phase / bumping `updatedAt`). On a healthy fast
 * supervisor consumption latches inside the short budget → `started`. When the
 * budget elapses but the pane is still ALIVE the timeout is NON-DESTRUCTIVE →
 * `launched-not-confirmed` (no kill, no respawn): the supervisor's first phase
 * write intrinsically lands ~60s out, so this is the common, expected outcome,
 * and the lazy orphan reaper (`reap-orphans.ts` via `flow ls`) is the
 * eventual-consistency backstop. Only a genuinely DEAD pane is `failed`.
 */
const READY_POLL_ATTEMPTS = 100; // ~30s to a non-empty pane on a cold launch under load
const READY_POLL_INTERVAL_MS = 300;
const CONSUME_POLL_ATTEMPTS = 17; // ~5s short fast-exit consume budget (non-destructive on timeout)
const CONSUME_POLL_INTERVAL_MS = 300;

/**
 * Result of a verified launch (`createWindowVerified` / `respawnWindowVerified`).
 * Three outcomes drive distinct caller behaviour:
 *   - `started`                — seed confirmed consumed within the short budget,
 *                                pane alive. The strong success.
 *   - `launched-not-confirmed` — short budget elapsed, pane STILL ALIVE. A
 *                                NON-DESTRUCTIVE success: never killed/respawned;
 *                                the caller exits 0 with the "still starting"
 *                                message and the reaper backstops cleanup.
 *   - `failed`                 — pane dead (or create/respawn errored). The only
 *                                outcome that triggers create's kill and counts
 *                                as a retryable `launchWithRetry` miss.
 */
export type VerifiedLaunchStatus =
  | "started"
  | "launched-not-confirmed"
  | "failed";
export type VerifiedLaunchResult = {
  status: VerifiedLaunchStatus;
  stderr: string;
};
/**
 * Confirmation tail: number of consecutive alive probes required AFTER the
 * ready/consumed condition is first met before returning early. The tail is
 * what catches the alive-then-dies race — if the pane dies during those N
 * probes we reset and keep polling. N=3 (3 × 300ms = 900ms) is chosen so
 * the existing "alive for exactly 2 probes then dies" regression test still
 * fails (tailCount reaches 2 < 3, the death is detected) while a healthy
 * cold-start exits early after just a handful of probes instead of burning the
 * full budget. This is the single early-exit mechanism — once consumption
 * latches, `pollUntilConsumed` runs only this short tail rather than holding
 * the full (already short ~5s) consume budget.
 */
const READY_TAIL_PROBES = 3;
const CONSUME_TAIL_PROBES = 3;

/**
 * True when the captured pane text is non-empty (ignoring surrounding
 * whitespace) — a string-free liveness signal that claude has drawn *something*
 * into its pane. Deliberately matches NO Claude Code TUI substring: readiness is
 * "the pane is alive and has rendered output", while consumption is verified
 * separately via the injected state-file `consumed` predicate, so this stays
 * version-independent. Pure + exported for fixture-based unit testing (mirrors
 * parseAliveStatus); the real capture-pane goes through the readPane seam.
 */
export function parsePaneNonEmpty(captured: string): boolean {
  return captured.trim().length > 0;
}

/**
 * Builds a `send-keys` argv. `literal: true` uses `-l --` so the text is taken
 * verbatim (no key-name interpretation, no shell) — keeps the seed path
 * shell-free through Bun.spawnSync's array form. `literal: false` is for key
 * names like "Enter"/"C-m" (the submit keystroke), issued as a SEPARATE call so
 * a newline in the seed can never pre-submit.
 */
export function buildSendKeysArgs(
  paneId: string,
  keysOrText: string,
  literal: boolean,
): string[] {
  return literal
    ? ["send-keys", "-t", paneId, "-l", "--", keysOrText]
    : ["send-keys", "-t", paneId, keysOrText];
}

/** Default readPane seam: capture the slug's first pane's rendered text.
 * Exported so `flow-session-start-hook`'s detached resume-delivery child can
 * reuse the same session-based capture rather than re-deriving the window. */
export function capturePaneBySlug(
  slug: string,
  session = FLOW_SESSION,
): string {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) return "";
  const r = tmux(["capture-pane", "-p", "-t", window.id]);
  return r.exitCode === 0 ? r.stdout : "";
}

/** Default sendKeys seam: resolve the pane by slug, send keys/text to it.
 * Exported so `flow-session-start-hook`'s detached resume-delivery child can
 * reuse the same session-based send rather than re-deriving the window. */
export function sendKeysBySlug(
  slug: string,
  keysOrText: string,
  literal: boolean,
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) {
    return { ok: false, stderr: `window not found for slug '${slug}'` };
  }
  const r = tmux(buildSendKeysArgs(window.id, keysOrText, literal));
  return { ok: r.exitCode === 0, stderr: r.stderr };
}

/**
 * Polls until the pane is alive AND has rendered output (a non-empty
 * `capture-pane` — string-free, no TUI substring match). Sleeps between probes
 * (never before the first). Short-circuits the readPane call when the pane is
 * not alive (so a dead-pane test never invokes the readPane seam). Once ready is
 * first observed, requires READY_TAIL_PROBES more consecutive alive probes
 * before returning true — this catches the alive-then-dies race without burning
 * the full budget. A death during the tail resets the tail count (and the ready
 * latch) so the polling resumes from scratch. The `attempts` budget is
 * injectable so unit tests run a tiny budget instantly.
 */
function pollUntilReady(
  isAlive: () => boolean,
  readPane: () => string,
  sleep: (ms: number) => void,
  attempts: number = READY_POLL_ATTEMPTS,
  onProgress?: (elapsedMs: number) => void,
): boolean {
  let ready = false;
  let tailCount = 0;
  let elapsedMs = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      sleep(READY_POLL_INTERVAL_MS);
      elapsedMs += READY_POLL_INTERVAL_MS;
      onProgress?.(elapsedMs);
    }
    if (!isAlive()) {
      ready = false;
      tailCount = 0;
      continue;
    }
    if (!ready) ready = parsePaneNonEmpty(readPane());
    if (ready) {
      if (++tailCount >= READY_TAIL_PROBES) return true;
    }
  }
  return ready;
}

/**
 * Polls the injected `consumed` predicate on the SHORT fast-exit budget and
 * returns one of three outcomes (see `VerifiedLaunchResult`):
 *   - `started`                — consumption latched (+ CONSUME_TAIL_PROBES
 *                                consecutive alive probes), or latched near the
 *                                end of the budget with the pane still alive.
 *   - `launched-not-confirmed` — budget exhausted, never consumed, but the pane
 *                                is STILL ALIVE. The non-destructive timeout.
 *   - `failed`                 — the pane is DEAD (consume-then-die Mode 3, or
 *                                ready-then-died-before-consuming): fail fast,
 *                                the only outcome that warrants a kill.
 * Consumption is LATCHED (monotonic positive evidence). `aliveAtEnd` tracks the
 * last liveness reading; because a dead pane after consumption fail-fasts to
 * `failed`, normal budget exhaustion with `everConsumed` implies the pane is
 * alive. The `attempts` budget + `onProgress` seam are injectable so unit tests
 * run a tiny budget instantly and assert progress emission.
 */
function pollUntilConsumed(
  isAlive: () => boolean,
  consumed: () => boolean,
  sleep: (ms: number) => void,
  attempts: number = CONSUME_POLL_ATTEMPTS,
  onProgress?: (elapsedMs: number) => void,
): VerifiedLaunchStatus {
  let everConsumed = false;
  let aliveAtEnd = false;
  let tailCount = 0;
  let elapsedMs = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      sleep(CONSUME_POLL_INTERVAL_MS);
      elapsedMs += CONSUME_POLL_INTERVAL_MS;
      onProgress?.(elapsedMs);
    }
    aliveAtEnd = isAlive();
    if (!aliveAtEnd) {
      // Fail fast on a consume-then-die (Mode 3): a dead pane can't recover.
      if (everConsumed) return "failed";
      continue;
    }
    if (!everConsumed && consumed()) {
      everConsumed = true;
    }
    if (everConsumed) {
      if (++tailCount >= CONSUME_TAIL_PROBES) return "started";
    }
  }
  // Budget exhausted. Consumed near the end (tail incomplete) + alive → started.
  // Never consumed but alive → the non-destructive launched-not-confirmed.
  // Dead at the end (never consumed) → failed.
  if (everConsumed) return "started";
  return aliveAtEnd ? "launched-not-confirmed" : "failed";
}

export type CreateWindowVerifiedDeps = {
  /**
   * Window-create seam. Defaults to the real `createWindow`. Injectable
   * because `createWindow` shells out via the module-private `tmux` spawn
   * (no spawn seam of its own, and the edit must not mutate it), so a unit
   * test stubs the create result here rather than standing up a tmux server.
   */
  create?: (
    slug: string,
    cwd: string,
    command: string[],
    session?: string,
  ) => { ok: boolean; stderr: string };
  /**
   * Liveness probe seam. Defaults to the real `isPaneAlive`, which shells out
   * to tmux unconditionally and so is not unit-testable; tests inject a stub.
   */
  isAlive?: (slug: string, session?: string) => boolean;
  /** Window-kill seam (defaults to `killWindow`) for the not-alive cleanup. */
  kill?: (slug: string, session?: string) => boolean;
  /**
   * Inter-probe delay seam (ms → void). Defaults to the spawn-free `sleepSync`;
   * unit tests inject a no-op so the bounded poll runs instantly instead of
   * consuming the real ~480ms budget.
   */
  sleep?: (ms: number) => void;
  /**
   * Pane-capture seam (capture-pane). Defaults to the real capturePaneBySlug,
   * which shells out via the module-private tmux spawn; tests inject a stub that
   * returns fixture pane text so the string-free readiness poll never touches
   * tmux. Read ONLY for liveness (non-empty), never for substring matching.
   */
  readPane?: (slug: string, session?: string) => string;
  /**
   * Consumption-signal seam. The caller (`feature.ts` / `epic.ts`) injects a
   * predicate that returns true once the seed has been consumed — i.e. the
   * supervisor advanced `~/.flow/state/<slug>.json` past `starting`. Keeps
   * `tmux.ts` state-module-agnostic (no `state.ts` import here) so the
   * fresh-vs-resume predicate difference lives where the semantics live.
   * Defaults to a never-consumed predicate (fail-closed) — every production
   * caller injects a real one.
   */
  consumed?: () => boolean;
  /**
   * Injectable readiness/consume poll budgets (attempt counts). Default to the
   * module constants in production; unit tests pass a tiny budget so the bounded
   * polls run instantly instead of consuming the real multi-second budget.
   */
  readyAttempts?: number;
  consumeAttempts?: number;
  /**
   * Progress seam, invoked at most once per poll interval during the readiness
   * and consumption waits with the elapsed ms for THAT phase. `feature.ts` wires a
   * writer that emits dim stderr progress so a launch is never a silent hang;
   * tests inject a spy. Never writes stdout (the `flow:<slug>` contract token).
   */
  onProgress?: (elapsedMs: number) => void;
  /**
   * send-keys seam. Defaults to the real sendKeysBySlug. `literal` selects
   * `-l --` literal text vs a key name (e.g. "Enter"). Tests inject a spy to
   * assert delivery happens only after ready and that text + Enter are separate
   * calls.
   */
  sendKeys?: (
    slug: string,
    keysOrText: string,
    literal: boolean,
    session?: string,
  ) => { ok: boolean; stderr: string };
};

export type RespawnWindowVerifiedDeps = {
  /**
   * Window-respawn seam. Defaults to the real `respawnWindow`, which shells out
   * via the module-private `tmux` spawn, so a unit test stubs the respawn result
   * here rather than standing up a tmux server. The create path's analogous
   * `create` seam.
   */
  respawn?: (
    slug: string,
    cwd: string,
    command: string[],
    session?: string,
  ) => { ok: boolean; stderr: string };
  /** Liveness probe seam — same contract as `CreateWindowVerifiedDeps.isAlive`. */
  isAlive?: (slug: string, session?: string) => boolean;
  /** Inter-probe delay seam — same contract as `CreateWindowVerifiedDeps.sleep`. */
  sleep?: (ms: number) => void;
  /** Pane-capture seam — same contract as `CreateWindowVerifiedDeps.readPane`. */
  readPane?: (slug: string, session?: string) => string;
  /** Consumption-signal seam — same contract as `CreateWindowVerifiedDeps.consumed`. */
  consumed?: () => boolean;
  /** Injectable poll budgets — same contract as `CreateWindowVerifiedDeps`. */
  readyAttempts?: number;
  consumeAttempts?: number;
  /** Progress seam — same contract as `CreateWindowVerifiedDeps.onProgress`. */
  onProgress?: (elapsedMs: number) => void;
  /** send-keys seam — same contract as `CreateWindowVerifiedDeps.sendKeys`. */
  sendKeys?: (
    slug: string,
    keysOrText: string,
    literal: boolean,
    session?: string,
  ) => { ok: boolean; stderr: string };
};

/**
 * Creates the window via `createWindow`, waits for `claude`'s pane to render,
 * then OWNS seed delivery: it sends `seed` via send-keys (literal text + a
 * separate Enter) and gates success on confirmed *consumption* — the injected
 * `consumed` predicate flipping true (the supervisor advanced the state-file
 * phase past `starting`). tmux's `new-window` exit code only proves the shell
 * forked, and a bare liveness probe passes a `claude` idle at an empty input box
 * (Mode 1), so this verifies the seed actually ran, not just that a process is
 * up. Returns the 3-state `VerifiedLaunchResult`: `started` (consumed within the
 * short budget), `launched-not-confirmed` (short budget elapsed, pane STILL
 * ALIVE — a NON-DESTRUCTIVE success: the window is left running), or `failed`
 * (pane dead / create errored). ONLY `failed` kills the half-created window so
 * the caller deletes the up-front state; a `launched-not-confirmed` live pane is
 * never killed.
 */
export function createWindowVerified(
  slug: string,
  cwd: string,
  command: string[],
  seed: string,
  deps: CreateWindowVerifiedDeps = {},
  session = FLOW_SESSION,
): VerifiedLaunchResult {
  const create = deps.create ?? createWindow;
  const isAlive = deps.isAlive ?? isPaneAlive;
  const kill = deps.kill ?? killWindow;
  const sleep = deps.sleep ?? sleepSync;
  const readPane = deps.readPane ?? capturePaneBySlug;
  const sendKeys = deps.sendKeys ?? sendKeysBySlug;
  const consumed = deps.consumed ?? (() => false);
  const onProgress = deps.onProgress;
  const readyAttempts = deps.readyAttempts ?? READY_POLL_ATTEMPTS;
  const consumeAttempts = deps.consumeAttempts ?? CONSUME_POLL_ATTEMPTS;

  const created = create(slug, cwd, command, session);
  if (!created.ok) return { status: "failed", stderr: created.stderr };

  // Phase 1 — readiness IS the launch-time liveness check: wait (on the wide
  // budget) for claude to come up AND render its pane (non-empty capture,
  // string-free). A pane that never becomes alive / never draws is a dead
  // launch → kill + failed.
  if (
    !pollUntilReady(
      () => isAlive(slug, session),
      () => readPane(slug, session),
      sleep,
      readyAttempts,
      onProgress,
    )
  ) {
    kill(slug, session);
    return {
      status: "failed",
      stderr:
        "tmux window created but claude never became ready (pane not alive / not drawn after launch)",
    };
  }

  // Phase 2 — deliver the seed via the shared chunked leading-line handshake
  // (checks every literal send, verifies the leading line echoed, chunks below
  // tmux's send-keys byte cap). The `if (!consumed())` guard is vestigial (the
  // positional auto-run path is gone): it only skips a redundant delivery when
  // the seed-ingested marker / resume baseline is already satisfied at
  // ready-time. The SEPARATE Enter is sent ONLY when delivery verified — a
  // failed/exhausted send must never submit a corrupt box; it falls through to
  // the non-destructive Phase-3 timeout.
  let deliverStderr = "";
  if (!consumed()) {
    const result = deliverSeed(seed, {
      capture: () => readPane(slug, session),
      send: (keysOrText, literal) =>
        sendKeys(slug, keysOrText, literal, session),
      sleep,
    });
    deliverStderr = result.stderr;
    if (result.delivered) sendKeys(slug, "Enter", false, session);
  }

  // Phase 3 — short, non-destructive consume probe. `started` and
  // `launched-not-confirmed` are both success; only a DEAD pane (`failed`) is
  // killed (Mode 3 consume-then-die, or ready-then-died-before-consuming).
  const consumeResult = pollUntilConsumed(
    () => isAlive(slug, session),
    consumed,
    sleep,
    consumeAttempts,
    onProgress,
  );
  if (consumeResult === "failed") {
    kill(slug, session);
    return {
      status: "failed",
      stderr:
        "tmux window created but claude died before the seed was confirmed consumed (pane not alive)",
    };
  }
  return { status: consumeResult, stderr: deliverStderr };
}

/**
 * `respawnWindow` + the same ready→send→consume flow as `createWindowVerified`:
 * it waits for claude's pane to render, OWNS seed delivery (send-keys literal
 * text + a separate Enter, guarded against a double-submit), and gates success
 * on confirmed *consumption* (the injected `consumed` predicate flipping true),
 * not mere liveness. `respawn-window`'s exit code only proves tmux relaunched
 * the pane, and a `claude` idle at an empty input box (Mode 1) passes a liveness
 * probe, so this verifies the resume seed actually ran. Returns the same
 * 3-state `VerifiedLaunchResult` as the create path, but NEVER kills/respawns
 * the window on ANY outcome — it pre-existed the resume and the user may want to
 * inspect its scrollback. A `launched-not-confirmed` (alive but slow) resume is
 * a non-destructive success; only a dead pane reports `failed`.
 */
export function respawnWindowVerified(
  slug: string,
  cwd: string,
  command: string[],
  seed: string,
  deps: RespawnWindowVerifiedDeps = {},
  session = FLOW_SESSION,
): VerifiedLaunchResult {
  const respawn = deps.respawn ?? respawnWindow;
  const isAlive = deps.isAlive ?? isPaneAlive;
  const sleep = deps.sleep ?? sleepSync;
  const readPane = deps.readPane ?? capturePaneBySlug;
  const sendKeys = deps.sendKeys ?? sendKeysBySlug;
  const consumed = deps.consumed ?? (() => false);
  const onProgress = deps.onProgress;
  const readyAttempts = deps.readyAttempts ?? READY_POLL_ATTEMPTS;
  const consumeAttempts = deps.consumeAttempts ?? CONSUME_POLL_ATTEMPTS;

  const respawned = respawn(slug, cwd, command, session);
  if (!respawned.ok) return { status: "failed", stderr: respawned.stderr };

  // Phase 1 — wait for the relaunched claude to come up AND render its pane
  // (non-empty capture, string-free). Never ready → failed (NO kill on resume).
  if (
    !pollUntilReady(
      () => isAlive(slug, session),
      () => readPane(slug, session),
      sleep,
      readyAttempts,
      onProgress,
    )
  ) {
    return {
      status: "failed",
      stderr:
        "tmux window respawned but claude never became ready (pane not alive / not drawn after launch)",
    };
  }

  // Phase 2 — deliver the resume seed via the shared chunked leading-line
  // handshake. The `if (!consumed())` guard is vestigial (positional auto-run
  // path gone): it only skips a redundant delivery when the resume baseline /
  // seed-ingested marker is already satisfied at ready-time. The SEPARATE Enter
  // is sent ONLY when delivery verified — a failed/exhausted send falls through
  // to the non-destructive Phase-3 timeout rather than submitting a corrupt box.
  let deliverStderr = "";
  if (!consumed()) {
    const result = deliverSeed(seed, {
      capture: () => readPane(slug, session),
      send: (keysOrText, literal) =>
        sendKeys(slug, keysOrText, literal, session),
      sleep,
    });
    deliverStderr = result.stderr;
    if (result.delivered) sendKeys(slug, "Enter", false, session);
  }

  // Phase 3 — short, non-destructive consume probe. `started` /
  // `launched-not-confirmed` are both success; `failed` (dead pane) is reported
  // but the window is STILL never killed — the resume path is non-destructive.
  const consumeResult = pollUntilConsumed(
    () => isAlive(slug, session),
    consumed,
    sleep,
    consumeAttempts,
    onProgress,
  );
  // On a dead pane surface the fixed 'failed' string; otherwise surface any
  // delivery stderr (failed/exhausted send) so it isn't silently dropped.
  return {
    status: consumeResult,
    stderr: consumeFailStderr(consumeResult) || deliverStderr,
  };
}

/** Stderr for the resume consume outcome — empty unless the pane died. */
function consumeFailStderr(status: VerifiedLaunchStatus): string {
  return status === "failed"
    ? "tmux window respawned but claude died before the seed was confirmed consumed (pane not alive)"
    : "";
}

/** Builds the `set-option -w` argv for a window-scoped user option. */
export function buildSetOptionArgs(
  windowId: string,
  option: string,
  value: string,
): string[] {
  return ["set-option", "-w", "-t", windowId, option, value];
}

/**
 * Seeds a freshly created window's user options: `@flow-slug` (the canonical
 * identifier, load-bearing for every later lookup — its failure fails creation),
 * plus three additive, best-effort mirrors whose failures are swallowed and
 * never block creation (state.json stays the source of truth): `@flow-repo`
 * (the repo basename, from `repoRoot`), `@flow-phase` (the raw phase mirror
 * seeded to `starting`), and `@flow-phase-short` (its compact abbreviation).
 * The windowId is already in hand from `createWindow`, so no extra
 * `listWindows` round-trip.
 */
export function seedWindowOptions(
  windowId: string,
  slug: string,
  repoRoot: string,
  spawnFn: (args: string[]) => SpawnResult = tmux,
): { ok: boolean; stderr: string } {
  const slugSet = spawnFn(buildSetOptionArgs(windowId, FLOW_SLUG_OPTION, slug));
  if (slugSet.exitCode !== 0) {
    return {
      ok: false,
      stderr: `set-option ${FLOW_SLUG_OPTION} failed: ${slugSet.stderr}`,
    };
  }
  // Additive, best-effort mirrors — only @flow-slug above is load-bearing, so a
  // non-zero exit on any of these is swallowed and never fails creation.
  spawnFn(
    buildSetOptionArgs(windowId, FLOW_REPO_OPTION, path.basename(repoRoot)),
  );
  spawnFn(buildSetOptionArgs(windowId, FLOW_PHASE_OPTION, INITIAL_PHASE));
  spawnFn(
    buildSetOptionArgs(
      windowId,
      FLOW_PHASE_SHORT_OPTION,
      shortPhase(INITIAL_PHASE),
    ),
  );
  return { ok: true, stderr: "" };
}

export type SetWindowPhaseDeps = {
  spawnTmux?: (args: string[]) => SpawnResult;
  listWindowsFn?: (session?: string) => TmuxWindow[];
  session?: string;
};

/**
 * Mirrors `phase` onto the window's `@flow-phase` user option (and its compact
 * `@flow-phase-short` abbreviation), resolving the target window by `@flow-slug`
 * (not display name) so a renamed window still receives the update. Best-effort:
 * a missing window or a non-zero `set-option` exit is a soft failure returned as
 * `{ ok: false }`, never a throw — callers (notably `flow-state-update`) ignore
 * the result so a tmux hiccup can never block a state write. The raw `@flow-phase`
 * set drives the returned `ok`; the additive `@flow-phase-short` set is swallowed.
 */
export function setWindowPhase(
  slug: string,
  phase: string,
  deps: SetWindowPhaseDeps = {},
): { ok: boolean; stderr: string } {
  const spawn = deps.spawnTmux ?? tmux;
  const list = deps.listWindowsFn ?? listWindows;
  const window = findWindowBySlug(list(deps.session), slug);
  if (!window) {
    return {
      ok: false,
      stderr: `setWindowPhase: no window for slug '${slug}'`,
    };
  }
  const r = spawn(buildSetOptionArgs(window.id, FLOW_PHASE_OPTION, phase));
  // Additive best-effort mirror — swallowed so it can't change the soft-fail
  // contract above (callers gate on the raw @flow-phase set only).
  spawn(
    buildSetOptionArgs(window.id, FLOW_PHASE_SHORT_OPTION, shortPhase(phase)),
  );
  return { ok: r.exitCode === 0, stderr: r.stderr };
}

export function buildNewWindowArgs(
  session: string,
  name: string,
  cwd: string,
  command: string[],
): string[] {
  return [
    "new-window",
    "-t",
    sessionTarget(session),
    "-n",
    name,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{window_id}",
    "--",
    ...command,
  ];
}

export function buildNewSessionArgs(
  session: string,
  name: string,
  cwd: string,
  command: string[],
): string[] {
  return [
    "new-session",
    "-d",
    "-s",
    session,
    "-n",
    name,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{window_id}",
    "--",
    ...command,
  ];
}

export function killWindow(slug: string, session = FLOW_SESSION): boolean {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) return false;
  return tmux(["kill-window", "-t", window.id]).exitCode === 0;
}

/**
 * Reruns `command` inside the named window's first pane, replacing whatever
 * was there. Used by `flow feature resume` when the window survived the crash —
 * preserves the pane id so the user's tmux scrollback addressing stays valid.
 */
export function respawnWindow(
  slug: string,
  cwd: string,
  command: string[],
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) {
    return { ok: false, stderr: `window not found for slug '${slug}'` };
  }
  const r = tmux([
    "respawn-window",
    "-k",
    "-t",
    window.id,
    "-c",
    cwd,
    "--",
    ...command,
  ]);
  return { ok: r.exitCode === 0, stderr: r.stderr };
}

/**
 * `true` when the window's first pane has a live foreground process. The
 * caller uses this to refuse `--resume` over a still-running supervisor.
 *
 * `pane_dead` flips to 1 only when tmux has `remain-on-exit on`; otherwise
 * the window disappears on exit, so we also probe the pid directly.
 */
export function isPaneAlive(slug: string, session = FLOW_SESSION): boolean {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) return false;
  const r = tmux([
    "list-panes",
    "-t",
    window.id,
    "-F",
    "#{pane_dead} #{pane_pid}",
  ]);
  if (r.exitCode !== 0) return false;
  return parseAliveStatus(r.stdout, pidIsAlive);
}

export function parseAliveStatus(
  stdout: string,
  pidProbe: (pid: number) => boolean,
): boolean {
  const line = stdout.split("\n").find((l) => l.length > 0);
  if (!line) return false;
  const [deadStr, pidStr] = line.split(/\s+/);
  if (deadStr !== "0") return false;
  const pid = Number(pidStr);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  return pidProbe(pid);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Replaces the current process with `tmux attach`. Never returns on success. */
export function execAttach(slug: string, session = FLOW_SESSION): never {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) {
    console.error(`flow attach: window for slug '${slug}' not found.`);
    process.exit(1);
  }
  // Focus the right window before attaching — tmux operates on the server,
  // so select-window works even with no client attached. Then hand the
  // foreground over via attach. stdio inherited so tmux owns the terminal.
  Bun.spawnSync(["tmux", "select-window", "-t", window.id], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const r = Bun.spawnSync(["tmux", "attach", "-t", sessionTarget(session)], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(r.exitCode ?? 1);
}

export function buildRenameArgs(windowId: string, title: string): string[] {
  return ["rename-window", "-t", windowId, title];
}
