/**
 * Typed agy failure taxonomy, splitting `bin/flow-delegate.ts`'s single
 * `"agy-error"` skip reason (and its siblings) into a distinct
 * `AgyFailureClass` a telemetry consumer can count separately —
 * `quota-exhausted` and `rate-limited` above all, since both are
 * frequent, actionable, and today indistinguishable from any other
 * `agy-error`/`agy-empty-artifact` bucket.
 *
 * Quota and rate-limit patterns are matched FIRST, before the generic
 * fallback AND before the empty-artifact fallback, and are matched
 * against BOTH `stdoutTail` and `stderrTail`: agy can print a quota
 * notice to its stdout (the artifact file itself, per `flow-delegate.ts`),
 * which exits non-zero with a non-empty artifact — that reaches the
 * generic `agy-error` skipReason, and must still classify as
 * `quota-exhausted`, not a bare `unknown` that discards the real cause. A
 * 0-byte artifact and "quota text was printed to stdout" are mutually
 * exclusive, so this case never reaches `agy-empty-artifact`.
 */

export const AGY_FAILURE_CLASSES = [
  "quota-exhausted",
  "rate-limited",
  "auth",
  "timeout",
  "canceled",
  "empty-artifact",
  "spawn-failed",
  "unknown",
] as const;

export type AgyFailureClass = (typeof AGY_FAILURE_CLASSES)[number];

const QUOTA_PATTERN =
  /quota reached|upgrade your subscription|resource[_ ]exhausted|quota exceeded/i;
const RATE_LIMIT_PATTERN = /rate limit|429|too many requests/i;

export function classifyAgyFailure(input: {
  skipReason: string;
  stderrTail?: string;
  stdoutTail?: string;
  agyError?: string;
  agyStatus?: string;
}): AgyFailureClass {
  const haystacks = [
    input.stderrTail,
    input.stdoutTail,
    input.agyError,
    input.agyStatus,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);

  for (const text of haystacks) {
    if (QUOTA_PATTERN.test(text)) return "quota-exhausted";
  }
  for (const text of haystacks) {
    if (RATE_LIMIT_PATTERN.test(text)) return "rate-limited";
  }

  switch (input.skipReason) {
    case "agy-not-authenticated":
      return "auth";
    case "agy-timeout":
      return "timeout";
    case "agy-canceled":
      return "canceled";
    case "agy-empty-artifact":
      return "empty-artifact";
    case "spawn-failed":
      return "spawn-failed";
    case "agy-not-found":
      return "unknown";
    default:
      return "unknown";
  }
}
