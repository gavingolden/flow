#!/usr/bin/env bun
/**
 * Research cache: persist a gather→refute→synthesize research synthesis keyed on a
 * normalized hash of the sharp research question, so a same-scope redirect /
 * crash-resume reuses it instead of re-running the agy fan-out. Backs BOTH the F2
 * discovery pre-check (`/product-planning` Step 1.5, keyed on the bare question) and
 * direct `/flow-research` invocations (keyed under a namespaced prefix, so the two
 * keyspaces stay isolated by construction). Self-contained on purpose — Step 1.5 runs in the
 * consumer/target worktree where flow's bin/lib is absent, so this is invoked by
 * BARE PATH name and imports nothing from bin/lib (root from homedir()).
 * Key = SHA-256 of the normalized question (lowercase/trim/collapse-whitespace);
 * host-wide at ~/.flow/research-cache/, default 48h TTL.
 *
 * Usage:
 *   flow-research-cache get --question <q> [--ttl-hours <N>]
 *   flow-research-cache put --question <q> (--synthesis-file <path> | --synthesis - | --synthesis <literal>)
 *   flow-research-cache prune [--max-entries <N>] [--max-age-hours <H>] [--tmp-max-age-hours <H>] [--dry-run]
 *
 * `prune` is an opt-in GC sweep — SEPARATE from the per-`get` TTL miss, which
 * only treats stale entries as misses and never deletes them. It reclaims:
 * stale entries (older than --max-age-hours), over-cap entries (oldest-by-
 * createdAt first, down to --max-entries), corrupt/unparseable entries, and
 * orphan `*.tmp` files left by a crashed mid-write (only those older than the
 * grace window, so a concurrent in-flight `put` is never raced). Always exits 0
 * (best-effort, never throws). Env: FLOW_RESEARCH_CACHE_MAX_ENTRIES,
 * FLOW_RESEARCH_CACHE_MAX_AGE_HOURS, FLOW_RESEARCH_CACHE_TMP_MAX_AGE_HOURS
 * (flag > env > default). Setting FLOW_RESEARCH_CACHE_SWEEP_ON_PUT to a truthy
 * value runs a best-effort prune after each successful `put` (off by default).
 *
 * Exit codes: 0 — get hit (synthesis on stdout) / put ok / prune done; 2 — bad
 *             args; 3 — get miss (no fresh valid entry; nothing on stdout).
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXIT_OK = 0;
const EXIT_ARGS = 2;
const EXIT_MISS = 3;

const DEFAULT_TTL_HOURS = 48;
const MS_PER_HOUR = 3600_000;

// Prune defaults. --max-age-hours defaults to the same 48h as the get TTL so
// age-pruning reclaims exactly the entries `get` already treats as stale; the
// knob stays separate so the two can diverge. The tmp grace window is short
// (1h) — long enough to never race a live `put`'s write-then-rename.
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_AGE_HOURS = DEFAULT_TTL_HOURS;
const DEFAULT_TMP_MAX_AGE_HOURS = 1;

// prune only ever touches files matching the exact names this helper authors —
// a `<sha256hex>.json` entry or a `<sha256hex>.json.<pid>.tmp` write-temp. This
// bounds the blast radius if FLOW_RESEARCH_CACHE_DIR is pointed at a shared
// directory: an unrelated `.json`/`.tmp` file is left untouched rather than
// reaped as "corrupt" or "orphan".
const ENTRY_NAME_RE = /^[0-9a-f]{64}\.json$/;
const TMP_NAME_RE = /^[0-9a-f]{64}\.json\.\d+\.tmp$/;

// --- Pure helpers (imported by the test) ---

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

export function cacheKey(q: string): string {
  return createHash("sha256").update(normalizeQuestion(q)).digest("hex");
}

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLOW_RESEARCH_CACHE_DIR;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".flow", "research-cache");
}

export function entryPath(q: string, opts: { root?: string } = {}): string {
  return path.join(opts.root ?? cacheRoot(), cacheKey(q) + ".json");
}

// --- Cache read / write ---

export type GetResult = { hit: true; synthesis: string } | { hit: false };

export function getEntry(
  question: string,
  opts: { root?: string; nowMs?: number; ttlHours?: number } = {},
): GetResult {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlHours = opts.ttlHours ?? DEFAULT_TTL_HOURS;
  // Any failure — missing file, unreadable dir, malformed JSON, a non-numeric or
  // absent timestamp, a non-string synthesis, any IO error — degrades to a miss
  // and must NEVER throw: a corrupt cache can't be allowed to error a discovery run.
  try {
    const raw = readFileSync(entryPath(question, { root: opts.root }), "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof obj.createdAt !== "number" ||
      !Number.isFinite(obj.createdAt) ||
      typeof obj.synthesis !== "string"
    ) {
      return { hit: false };
    }
    if (nowMs - obj.createdAt < ttlHours * MS_PER_HOUR) {
      return { hit: true, synthesis: obj.synthesis };
    }
    return { hit: false };
  } catch {
    return { hit: false };
  }
}

export function putEntry(
  question: string,
  synthesis: string,
  opts: { root?: string; nowMs?: number; env?: NodeJS.ProcessEnv } = {},
): void {
  const root = opts.root ?? cacheRoot();
  const env = opts.env ?? process.env;
  const createdAt = opts.nowMs ?? Date.now();
  mkdirSync(root, { recursive: true });
  const dest = entryPath(question, { root });
  const payload = JSON.stringify({
    question,
    normalizedQuestion: normalizeQuestion(question),
    createdAt,
    synthesis,
  });
  // Write-then-rename in the SAME dir: rename is atomic on a single filesystem,
  // so a concurrent reader never sees a half-written entry (or an empty file
  // from a crash mid-write).
  const tmp = dest + "." + process.pid + ".tmp";
  writeFileSync(tmp, payload);
  renameSync(tmp, dest);

  // Opt-in on-put sweep: when FLOW_RESEARCH_CACHE_SWEEP_ON_PUT is truthy, bound
  // the cache without a daemon. Best-effort — a sweep failure must never fail
  // the write that just succeeded (pruneCache is already non-throwing; the
  // try/catch is belt-and-suspenders). Off by default: an unset env var leaves
  // the put hot path free of surprise deletions.
  if (isTruthy(env.FLOW_RESEARCH_CACHE_SWEEP_ON_PUT)) {
    try {
      pruneCache({
        root,
        nowMs: createdAt,
        maxEntries: positiveFloat(env.FLOW_RESEARCH_CACHE_MAX_ENTRIES),
        maxAgeHours: positiveFloat(env.FLOW_RESEARCH_CACHE_MAX_AGE_HOURS),
        tmpMaxAgeHours: positiveFloat(
          env.FLOW_RESEARCH_CACHE_TMP_MAX_AGE_HOURS,
        ),
      });
    } catch {
      // swallow — the put already succeeded.
    }
  }
}

// --- GC sweep (prune) — additive; the get/put TTL-miss contract is untouched ---

export type PruneResult = {
  removedTmp: number;
  removedCorrupt: number;
  removedAge: number;
  removedCount: number;
  remaining: number;
  dryRun: boolean;
};

/**
 * Reclaim space from the cache dir. Pure aside from the `unlinkSync`s it
 * performs (suppressed under `dryRun`). NEVER throws — every IO op is wrapped,
 * mirroring `getEntry`'s never-throw discipline, so a corrupt cache or an
 * unreadable file can't error a sweep. Order: orphan-tmp → corrupt → age →
 * over-count. An undefined limit falls back to its default (the on-put sweep
 * relies on this to pass through env-resolved-or-undefined values directly).
 */
