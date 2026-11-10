/** The headless child's one-line JSON envelope and its two parse helpers. */

export type HeadlessEnvelope = {
  ran?: boolean;
  skipReason?: string;
  artifact?: string;
  total_cost_usd?: number;
};

/** The child prints one JSON line last; anything unparseable is a skip. */
export function parseHeadlessStdout(stdout: string): HeadlessEnvelope {
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as HeadlessEnvelope)
      : { ran: false, skipReason: "headless-error" };
  } catch {
    return { ran: false, skipReason: "headless-error" };
  }
}

/** Reads the child's `.result` text from the headless artifact. */
export function readHeadlessResult(
  envelope: HeadlessEnvelope,
  fallbackPath: string,
  readFile: (p: string) => string,
): string | null {
  try {
    const artifact: unknown = JSON.parse(
      readFile(envelope.artifact ?? fallbackPath),
    );
    const result = (artifact as { result?: unknown } | null)?.result;
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}
