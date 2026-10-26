/**
 * Pure builders for the UI critic's prompt and reply parsing. The critic is a
 * fixed-model headless child that can only Read files and answer; this module
 * lists every path it must read and fixes the one JSON shape it may reply in.
 */
import { fencedLineMask } from "./md-block-structure";
import type { SectionShot } from "./ui-driver-schema";

const LAYOUT_INTENT_MAX_CHARS = 6000;

/**
 * The `## Layout Intent` section body (its design-intent bullets included),
 * from the heading to the next `##` heading or end-of-file, fence-aware.
 */
export function extractLayoutIntent(planMd: string): string | null {
  const lines = planMd.split("\n");
  const fenced = fencedLineMask(lines);
  const start = lines.findIndex(
    (l, i) => !fenced[i] && /^##\s+Layout Intent\s*$/i.test(l),
  );
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!fenced[i] && /^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body.length > 0 ? body.slice(0, LAYOUT_INTENT_MAX_CHARS) : null;
}

export type CritiquePromptInput = {
  shots: SectionShot[];
  snapshots: { route: string; path: string }[];
  layoutIntent: string | null;
  ruleDocPaths: string[];
  smells: string[];
  phase: "round-0" | "post-round";
};

/**
 * `post-round` carries no earlier findings and no hint of what changed: the
 * critic judges the new gallery as if fresh, and the loop compares rounds.
 */
export function buildCritiquePrompt(i: CritiquePromptInput): string {
  const rubric = i.ruleDocPaths.filter((p) =>
    p.endsWith("rendered-critique.md"),
  );
  const rules = [
    ...rubric,
    ...i.ruleDocPaths.filter((p) => !rubric.includes(p)),
  ];
  const lines: string[] = [
    "You are a UI design critic. You can only Read files and reply; you cannot run or edit anything.",
    i.phase === "post-round"
      ? "Judge the page below as if you had never seen it before."
      : "Judge the rendered page below.",
    "",
    "Step 1. Read every rule doc, one path per line. `rendered-critique.md` is the rubric: it defines severity and the finding shape.",
    ...rules,
    "",
    "Step 2. Read each route's accessibility snapshot. It is the primary evidence for hierarchy, roles, names and reading order.",
    ...i.snapshots.map((s) => `${s.path}  (route ${s.route})`),
    "",
    "Step 3. Read each screenshot (the Read tool displays images). A screenshot is never the sole basis for a finding.",
    ...i.shots.map(
      (s) =>
        `${s.path}  (route ${s.route}, section ${s.section}, ${s.viewport}, ${s.part})`,
    ),
    "",
    "Design intent:",
    i.layoutIntent ??
      "No design intent was ratified — judge against the rule docs only.",
  ];
  if (i.smells.length > 0) {
    lines.push(
      "",
      "Page-check smells (hints about where to look, never findings by themselves):",
      ...i.smells.map((s) => `- ${s}`),
    );
  }
  lines.push(
    "",
    'Reply with exactly one JSON object and nothing else: {"findings":[{"id":"…","severity":"defect|major|minor","route":"…","section":"…","viewport":"…","shot":"<the exact screenshot path above this finding is grounded on>","observation":"…","rule":"<rule doc and principle>","fix":"<a direction, never a framework mechanic>"}]}.',
    'Every string is non-empty and at most 300 characters; report at most 20 findings. Reply {"findings":[]} when the page has no defect or major issue.',
  );
  return lines.join("\n");
}

/** The first balanced JSON object in the child's text that parses, else null. */
export function parseJsonReply(text: string): unknown {
  for (
    let start = text.indexOf("{");
    start >= 0;
    start = text.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
