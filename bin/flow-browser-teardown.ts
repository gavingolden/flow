#!/usr/bin/env bun
/**
 * Session-scoped chrome-devtools-mcp browser teardown.
 *
 * chrome-devtools-mcp exposes no browser-close tool: `closeBrowser()` runs
 * only inside the MCP server's own `shutdown()` handler. `close_page` (the
 * page-level MCP tool) never reaches it. So the only safe way to reap a
 * pipeline's Chrome subprocess is to signal the SERVER — never Chrome
 * itself directly — and let its own shutdown path run.
 *
 * Default mode: resolve THIS flow-pipeline session's own `claude` pid by a
 * PPID walk, select that session's chrome-devtools-mcp SERVER descendants
 * (never a sibling session's, never the npm wrapper or telemetry
 * watchdog), signal them, and poll for exit. SIGTERM only — there is no
 * escalation to a harsher signal even on a poll timeout, because a harsher
 * signal skips the server's own shutdown path and orphans Chrome to PPID 1
 * (the exact failure mode this helper exists to prevent).
 *
 * `--orphans` mode (opt-in, report-only unless `--yes`): sweeps sessionless
 * automation-Chrome processes and sessionless chrome-devtools-mcp servers
 * left behind by a crashed/killed session. This is NOT the same sweep as
 * `flow done --orphans` (which sweeps stale pipeline STATE FILES, see
 * `bin/lib/done.ts` / `bin/lib/help.ts`) — the two commands share a flag
 * name but sweep unrelated things.
 *
 * `--reap` mode (opt-in): verifies and signals every row recorded in this
 * slug's process registry (`bin/lib/proc-registry.ts`) via
 * `bin/lib/reap.ts`'s asymmetric verify-then-signal engine, then falls back
 * to the ancestry walk above for anything the registry did not cover. Per-
 * class kill policy (including this file's own escalation, if any, for a
 * kill-uncooperative process group) lives entirely in `bin/lib/reap.ts` —
 * see that module for the exact signal sequence a `default`-class row
 * receives. Run with `--dry-run` first; it sends no signal at all.
 * `--record` (with `--reap` only, never under `--dry-run`) additionally
 * writes the reap verdict to `~/.flow/state/<slug>.json` as `state.reap`
 * — a plain state write, never a phase transition; a failure there is
 * warned, never thrown, so this helper still cannot break its caller.
 *
 * Always exits 0. This helper must never break a caller.
 */

import * as os from "node:os";
import { pidStartEpoch } from "./lib/liveness";
import { appendRow } from "./lib/proc-registry";
import {
  runRegistryReap,
  type ReapDeps,
  type RegistryReapResult,
} from "./lib/reap";
import { resolveSlugFromEnv } from "./lib/session-identity";
import { isValidSlug } from "./lib/slug";
import { readState, writeState, type ReapRecord } from "./lib/state";

// --- Core types --------------------------------------------------------

export type ProcRow = { pid: number; ppid: number; command: string };

export type TeardownResult = {
  ran: boolean;
  skipReason?:
    | "not-a-pipeline-session"
    | "no-session-pid"
    | "no-mcp-server"
    | "ps-unavailable";
  sessionPid?: number;
  dryRun: boolean;
  signalled: Array<{ pid: number; command: string }>;
  stillAlive: number[];
};

const CLAUDE_COMMAND_RE = /(^|\/)claude(\s|$)/;

/**
 * Walks the PPID chain UP from `startPid` and returns the NEAREST ancestor
 * whose command matches a `claude` binary. There is deliberately NO
 * widening fallback: verified live on the target host, a session's
 * `claude` parent can be a SHARED TMUX SERVER with dozens of sibling
 * `claude` children, each owning its own chrome-devtools-mcp server —
 * widening past the nearest `claude` match would reach that shared root
 * and every sibling pipeline's server would be in scope. Bounded to 64
 * hops and cycle-safe so a malformed process table cannot spin.
 */
export function resolveSessionPid(
  procs: ProcRow[],
  startPid: number,
): number | undefined {
  const byPid = new Map(procs.map((p) => [p.pid, p] as const));
  const visited = new Set<number>();
  let pid = startPid;
  for (let hop = 0; hop < 64; hop++) {
    if (visited.has(pid)) return undefined; // PPID cycle
    visited.add(pid);
    const proc = byPid.get(pid);
    if (!proc) return undefined; // chain runs off the known table
    if (CLAUDE_COMMAND_RE.test(proc.command)) return proc.pid;
    pid = proc.ppid;
  }
  return undefined; // exceeded the hop bound — bail safely
}

