#!/usr/bin/env bun
/**
 * Polls a GitHub PR's checks and bot reviews until terminal state, then
 * prints a structured JSON document on stdout for the orchestrator wrapper
 * to consume.
 *
 * Usage:
 *   ./scripts/ci-wait.ts --pr <number> [--config <abs-path>]
 *
 * Stdout: a single JSON document describing the final outcome.
 * Stderr: newline-delimited JSON events (`ci-wait.start`, `ci-wait.poll`,
 *         `ci-wait.exit`) consumed by the orchestrator's per-phase JSONL
 *         sink.
 *
 * Exit codes:
 *   0 — outcome "ok"
 *   1 — outcome "ci-hang" or "config-invalid"
 *
 * The script reads `.flow/ci-wait.json` from cwd by default; pass `--config`
 * to override. Per-task state is not consulted — invocations are stateless
 * with respect to the task file, which is what makes the script
 * standalone-runnable against any open PR.
 */

import { readFileSync } from "node:fs";

// --- Types ---

export type CiWaitConfig = {
  bots: string[];
  cadenceMs: number;
  hardCapMs: number;
};

// The GitHub Copilot reviewer's actual login is `copilot-pull-request-reviewer`,
// not `Copilot`. `botsCollected` matches by exact (case-insensitive) login, so
// the default must be the real login or every default-config run hangs to
// hard cap waiting for a bot that will never appear.
export const DEFAULT_CONFIG: CiWaitConfig = {
  bots: ["copilot-pull-request-reviewer"],
  cadenceMs: 30_000,
  hardCapMs: 20 * 60 * 1000,
};

export class ConfigInvalidError extends Error {
  constructor(public readonly detail: string) {
    super(`ci-wait config invalid: ${detail}`);
    this.name = "ConfigInvalidError";
  }
}

// gh's JSON shape for `gh pr checks --json name,state`. `state` values are
// upper-snake-case strings like SUCCESS, FAILURE, IN_PROGRESS, QUEUED,
// PENDING, STARTUP_FAILURE, STALE. We type the field as a wide `string` so
// unknown future values don't fail the load — `isChecksTerminal` is the
// single decision point. `gh pr checks` does not expose a `conclusion`
// field; `state` already encodes the terminal verdict.
export type GhCheck = {
  name: string;
  state: string;
};

export type GhReview = {
  id: number;
  author: { login: string };
  body: string;
  state: string;
  submittedAt: string;
};

export type GhOps = {
  prChecks(pr: number): GhCheck[];
  prReviews(pr: number): GhReview[];
  prUrl(pr: number): string;
};

export class GhTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhTransientError";
  }
}

// CLI-usage / structural errors from `gh` are not transient — retrying them
// for an hour just delays the inevitable failure. We classify by stderr
// content so the polling loop can fail fast instead of treating "Unknown
// JSON field" or "unknown flag" as a retryable network blip.
export class GhPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhPermanentError";
  }
}

const PERMANENT_GH_PATTERNS: RegExp[] = [
  /Unknown JSON field/i,
  /unknown flag/i,
  /unknown command/i,
  /accepts \d+ arg\(s\)/i,
];

export function isPermanentGhStderr(stderr: string): boolean {
  return PERMANENT_GH_PATTERNS.some((p) => p.test(stderr));
}

// --- Config ---

