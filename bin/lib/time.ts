/**
 * Small time helpers shared by the bin/ scripts.
 */

/**
 * Renders the difference between two timestamps as the largest non-zero
 * unit ("30s ago", "12m ago", "3h ago", "2d ago"). Used by `flow ls`'s
 * LAST ACTIVITY column. Negative deltas (clock skew, future timestamps)
 * clamp to "0s ago" rather than producing a negative value.
 */
export function relativeTime(thenMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/**
 * Renders an elapsed-time delta (in milliseconds) as a compact, largest-two-
 * units string: "45s", "3m12s", "1h04m". Used by the pipeline snapshot's
 * PHASES section to show how long each phase took. Returns "" for non-finite,
 * zero, or negative input so callers can omit the suffix rather than print a
 * garbage value.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    return `${totalMin}m${String(totalSec % 60).padStart(2, "0")}s`;
  }
  const hr = Math.floor(totalMin / 60);
  return `${hr}h${String(totalMin % 60).padStart(2, "0")}m`;
}