export function pruneCache(
  opts: {
    root?: string;
    nowMs?: number;
    maxEntries?: number;
    maxAgeHours?: number;
    tmpMaxAgeHours?: number;
    dryRun?: boolean;
  } = {},
): PruneResult {
  const root = opts.root ?? cacheRoot();
  const nowMs = opts.nowMs ?? Date.now();
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const tmpMaxAgeHours = opts.tmpMaxAgeHours ?? DEFAULT_TMP_MAX_AGE_HOURS;
  const dryRun = opts.dryRun ?? false;

  const result: PruneResult = {
    removedTmp: 0,
    removedCorrupt: 0,
    removedAge: 0,
    removedCount: 0,
    remaining: 0,
    dryRun,
  };

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    // Missing or unreadable dir: nothing to prune. Not an error — the cache
    // simply hasn't been created yet, or this host can't read it.
    return result;
  }

  // Under dryRun, report what WOULD be removed without touching disk. A real
  // unlink that fails (race, perms) is not counted, so the tallies always
  // reflect files actually gone.
  const remove = (p: string): boolean => {
    if (dryRun) return true;
    try {
      unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  };

  // Fresh, valid entries surviving the age pass — candidates for the count cap.
  const valid: { p: string; createdAt: number }[] = [];

  for (const name of names) {
    const full = path.join(root, name);

    // Orphan tmp (`<key>.json.<pid>.tmp`): delete only outside the grace window
    // so a concurrent `put` about to renameSync its tmp is never raced. Checked
    // before the entry branch because the tmp name also ends in a `.json`
    // segment. Only this helper's own write-temp shape is eligible — an
    // unrelated `.tmp` is left alone.
    if (name.endsWith(".tmp")) {
      if (!TMP_NAME_RE.test(name)) continue;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (nowMs - mtimeMs >= tmpMaxAgeHours * MS_PER_HOUR) {
        if (remove(full)) result.removedTmp++;
      }
      continue;
    }

    // Only the `<sha256hex>.json` entries this helper authors are eligible —
    // any other file (including an unrelated `.json`) is left untouched.
    if (!ENTRY_NAME_RE.test(name)) continue;

    let createdAt: number | undefined;
    try {
      const obj = JSON.parse(readFileSync(full, "utf8")) as Record<
        string,
        unknown
      >;
      // Mirror getEntry's validity check exactly (createdAt finite number AND
      // synthesis a string): an entry get would treat as a permanent miss is
      // dead weight the sweep should reclaim, not keep.
      if (
        typeof obj.createdAt === "number" &&
        Number.isFinite(obj.createdAt) &&
        typeof obj.synthesis === "string"
      ) {
        createdAt = obj.createdAt;
      }
    } catch {
      createdAt = undefined;
    }

    // Corrupt / unparseable / missing-timestamp entry: a permanent `get` miss
    // with zero value (atomic rename guarantees a valid writer never produces
    // one). Remove it.
    if (createdAt === undefined) {
      if (remove(full)) result.removedCorrupt++;
      continue;
    }

    // Age prune: `>=` matches the get TTL's boundary (an entry exactly at the
    // threshold is a miss there, so it is reclaimable here).
    if (nowMs - createdAt >= maxAgeHours * MS_PER_HOUR) {
      if (remove(full)) result.removedAge++;
      continue;
    }

    valid.push({ p: full, createdAt });
  }

  // Count cap: evict oldest-by-createdAt first (a FIFO-by-creation LRU
  // approximation — `get` is read-only, so no access-time is recorded).
  if (valid.length > maxEntries) {
    valid.sort((a, b) => a.createdAt - b.createdAt);
    const overflow = valid.length - maxEntries;
    for (let i = 0; i < overflow; i++) {
      if (remove(valid[i].p)) result.removedCount++;
    }
    result.remaining = valid.length - result.removedCount;
  } else {
    result.remaining = valid.length;
  }

  return result;
}

