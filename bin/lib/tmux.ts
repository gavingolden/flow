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
 * resolved at `flow new`, matching the REPO column in `flow ls`). Same
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
 * `flow-state-update --phase` lands. Must match the initial phase `flow new`
 * writes to `~/.flow/state/<slug>.json` (`STEP_PHASES[0]` in `./state`), so a
 * status bar bound to `@flow-phase` never renders empty for a live pipeline.
 */
const INITIAL_PHASE = "starting";

export type ResolveSlugDeps = {
  env?: NodeJS.ProcessEnv;
  spawnTmux?: (args: string[]) => SpawnResult;
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
  return slug.length > 0 ? slug : null;
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
 * substring match. Success is then gated on confirmed CONSUMPTION via the
 * injected `consumed` predicate, which `new.ts` / `epic.ts` build from the
 * `~/.flow/state/<slug>.json` signal: the supervisor advanced the phase past
 * `starting` (its first `flow-state-update --phase triaging`). That state-file
 * transition is version-independent — no `capture-pane` text scraping — so a
 * future Claude Code TUI change can no longer brick the verb (the version
 * coupling PR #355 flagged). These budgets are deliberately long so a slow
 * cold-start is not killed as a false orphan AND a multi-second death (Mode 3)
 * is still caught. On the NEVER-consumed path we keep polling across the whole
 * budget and require alive-at-the-end; on the happy path `pollUntilConsumed`
 * early-exits once consumption latches (running only the short CONSUME_TAIL_PROBES
 * confirmation tail), so the large consume budget is a timeout ceiling, not a
 * fixed per-launch runtime. The consume budget is longer
 * than the readiness budget because the phase-advance signal lands LATER than a
 * first glyph would: the supervisor must cold-start, load `/flow-pipeline`,
 * rename the window, then make its first bash call. ~60s carries a margin over a
 * realistic cold start; re-validate against a live dogfood if cold-start timing
 * changes.
 */
const READY_POLL_ATTEMPTS = 60; // ~18s to a non-empty pane on a cold launch
const READY_POLL_INTERVAL_MS = 300;
const CONSUME_POLL_ATTEMPTS = 200; // ~60s ceiling from submit to the phase advancing past `starting`
const CONSUME_POLL_INTERVAL_MS = 300;
/**
 * Confirmation tail: number of consecutive alive probes required AFTER the
 * ready/consumed condition is first met before returning early. The tail is
 * what catches the alive-then-dies race — if the pane dies during those N
 * probes we reset and keep polling. N=3 (3 × 300ms = 900ms) is chosen so
 * the existing "alive for exactly 2 probes then dies" regression test still
 * fails (tailCount reaches 2 < 3, the death is detected, returns false) while
 * a healthy cold-start exits early after just a handful of probes instead of
 * burning the full budget. This is the single early-exit mechanism — once
 * consumption latches, `pollUntilConsumed` runs only this short tail rather
 * than holding the full ~60s ceiling, so the budget is a never-consumed
 * timeout, not a fixed per-launch runtime.
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

/** Default readPane seam: capture the slug's first pane's rendered text. */
function capturePaneBySlug(slug: string, session = FLOW_SESSION): string {
  const window = findWindowBySlug(listWindows(session), slug);
  if (!window) return "";
  const r = tmux(["capture-pane", "-p", "-t", window.id]);
  return r.exitCode === 0 ? r.stdout : "";
}

/** Default sendKeys seam: resolve the pane by slug, send keys/text to it. */
function sendKeysBySlug(
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
): boolean {
  let ready = false;
  let tailCount = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) sleep(READY_POLL_INTERVAL_MS);
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
 * Polls the injected `consumed` predicate until the seed is confirmed consumed
 * (the supervisor advanced the state-file phase past `starting`) AND the pane is
 * still alive. Consumption is LATCHED (monotonic positive evidence — once the
 * phase has advanced it cannot un-advance). Once consumed, requires
 * CONSUME_TAIL_PROBES more consecutive alive probes before returning true — an
 * early exit that still catches the consume-then-die (Mode 3) race, so a healthy
 * launch returns in seconds rather than blocking the whole ~60s budget. A death
 * detected mid-tail returns false immediately (fail-fast: a dead pane can't
 * recover). A never-consumed pane (Mode 1) exhausts the budget and returns
 * false. The `attempts` budget is injectable so unit tests run a tiny budget
 */
function pollUntilConsumed(
  isAlive: () => boolean,
  consumed: () => boolean,
  sleep: (ms: number) => void,
  attempts: number = CONSUME_POLL_ATTEMPTS,
): boolean {
  let everConsumed = false;
  let aliveAtEnd = false;
  let tailCount = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) sleep(CONSUME_POLL_INTERVAL_MS);
    aliveAtEnd = isAlive();
    if (!aliveAtEnd) {
      // Fail fast on a consume-then-die (Mode 3): a dead pane can't recover.
      if (everConsumed) return false;
      continue;
    }
    if (!everConsumed && consumed()) {
      everConsumed = true;
    }
    if (everConsumed) {
      if (++tailCount >= CONSUME_TAIL_PROBES) return true;
    }
  }
  // Budget exhausted: consumed near the end (tail incomplete) or never consumed.
  return everConsumed && aliveAtEnd;
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
   * Consumption-signal seam. The caller (`new.ts` / `epic.ts`) injects a
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
 * up. On ANY verification failure (never ready, seed never consumed,
 * consumed-then-died) we kill the half-created window and return `{ ok: false }`
 * so the caller deletes the up-front state for it. The double-submit guard skips
 * send-keys when the positional prompt already auto-ran the seed (`consumed()`
 * already true).
 */
export function createWindowVerified(
  slug: string,
  cwd: string,
  command: string[],
  seed: string,
  deps: CreateWindowVerifiedDeps = {},
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  const create = deps.create ?? createWindow;
  const isAlive = deps.isAlive ?? isPaneAlive;
  const kill = deps.kill ?? killWindow;
  const sleep = deps.sleep ?? sleepSync;
  const readPane = deps.readPane ?? capturePaneBySlug;
  const sendKeys = deps.sendKeys ?? sendKeysBySlug;
  const consumed = deps.consumed ?? (() => false);
  const readyAttempts = deps.readyAttempts ?? READY_POLL_ATTEMPTS;
  const consumeAttempts = deps.consumeAttempts ?? CONSUME_POLL_ATTEMPTS;

  const created = create(slug, cwd, command, session);
  if (!created.ok) return created;

  // Phase 1 — wait for claude to come up AND render its pane (non-empty capture,
  // string-free). Catches an immediate or early death (never alive) and a pane
  // that never renders.
  if (
    !pollUntilReady(
      () => isAlive(slug, session),
      () => readPane(slug, session),
      sleep,
      readyAttempts,
    )
  ) {
    kill(slug, session);
    return {
      ok: false,
      stderr:
        "tmux window created but claude never became ready (pane not alive / not drawn after launch)",
    };
  }

  // Phase 2 — deliver the seed via send-keys UNLESS the positional prompt
  // already auto-ran it (double-submit guard, gated on `consumed()`). Literal
  // text, then a SEPARATE Enter — keeps the path shell-free and a newline in the
  // seed can't pre-submit.
  if (!consumed()) {
    sendKeys(slug, seed, true, session);
    sendKeys(slug, "Enter", false, session);
  }

  // Phase 3 — confirm the seed was consumed (supervisor advanced the phase past
  // `starting`) AND the pane is still alive. Catches Mode 1 (seed never
  // consumed) and Mode 3 (consumed then died within seconds).
  if (
    !pollUntilConsumed(
      () => isAlive(slug, session),
      consumed,
      sleep,
      consumeAttempts,
    )
  ) {
    kill(slug, session);
    return {
      ok: false,
      stderr:
        "tmux window created but the seed prompt was never consumed (supervisor did not start)",
    };
  }
  return { ok: true, stderr: "" };
}

/**
 * `respawnWindow` + the same ready→send→consume flow as `createWindowVerified`:
 * it waits for claude's pane to render, OWNS seed delivery (send-keys literal
 * text + a separate Enter, guarded against a double-submit), and gates success
 * on confirmed *consumption* (the injected `consumed` predicate flipping true),
 * not mere liveness. `respawn-window`'s exit code only proves tmux relaunched
 * the pane, and a `claude` idle at an empty input box (Mode 1) passes a liveness
 * probe, so this verifies the resume seed actually ran. Unlike the create path
 * we NEVER kill the window on any verification failure — it pre-existed the
 * resume and the user may want to inspect its scrollback; we only report
 * `{ ok: false }`.
 */
export function respawnWindowVerified(
  slug: string,
  cwd: string,
  command: string[],
  seed: string,
  deps: RespawnWindowVerifiedDeps = {},
  session = FLOW_SESSION,
): { ok: boolean; stderr: string } {
  const respawn = deps.respawn ?? respawnWindow;
  const isAlive = deps.isAlive ?? isPaneAlive;
  const sleep = deps.sleep ?? sleepSync;
  const readPane = deps.readPane ?? capturePaneBySlug;
  const sendKeys = deps.sendKeys ?? sendKeysBySlug;
  const consumed = deps.consumed ?? (() => false);
  const readyAttempts = deps.readyAttempts ?? READY_POLL_ATTEMPTS;
  const consumeAttempts = deps.consumeAttempts ?? CONSUME_POLL_ATTEMPTS;

  const respawned = respawn(slug, cwd, command, session);
  if (!respawned.ok) return respawned;

  // Phase 1 — wait for the relaunched claude to come up AND render its pane
  // (non-empty capture, string-free).
  if (
    !pollUntilReady(
      () => isAlive(slug, session),
      () => readPane(slug, session),
      sleep,
      readyAttempts,
    )
  ) {
    return {
      ok: false,
      stderr:
        "tmux window respawned but claude never became ready (pane not alive / not drawn after launch)",
    };
  }

  // Phase 2 — deliver the resume seed via send-keys UNLESS the positional prompt
  // already auto-ran it (double-submit guard, gated on `consumed()`). Literal
  // text, then a SEPARATE Enter — keeps the path shell-free.
  if (!consumed()) {
    sendKeys(slug, seed, true, session);
    sendKeys(slug, "Enter", false, session);
  }

  // Phase 3 — confirm the resume seed was consumed AND the pane is still alive.
  // NO kill on failure: the window pre-existed the resume.
  if (
    !pollUntilConsumed(
      () => isAlive(slug, session),
      consumed,
      sleep,
      consumeAttempts,
    )
  ) {
    return {
      ok: false,
      stderr:
        "tmux window respawned but the seed prompt was never consumed (supervisor did not start)",
    };
  }
  return { ok: true, stderr: "" };
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
 * was there. Used by `flow new --resume` when the window survived the crash —
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