/** Transitive descendants of `rootPid`. Never includes the root. Cycle-safe. */
export function descendantsOf(procs: ProcRow[], rootPid: number): ProcRow[] {
  const childrenOf = new Map<number, ProcRow[]>();
  for (const p of procs) {
    const siblings = childrenOf.get(p.ppid) ?? [];
    siblings.push(p);
    childrenOf.set(p.ppid, siblings);
  }
  const out: ProcRow[] = [];
  const visited = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of childrenOf.get(pid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * The MCP server's own entrypoint script, as it appears in the argv of the
 * `node`/`bun` process that runs it. Never matched against a whole command
 * line — see `isMcpServerCommand`.
 */
const MCP_SERVER_ENTRYPOINT_RE =
  /node_modules\/\.bin\/chrome-devtools-mcp|chrome-devtools-mcp\/build\/.*\.js/;

const RUNTIME_ARGV0_RE = /(^|\/)(node|bun)$/;
const SERVER_ARGV0_RE = /(^|\/)chrome-devtools-mcp$/;

/**
 * Is this process row an actual chrome-devtools-mcp SERVER — the one process
 * whose SIGTERM runs `shutdown()` and reaps Chrome?
 *
 * Anchored on argv POSITION, never a bare substring over the whole command
 * line. A substring test is unsafe here because this helper SIGTERMs what it
 * selects, and a pipeline session routinely has descendants whose command
 * line merely MENTIONS the string — `grep -rn chrome-devtools-mcp skills/`,
 * an editor invocation on this very file, or the `zsh -c` wrapper of the
 * Bash call running the teardown itself. Verified live: the substring form
 * SIGTERMed an unrelated in-session `sleep` AND its own invoking shell
 * (which exited 144 = 128+SIGTERM) while no real server was even running.
 *
 * Two accepted shapes, both observed live:
 *   - argv[0] IS the server binary (`chrome-devtools-mcp`, argv[0] rewritten
 *     by the npx shim) — the common case;
 *   - a `node`/`bun` runtime whose script argument is the server entrypoint
 *     (`.../node_modules/.bin/chrome-devtools-mcp`, `.../build/*.js`).
 *
 * The `npm exec` wrapper and the telemetry watchdog are excluded explicitly:
 * both legitimately carry the entrypoint shape but neither runs the server's
 * `shutdown()` handler, so signalling either reproduces the very orphan
 * failure mode this helper exists to prevent.
 */
export function isMcpServerCommand(command: string): boolean {
  if (command.includes("npm exec ")) return false;
  if (command.includes("telemetry/watchdog/main.js")) return false;

  const tokens = command.trim().split(/\s+/);
  const argv0 = tokens[0] ?? "";
  if (SERVER_ARGV0_RE.test(argv0)) return true;

  // A runtime process: the entrypoint must appear as a SCRIPT ARGUMENT, not
  // anywhere in the line — `grep node_modules/.bin/chrome-devtools-mcp .`
  // would otherwise match on its search pattern.
  if (!RUNTIME_ARGV0_RE.test(argv0)) return false;
  return tokens.slice(1).some((t) => MCP_SERVER_ENTRYPOINT_RE.test(t));
}

/**
 * The session's own chrome-devtools-mcp SERVER descendants.
 */
export function selectMcpServers(
  procs: ProcRow[],
  sessionPid: number,
): ProcRow[] {
  return descendantsOf(procs, sessionPid).filter((p) =>
    isMcpServerCommand(p.command),
  );
}

export type Deps = {
  listProcs: () => ProcRow[] | undefined;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
  sleepMs: (ms: number) => void;
  env: NodeJS.ProcessEnv;
  selfPid: number;
  homeDir: string;
  tmpDir: string;
  /**
   * MILLISECOND-scaled start time, for the `--orphans` `ageMs` display only.
   * Deliberately NOT named `startEpochOf` — `bin/lib/reap.ts`'s `ReapDeps`
   * has its own SECONDS-scaled field of that name, and the two are
   * type-compatible modulo `null`/`undefined` (a `?? null` would silence
   * even that), so a shared name invites a future edit to `toReapDeps`
   * forwarding this one straight through and turning every reap epoch
   * comparison into a permanent ~1000x mismatch (see `toReapDeps`'s own
   * comment). The unit is now in the name, not just in a comment.
   */
  startEpochMsOf?: (pid: number) => number | undefined;
  nowMs: () => number;
  /** This process's own pgid, or null when it could not be determined — see
   * `--reap`'s A2 pgid snapshot in the Default Deps section below. Only
   * consumed by the reap path; the flagless default/`--orphans` modes never
   * read it. */
  selfPgid: number | null;
  /** Members of process group `pgid`, or null when the group table could
   * not be read/parsed. Only consumed by the reap path. */
  groupMembers: (pgid: number) => number[] | null;
  /** The pgid of THIS flow-pipeline session's own `claude` ancestor (see
   * `resolveSessionPid`), when resolvable. Only consumed by the reap path. */
  sessionPgid?: number;
};

function pollForExit(deps: Deps, pids: number[], timeoutMs: number): number[] {
  const deadline = deps.nowMs() + timeoutMs;
  let alive = pids.filter((pid) => deps.alive(pid));
  while (alive.length > 0 && deps.nowMs() < deadline) {
    deps.sleepMs(200);
    alive = alive.filter((pid) => deps.alive(pid));
  }
  return alive;
}

export function runTeardown(
  deps: Deps,
  opts: {
    dryRun: boolean;
    sessionPid?: number;
    timeoutMs: number;
    /**
     * Fired after `selectMcpServers` resolves its list and BEFORE any
     * signal is sent — additive, optional, and never invoked when
     * selection itself never runs (the gate/session/ps-unavailable early
     * returns above). The flagless default mode never passes this; the
     * `--reap` fallback path (`runReapMode` below) uses it to post-hoc
     * register any server this ancestry walk found but the registry
     * didn't already know about.
     */
    onSelect?: (servers: ProcRow[]) => void;
  },
): TeardownResult {
  const explicitSessionPid = opts.sessionPid !== undefined;
  if (!explicitSessionPid && deps.env.FLOW_PIPELINE !== "1") {
    return {
      ran: false,
      skipReason: "not-a-pipeline-session",
      dryRun: opts.dryRun,
      signalled: [],
      stillAlive: [],
    };
  }

  const procs = deps.listProcs();
  if (!procs) {
    return {
      ran: false,
      skipReason: "ps-unavailable",
      dryRun: opts.dryRun,
      signalled: [],
      stillAlive: [],
    };
  }

  let sessionPid = opts.sessionPid ?? resolveSessionPid(procs, deps.selfPid);
  if (explicitSessionPid) {
    // An explicit `--session-pid` bypasses the FLOW_PIPELINE gate AND
    // resolveSessionPid, so it must be independently verified: it has to
    // resolve to a real, currently-alive `claude` process in the table.
    // Without this, a caller-supplied 0/1/negative pid (or anything not in
    // `procs`) would fall through to `descendantsOf` and enumerate — or
    // even SIGTERM — an unrelated slice of the process table.
    const byPid = new Map(procs.map((p) => [p.pid, p] as const));
    const proc = sessionPid === undefined ? undefined : byPid.get(sessionPid);
    if (!proc || !CLAUDE_COMMAND_RE.test(proc.command)) {
      sessionPid = undefined;
    }
  }
  if (sessionPid === undefined) {
    return {
      ran: false,
      skipReason: "no-session-pid",
      dryRun: opts.dryRun,
      signalled: [],
      stillAlive: [],
    };
  }

  const servers = selectMcpServers(procs, sessionPid);
  opts.onSelect?.(servers);
  if (servers.length === 0) {
    return {
      ran: false,
      skipReason: "no-mcp-server",
      sessionPid,
      dryRun: opts.dryRun,
      signalled: [],
      stillAlive: [],
    };
  }

  const signalled: Array<{ pid: number; command: string }> = [];
  if (!opts.dryRun) {
    for (const p of servers) {
      try {
        deps.kill(p.pid, "SIGTERM");
        signalled.push({ pid: p.pid, command: p.command });
      } catch {
        // A race where the process exited between selection and signalling
        // is not a failure — the poll below will simply not find it alive.
      }
    }
  }

  const stillAlive = opts.dryRun
    ? []
    : pollForExit(
        deps,
        servers.map((p) => p.pid),
        opts.timeoutMs,
      );

  return { ran: true, sessionPid, dryRun: opts.dryRun, signalled, stillAlive };
}

// --- Registry-driven reap (--reap) --------------------------------------

export type ReapEnvelope = {
  mode: "reap";
  registry: RegistryReapResult;
  fallback: TeardownResult | null;
  fallbackSkipReason: "registry-covered" | "not-gated" | "no-servers" | null;
  postRegistered: number;
};

/**
 * Bridges this file's `Deps` to `bin/lib/reap.ts`'s `ReapDeps`. Deliberately
 * builds its own `startEpochOf` from `pidStartEpoch` rather than forwarding
 * `deps.startEpochMsOf` — that field is millisecond-scaled for the
 * `--orphans` `ageMs` display (see `buildDefaultDeps` below), while
 * `ProcRegistryRow.startEpoch` (and every comparison the reap engine makes
 * against it) is SECONDS, matching `pidStartEpoch`'s own return unit and
 * `flow-spawn.ts`'s `buildRow`. The two fields now also carry distinct names
 * (`startEpochMsOf` vs. `startEpochOf`), so a future edit here can no longer
 * type-check its way into forwarding the millisecond field straight through
 * and silently epoch-mismatching every live row (a ~1000x scale error) that
 * would turn every reap into a permanent no-op.
 */
function toReapDeps(deps: Deps): ReapDeps {
  return {
    kill: deps.kill,
    alive: deps.alive,
    sleepMs: deps.sleepMs,
    nowMs: deps.nowMs,
    selfPid: deps.selfPid,
    selfPgid: deps.selfPgid,
    sessionPgid: deps.sessionPgid,
    groupMembers: deps.groupMembers,
    startEpochOf: (pid) => pidStartEpoch(pid),
  };
}

/**
 * Registry-first reap: runs `runRegistryReap` against
 * `~/.flow/state/procs/<slug>.jsonl` first, then falls back to the
 * mechanically-unchanged ancestry-walk `runTeardown` only when the registry
 * did not already cover the session's chrome-devtools-mcp server. The
 * fallback is provably skipped (never invisibly skipped): `fallback` is
 * `null` with a named `fallbackSkipReason` whenever it did not run.
 */
export function runReapMode(
  deps: Deps,
  opts: {
    dryRun: boolean;
    slug?: string;
    timeoutMs: number;
    sessionPid?: number;
    baseDir?: string;
  },
): ReapEnvelope {
  // `resolveSlugFromEnv` returns `null`, not `undefined` — `runRegistryReap`
  // keys its `skipReason: "no-slug"` branch on `undefined`, so this must be
  // normalised before the call.
  const slug = opts.slug ?? resolveSlugFromEnv(deps.env) ?? undefined;

  const registry = runRegistryReap(slug, toReapDeps(deps), {
    dryRun: opts.dryRun,
    baseDir: opts.baseDir,
  });

  const registryCoveredMcp = registry.rows.some(
    (r) =>
      r.class === "mcp-server" &&
      (r.outcome === "reaped" ||
        r.outcome === "would-reap" ||
        r.outcome === "still-alive"),
  );

  if (registryCoveredMcp) {
    return {
      mode: "reap",
      registry,
      fallback: null,
      fallbackSkipReason: "registry-covered",
      postRegistered: 0,
    };
  }

  // Independently mirrors runTeardown's own ancestry-walk resolution, purely
  // to stamp the reaper's own session identity onto any post-hoc registered
  // row below (D3) — informational metadata only, never a kill-scope
  // decision. That verification (an explicit --session-pid must resolve to
  // a REAL claude process) stays inside runTeardown itself, unchanged.
  const procsForSession = deps.listProcs();
  const resolvedSessionPid =
    opts.sessionPid ??
    (procsForSession
      ? resolveSessionPid(procsForSession, deps.selfPid)
      : undefined);
  const resolvedSessionStartEpoch =
    resolvedSessionPid !== undefined ? pidStartEpoch(resolvedSessionPid) : null;

  let postRegistered = 0;
  const onSelect = (servers: ProcRow[]): void => {
    // Post-hoc registration is NON-DRY-RUN ONLY, and requires a resolved
    // slug — with no slug at all there is no registry to append to.
    if (opts.dryRun || slug === undefined) return;
    for (const server of servers) {
      const result = appendRow(
        {
          // The server is harness-owned, so its real pgid belongs to the
          // harness, not this row — recording that would put a foreign
          // group into the registry a future default-class bug could
          // group-kill. pgid = pid is harmless: mcp-server rows never take
          // the group path.
          pgid: server.pid,
          pid: server.pid,
          startEpoch: pidStartEpoch(server.pid),
          slug,
          class: "mcp-server",
          argv: [server.command],
          recordedAt: deps.nowMs(),
          sessionPid: resolvedSessionPid ?? null,
          sessionStartEpoch: resolvedSessionStartEpoch,
        },
        opts.baseDir,
      );
      if (result.written) postRegistered++;
    }
  };

  const fallbackResult = runTeardown(deps, {
    dryRun: opts.dryRun,
    sessionPid: opts.sessionPid,
    timeoutMs: opts.timeoutMs,
    onSelect,
  });

  let fallback: TeardownResult | null;
  let fallbackSkipReason:
    | "registry-covered"
    | "not-gated"
    | "no-servers"
    | null;
  if (fallbackResult.ran) {
    fallback = fallbackResult;
    fallbackSkipReason = null;
  } else if (fallbackResult.skipReason === "no-mcp-server") {
    fallback = null;
    fallbackSkipReason = "no-servers";
  } else {
    // "not-a-pipeline-session", "no-session-pid", or "ps-unavailable" — in
    // every case the fallback could not identify a live pipeline session
    // (or its process table) to act on at all. This IS the asymmetric-gate
    // hole named in the plan: reaping from an ordinary, non-pipeline shell
    // leaves an unregistered server neither signalled nor reported by the
    // fallback — named here rather than silently swallowed.
    fallback = null;
    fallbackSkipReason = "not-gated";
  }

  return {
    mode: "reap",
    registry,
    fallback,
    fallbackSkipReason,
    postRegistered,
  };
}

export function summarizeReapEnvelope(envelope: ReapEnvelope): string {
  const c = envelope.registry.counts;
  const registryLine = envelope.registry.ran
    ? `registry: reaped=${c.reaped} would-reap=${c["would-reap"]} still-alive=${c["still-alive"]} failed=${c.failed} already-dead=${c["already-dead"]} skipped-unsafe-pgid=${c["skipped-unsafe-pgid"]} skipped-epoch-mismatch=${c["skipped-epoch-mismatch"]} skipped-foreign-member=${c["skipped-foreign-member"]} skipped-dead-leader=${c["skipped-dead-leader"]} deadline-exceeded=${c["deadline-exceeded"]} malformed=${envelope.registry.malformed}`
    : `registry: ran=false skipReason=${envelope.registry.skipReason ?? "none"} malformed=${envelope.registry.malformed}`;
  const fallbackLine = envelope.fallback
    ? `fallback: ran=true signalled=${envelope.fallback.signalled.length} stillAlive=${envelope.fallback.stillAlive.length}`
    : `fallback: ran=false fallbackSkipReason=${envelope.fallbackSkipReason ?? "none"}`;
  return `flow-browser-teardown --reap: ${registryLine} | ${fallbackLine} | postRegistered=${envelope.postRegistered}`;
}

/**
 * Short, human-scannable counterpart to `summarizeReapEnvelope` — the
 * `CLEANUP:` row's whole payoff is at-a-glance scanning, so the recorded
 * `ReapRecord.summary` uses this instead of the ~290-char counter dump.
 * The verbose dump stays reachable via `--reap --json`; on the unclean
 * path the caller passes `classifyReapEnvelope`'s own `problems` list so
 * the row names the actual leak signal rather than a generic phrase.
 */
export function shortReapSummary(
  envelope: ReapEnvelope,
  problems: string[],
): string {
  if (problems.length > 0) return problems.join("; ");
  const c = envelope.registry.counts;
  const acted = c.reaped + c["already-dead"];
  return acted === 0
    ? "no live processes"
    : `${c.reaped} reaped, ${c["already-dead"]} already dead`;
}

/**
 * Pure classification of a reap envelope into a durable ok/unclean verdict.
 * Problems are drawn only from genuine LEAK signals — `failed`,
 * `still-alive`, `deadline-exceeded`, `skipped-dead-leader`,
 * `registry.malformed`, a non-empty ancestry-walk `fallback.stillAlive`, and
 * `fallbackSkipReason === "not-gated"` (the asymmetric-gate hole named in
 * `runReapMode`'s own comment). `already-dead`, `skipped-epoch-mismatch`,
 * `skipped-unsafe-pgid`, and `skipped-foreign-member` are SAFETY REFUSALS —
 * the reap engine correctly declining to touch a process it can't safely
 * verify — and must never mark the verdict unclean.
 */
export function classifyReapEnvelope(envelope: ReapEnvelope): {
  status: "ok" | "unclean";
  problems: string[];
} {
  const problems: string[] = [];
  const c = envelope.registry.counts;
  if (c.failed > 0) problems.push(`registry: failed=${c.failed}`);
  if (c["still-alive"] > 0)
    problems.push(`registry: still-alive=${c["still-alive"]}`);
  if (c["deadline-exceeded"] > 0)
    problems.push(`registry: deadline-exceeded=${c["deadline-exceeded"]}`);
  if (c["skipped-dead-leader"] > 0)
    problems.push(`registry: skipped-dead-leader=${c["skipped-dead-leader"]}`);
  if (envelope.registry.malformed > 0)
    problems.push(`registry: malformed=${envelope.registry.malformed}`);
  if (envelope.fallback && envelope.fallback.stillAlive.length > 0) {
    problems.push(
      `fallback: stillAlive=${envelope.fallback.stillAlive.length}`,
    );
  }
  if (envelope.fallbackSkipReason === "not-gated") {
    problems.push("fallback: not-gated");
  }
  return { status: problems.length > 0 ? "unclean" : "ok", problems };
}

/**
 * Writes the reap outcome to `~/.flow/state/<slug>.json` as a plain state
 * write (the `flow-checkpoint` arm precedent) — never a `flow-state-update`
 * phase transition, so `updatedAt` is deliberately NOT bumped. A missing
 * state file (no slug resolves, or no pipeline state for that slug) returns
 * `{written: false}` WITHOUT creating one; any other failure (e.g. an
 * unwritable state dir) is caught and returned as a warning, never thrown —
 * this helper must never break the caller that invoked --reap.
 */
export function recordReapOutcome(
  envelope: ReapEnvelope,
  opts?: { stateDir?: string; now?: () => Date },
): { written: boolean; warning?: string } {
  try {
    const slug = envelope.registry.slug;
    if (slug === undefined) return { written: false };
    const state = readState(slug, opts?.stateDir);
    if (state === null) return { written: false };
    const { status, problems } = classifyReapEnvelope(envelope);
    const now = opts?.now ? opts.now() : new Date();
    const record: ReapRecord = {
      at: now.toISOString(),
      status,
      summary: shortReapSummary(envelope, problems),
      ran: envelope.registry.ran || envelope.fallback !== null,
      ...(problems.length > 0 ? { problems } : {}),
    };
    writeState({ ...state, reap: record }, opts?.stateDir);
    return { written: true };
  } catch (err) {
    return { written: false, warning: String(err) };
  }
}

// --- Orphan sweep (--orphans) -------------------------------------------

export type ProfileShape =
  | "chrome-devtools-mcp-cache"
  | "chrome-devtools-mcp-isolated"
  | "go-rod-temp"
  | "unmatched";

export type OrphanRow = {
  pid: number;
  command: string;
  userDataDir: string;
  ageMs: number;
  profileShape: ProfileShape;
  matched: boolean;
};

function trimTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function underPrefix(path: string, prefix: string): boolean {
  const normPath = trimTrailingSlash(path);
  const normPrefix = trimTrailingSlash(prefix);
  return normPath === normPrefix || normPath.startsWith(`${normPrefix}/`);
}

function pathSegments(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

/**
 * A POSITIVE ALLOWLIST, one named entry per recognized shape — never a
 * negative exclusion. Anchored on recognized temp roots + path SEGMENTS
 * (never a raw substring), so a real project dir (e.g. `~/code/rod/user-data`)
 * never false-matches the go-rod shape.
 */
export function classifyProfileShape(
  userDataDir: string,
  opts: { homeDir: string; tmpDir: string },
): ProfileShape {
  const cachePrefix = `${trimTrailingSlash(opts.homeDir)}/.cache/chrome-devtools-mcp`;
  if (underPrefix(userDataDir, cachePrefix)) return "chrome-devtools-mcp-cache";

  const tempRoots = [opts.tmpDir, "/tmp", "/var/folders/"];
  const underTemp = tempRoots.some((root) => underPrefix(userDataDir, root));
  if (!underTemp) return "unmatched";

  const segments = pathSegments(userDataDir);
  const last = segments[segments.length - 1] ?? "";

  // Puppeteer's isolated temp-profile directory shape. UNCONFIRMED BY
  // OBSERVATION: 27 chrome-devtools-mcp servers were live on the host when
  // this was written, but none currently had a Chrome child to inspect.
  // Ship the documented shape rather than inventing a different guess — an
  // unmatched row stays report-only (never signalled even with --yes), so a
  // wrong guess here degrades to report-only instead of an unsafe kill.
  if (/^puppeteer_dev_chrome_profile-/.test(last)) {
    return "chrome-devtools-mcp-isolated";
  }

  // go-rod's os.TempDir()-based profile shape: rod/user-data/<lowercase-hex>,
  // verified live at `/var/folders/8z/.../T/rod/user-data/99b0c95236a886aa`.
  const n = segments.length;
  if (
    n >= 3 &&
    segments[n - 3] === "rod" &&
    segments[n - 2] === "user-data" &&
    /^[0-9a-f]+$/.test(last)
  ) {
    return "go-rod-temp";
  }

  return "unmatched";
}

function extractFlagValue(command: string, flag: string): string | undefined {
  const m = new RegExp(`${flag}=(\\S+)`).exec(command);
  return m?.[1];
}

/**
 * Sessionless automation-Chrome browser ROOTS: ppid 1, the automation flag
 * signature, and a recognized profile shape. A negative "not the user's
 * real Chrome profile" exclusion is deliberately NOT used — it would
 * misclassify a developer's own long-lived custom-profile automation
 * Chrome as an orphan. `--type=` children are excluded as defence in depth
 * (already excluded by the ppid check in practice, since a helper's ppid
 * is the browser root's pid, not 1) — signalling only the root, never a
 * helper, avoids leaving a half-dead browser behind.
 */
export function selectOrphanBrowsers(
  procs: ProcRow[],
  opts: { homeDir: string; tmpDir: string },
): OrphanRow[] {
  const out: OrphanRow[] = [];
  for (const p of procs) {
    if (p.ppid !== 1) continue;
    if (p.command.includes("--type=")) continue;
    const hasAutomationSignature =
      (p.command.includes("--enable-automation") ||
        p.command.includes("--remote-debugging-port")) &&
      p.command.includes("--disable-background-networking");
    if (!hasAutomationSignature) continue;
    const userDataDir = extractFlagValue(p.command, "--user-data-dir");
    if (!userDataDir) continue;
    const profileShape = classifyProfileShape(userDataDir, opts);
    out.push({
      pid: p.pid,
      command: p.command,
      userDataDir,
      // Filled in by runOrphanSweep via deps.startEpochMsOf — see the ageMs
      // seam note there. 0 here is a placeholder, not a claim of freshness.
      ageMs: 0,
      profileShape,
      matched: profileShape !== "unmatched",
    });
  }
  return out;
}

/**
 * Sessionless chrome-devtools-mcp SERVER rows — ppid 1, or ppid absent from
 * the table (parent gone). Shares the single `isMcpServerCommand` predicate
 * with `selectMcpServers` so the two selectors cannot drift. A stale server
 * is exactly what keeps a leaked Chrome alive, and SIGTERM is the only
 * signal that runs its `shutdown()` handler, so reaping it is the same
 * mechanism as `runTeardown`, not a new one.
 *
 * Sharing the predicate also closes a latent FALSE NEGATIVE this selector
 * had on its own: the common server shape has argv[0] rewritten to the bare
 * `chrome-devtools-mcp`, which the entrypoint regex alone never matched, so
 * an orphaned server in that shape was previously swept right past.
 */
export function selectOrphanMcpServers(procs: ProcRow[]): ProcRow[] {
  const knownPids = new Set(procs.map((p) => p.pid));
  return procs.filter(
    (p) =>
      isMcpServerCommand(p.command) && (p.ppid === 1 || !knownPids.has(p.ppid)),
  );
}

function ageMsFor(deps: Deps, pid: number): number {
  const startEpochMsOf = deps.startEpochMsOf;
  if (!startEpochMsOf) return 0;
  const startMs = startEpochMsOf(pid);
  if (startMs === undefined) return 0;
  return Math.max(0, deps.nowMs() - startMs);
}

export type OrphanSweepResult = {
  ran: boolean;
  skipReason?: "ps-unavailable";
  found: OrphanRow[];
  foundServers: Array<{ pid: number; command: string }>;
  signalled: number[];
};

export function runOrphanSweep(
  deps: Deps,
  opts: { yes: boolean; dryRun?: boolean; homeDir: string; tmpDir: string },
): OrphanSweepResult {
  const procs = deps.listProcs();
  if (!procs) {
    return {
      ran: false,
      skipReason: "ps-unavailable",
      found: [],
      foundServers: [],
      signalled: [],
    };
  }

  const found = selectOrphanBrowsers(procs, opts).map((row) => ({
    ...row,
    ageMs: ageMsFor(deps, row.pid),
  }));
  const foundServers = selectOrphanMcpServers(procs).map((p) => ({
    pid: p.pid,
    command: p.command,
  }));

  const signalled: number[] = [];
  if (opts.yes && !opts.dryRun) {
    for (const row of found) {
      if (!row.matched) continue;
      try {
        deps.kill(row.pid, "SIGTERM");
        signalled.push(row.pid);
      } catch {
        // best-effort — a process that exited between selection and
        // signalling is not a failure.
      }
    }
    for (const server of foundServers) {
      try {
        deps.kill(server.pid, "SIGTERM");
        signalled.push(server.pid);
      } catch {
        // best-effort, same as above.
      }
    }
  }

  return { ran: true, found, foundServers, signalled };
}

// --- Default Deps (real process table / real signals) -------------------

function parsePsOutput(text: string): ProcRow[] {
  const out: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue; // header line or malformed row — skip, not fatal
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return out;
}

function defaultListProcs(): ProcRow[] | undefined {
  try {
    const r = Bun.spawnSync(["ps", "-Ao", "pid,ppid,command"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LC_ALL: "C" },
    });
    if (r.exitCode !== 0) return undefined;
    return parsePsOutput(r.stdout.toString());
  } catch {
    return undefined;
  }
}

/**
 * Local 3-way ESRCH/EPERM-aware liveness probe (treats EPERM as alive).
 * Deliberately NOT `bin/lib/tmux.ts`'s private `pidIsAlive`, which
 * collapses ESRCH and EPERM into a single `false` and would under-report
 * `stillAlive` for a permission-denied-but-alive process. A local copy is
 * this repo's accepted convention here — `lock.ts`, `liveness.ts`, and
 * `tmux.ts` each keep their own.
 */
function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM, or anything unexpected: assume still alive rather than
    // falsely reporting a clean exit — this only affects a report field,
    // never triggers a harder signal.
    return true;
  }
}

