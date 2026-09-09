---
name: flow-deliberate
description: >-
  Get a blind second opinion on one logical question: an isolated,
  spend-capped judge that enumerates the options, checks each one's
  load-bearing claim against the repo, weighs which are complementary vs
  mutually exclusive, and commits to one recommendation with a confidence
  and an anchor. Use when the user says "second opinion", "I'm stuck",
  "judge this", "what would you recommend", "consider all the options and
  give a final recommendation", or when you are about to tell the user you
  do not have an answer to a question they could reasonably expect one for.
  Skip for questions of taste or preference, for anything needing a
  credential or a fact only the user holds, and for questions already
  settled elsewhere in the conversation.
---

# Goal

Answer ONE logical question with a bounded, blind second opinion, so a
question that would otherwise be bounced back to the user gets resolved by
the system instead. The judge runs in its own process — it never sees this
conversation, and in particular never sees which way you already lean.

# When to Use

- You are about to say "I don't have an answer to that" on a question the
  repository could actually settle.
- You are about to escalate or hand a design fork back to the user, and the
  fork is not a matter of their taste.
- You have a recommendation but low confidence in it, and a second,
  un-anchored read would either confirm it or replace it.
- The user asks directly for a second opinion, or for the options weighed
  and a final recommendation.

# When NOT to Use

- **Taste and preference.** Naming, tone, visual style, "which do you like
  better" — only the user holds the answer, and a judge would override a
  preference rather than resolve a question.
- **Facts only the user has.** Credentials, private context, what they meant
  by an ambiguous instruction. Ask them; a judge would guess.
- **Questions a single command answers.** If `grep` or one file read settles
  it, read the file — the judge is ~$0.50–$1.50 and up to five minutes.
- **Fact-gathering from the web.** That is `/flow-research`; this judge reads
  only the local repository.

# How it works

One Bash call, no sub-agent:

```bash
flow-deliberate --question-file <path> [--blind-to-file <path>] \
  [--worktree <dir>] [--model <alias>] [--effort <lvl>] \
  [--max-budget-usd 2] [--max-turns 15] [--timeout-sec 300] [--task <name>]
```

`flow-deliberate` builds a four-step judge prompt (restate the question
stripped of its framing → enumerate at least three options → verify each
option's load-bearing claim against the repo → weigh complementary vs
exclusive), runs it through ONE `flow-claude-headless` call with the repo
mounted read-only, and prints one JSON envelope.

This is a Bash fan-out over the sanctioned headless-Claude surface, **not**
a Task-tool spawn — see `AGENTS.md` "Don'ts". That is what lets a
Task-spawned sub-agent call it: a sub-agent may never spawn a nested Task,
but it may always shell out.

# The caller contract

## What to put in the question file

- **The question itself**, stated neutrally. Strip the adjectives and the
  narrative. "Should X live in A or B?" — not "X obviously belongs in A,
  but should it go in B?"
- **The fixed facts** the judge cannot discover by reading: a constraint the
  user stated, a decision already made, a number you measured.
- **The options as neutral labels.** Give each option the same amount of
  prose. A paragraph for your favourite and a clause for the other is a
  lean, whatever the words say.

## What to withhold

- **Your own lean, and anything that implies it.** This is the whole point:
  a model told what the asker prefers tends to agree with it. Put the lean
  in `--blind-to-file` and the helper mechanically refuses a question that
  leaked it (skip reason `question-not-blind`, before any spend).
- **The conversation transcript.** It carries the lean implicitly and buries
  the question in the middle of a long context, where it gets used poorly.
- **The plan, and `.flow-tmp/` generally.** The judge is told not to read it;
  do not hand it over anyway.
- **Anything the judge should verify itself.** State claims it cannot check;
  let it check the ones it can.

## How to read the result

The envelope is one JSON line. Branch on `ran`, never on the exit code —
every non-usage path exits 0 by design, so an unavailable judge degrades to
whatever you would have done anyway.

| Field            | Meaning                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `ran`            | `true` when a judgment came back; `false` with `skipReason` otherwise |
| `recommendation` | the judge's one-sentence answer                                       |
| `confidence`     | `high` / `medium` / `low` — derived from the anchor, not asserted     |
| `anchor`         | the evidence the confidence rests on                                  |
| `anchorDemoted`  | `true` when the judge claimed more than its anchor supports           |
| `artifact`       | the full note at `.flow-tmp/deliberation-<task>.md`                   |
| `total_cost_usd` | what this consult actually cost                                       |

**Confidence is anchor-derived, and the helper enforces it.** `high` needs a
file path the judge read or a quotation of the asker; `medium` needs an
adjacent precedent in the repo; anything else — a convention, a weighing, a
general principle — is `low`. A judge that claims `high` on an unverifiable
anchor is mechanically demoted to `low` and `anchorDemoted` is set. This is
what keeps a confident-sounding guess from being adopted as a settled fact.

**Adopt `medium` and `high`; let `low` fall through.** Re-verify the anchor
before adopting (does that path exist? is that quotation really the user's?).
A `low` result, or any `ran: false`, means you do what you would have done
without the judge — ask the user, or escalate. Never retry a skip.

# Reporting the result

Render it in the pause-output contract's slots
(`skills/pipeline/flow-pipeline/references/pause-output-contract.md`):

- `**TLDR:**` — the recommendation, with the confidence in parentheses.
- `**Needs attention:**` — the "what would change my mind" line from the
  note, so the user sees the load-bearing assumption rather than a verdict.
- `**Next action:**` — what you are doing with it (adopting, or asking).

Always say the recommendation came from a blind second opinion, and always
name the confidence. A judge's answer presented as your own conclusion
hides exactly the uncertainty the user needs in order to overrule it.

# Verification

- Exactly one `flow-deliberate` call per question — no retries on a skip.
- The question file names the options neutrally and carries no lean.
- `--blind-to-file` was passed whenever a lean exists in writing.
- The reported confidence is the envelope's `confidence`, not the judge's
  own claim (they differ when `anchorDemoted` is `true`).
- A `low` or `ran: false` result did NOT become an adopted answer.

# Constraints

- NEVER pass the conversation transcript, the plan, or your own reasoning as
  the question. The judge's independence is the only thing it adds.
- NEVER adopt a `low`-confidence recommendation as a resolved answer.
- NEVER re-run the judge to get a different answer. One consult per question;
  a second run on the same question is shopping for the result you wanted.
- NEVER use it for questions of taste, or for anything only the user knows.
- NEVER let a skip block the work — degrade to the path you were already on.
