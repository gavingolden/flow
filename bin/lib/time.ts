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