// --- Subcommand runners ---

/**
 * Parse `--flag value` pairs into a map; returns an error string on a bare flag.
 * Names in `booleanFlags` are valueless toggles (recorded as `"true"`) and do
 * NOT consume the next token — `get`/`put` pass no boolean flags, so their
 * strict key-value parsing is unchanged.
 */
function parseFlags(
  argv: string[],
  booleanFlags: ReadonlySet<string> = new Set(),
): Record<string, string> | { error: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--"))
      return { error: `unexpected argument: ${flag}` };
    const name = flag.slice(2);
    if (booleanFlags.has(name)) {
      out[name] = "true";
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) return { error: `${flag} requires a value` };
    out[name] = value;
    i++;
  }
  return out;
}

export function runGet(argv: string[]): number {
  const flags = parseFlags(argv);
  if ("error" in flags) return argError(flags.error);
  const question = flags.question;
  if (!question) return argError("--question is required");

  // TTL precedence: --ttl-hours flag > FLOW_RESEARCH_CACHE_TTL_HOURS env > default.
  const ttlHours =
    positiveFloat(flags["ttl-hours"]) ??
    positiveFloat(process.env.FLOW_RESEARCH_CACHE_TTL_HOURS) ??
    DEFAULT_TTL_HOURS;

  const result = getEntry(question, { root: cacheRoot(), ttlHours });
  if (result.hit) {
    process.stdout.write(result.synthesis);
    return EXIT_OK;
  }
  return EXIT_MISS;
}

