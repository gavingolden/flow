#!/usr/bin/env bun
/**
 * Research cache: persist the F2 discovery research synthesis (`/product-planning`
 * Step 1.5's gather→refute→synthesize result) keyed on a normalized hash of the
 * sharp research question, so a same-scope redirect / crash-resume reuses it
 * instead of re-running the agy fan-out. Self-contained on purpose — Step 1.5 runs
 * in the consumer/target worktree where flow's bin/lib is absent, so this is
 * invoked by BARE PATH name and imports nothing from bin/lib (root from homedir()).
 * Key = SHA-256 of the normalized question (lowercase/trim/collapse-whitespace);
 * host-wide at ~/.flow/research-cache/, default 48h TTL.
 *
 * Usage:
 *   flow-research-cache get --question <q> [--ttl-hours <N>]
 *   flow-research-cache put --question <q> (--synthesis-file <path> | --synthesis - | --synthesis <literal>)
 *
 * Exit codes: 0 — get hit (synthesis on stdout) / put ok; 2 — bad args;
 *             3 — get miss (no fresh valid entry; nothing on stdout).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXIT_OK = 0;
const EXIT_ARGS = 2;
const EXIT_MISS = 3;

const DEFAULT_TTL_HOURS = 48;
const MS_PER_HOUR = 3600_000;

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
  opts: { root?: string; nowMs?: number } = {},
): void {
  const root = opts.root ?? cacheRoot();
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
}

// --- Subcommand runners ---

/** Parse `--flag value` pairs into a map; returns an error string on a bare flag. */
function parseFlags(
  argv: string[],
): Record<string, string> | { error: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--"))
      return { error: `unexpected argument: ${flag}` };
    const value = argv[i + 1];
    if (value === undefined) return { error: `${flag} requires a value` };
    out[flag.slice(2)] = value;
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

function positiveFloat(raw: string | undefined): number | undefined {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
    default:
      console.error(
        "usage: flow-research-cache get --question <q> [--ttl-hours <N>]\n" +
          "       flow-research-cache put --question <q> (--synthesis-file <path> | --synthesis - | --synthesis <literal>)",
      );
      return EXIT_ARGS;
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
