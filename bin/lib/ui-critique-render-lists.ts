/**
 * Line builders for the `## UI review` section's lists: the pages reviewed
 * and the findings. Split from `ui-critique-render.ts` to keep each module
 * small.
 */
import { isGating, type CritiqueFinding } from "./ui-critique";
import type { UiReviewTarget } from "./ui-review-scope";

const SEVERITY_ORDER = ["defect", "major", "minor"] as const;

export function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** Pages the review photographed; derived ones say they are unconfirmed. */
export function targetLines(targets: UiReviewTarget[]): string[] {
  if (targets.length === 0) return [];
  return [
    "**Pages reviewed:**",
    ...targets.map((t) =>
      t.source === "plan"
        ? `- ${cell(t.route)}${t.state ? ` — ${cell(t.state)}` : ""}`
        : `- ${cell(t.route)} — derived — not confirmed to show the change`,
    ),
    "",
  ];
}

const finding = (f: CritiqueFinding): string =>
  `- ${cell(f.section)} @ ${f.viewport} — ${cell(f.observation)}`;

export function residualLines(residual: CritiqueFinding[]): string[] {
  const out: string[] = [];
  const gating = residual.filter(isGating);
  for (const sev of SEVERITY_ORDER) {
    const group = gating.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push(`**Unresolved ${sev} findings:**`, ...group.map(finding), "");
  }
  const preExisting = residual.filter((f) => !isGating(f));
  if (preExisting.length > 0) {
    out.push(
      "**Pre-existing (not gated):**",
      ...preExisting.map((f) => `${finding(f)} (${f.severity})`),
      "",
    );
  }
  return out;
}

/** Advice on the review-time sign-off screenshots; introduced defects first. */
export function signoffLines(
  signoff: { findings: CritiqueFinding[] } | undefined,
): string[] {
  if (!signoff || signoff.findings.length === 0) return [];
  const sorted = [...signoff.findings].sort(
    (a, b) => Number(isGating(b)) - Number(isGating(a)),
  );
  return [
    "**Sign-off screenshots (advisory):**",
    ...sorted.map(
      (f) =>
        `${finding(f)} (${f.severity}${isGating(f) ? "" : ", pre-existing"})`,
    ),
    "",
  ];
}
