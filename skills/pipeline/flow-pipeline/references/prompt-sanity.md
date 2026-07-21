# Prompt sanity gate — checklist and recipes

Full contract for the "Prompt sanity gate" sub-step `skills/pipeline/flow-pipeline/SKILL.md`
Step 1 points at, run right before triage classification.

## Purpose

The user's prompt may cite facts about the codebase that have drifted or
were never true (a renamed symbol, a moved path, a stale PR number). This
gate catches contradictions BEFORE they propagate into discovery/plan.md,
where they are far more expensive to unwind. It is a bounded pass, not a
research task — it verifies concrete, checkable claims, not opinions or
preferences.

## What counts as a "concrete factual claim"

- A file or directory path the prompt asserts exists (or doesn't).
- A function/symbol/flag/env-var name the prompt asserts is present (or
  absent) in a named file or module.
- A PR or issue number the prompt references (`"per #123"`, `"like the
fix in PR 456"`).
- A behavioural claim about an attached or referenced file's contents
  ("the file already handles X", "there's no test for Y").

Opinions, priorities, and design preferences are never in scope for this
gate — only checkable facts.

## Verification recipes

- **Path claims** — `test -e <path>` (or `test -f` / `test -d` as
  appropriate). Do this before trusting a claim like "the helper at
  `bin/flow-foo.ts` already does X."
- **Symbol/flag claims** — `grep -n '<symbol>' <file>` (or `grep -rn` when
  the file isn't named). Confirms the named export/flag/constant exists
  where claimed.
- **PR/issue-number claims** — `gh pr view <n>` / `gh issue view <n>` (or
  `gh pr view <n> --json title,state` for a bounded check). Confirms the
  number exists and roughly matches the prompt's description of it.
- **Attached/referenced file claims** — read with **bounded excerpt
  reads only**: a targeted `grep -n '<term>' <file>` to locate the
  relevant lines, then `head`/`Read` with an offset+limit around just
  those lines. Never `cat` the whole file to sanity-check one claim —
  that defeats the point of a bounded gate and burns context the
  downstream discovery pass needs.

## Cross-checking for contradiction

After gathering the bounded evidence, compare it against the prompt's
claim line by line. A contradiction is when the evidence directly
conflicts with what the prompt asserts (the path doesn't exist, the
symbol isn't there, the PR says something different from what's quoted)
— not merely when the evidence is silent on the claim (that's "suspect",
not "contradicted").

## Verdicts

- **sound** — every checkable claim in the prompt was verified and
  matched the evidence. Note it in one line in chat and proceed straight
  to classification.
- **suspect** — at least one claim could not be verified (no test/grep
  hit either way) but nothing was directly contradicted. Proceed, but
  carry a short note describing the unverifiable claim into step 3 —
  threaded to discovery per
  `skills/pipeline/flow-pipeline/references/step3-threading.md` so the
  discovery agent's own premise check has the context.
- **contradicted** — at least one claim's evidence directly conflicts
  with the prompt. Do not proceed silently:
  1. Write `flow-state-update --phase triage-pending-clarification`.
  2. Ask exactly **one** question, quoting both sides verbatim — the
     prompt's claim and the contradicting evidence (e.g. the `grep`
     output or the `gh pr view` result).
  3. End the turn.
  4. If the reply doesn't resolve the contradiction (or the user's next
     turn doesn't clarify it), escalate `NEEDS HUMAN: prompt-contradiction`
     rather than asking a second time.

## Discipline notes

- This gate is bounded — spend it on the prompt's stated concrete
  claims, not an open-ended audit of the whole repo.
- Bounded-read discipline applies to every attached/referenced file: grep
  first to find the relevant lines, then read a small window around
  them. A full-file read defeats the gate's purpose.
- `suspect` is not a failure mode — most prompts will land here when they
  reference plausible-but-unverified details. Only `contradicted` blocks
  the turn.
