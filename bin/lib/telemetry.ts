/**
 * Durable, correlatable pipeline-telemetry log: one JSON line per event,
 * appended to `~/.flow/telemetry/events.jsonl`. Modeled on
 * `bin/lib/launch-log.ts`'s `appendLaunchRecord` (fail-open `mkdirSync` +
 * one `appendFileSync` + catch) rather than the heavier multi-dependency
 * shape used elsewhere — `recordEvent` below never throws, so a caller
 * never has to guard it.
 *
 * This is an internal lib, not a PATH-shipped helper: it is deliberately NOT
 * registered in `bin/lib/sources.ts`'s `VALIDATOR_MODULES` allowlist — see
 * `bin/lib/delegate-skip-class.ts`'s header comment for the same rationale.
 *
 * Event vocabulary is deliberately narrow: `plan.redirect` is NOT an event.
 * A user redirect at plan review is instead DERIVED from a `phase.transition`
 * whose `from` is `"plan-pending-review"` and whose `to` is `"planning"` —
 * see `docs/configuration.md`'s worked jq one-liner. No agent-authored
 * telemetry emission surface exists; every event is emitted by a helper at
 * an existing chokepoint (`AGENTS.md`, "derive, don't emit").
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { flowTelemetryLogPath } from "./paths";
import { resolveSlugAmbient } from "./session-identity";
import { readState, type PipelineState } from "./state";
import { FLOW_STATE_DIR } from "./paths";
import {
  shouldAttemptCompaction,
  compactLogIfNeeded,
} from "./telemetry-rotate";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export const TELEMETRY_EVENTS = [
  "delegate.call",
  "phase.transition",
  "verify.attempt",
  "run.terminal",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];

/**
 * Soft per-line byte cap (measured as JS string length, ASCII-dominant
 * content in practice). `serializeEvent` truncates `attrs.stderr_tail` /
 * `attrs.stdout_tail` — never the correlation fields — to stay under it.
 */
export const TELEMETRY_LINE_CAP = 4000;

export type TelemetryEvent = {
  version: 1;
  ts: string;
  event: TelemetryEventName;
  slug: string | null;
  pr: number | null;
  repo: string | null;
  session_id: string | null;
  attrs: Record<string, unknown>;
};

export type ResolveCorrelationOpts = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

export type CorrelationResult = {
  slug: string | null;
  pr: number | null;
  repo: string | null;
  session_id: string | null;
  /** Extra attrs the guard wants merged into the emitted event's attrs. */
  attrs: Record<string, unknown>;
};

/**
 * Resolves the slug/pr/repo/session_id correlation quadruple for the
 * current process, plus the slug-misattribution guard.
 *
 * The guard exists because `resolveSlugAmbient` is env-only (`FLOW_SLUG`):
 * a `claude` subprocess spawned from inside a live pipeline window inherits
 * that env var even when it is NOT that pipeline's own session (the same
 * FLOW_SLUG-leak hazard `bin/lib/session-identity.ts` and flow's stop-guard
 * both defend against). Comparing the resolved `CLAUDE_CODE_SESSION_ID`
 * against the state file's own `sessionId` (written once by
 * `flow-open-pr.ts` at PR-open time) catches that case: on a MISMATCH the
 * event is recorded with slug/pr/repo nulled out and `attrs.unmatched_slug`
 * set to the inherited (wrong) slug, rather than silently misattributing
 * the event to a pipeline it didn't belong to.
 *
 * When either side's session id is simply ABSENT (no Claude Code harness,
 * or the state file predates `flow-open-pr`'s session-id capture) that is
 * NOT a mismatch — there is nothing to disprove — so attribution is kept
 * and `attrs.slug_unverified = true` is set instead, so a downstream
 * reader can distinguish "verified" from "trusted but unconfirmed".
 */
