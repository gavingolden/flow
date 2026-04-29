export const TRUNCATE_AT = 120;

export function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

export function stringifyInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return "<unstringifiable>";
  }
}

export function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx >= 0 ? text.slice(0, idx) : text;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function stringifyRest(
  event: Record<string, unknown>,
  exclude: string[],
): string {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (!exclude.includes(k)) rest[k] = v;
  }
  try {
    return JSON.stringify(rest);
  } catch {
    return "";
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