/**
 * ONE `ps -Ao pid=,pgid=` snapshot, parsed into a pid->pgid map. Serves both
 * `selfPgid` and `groupMembers` from the SAME snapshot (see A2 in the
 * plan): GNU procps' `ps -g <pgid>` selects by session-or-effective-group
 * NAME, not membership, so a per-row `-g` invocation would plausibly return
 * a session superset on Linux (CI runs ubuntu-latest) that always contains
 * an older process, silently turning every default-class row into
 * `skipped-foreign-member`. Parsing one bulk snapshot in TypeScript avoids
 * that platform hazard entirely, and collapses what would otherwise be a
 * per-row fork into a single one.
 */
function takePgidSnapshot(): Map<number, number> | null {
  try {
    const r = Bun.spawnSync(["ps", "-Ao", "pid=,pgid="], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LC_ALL: "C" },
    });
    if (r.exitCode !== 0) return null;
    const byPid = new Map<number, number>();
    for (const line of r.stdout.toString().split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue; // blank/malformed line — skip, not fatal
      byPid.set(Number(m[1]), Number(m[2]));
    }
    return byPid;
  } catch {
    return null;
  }
}

function groupMembersFrom(
  byPid: Map<number, number> | null,
): (pgid: number) => number[] | null {
  return (pgid) => {
    if (byPid === null) return null;
    const members: number[] = [];
    for (const [pid, rowPgid] of byPid) {
      if (rowPgid === pgid) members.push(pid);
    }
    return members;
  };
}