export function resolveCorrelation(
  opts: ResolveCorrelationOpts = {},
): CorrelationResult {
  const env = opts.env ?? process.env;
  const slug = resolveSlugAmbient({ env });
  const sessionId = env.CLAUDE_CODE_SESSION_ID ?? null;

  if (slug === null) {
    return {
      slug: null,
      pr: null,
      repo: null,
      session_id: sessionId,
      attrs: {},
    };
  }

  let state: PipelineState | null = null;
  try {
    state = readState(slug, opts.stateDir ?? FLOW_STATE_DIR);
  } catch {
    state = null;
  }

  const pr = state?.pr ?? null;
  const repo = state?.repo ?? null;
  const stateSessionId = state?.sessionId ?? null;

  if (sessionId !== null && stateSessionId !== null) {
    if (sessionId !== stateSessionId) {
      return {
        slug: null,
        pr: null,
        repo: null,
        session_id: sessionId,
        attrs: { unmatched_slug: slug },
      };
    }
    return { slug, pr, repo, session_id: sessionId, attrs: {} };
  }

  // Absent on either side — not a mismatch, keep attribution but mark it
  // unverified.
  return {
    slug,
    pr,
    repo,
    session_id: sessionId,
    attrs: { slug_unverified: true },
  };
}

/**
 * Serializes a `TelemetryEvent` to a single JSON line, truncating
 * `attrs.stderr_tail` then `attrs.stdout_tail` (halving each repeatedly,
 * which converges in a handful of passes even for a multi-KB tail) and, if
 * still over cap once both are emptied, deleting them outright. Any
 * truncation or deletion sets `attrs.truncated = true`.
 */
export function serializeEvent(
  event: TelemetryEvent,
  cap: number = TELEMETRY_LINE_CAP,
): string {
  const working: TelemetryEvent = {
    ...event,
    attrs: { ...event.attrs },
  };

  const fits = () => JSON.stringify(working).length <= cap;
  if (fits()) return JSON.stringify(working);

  let truncated = false;
  for (const field of ["stderr_tail", "stdout_tail"] as const) {
    const val = working.attrs[field];
    if (typeof val !== "string" || val.length === 0) continue;
    let text = val;
    while (text.length > 0 && !fits()) {
      const half = Math.floor(text.length / 2);
      const nextLen = half === text.length ? text.length - 1 : half;
      text = text.slice(0, nextLen);
      working.attrs[field] = text;
      truncated = true;
    }
    if (fits()) break;
  }

  if (!fits()) {
    for (const field of ["stderr_tail", "stdout_tail"] as const) {
      if (field in working.attrs) {
        delete working.attrs[field];
        truncated = true;
      }
    }
  }

  if (truncated) {
    working.attrs.truncated = true;
  }
  return JSON.stringify(working);
}

export type RecordEventOpts = {
  /** Test seam: write target, resolved at call time when absent. */
  logPath?: string;
  /** Test seam: correlation's env source, defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: correlation's state-dir, defaults to `FLOW_STATE_DIR`. */
  stateDir?: string;
};

/**
 * Best-effort telemetry append. NEVER throws and never changes a caller's
 * control flow — an unwritable `~/.flow/telemetry/` is a silent no-op,
 * exactly like `appendLaunchRecord`'s fail-open contract.
 */
export function recordEvent(
  event: TelemetryEventName,
  attrs: Record<string, unknown> = {},
  opts: RecordEventOpts = {},
): void {
  try {
    const correlation = resolveCorrelation({
      env: opts.env,
      stateDir: opts.stateDir,
    });
    const record: TelemetryEvent = {
      version: TELEMETRY_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      event,
      slug: correlation.slug,
      pr: correlation.pr,
      repo: correlation.repo,
      session_id: correlation.session_id,
      attrs: { ...attrs, ...correlation.attrs },
    };
    const line = serializeEvent(record);
    const target = opts.logPath ?? flowTelemetryLogPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${line}\n`);

    if (shouldAttemptCompaction(target)) {
      compactLogIfNeeded(target, Date.now());
    }
  } catch {
    // Best-effort: telemetry must never fail the caller's operation.
  }
}
