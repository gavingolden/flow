// Parses a compact duration string such as "1h30m" or "45s" into seconds.
const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1 };

export function parseDuration(input: string): number {
  const parts = input.trim().match(/(\d+)([hms])/g);
  if (!parts || parts.join("") !== input.trim()) {
    throw new Error(`invalid duration: ${input}`);
  }
  return parts.reduce((total, part) => {
    const unit = part.slice(-1);
    return total + Number(part.slice(0, -1)) * UNIT_SECONDS[unit];
  }, 0);
}