/**
 * Wraps `defaultListProcs` so the underlying `ps -Ao pid,ppid,command` fork
 * runs at most once per CLI invocation regardless of how many times
 * `deps.listProcs()` is called (the `--reap` fallback path calls it once to
 * resolve a session pid for post-hoc registration, then again inside
 * `runTeardown`) — the process table can't meaningfully change within one
 * short-lived invocation in a way that matters here.
 */
function memoizedListProcs(): () => ProcRow[] | undefined {
  let cached: ProcRow[] | undefined;
  let computed = false;
  return () => {
    if (!computed) {
      computed = true;
      cached = defaultListProcs();
    }
    return cached;
  };
}

/**
 * `includeReapExtras` gates the extra `ps -Ao pid=,pgid=` snapshot fork
 * (plus eagerly resolving `sessionPgid`) behind the `--reap` path only —
 * the flagless default and `--orphans` modes never read `selfPgid` /
 * `groupMembers` / `sessionPgid`, so they keep their prior zero-extra-fork
 * behaviour (in the common case where the pipeline-session gate fails
 * before `listProcs` is ever called, that stays a true no-op).
 */
function buildDefaultDeps(opts: { includeReapExtras?: boolean } = {}): Deps {
  const listProcs = memoizedListProcs();
  const selfPid = process.pid;

  let selfPgid: number | null = null;
  let groupMembers: (pgid: number) => number[] | null = () => null;
  let sessionPgid: number | undefined;

  if (opts.includeReapExtras) {
    const byPid = takePgidSnapshot();
    selfPgid = byPid?.get(selfPid) ?? null;
    groupMembers = groupMembersFrom(byPid);
    const procs = listProcs();
    const sessionPid = procs ? resolveSessionPid(procs, selfPid) : undefined;
    sessionPgid = sessionPid !== undefined ? byPid?.get(sessionPid) : undefined;
  }

  return {
    listProcs,
    kill: (pid, signal) => process.kill(pid, signal),
    alive: defaultAlive,
    sleepMs: (ms) => Bun.sleepSync(ms),
    env: process.env,
    selfPid,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    startEpochMsOf: (pid) => {
      const epoch = pidStartEpoch(pid);
      return epoch === null ? undefined : epoch * 1000;
    },
    nowMs: () => Date.now(),
    selfPgid,
    groupMembers,
    sessionPgid,
  };
}