export function loadConfig(configPath: string): CiWaitConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw new ConfigInvalidError(
      `cannot read ${configPath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new ConfigInvalidError(`parse error in ${configPath}: ${(err as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigInvalidError("expected a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const merged: CiWaitConfig = { ...DEFAULT_CONFIG };

  if (Object.hasOwn(obj, "bots")) {
    const bots = obj.bots;
    if (
      !Array.isArray(bots) ||
      bots.length === 0 ||
      !bots.every((b) => typeof b === "string" && b.length > 0)
    ) {
      throw new ConfigInvalidError("`bots` must be a non-empty array of strings");
    }
    merged.bots = bots as string[];
  }
  if (Object.hasOwn(obj, "cadenceMs")) {
    const c = obj.cadenceMs;
    if (typeof c !== "number" || !Number.isInteger(c) || c <= 0) {
      throw new ConfigInvalidError("`cadenceMs` must be a positive integer");
    }
    merged.cadenceMs = c;
  }
  if (Object.hasOwn(obj, "hardCapMs")) {
    const h = obj.hardCapMs;
    if (typeof h !== "number" || !Number.isInteger(h) || h <= 0) {
      throw new ConfigInvalidError("`hardCapMs` must be a positive integer");
    }
    merged.hardCapMs = h;
  }
  if (merged.cadenceMs >= merged.hardCapMs) {
    throw new ConfigInvalidError(
      `cadenceMs (${merged.cadenceMs}) must be < hardCapMs (${merged.hardCapMs})`,
    );
  }
  return merged;
}

// --- Default GhOps (Bun.spawnSync) ---

function ghCapture(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const r = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    exitCode: r.exitCode ?? 0,
  };
}

export function defaultGhOps(): GhOps {
  return {
    prChecks(pr: number): GhCheck[] {
      const r = ghCapture([
        "pr",
        "checks",
        String(pr),
        "--json",
        "name,state",
      ]);
      // `gh pr checks` exits 1 with stderr "no checks reported on the '<ref>'
      // branch" when the PR genuinely has no checks. That's a successful
      // empty result, not a transient failure — distinguish it explicitly so
      // repos without GitHub Actions don't hang the loop to hard cap.
      if (r.exitCode !== 0) {
        if (/no checks reported/i.test(r.stderr)) return [];
        if (isPermanentGhStderr(r.stderr)) {
          throw new GhPermanentError(
            `gh pr checks: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
          );
        }
        throw new GhTransientError(
          r.stderr.trim() || `gh pr checks exit ${r.exitCode}`,
        );
      }
      try {
        const parsed = JSON.parse(r.stdout) as GhCheck[];
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        throw new GhTransientError(`gh pr checks: invalid JSON: ${(err as Error).message}`);
      }
    },
    prReviews(pr: number): GhReview[] {
      const r = ghCapture([
        "pr",
        "view",
        String(pr),
        "--json",
        "reviews",
        "--jq",
        ".reviews",
      ]);
      if (r.exitCode !== 0) {
        if (isPermanentGhStderr(r.stderr)) {
          throw new GhPermanentError(
            `gh pr view (reviews): ${r.stderr.trim() || `exit ${r.exitCode}`}`,
          );
        }
        throw new GhTransientError(
          r.stderr.trim() || `gh pr view exit ${r.exitCode}`,
        );
      }
      try {
        const parsed = JSON.parse(r.stdout) as GhReview[];
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        throw new GhTransientError(`gh pr view: invalid JSON: ${(err as Error).message}`);
      }
    },
    prUrl(pr: number): string {
      const r = ghCapture(["pr", "view", String(pr), "--json", "url", "--jq", ".url"]);
      if (r.exitCode !== 0) {
        if (isPermanentGhStderr(r.stderr)) {
          throw new GhPermanentError(
            `gh pr view (url): ${r.stderr.trim() || `exit ${r.exitCode}`}`,
          );
        }
        throw new GhTransientError(
          r.stderr.trim() || `gh pr view --json url exit ${r.exitCode}`,
        );
      }
      return r.stdout.trim();
    },
  };
}

// --- Pure helpers ---

const PENDING_STATES = new Set(["QUEUED", "IN_PROGRESS", "PENDING"]);

export function isChecksTerminal(checks: GhCheck[]): boolean {
  for (const c of checks) {
    if (PENDING_STATES.has(c.state.toUpperCase())) return false;
  }
  return true;
}

export function pendingCheckNames(checks: GhCheck[]): string[] {
  return checks
    .filter((c) => PENDING_STATES.has(c.state.toUpperCase()))
    .map((c) => c.name);
}

export function botsCollected(
  reviews: GhReview[],
  bots: string[],
): { collected: GhReview[]; missing: string[] } {
  const lower = bots.map((b) => b.toLowerCase());
  const seen = new Set<string>();
  const collected: GhReview[] = [];
  for (const r of reviews) {
    const login = r.author?.login?.toLowerCase() ?? "";
    if (lower.includes(login)) {
      if (!seen.has(login)) {
        seen.add(login);
        collected.push(r);
      }
    }
  }
  const missing = bots.filter((b) => !seen.has(b.toLowerCase()));
  return { collected, missing };
}

// Truncate a review body to at most `maxLines` lines. When truncated, append a
// trailing marker line referencing the review id and url so the consumer can
// fetch the full body. The marker is rendered by the caller via blockquoting.
export function truncateReviewBody(
  body: string,
  reviewId: number,
  reviewUrl: string,
  maxLines = 50,
): { body: string; truncated: boolean } {
  const lines = body.split("\n");
  if (lines.length <= maxLines) {
    return { body, truncated: false };
  }
  const head = lines.slice(0, maxLines).join("\n");
  const marker = `[...truncated, full body in PR review ${reviewId} at ${reviewUrl}]`;
  return { body: `${head}\n${marker}`, truncated: true };
}

// --- Polling loop ---

export type PollDeps = {
  gh: GhOps;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  emit: (event: string, payload: Record<string, unknown>) => void;
};

export type PollOutcome = "ok" | "ci-hang";

export type PollResult = {
  outcome: PollOutcome;
  polls: number;
  durMs: number;
  checks: GhCheck[];
  reviews: GhReview[];
  pendingChecks: string[];
  missingBots: string[];
  // True when the loop exited at hard cap without ever observing a
  // successful checks fetch — i.e. a sustained `gh` outage rather than a
  // legitimately-pending CI run. The renderer distinguishes the two cases
  // so the user isn't left with a `ci-hang` section that omits the cause.
  ciHangNoChecksFetched: boolean;
};

// Per-call retry wrapper. The first failure pauses 5s, then re-invokes; the
// second failure surfaces. The polling loop's caller decides what "second
// failure" means at the iteration level — typically: skip this poll, sleep
// the cadence, try again until the hard cap. `GhPermanentError` is
// rethrown immediately on either attempt — retrying a CLI-usage error just
// burns the hard cap on a guaranteed failure.
async function callWithRetry<T>(
  label: string,
  fn: () => T | Promise<T>,
  sleep: (ms: number) => Promise<void>,
  emit: (event: string, payload: Record<string, unknown>) => void,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof GhPermanentError) throw err;
    const e = err as Error;
    emit("ci-wait.gh_retry", { call: label, error: e.message });
    await sleep(5_000);
    try {
      return { ok: true, value: await fn() };
    } catch (err2) {
      if (err2 instanceof GhPermanentError) throw err2;
      return { ok: false, error: (err2 as Error).message };
    }
  }
}

export async function pollUntilTerminal(args: {
  pr: number;
  config: CiWaitConfig;
  deps: PollDeps;
}): Promise<PollResult> {
  const { pr, config, deps } = args;
  const { gh, sleep, now, emit } = deps;
  const start = now();

  let polls = 0;
  let lastChecks: GhCheck[] = [];
  let lastReviews: GhReview[] = [];
  // Track whether we ever observed a successful checks fetch. Initial empty
  // `[]` is indistinguishable from "no checks exist on this PR", and we don't
  // want a sustained gh outage to look like terminal checks at hard cap.
  let everFetchedChecks = false;

  while (true) {
    const elapsed = now() - start;
    if (elapsed >= config.hardCapMs) {
      // Hard cap reached. Branch on whether checks were terminal at the
      // last successful poll: terminal-but-bots-missing → bot timeout
      // (proceed); a sustained gh outage with no successful poll → ci-hang.
      const checksAreTerminal = everFetchedChecks && isChecksTerminal(lastChecks);
      const pending = pendingCheckNames(lastChecks);
      const missing = botsCollected(lastReviews, config.bots).missing;
      const outcome: PollOutcome = checksAreTerminal ? "ok" : "ci-hang";
      return {
        outcome,
        polls,
        durMs: now() - start,
        checks: lastChecks,
        reviews: lastReviews,
        pendingChecks: pending,
        missingBots: missing,
        ciHangNoChecksFetched: outcome === "ci-hang" && !everFetchedChecks,
      };
    }

    polls++;

    const checksRes = await callWithRetry("prChecks", () => gh.prChecks(pr), sleep, emit);
    const reviewsRes = await callWithRetry("prReviews", () => gh.prReviews(pr), sleep, emit);

    if (!checksRes.ok && !reviewsRes.ok) {
      // Both calls failed both attempts. Treat this iteration as no-progress
      // and continue. The hard cap above will eventually escalate if the
      // outage is sustained.
      emit("ci-wait.poll", {
        polls,
        elapsedMs: now() - start,
        noProgress: true,
        checksError: checksRes.error,
        reviewsError: reviewsRes.error,
      });
      await sleep(config.cadenceMs);
      continue;
    }

    if (checksRes.ok) {
      lastChecks = checksRes.value;
      everFetchedChecks = true;
    }
    if (reviewsRes.ok) lastReviews = reviewsRes.value;

    const checksTerm = isChecksTerminal(lastChecks);
    const { collected, missing } = botsCollected(lastReviews, config.bots);
    const pending = pendingCheckNames(lastChecks);

    emit("ci-wait.poll", {
      polls,
      elapsedMs: now() - start,
      checks: {
        total: lastChecks.length,
        pending: pending.length,
        terminal: checksTerm,
      },
      reviews: {
        collected: collected.map((r) => r.author.login),
        missing,
      },
    });

    // Require that we actually saw a successful checks fetch before
    // declaring "checks terminal" — `isChecksTerminal([])` is true, so a
    // gh outage that never returned check data must not advance past CI
    // just because the reviews call succeeded and bots happen to be present.
    if (everFetchedChecks && checksTerm && missing.length === 0) {
      return {
        outcome: "ok",
        polls,
        durMs: now() - start,
        checks: lastChecks,
        reviews: lastReviews,
        pendingChecks: [],
        missingBots: [],
        ciHangNoChecksFetched: false,
      };
    }

    await sleep(config.cadenceMs);
  }
}

// --- Markdown rendering ---

export type RenderArgs = {
  reviews: GhReview[];
  bots: string[];
  prUrl: string;
  pendingChecks?: string[];
  // When the hard cap was reached without ever fetching checks (sustained
  // gh outage), `pendingChecks` is empty by definition — the script never
  // observed any. Set this flag so the renderer can surface a distinct
  // "no checks could be fetched" diagnostic instead of falling through
  // silently and producing a section with no cause.
  ciHangNoChecksFetched?: boolean;
};

export function renderCiSection(args: RenderArgs): string {
  const { reviews, bots, prUrl, pendingChecks, ciHangNoChecksFetched } = args;
  const lines: string[] = [];

  if (pendingChecks && pendingChecks.length > 0) {
    lines.push(`**Checks still pending at hard cap:** ${pendingChecks.join(", ")}`);
    lines.push("");
  } else if (ciHangNoChecksFetched) {
    lines.push(
      "**Checks could not be fetched within the hard cap (sustained gh failure).**",
    );
    lines.push("");
  }

  // Build the table in `bots` order so the rendered output is stable across
  // runs regardless of the order GitHub returns reviews in.
  const byBot = new Map<string, GhReview>();
  for (const r of reviews) {
    const login = r.author?.login;
    if (!login) continue;
    const lower = login.toLowerCase();
    const matchedBot = bots.find((b) => b.toLowerCase() === lower);
    if (matchedBot && !byBot.has(matchedBot)) {
      byBot.set(matchedBot, r);
    }
  }

  lines.push("| bot | state | submitted_at |");
  lines.push("|---|---|---|");
  for (const bot of bots) {
    const r = byBot.get(bot);
    if (r) {
      lines.push(`| ${bot} | ${r.state} | ${r.submittedAt} |`);
    } else {
      lines.push(`| ${bot} | TIMEOUT | - |`);
    }
  }
  lines.push("");

  for (const bot of bots) {
    lines.push(`#### ${bot}`);
    lines.push("");
    const r = byBot.get(bot);
    if (!r) {
      lines.push(`> _(no review posted within hard cap)_`);
      lines.push("");
      continue;
    }
    const reviewUrl = `${prUrl}#pullrequestreview-${r.id}`;
    const truncated = truncateReviewBody(r.body, r.id, reviewUrl);
    const body = truncated.body.trim().length === 0
      ? "_(empty review body)_"
      : truncated.body;
    for (const line of body.split("\n")) {
      lines.push(`> ${line}`);
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

// --- main() ---

function parseArgs(argv: string[]): {
  pr: number;
  configPath: string | null;
} {
  let pr: number | null = null;
  let configPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pr") {
      const v = argv[++i];
      const n = parseInt(v ?? "", 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--pr requires a positive integer (got ${v})`);
      }
      pr = n;
    } else if (a === "--config") {
      configPath = argv[++i] ?? "";
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: ./scripts/ci-wait.ts --pr <n> [--config <abs>]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (pr == null) throw new Error("--pr is required");
  return { pr, configPath };
}

function emitStderrEvent(event: string, payload: Record<string, unknown>): void {
  const obj = { ts: new Date().toISOString(), event, ...payload };
  process.stderr.write(`${JSON.stringify(obj)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const configPath = args.configPath ?? `${cwd}/.flow/ci-wait.json`;

  let config: CiWaitConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigInvalidError) {
      emitStderrEvent("ci-wait.exit", { outcome: "config-invalid", reason: err.detail });
      process.stdout.write(
        `${JSON.stringify({ outcome: "config-invalid", reason: err.detail })}\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  emitStderrEvent("ci-wait.start", {
    pr: args.pr,
    bots: config.bots,
    cadenceMs: config.cadenceMs,
    hardCapMs: config.hardCapMs,
  });

  const gh = defaultGhOps();
  // Resolve the PR url once up front — it doesn't change between polls and
  // we only need it for the rendered review-section markdown.
  let prUrl = "";
  try {
    prUrl = gh.prUrl(args.pr);
  } catch (err) {
    // Non-fatal — fall back to a synthetic placeholder so rendering still
    // produces a usable section. The truncation marker just won't link.
    emitStderrEvent("ci-wait.gh_retry", {
      call: "prUrl",
      error: (err as Error).message,
    });
  }

  let result: PollResult;
  try {
    result = await pollUntilTerminal({
      pr: args.pr,
      config,
      deps: {
        gh,
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        emit: emitStderrEvent,
      },
    });
  } catch (err) {
    if (err instanceof GhPermanentError) {
      emitStderrEvent("ci-wait.exit", { outcome: "gh-permanent", reason: err.message });
      process.stdout.write(
        `${JSON.stringify({ outcome: "gh-permanent", reason: err.message })}\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  const section = renderCiSection({
    reviews: result.reviews,
    bots: config.bots,
    prUrl,
    pendingChecks: result.outcome === "ci-hang" ? result.pendingChecks : undefined,
    ciHangNoChecksFetched: result.ciHangNoChecksFetched,
  });

  emitStderrEvent("ci-wait.exit", {
    outcome: result.outcome,
    polls: result.polls,
    durMs: result.durMs,
  });

  process.stdout.write(
    `${JSON.stringify({
      outcome: result.outcome,
      polls: result.polls,
      durMs: result.durMs,
      section,
      missingBots: result.missingBots,
      pendingChecks: result.pendingChecks,
    })}\n`,
  );
  process.exit(result.outcome === "ok" ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
