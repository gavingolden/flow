# Intent-mismatch resolution — full contract

Full detail for the "Diff-only intent-guess agent", "Cross-model intent
guess", and "## 3.6. Intent-mismatch resolution" sub-steps `SKILL.md`
Step 3 points at.

## Diff-only intent-guess agent

Spawn ONE additional Task agent, `flow-review-intent-guess`, in the SAME
fan-out message as the six lens agents (rides the existing Multi-Agent
Review exemption — no new Task-tool exemption), resolved via the same
`[ -f ~/.claude/agents/flow-review-intent-guess.md ] ||
general-purpose` fallback as the per-lens resolution.

Context is diff-only, deliberately narrower than the six lenses' shared
context block: `$WORKTREE/.flow-tmp/diff.txt` and the changed-file list
only — never `{{PR_TITLE}}`, `{{PR_DESCRIPTION}}`, `{{COMMIT_MESSAGES}}`,
`.flow-tmp/plan.md`, or any other PR-metadata variable from
`agent-prompts.md`'s shared context block. Leaking PR metadata into its
context defeats the blind-guess purpose.

Instruct it to write `$WORKTREE/.flow-tmp/intent-guess.json` before
returning, shape `{"guessed_purpose": string, "key_changes": string[],
"justification": string, "confidence": 0-100}` (full contract, including
the anti-vagueness rule, in `agents/flow-review-intent-guess.md`).

This agent is NOT a seventh row in the six-agent table, NOT part of
`AGENT_LENS_MAP`, and NOT a Step 3.5 Consolidator input — do not fold it
into the consolidator merge. Supervisor-side shape check (run after the
fan-out returns, before Step 3.6 consumes it):

```bash
jq -e 'has("guessed_purpose") and has("key_changes") and has("justification") and has("confidence")' "$WORKTREE/.flow-tmp/intent-guess.json"
```

A missing artifact or a non-zero exit above is a named graceful skip
(`intent-guess-skipped: <reason>`), recorded for step 12 — never treated
as `consolidator-missing-artifact`.

## Cross-model intent guess

`flow-gemini-intent-guess` is a `flow-delegate` (agy) Bash fan-out, NOT a
Task — same "additive, not a tenth exemption" contract as the
Cross-model (Gemini) lens, same `review.gemini`-gate (`jq -e '(.review |
type == "object") and (.review.gemini == true)' ~/.flow/config.json`):

```bash
flow-gemini-intent-guess --worktree "$WORKTREE" \
  --diff-file "$WORKTREE/.flow-tmp/diff.txt" \
  --out "$WORKTREE/.flow-tmp/intent-guess-gemini.json"
```

Branch on the helper's `{ran}` stdout envelope, never the exit code (it
exits 0 on every graceful path): `ran: true` → `intent-guess-gemini.json`
is schema-valid and feeds Step 3.6's cross-model agreement weighing;
`ran: false` → record `skipReason` and proceed with only the diff-only
agent's guess. Gate off, agy absent/unauthenticated, or unparseable agy
output are all graceful skips — never a hard failure.

## 3.6. Intent-mismatch resolution — full detail

Read `$WORKTREE/.flow-tmp/intent-guess.json` (the diff-only agent's
blind guess) and, when `$WORKTREE/.flow-tmp/intent-guess-gemini.json` is
present (the cross-model helper's `ran: true` output), read it too.
**Graceful skip**: when `intent-guess.json` is missing or fails the
shape check above, record `intent-guess-skipped: <reason>` and skip this
sub-step entirely — never `consolidator-missing-artifact`, never a hard
failure.

**Cross-model weighing.** When both guesses are present, agreement on a
mismatch upgrades confidence in the resolution below; disagreement
between the two guesses is recorded as a vagueness signal on its own —
never itself an escalation (two guessers landing on different purposes
can mean the diff is genuinely broad, not that either guess is wrong).
Record `cross_model.agreement` as `"agree"` or `"disagree"`; when the
Gemini guess is absent (gated off, agy unavailable, or malformed),
record `cross_model.ran = false` and `cross_model.agreement = null`.

**Resolve the actual-intent source:**

- Pipeline-launched review: the verbatim user description plus the
  ultimate goal `/flow-pipeline` step 1's triage inferred (carried in
  supervisor context).
- Standalone `/flow-pr-review` invocation: the PR body's `## Why` section
  via `gh pr view <PR> --json body`.

**Apply the ladder:**

1. **Benign divergence** — the guessed purpose and the actual-intent
   source describe the same change from a different angle (wording,
   granularity) with no material scope difference. Record one line in
   the chat summary and proceed; no PR change.
2. **Scope drift** — the guessed purpose names work materially broader
   or narrower than, or adjacent to but distinct from, the actual
   intent. Append one unchecked Test Steps item to the PR body
   (idempotent upsert — do not duplicate on re-run):
   `- [ ] MANUAL: confirm scope drift is intentional - <guess vs request>`.
   This holds the PR at `flow-gate-decide` (an unchecked Test Steps item
   ⇒ gated) — it is never handed to the fix-applier, since "is this
   drift intentional" is a human call, not a mechanical fix.
3. **Fundamental** — the guessed purpose contradicts the actual intent
   (the diff does something the request never asked for, or omits the
   thing it did ask for). Escalate `NEEDS HUMAN: intent-drift` per the
   `intent-drift` recipe in
   [escalation-recipes.md](escalation-recipes.md), quoting the guessed
   purpose, its justification, and the actual request verbatim.

**Vagueness as a mismatch signal.** A `guessed_purpose` broad enough to
fit any PR (per the diff-only agent's anti-vagueness rule) is itself
evidence of a mismatch, not a neutral "guess failed" outcome — weigh it
toward scope-drift or fundamental rather than defaulting to benign
divergence.

**Write the resolution artifact** at
`$WORKTREE/.flow-tmp/intent-resolution.json`:

```json
{
  "verdict": "match" | "benign-divergence" | "scope-drift" | "fundamental",
  "guessed_purpose": "<from intent-guess.json>",
  "resolution": "<one or two sentences — what you decided and why>",
  "cross_model": { "ran": true, "agreement": "agree" | "disagree" | null }
}
```

`"verdict": "match"` covers the sound case where the guess and actual
intent align exactly with nothing worth even a benign-divergence note.
Absent/malformed `intent-guess.json` means this artifact is never
written — the graceful skip above governs.