// --- CLI -------------------------------------------------------------

type ParsedCli = {
  json: boolean;
  dryRun: boolean;
  sessionPid?: number;
  timeoutMs: number;
  orphans: boolean;
  yes: boolean;
  reap: boolean;
  record: boolean;
  slug?: string;
  usageError?: string;
};

function parseCliArgs(argv: string[]): ParsedCli {
  const out: ParsedCli = {
    json: false,
    dryRun: false,
    timeoutMs: 12000,
    orphans: false,
    yes: false,
    reap: false,
    record: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--orphans") {
      out.orphans = true;
    } else if (a === "--yes") {
      out.yes = true;
    } else if (a === "--reap") {
      out.reap = true;
    } else if (a === "--record") {
      out.record = true;
    } else if (a === "--slug") {
      const v = argv[++i];
      if (v === undefined || v === "" || !isValidSlug(v)) {
        out.usageError = `--slug requires a valid slug value (got: ${v ?? ""})`;
      } else {
        out.slug = v;
      }
    } else if (a === "--session-pid") {
      const v = argv[++i];
      const n = v === undefined || v === "" ? Number.NaN : Number(v);
      if (v === undefined || v === "" || !Number.isInteger(n) || n <= 1) {
        out.usageError = "--session-pid requires an integer value > 1";
      } else {
        out.sessionPid = n;
      }
    } else if (a === "--timeout-ms") {
      const v = argv[++i];
      const n = v === undefined || v === "" ? Number.NaN : Number(v);
      if (v === undefined || v === "" || !Number.isFinite(n) || n < 0) {
        out.usageError = "--timeout-ms requires a non-negative numeric value";
      } else {
        out.timeoutMs = n;
      }
    } else {
      out.usageError = `unknown flag: ${a}`;
    }
  }
  if (!out.usageError && out.record && !out.reap) {
    out.usageError = "--record requires --reap";
  }
  return out;
}

