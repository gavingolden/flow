/**
 * Tolerant `ui.critique` read: the one switch for the automatic UI
 * critique-and-fix round. Mirrors `readJudgeEnabled` — an absent file,
 * malformed JSON, `ui: null` and a missing key all read as ENABLED; only a
 * strict `false` opts out.
 */
export function readUiCritiqueEnabled(
  readFile: (p: string) => string | null,
): boolean {
  const raw = readFile("config");
  if (raw === null) return true;
  try {
    return JSON.parse(raw)?.ui?.critique !== false;
  } catch {
    return true;
  }
}
