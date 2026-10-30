## Step 1 — Triage

Contents: The first action of the supervisor · No-state-file guard · Only these two step-1 calls use --slug · Goal-framing: ladder up to the ultimate goal · Solution fit · Intent interview · Prompt sanity gate · End conditions

**Phase:** `triaging`

**The first action of the supervisor.** Extract the pipeline slug from the seed prompt before
any bash calls. The seed is a single line whose
prefix has the form `[pipeline-slug: <slug>]` — parse the literal
`<slug>` value from it and embed it inline in the two calls below. The
slug is a concrete string (e.g. `csv-export`), not a shell variable
that persists across tool calls.

**The seed carries `REQUEST_FILE: <path>`; read that file first and
treat its full contents as the verbatim request** (the description no
longer rides the seed — a stray control char in free-form text used to
corrupt delivery, so the launcher now writes it to this file first). If
`REQUEST_FILE` is absent, escalate `NEEDS HUMAN: request-file-missing`.
A hand-run `/flow-pipeline <description>` carries no `REQUEST_FILE` —
the inline description IS the request, used exactly as before.

Write the phase to state.json so `flow ls` immediately shows `triaging`
instead of the stale `starting` from `flow feature create`. Pass `--slug <slug>`
explicitly — explicit and self-documenting, rather than relying on
`resolveSlugAmbient()`'s ambient `FLOW_SLUG` read:

```bash
flow-state-update --phase triaging --slug <slug>
```

**No-state-file guard (never work inline on the base branch).** If this
first `flow-state-update --phase triaging` exits non-zero with a `no state
file` error *while `FLOW_SLUG` is set* — i.e.
the supervisor is genuinely inside a `flow feature create`-launched pipeline — this is the
`flow feature create` state-write race (the parent's `phase: starting` write has not
landed yet), **not** a direct/manual invocation. The supervisor must **not**
fall through to classifying or implementing inline on the base branch.
Retry `flow-state-update --phase triaging --slug <slug>` a bounded ~3 times
with a short backoff; if it still fails, escalate `NEEDS HUMAN:
state-file-missing-on-start` and end the turn. The escalation's
`flow-gate-summary` render may itself be unable to record `phase:
needs-human` (there is no state file to update), so
the supervisor prints the `NEEDS HUMAN: state-file-missing-on-start` line and
ends — `flow-stop-guard` already no-ops when state.json is missing, so the
turn-end is permitted. (`flow feature create` now writes `phase: starting` before it
delivers the seed, so this guard is defense-in-depth against a residual
slow-filesystem window or a future regression, not the common path.)

Then, under the tmux launcher, set a readable tmux window title so the user can scan their
status bar at a glance instead of squinting at the slug. The slug
stays the canonical lookup key (`FLOW_SLUG`, set in the launch env
when `flow feature create` launched the pipeline) — the rename
only changes the tmux window's display title. Pass `--slug <slug>` here for the same
reason as above: explicit and self-documenting.

```bash
flow-rename-window --slug <slug> "<short descriptive title>"
```

**Only these two step-1 calls use `--slug`.** All other helpers after
step 1 continue to use auto-resolution (`resolveSlugAmbient`) because
`FLOW_SLUG` is reliably set for the pipeline's whole lifetime.

Pick a 20–30-character title from the user's verbatim description.
Strip imperative verbs and articles (`make`, `add`, `the`, `a`),
keep the topic noun phrase. Examples:

- `"Make tmux window renames safe …"` → `"safe tmux window renames"`
- `"Add CSV export to portfolio page"` → `"CSV export"`
- `"Fix the flow-ci-wait copilot detection bug"` → `"copilot detection fix"`

Fire `flow-rename-window` exactly **once** in this step. If the user
later runs `tmux ,` to rename to something else, do **not** re-rename
in subsequent steps — the user's choice wins.

#### Goal-framing: ladder up to the ultimate goal