function usage(): string {
  return [
    "usage: flow-browser-teardown [--json] [--dry-run] [--session-pid <pid>] [--timeout-ms <n>]",
    "       flow-browser-teardown --orphans [--yes] [--dry-run] [--json]",
    "       flow-browser-teardown --reap [--slug <s>] [--dry-run] [--json] [--record]",
    "",
    "Default mode: session-scoped teardown — SIGTERMs THIS flow-pipeline",
    "session's own chrome-devtools-mcp SERVER (found by process ancestry) so",
    "its shutdown() handler reaps its Chrome subprocess. Gated on",
    "FLOW_PIPELINE=1 unless --session-pid is passed explicitly.",
    "",
    "--orphans mode sweeps sessionless browser PROCESSES (and sessionless",
    "chrome-devtools-mcp servers) left behind by a crashed/killed session.",
    "This is NOT the same sweep as `flow done --orphans`, which sweeps stale",
    "pipeline STATE FILES, not browser processes — the two commands share a",
    "flag name but sweep unrelated things.",
    "",
    "--reap mode (opt-in) verifies and signals every row recorded in",
    "~/.flow/state/procs/<slug>.jsonl before falling back to the ancestry",
    "walk above. --slug resolves explicitly, else FLOW_SLUG, else no slug.",
    "A default-class row escalates to a harder signal against its whole",
    "process group after a bounded grace wait; an mcp-server row is",
    "signalled once and never escalated, same policy as the default mode",
    "above. Run with --dry-run first — it sends no signal at all.",
    "",
    "--record (with --reap only) durably writes the reap verdict to",
    "~/.flow/state/<slug>.json as state.reap, surfaced by",
    "`flow-gate-summary --cleanup`. Never writes with --dry-run.",
  ].join("\n");
}

