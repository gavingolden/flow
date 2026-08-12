/**
 * Prompt builder for `bin/flow-plan-review.ts`'s cross-model (AGY) plan
 * review. Extracted out of that file's former private `buildPrompt` so the
 * prompt content is directly testable without exporting the CLI's
 * internals.
 *
 * The battery replaces the prior 6-point decision-local rubric (branch
 * walk-through / system flow / ripple / exclusivity / missing branch /
 * pre-mortem) with an ADVERSARIAL, GOAL-ANCHORED battery: every lens judges
 * the plan against the PRD's own `**Goal:**` line rather than staying
 * decision-internal, explicitly challenges the human author's elicited
 * preferences when they conflict with that goal, and forces the reviewer to
 * form an independent cut-list BEFORE it reads the plan's own `## Cut
 * list` — so a lazy "I agree with the author" never happens by construction.
 *
 * The battery now runs WITH REPO ACCESS: `flow-plan-review.ts` passes the
 * repository itself as the reviewer's sole `--add-dir`, so the prompt
 * instructs the reviewer to verify the plan's claims about existing
 * behaviour against the real code rather than assuming them, and to cite
 * the exact path any current-behaviour claim was read from.
 */

/**
 * Extracts the PRD's `**Goal:**` line verbatim (including the `**Goal:**`
 * marker) so callers can quote it directly. Tolerant: matches the FIRST
 * such line anywhere in the plan text (not scoped to the `# PRD` section —
 * unlike flow-plan-lint.ts's stricter `checkGoalLine`, a malformed/missing
 * `# PRD` heading here should not suppress a Goal line that IS present) and
 * returns `null`, never throws, when no such line exists.
 */
export function extractGoalLine(planText: string): string | null {
  const m = planText.match(/^\*\*Goal:\*\*.*$/m);
  return m ? m[0].trim() : null;
}

/**
 * Extracts a named `## `-level section's body — from the heading to the
 * next `#`/`##` heading or EOF. Returns "" when the heading is absent.
 * Local, tolerant helper for the Problem-Statement fallback below; NOT a
 * general-purpose export (flow-plan-review.ts's own decision-analysis
 * extractor stays independent per that file's existing convention).
 */
function extractHeadingBody(planText: string, heading: string): string {
  const lines = planText.split("\n");
  const startIdx = lines.findIndex(
    (l) => l.trim() === heading || new RegExp(`^${heading}\\s*$`).test(l),
  );
  if (startIdx === -1) return "";
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines
    .slice(startIdx + 1, endIdx)
    .join("\n")
    .trim();
}

export type BatteryPromptInput = {
  planText: string;
  goalLine: string | null;
  // True when the reviewer receiving this prompt is the SAME model family as
  // the PRD's author (flow's PRDs are drafted by the Claude discovery
  // subagent, so the deep tier's second reviewer — also Claude — sets this).
  // Swaps the opener's premise so a same-family reviewer isn't told it has
  // independence it doesn't have; defaults to false (the original
  // different-family framing) for the standard tier and the deep tier's
  // first (genuinely different-family) reviewer.
  sameFamilyAsAuthor?: boolean;
  // The absolute repository root the reviewer can read (flow-plan-review.ts
  // passes it as the reviewer's sole `--add-dir`). REQUIRED: both call
  // sites in flow-plan-review.ts already hold `$WORKTREE` verbatim, so a
  // caller that omits it is a wiring bug the type system should catch.
  worktreePath: string;
};

/**
 * Builds the adversarial, goal-anchored battery prompt sent to the
 * cross-model reviewer. The reviewer's output is INPUT the supervisor
 * weighs, never a verdict — that framing (and the "flag uncertainty, never
 * fabricate" instruction) is preserved verbatim from the prior rubric.
 */
