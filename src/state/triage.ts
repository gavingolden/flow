export type TaskIntent =
  | "feature"
  | "bug"
  | "refactor"
  | "docs"
  | "infra"
  | "chore";

const INTENTS: ReadonlySet<string> = new Set<TaskIntent>([
  "feature",
  "bug",
  "refactor",
  "docs",
  "infra",
  "chore",
]);

// Scans the body's `## Triage` section for a `- intent: <value>` line and
// returns the validated literal, or null when the section / line is missing
// or the value is unrecognised. Never throws — callers downstream of this
// (the runner's post-plan fork) treat null as "non-feature, no checkpoint",
// which keeps a malformed intent line from killing the run.
export function parseIntent(body: string): TaskIntent | null {
  const sectionMatch = body.match(
    /^## Triage\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m,
  );
  if (!sectionMatch) return null;
  const section = sectionMatch[1] ?? "";
  const intentMatch = section.match(/^[\s-]*intent\s*:\s*(.+?)\s*$/im);
  const raw = intentMatch?.[1];
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return INTENTS.has(normalized) ? (normalized as TaskIntent) : null;
}