export function main(argv: string[]): number {
  const parsed = parseCliArgs(argv);
  if (parsed.usageError) {
    process.stderr.write(
      `flow-browser-teardown: ${parsed.usageError}\n${usage()}\n`,
    );
    return 0; // never break a caller
  }

  if (parsed.reap) {
    const deps = buildDefaultDeps({ includeReapExtras: true });
    if (!parsed.json) {
      const label = parsed.slug ?? resolveSlugFromEnv(deps.env) ?? undefined;
      process.stderr.write(
        label
          ? `flow-browser-teardown: reaping registered processes for ${label}…\n`
          : "flow-browser-teardown: reaping registered processes for this session…\n",
      );
    }
    const envelope = runReapMode(deps, {
      dryRun: parsed.dryRun,
      slug: parsed.slug,
      timeoutMs: parsed.timeoutMs,
      sessionPid: parsed.sessionPid,
    });
    if (parsed.record && !parsed.dryRun) {
      const { warning } = recordReapOutcome(envelope);
      if (warning) {
        process.stderr.write(`flow-browser-teardown: warning: ${warning}\n`);
      }
    }
    if (parsed.json) {
      console.log(JSON.stringify(envelope));
    } else {
      console.log(summarizeReapEnvelope(envelope));
    }
    return 0;
  }

  const deps = buildDefaultDeps();

  if (parsed.orphans) {
    const result = runOrphanSweep(deps, {
      yes: parsed.yes,
      dryRun: parsed.dryRun,
      homeDir: deps.homeDir,
      tmpDir: deps.tmpDir,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(
        `flow-browser-teardown --orphans: found=${result.found.length} servers=${result.foundServers.length} signalled=${result.signalled.length}`,
      );
    }
    return 0;
  }

  const result = runTeardown(deps, {
    dryRun: parsed.dryRun,
    sessionPid: parsed.sessionPid,
    timeoutMs: parsed.timeoutMs,
  });
  if (parsed.json) {
    console.log(JSON.stringify(result));
  } else {
    const reason = result.skipReason ? ` skipReason=${result.skipReason}` : "";
    console.log(
      `flow-browser-teardown: ran=${result.ran}${reason} signalled=${result.signalled.length} stillAlive=${result.stillAlive.length}`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