export function buildBatteryPrompt(input: BatteryPromptInput): string {
  const anchor =
    input.goalLine ??
    (() => {
      const body = extractHeadingBody(input.planText, "## Problem Statement");
      return body
        ? `(no **Goal:** line found; falling back to the '## Problem Statement' body below)\n\n${body}`
        : "(no **Goal:** line or '## Problem Statement' section found in this plan)";
    })();

  const opener = input.sameFamilyAsAuthor
    ? "You are a cross-model plan reviewer. A PRD drafted by another instance of your own model family (Claude) is below — you share its blind spots by construction, so weight the structurally-independent lenses (3-6 below) over agreement with its stated risks. Your job is to independently pressure-test the PRD against its OWN stated goal — not just the internal consistency of its decisions."
    : "You are a cross-model plan reviewer. A PRD drafted by a different model family (Claude) is below. Its author both wrote the plan and named its own risks in one context, so it shares that model's blind spots. Your job is to independently pressure-test the PRD against its OWN stated goal — not just the internal consistency of its decisions.";

  return `${opener}

Your output is INPUT the supervisor weighs against context it has and you do not — it is NOT a verdict. Reason at the end-user and PRD level (named skills, pipeline steps, consumer repos). ${input.worktreePath} is the readable repository root — READ it to VERIFY the plan's claims about existing behaviour rather than assuming them. Reach for it with your file-reading tools ONLY (read a file, list a directory). Do NOT shell out — no \`grep\`, \`find\`, \`ls\`, \`cat\`, or \`git\` commands: this is a headless run in which shell commands need a permission nothing can grant mid-run, so they are auto-denied and your review ends silently with no output at all. Do NOT read the \`.flow-tmp/\` directory — it holds this pipeline's own scratch state, including any OTHER reviewer's in-flight or already-written output; your independence from the other reviewer is the entire point of running a second model, so reading their output would silently turn an "independently converged" point into an echo. Do NOT open \`.env*\` files or any credential/secret file — you never need them to review a plan, and reading them would be a pure liability with no reviewing benefit. Findings are about the PLAN's decisions, not about the current code's style — the code this plan describes does not exist yet, so do not review it. When you cannot verify a claim from the repository, flag the uncertainty explicitly — never fabricate a concrete flow to sound authoritative.

Emit the six lenses below under their EXACT authored headings (e.g. \`**Goal-anchored verdicts.**\`) — do not paraphrase or rename them, so your output can be matched back to the lens it addresses. Any claim you make about CURRENT behaviour must cite the exact file path you read it from; an uncited claim about current behaviour must be labelled an assumption, not stated as fact — with repo access, a confident-but-fabricated codebase claim is the new failure mode this battery must guard against.

## Goal anchor

The plan's stated goal is the yardstick for every lens below:

"""
${anchor}
"""

Apply these lenses, in this order:

1. **Goal-anchored verdicts.** For every consequential verdict/decision in the plan (especially \`## Decision analysis\` and \`## Recommendation\`), judge it explicitly against the goal anchor above — not just against internal consistency. Name any verdict that is locally coherent but drifts from, or under-serves, the stated goal.
2. **Preference challenge.** The plan may encode preferences the human author elicited or asserted mid-discovery. Where a preference's LITERAL reading conflicts with the goal anchor, challenge it explicitly — say so plainly, don't soften it into a vague caveat.
3. **Per-option user-flow walkthrough.** For each option under every open question / decision fork, give a concrete end-to-end user-flow walkthrough: what the user sees, what they type, what they wait for. Every walkthrough that involves any prompt, confirmation, or blocking wait MUST state interruptions-per-run as a NUMBER (e.g. "1 interruption per run", "0 interruptions — fully automated").
4. **Structurally-different alternatives.** Propose alternatives that are STRUCTURALLY different from the plan's chosen design — never a mere variant/rewording of it — and rank them against the goal anchor. Name the dominant one.
5. **Failure-modes battery.** Enumerate the plan's top failure modes. For EACH one, give a mitigation that costs NOTHING in extra prompts, confirmations, or user interruptions (a prompt-free mitigation) — a mitigation that just adds another confirmation step does not count.
6. **Independent cut list.** Before reading the plan's own \`## Cut list\` section, form your OWN list of unnecessary complexity in the plan body that slows shipping. THEN read the plan's \`## Cut list\` and reconcile the two: name anything you found that the author missed, and — if the author claims "nothing — minimal" — say explicitly whether that claim survives your independent list or not.

Write prose (or lightly-structured markdown), organized by lens. Be concrete and specific; skip praise and preamble. If a lens is genuinely well-converged (nothing to add), say so briefly and move on.

## PRD

${input.planText}`;
}