export function runPut(argv: string[]): number {
  const flags = parseFlags(argv);
  if ("error" in flags) return argError(flags.error);
  const question = flags.question;
  if (!question) return argError("--question is required");

  let body: string;
  if (flags["synthesis-file"] !== undefined) {
    try {
      body = readFileSync(flags["synthesis-file"], "utf8");
    } catch (e) {
      return argError(`could not read --synthesis-file: ${String(e)}`);
    }
  } else if (flags.synthesis === "-") {
    body = readFileSync(0, "utf8"); // fd 0 = stdin
  } else if (flags.synthesis !== undefined) {
    body = flags.synthesis;
  } else {
    return argError(
      "one of --synthesis-file <path>, --synthesis -, or --synthesis <literal> is required",
    );
  }

  putEntry(question, body, { root: cacheRoot() });
  return EXIT_OK;
}

export function runPrune(argv: string[]): number {
  const flags = parseFlags(argv, new Set(["dry-run"]));
  if ("error" in flags) return argError(flags.error);

  // flag > env > default, mirroring runGet's --ttl-hours resolution.
  const maxEntries =
    positiveFloat(flags["max-entries"]) ??
    positiveFloat(process.env.FLOW_RESEARCH_CACHE_MAX_ENTRIES) ??
    DEFAULT_MAX_ENTRIES;
  const maxAgeHours =
    positiveFloat(flags["max-age-hours"]) ??
    positiveFloat(process.env.FLOW_RESEARCH_CACHE_MAX_AGE_HOURS) ??
    DEFAULT_MAX_AGE_HOURS;
  const tmpMaxAgeHours =
    positiveFloat(flags["tmp-max-age-hours"]) ??
    positiveFloat(process.env.FLOW_RESEARCH_CACHE_TMP_MAX_AGE_HOURS) ??
    DEFAULT_TMP_MAX_AGE_HOURS;
  const dryRun = flags["dry-run"] === "true";

  const r = pruneCache({
    root: cacheRoot(),
    maxEntries,
    maxAgeHours,
    tmpMaxAgeHours,
    dryRun,
  });
  const verb = dryRun ? "would remove" : "removed";
  process.stderr.write(
    `flow-research-cache prune: ${verb} ${r.removedAge} stale, ` +
      `${r.removedCount} over-cap, ${r.removedCorrupt} corrupt, ` +
      `${r.removedTmp} orphan-tmp; ${r.remaining} remaining\n`,
  );
  return EXIT_OK;
}

function positiveFloat(raw: string | undefined): number | undefined {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  const s = raw.toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function argError(message: string): number {
  console.error(`flow-research-cache: ${message}`);
  return EXIT_ARGS;
}

// --- Top-level dispatcher ---

export function run(argv: string[]): number {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "get":
      return runGet(rest);
    case "put":
      return runPut(rest);
    case "prune":
      return runPrune(rest);
    default:
      console.error(
        "usage: flow-research-cache get --question <q> [--ttl-hours <N>]\n" +
          "       flow-research-cache put --question <q> (--synthesis-file <path> | --synthesis - | --synthesis <literal>)\n" +
          "       flow-research-cache prune [--max-entries <N>] [--max-age-hours <H>] [--tmp-max-age-hours <H>] [--dry-run]",
      );
      return EXIT_ARGS;
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