Before classifying, ladder up from the surface request to the underlying
problem / friction / efficiency-gain it serves — what the user ultimately
wants fixed, unblocked, or sped up — using the Ladder Up technique in
`skills/pipeline/flow-product-planning/references/discovery-playbook.md`
(reference it; don't duplicate it here). Infer the **ultimate goal** and
state it in **one line** in chat, then carry it in your context to step 3.

**Solution fit.** When (and only when) the request's named mechanism may not serve that goal, add one chat line
`Solution fit: <mechanism> may not serve <ultimate goal> — <what the user would gain or lose>`, worded in user
terms with no path:line in it; omit when there is no case. A confident case (cites a path:line or zero-hit grep AND
names a concrete alternative) seeds the intent interview's Q1 and overrides the expert-specified carve-out;
otherwise append `SOLUTION-FIT: <case>` to the ultimate-goal line threaded to step 3. Body:
`references/solution-fit.md`.

Laddering up is the default; the same playbook carries a broader set of
**framing lenses** (internal-only Five Whys, Jobs-to-be-Done,
first-principles, inversion, pre-mortem, second-order effects) for a
request at the right altitude but still mis-framed — reach for one only
when framing is genuinely in doubt, and keep it internal (never an
interrogation or an emitted section).

This is the triage-side entry point for the AGENTS.md `## Output style`
rule **Understand the ultimate goal behind the request, not just the
literal ask.**, and it is **conditional**: skip the whole sub-step on
trivial / time-critical requests; expert-specified ones still run the
one-line goal and Solution fit, never the lenses. Infer-and-proceed is the default: flow PRs are
gated and revertible, so proceed on the most-likely goal and surface the
considered alternative in the PRD and the PR `## Why` (gated at
`plan-pending-review` for feature intent) rather than stopping to ask.

**Intent interview (adaptive).** After Ladder Up above and the prompt-sanity
gate below, apply the trigger contract in
`references/interview-playbook.md` (fire-by-default for change-intent
requests, with named carve-outs and a mechanical under-~50-character
floor — full detail lives there, not duplicated here). When the trigger
does NOT fire, proceed straight to classification below unchanged.

When the trigger **fires**:

1. Compose the round's questions, then write the phase **together with
   the ask-time digest** — the full interview-to-date with this round's
   questions carried at `still-open` (the third resolution state the
   playbook's `## 7` names):

   ```bash
   flow-state-update --phase triage-pending-interview --interview-stdin <<'EOF'
   <digest: every question asked so far, each ANSWERED/adopted/still-open>
   EOF
   ```

   Unlike step 3's question gate — whose battery survives the pause on
   disk at `.flow-tmp/interview-questions.md` — the step-1 battery
   exists ONLY in the turn being ended here, so a `/clear` or crash at
   the pause would otherwise strand the resume row (`step-1`,
   `awaiting-triage-interview-answers`) with an empty
   `.context.interview` and force it to re-derive a different frontier —
   renumbering questions the user is looking at and breaking the stable
   `Q<n>` ids that make `answer: 3a` unambiguous. This ask-time write is
   what makes the pause itself recoverable.
2. Render the current frontier round per the playbook's `## 3. Question
   format` — every question numbered `Q<n>`, grouped under its category
   heading — inside the `references/pause-output-contract.md` slot
   shape (template: `references/interview-playbook.md` `## 8`; labeled
   slots, no open prose).
   <!-- any new pause site below must reference pause-output-contract.md -->
3. End the turn.
4. On the user's reply, parse it per the playbook's `## 5. Answer
   parsing` (compact `1a 2c 3: <text>` form; a vague/non-committal
   answer silently adopts that question's `Recommended:` option) or
   route an escape verb per `## 6` (`proceed` / `skip interview` /
   `cancel`).
5. Immediately after parsing the reply — BEFORE recomputing the
   frontier — persist the full interview digest so far (every question
   asked in every round up to and including this one, and its
   resolution) via `flow-state-update --interview-stdin` (see the
   playbook's `## 7. Persistence contract`; the write REPLACES the
   prior digest with the full interview-to-date, not a delta). This
   per-round write is what makes a mid-interview crash or `/clear`
   recoverable — a resumed session re-renders from the last persisted
   round instead of losing every answered round since the interview
   started.
6. Recompute the frontier: settled answers may reveal new questions
   (push them to the next round) or the frontier may be empty (proceed
   to step 2). Repeat from step 2 above for a non-empty frontier.

This sub-step is DISTINCT from the unparseable-input branch below
(**Ambiguous** → `triage-pending-clarification`): that branch is a
single, unpersisted clarifying ask for genuinely unparseable input; this
interview is the adaptive, multi-round, persisted battery for a
parseable-but-underspecified change request. Never ask mid-run outside
either of these two named mechanisms.

#### Prompt sanity gate

Bounded pass verifying the prompt's concrete claims against the worktree/attached files (bounded excerpt reads only), reaching **sound** (proceed) / **suspect** (proceed, thread note to step 3) / **contradicted** (ask one question quoting both sides; unresolved ⇒ `NEEDS HUMAN: prompt-contradiction` — or `NEEDS HUMAN: wrong-repo` when the repo-fit sub-check found none of the request's surfaces or domain terms in this repo). Checklist: `references/prompt-sanity.md`.

Then classify:

| Pattern | Class |
|---|---|
| "how does X work?", "explain Y", "what's the difference …" | no-change |
| "add", "implement", "build", "fix", "refactor", "change", "remove" | change |
| Ambiguous ("I'm thinking about …", "what would it take to …") | **ASK** before classifying |

Then assign an **intent**: `feature` / `bug` / `refactor` / `docs` /
`infra` / `chore`. Intent governs whether step 4 (approval) runs:
`feature` triggers the plan checkpoint; non-feature intents skip it.

**End conditions:**

- **No-change** → answer the user's question in chat directly,
  then write the phase and persist the answer via a quoted heredoc on
  stdin before ending the turn:

  ```bash
  flow-state-update --phase triaged-no-change --answer-stdin <<'EOF'
  <the answer just given to the user>
  EOF
  ```

  The phase write is what `flow-stop-guard` reads to recognise the
  legitimate stop; the quoted-heredoc + `--answer-stdin` transport persists
  the answer verbatim (immune to shell expansion and a leading `--`, so
  backticks, `$(...)`, or a leading `---` round-trip byte-for-byte) for
  re-surfacing on resume, since a no-change pipeline has no worktree. Do NOT
  proceed to step 2.
- **Change** → continue to step 2. The **slug** was already finalized by
  `flow feature create`'s slugify (`bin/lib/slug.ts`) and is the worktree
  directory basename; the supervisor never re-derives or renames it (it is
  the canonical pipeline identifier, set in the launch env as `FLOW_SLUG`
  — changing it would orphan the state file, worktree branch, and
  `flow attach`/`flow done` lookups). The display-title rename
  (`flow-rename-window`, tmux launcher only) is the only exception.
  `flow-new-worktree` enforces
  this: a positional slug not matching the ambient `FLOW_SLUG` exits
  non-zero with `slug-mismatch:` (the PR #152 footgun).
- **Ambiguous** (input is genuinely unparseable) → write
  `flow-state-update --phase triage-pending-clarification`,
  then ask the single clarifying question and end the turn. The
  next turn re-enters step 1 with the user's reply. If the answer
  is still ambiguous, escalate `NEEDS HUMAN: triage-ambiguous` via
  `flow-gate-summary` (which records
  `phase: needs-human` itself) instead of asking again.
  Format this reply per `references/pause-output-contract.md` — labeled slots, no open prose, ≤12 lines, ≤2 bullets per slot (template: `### ❓ Clarification needed` / `**Needs attention:** <the ambiguity>` / `**Next action:** reply with your intent`).
  <!-- any new pause site below must reference pause-output-contract.md -->
