# Pause-output contract

Every turn-ending assistant message that hands control back to the user
ends in one **pause block**: a single `###` markdown status heading plus
a fixed set of bold-label bullets. The block mirrors the formal
`STATUS:` / `WHY:` / `NEXT ACTION:` gate grammar rendered by
`bin/flow-gate-summary.ts` (see its header comment), so users sight-read
one vocabulary everywhere — the informal sites just render it as
markdown instead of a helper block.

## The block

1. **Status heading (always).** Exactly one `###` markdown heading
   carrying the status, e.g. `### ⏸ GATED — manual validation needed`,
   `### ❓ Clarification needed`, `### ✅ Merged`. It is the visual
   anchor the user scrolls to.
2. `**TLDR:**` (always) — one sentence, the user-visible outcome or
   consequence, never the mechanism. It is the first slot, before any
   omit-when-empty slot, so a reader who stops after one line still
   knows what happened.
3. **Labeled slots (omit-when-empty, in this order):**
   - `**Unsolved:**` — open forks, unresolved questions, or known-red
     items left as-is, each with the recommended default inline when
     one exists.
   - `**Needs attention:**` — high-stakes decisions (see
     `## Definitions`) and items awaiting the user's judgment
     (subjective checks, gated Test Steps with their click target, open
     questions), each stated as before→after plus the option chosen and
     why.
   - `**Manual action:**` — split `before merge:` / `whenever:` (see
     `## Definitions`).
   - `**Untracked:**` — discovered-but-not-tracked work items (see
     `## Definitions`), each with its `#N` and the `file #N` /
     `drop #N` reply verbs.
4. `**Next action:**` (always, last) — the single most useful thing the
   user can do next, naming the reply verbs the site accepts (e.g.
   `approve` / `redirect: …` / `cancel`, or "tick the Test Steps boxes
   and say `merge`").

There is no catch-all slot. A Q&A answer, a mechanism note, or any
content that does not fit one of the six labels above lives as prose
**above** the block (see `## Closing-summary` below), never forced under
a wrong label and never left as unlabeled prose after the block.

## Ceiling

A pause block is a decision surface, not a recap: it targets **~12
lines** including the status heading and the reply-verb line, with
**≤2 bullets per slot**. When a slot's content would exceed two bullets:

- minor/solved items collapse into the one count line inside
  `**Manual action:**` or the area just above `**Next action:**` (see
  the count-line definition below) rather than enumerating each one,
- overflow rides behind a named artifact path (`plan: <path>`,
  `→ <pr-url>`) the reader can open on demand, or behind a chat-visible
  `<details>` block for a snapshot/comment render,
- never behind a second, unlinked pause block or a wall of additional
  bullets.

The ceiling is advisory for helper-rendered blocks with more than two
attention items (calibration sample 7 renders 13 lines with two items
plus one follow-up) and binding for LLM-authored informal pauses, which
have no mechanical cap — see a feature plan's `## Plan risks` for the
acknowledged risk that this is a strong, not mechanical, lever.

## Definitions

**Meaningful deviation** (feeds `**Unsolved:**` / `**Needs attention:**`
and the PR body's `## Deviations from plan`): user-visible behavior
differs from what the plan described, scope was dropped or added, an
architecture choice changed from the plan's, or something was deferred
rather than shipped.

**High-stakes decision** (feeds `**Needs attention:**`): a new
dependency or module, a changed storage/state/contract shape, a new
policy or exemption, a hard-to-reverse choice, or a debated fork with
more than one viable option. Read these from a plan's
`## Decision analysis` and `## Architecture Decisions` sections; state
each as before→after, the option chosen, and why — never as an
enumerated task or file list (see `## Applicability`'s plan-approval
entry).

**Untracked** (feeds `**Untracked:**`): work discovered mid-run that is
not in the plan and not filed as an issue — a mechanically-seeded
deferral, an observed anti-pattern, or a supervisor-judged addition.
flow only **lists** untracked items with their `#N`; it never
auto-files one. `file #N` (any pause site) or `drop #N` are the only
ways an item leaves the unfiled list; both produce a one-line
confirmation, never a silent state change.

**Count line**: minor, already-solved problems (findings fixed, defects
closed) collapse to one line — `N findings fixed, M deferred` — rather
than an itemized recap. It never attests to behavior ("none changed
behavior"); a fix whose behavior changed is a deviation and belongs
under `**Needs attention:**` / `## Deviations from plan` instead, per
its own defined slot.

**Manual action split**: `before merge:` is the mechanical
`SUBJECTIVE:`-prefixed subset of a gate's validation items; `whenever:`
is everything else queued for later (local follow-ups, post-merge
chores). An item never appears in both buckets.

**"Give me the technical version"**: on request, the current reply
expands in place to the full mechanism-and-identifier detail (the raw
tool names, step numbers, internal error strings this contract
otherwise translates away) — a one-time chat expansion, not a change to
`output.lens` or any persisted setting.

**Q&A answers live above the block**: an answer to a question the user
asked rides as prose immediately above the pause block, in ≤3 sentences
per `## Language contract`; it is never squeezed into `**TLDR:**` or any
other slot as a label-mismatched summary.

## Language contract

`## The block` fixes the slot set; this section governs what goes
**inside** those slots. Write for a reader who has decision authority
but zero project context — they have been away from this thread and
share none of your vocabulary: not the tool names, not the step
numbers, not the internal error strings. Problem reports — pipeline
pauses, escalations, `NEEDS HUMAN` blocks, gate decisions, verify/CI
failures, and merge-conflict reports — follow the six rules below;
everything else follows "Calibrate length to task" in
`references/output-style.md`.
Explanatory content in any slot follows rules 1–2 as well — see the
generalized rule in `references/output-style.md`.

1. **Impact first.** The status heading and the first slot line state
   the user-visible consequence, never the mechanism; a caveat that
   changes the user's decision rides with the impact line or the
   option line it affects, never only in the detail above the block.
2. **Zero internal jargon.** Translate internal tool, step, and error
   names into their effect; an internal identifier may trail in a
   parenthetical, never stand as the statement itself.
3. **Honest uncertainty.** When no clear recommendation exists, say so
   plainly and present the options symmetrically — never manufacture a
   confident bottom line. (This rule is deliberately ordered before the
   options rule.)
4. **Options with consequences.** When a decision is needed,
   `**Needs attention:**` carries the short option list —
   recommendation first, each option naming its good AND bad
   consequence on one line. `**Next action:**` keeps the single-line
   form the slot set above defines: the recommended reply verb, or
   `choose one of the options above` when no recommendation exists.
5. **Progressive disclosure.** Logs, diffs, and analysis live above the
   block or in a named artifact referenced by path. Advisory, never
   enforced: the impact summary runs about 150 words (the options list
   is additional and not counted) and the whole block fits a
   screenful.
6. **Formal renders carry the language rules too.** The `--why` text
   passed to `flow-gate-summary` follows rules 1-3 and 5; its slot and
   sentinel syntax is untouched, and it is single-line by construction,
   so structured options in the formal grammar are out of scope here.

**CI failure:**

> Before: `flow-ci-wait` returned `ci-hang` after polling PR #212 for
> 20 minutes.
> After: CI hasn't finished in 20 minutes — longer than normal, and it
> may be stuck (`flow-ci-wait` timeout).

**Test failure:**

> Before: `flow-pre-commit --json` came back with `allPassed: false` on
> the `scripts` scope.
> After: One of the automated checks is failing, so this change isn't
> safe to merge yet.

**Merge conflict:**

> Before: the merge-conflict resolver hit a conflicted base merge in
> `bin/flow-state-update.ts`.
> After: Your branch and `main` both changed the same file in
> different ways; I need to pick which change wins before I can
> continue.

**Gate decision needing a choice:**

> Before: `flow-gate-decide` returned `gated` with two unchecked Test
> Steps on PR #212.
> After: Two checks only you can do are still open, so this won't
> merge on its own. Ticking them and saying `merge` ships it now;
> asking me to merge anyway skips those checks — I'll confirm once
> before doing it.

**Honest uncertainty:**

> Before: intent-guess confidence came back `low` on whether "faster"
> means load time or refresh interval.
> After: I'm not sure which kind of "faster" you mean — page load or
> the live-refresh interval — and either reading is equally plausible
> from what you wrote.

## Step contract

`## Language contract` above governs wording; this section governs
**shape** — how an instruction or action list is laid out once the words
are chosen. It is binding, not advisory.

**The rule.** An instruction or action list renders as numbered
imperative steps, one action per line: `  1. <imperative step>`, `  2.
<imperative step>`, … — in a helper-rendered block the step lines carry
the block's two-space indent, matching the GATED block's validation-item
rows (`  - <item>`) and the `MANUAL ACTION:` entries. Multi-sentence or
reference detail rides as an indented sub-bullet under the step it
belongs to (`   - <detail>`), never bundled onto the step line itself —
except a short trailing qualifier on the step's own command (see
"Discrete action" below), which stays on the step line rather than
forking into a sub-bullet. When more than one party acts — the
supervisor runs a command, the user makes a call, a subagent reports
back — name the actor at the start of the relevant step (`**Supervisor:**
…`, `**User:** …`) so the reader never has to infer who does what.

**Scope.** This section binds two surfaces: (a) the formal gate-grammar
`NEXT ACTION:` row `bin/flow-gate-summary.ts` renders for a multi-action
recipe, and (b) authored procedure docs — the escalation procedures in
`references/failure-recovery.md`. It does **not** change the informal
pause-block `**Next action:**` slot defined in `## The block` item 4
above: that slot is bound by `## Language contract` rule 4 to a single
most-useful next thing, single-line by construction, and stays that way.
The two sections are not in tension — `## The block` governs the one
informal slot; `## Step contract` governs everything else that lists out
instructions. `## Language contract` rule 6's "structured options in the
formal grammar are out of scope" is scoped to the informal
`**Next action:**` slot's option-list shape (rule 4); it does not carve
out the `NEXT ACTION:` row's numbered _steps_, which this section governs
instead.

For a `NEXT_ACTION_BY_REASON` recipe in `bin/flow-gate-summary.ts`
specifically: a multi-line recipe's first line is always a plain,
non-numbered header sentence — `pushNextAction` puts it on the `NEXT
ACTION:` row and every following line verbatim, so a recipe whose first
line is itself numbered would render with inconsistent indentation
between the header and the steps below it.

**Discrete action.** A separate copy-pasteable command, or a separate
decision the reader must make. A trailing qualifier on one command (e.g.
"and inspect its output") is detail, not a second action, and stays on
the step line. Threshold: two or more discrete actions become a numbered
list; one discrete action stays inline.

**Terminal punctuation.** A step line that ends on a bare copy-pasteable
command or path takes no trailing period — terminals and drag-select
extend greedily through adjacent punctuation, so a period stuck to the
command breaks the copy target, the same hazard the two-bullet AWAITING
APPROVAL render already avoids. A step that ends in prose, or on a
closing parenthesis that already terminates the command, keeps its
normal period. For a `NEXT_ACTION_BY_REASON` recipe this is mechanical
rather than a matter of judgment: `bin/gate-summary-recipe-lint.test.ts`
asserts that no declared `RECIPE_COMMANDS` entry is immediately followed
by a `.` in its recipe.

**Carve-outs.**

1. A single discrete action stays inline on its label line — it is
   never padded into a one-item numbered list just to look consistent
   with the multi-step cases.
2. `- [ ]` Test Steps keep their checkbox form and are **never**
   renumbered to ordinals, because the auto-merge gate counts unchecked
   boxes (see `references/auto-merge-rubric.md`). They take the
   one-action-per-box and named-actor rules, not the numbering.
3. Fact recaps (`## PIPELINE SNAPSHOT`, the echo recap) are already
   one-fact-per-line and are out of scope: numbering a recap of what
   already happened would imply an execution order that does not exist.

**Worked pair.**

> Before:
>
> ```
> Recover manually: cd <worktree> && git fetch origin <base> && git merge origin/<base>; then STOP and resolve every conflict marker in your editor before committing. Once resolved: git add <resolved-files>, git commit, git push. If the push is rejected non-fast-forward, that means origin/<pr-branch> advanced (not the base) -- run git fetch origin <pr-branch> && git merge origin/<pr-branch>, then push again; do NOT force. Then (cd <repo> && gh pr merge --squash <pr>)
> ```
>
> After:
>
> ```
>   1. Recover manually: run cd <worktree> && git fetch origin <base> && git merge origin/<base>
>   2. STOP and resolve every conflict marker in your editor before committing.
>   3. Once resolved, run git add <resolved-files>, git commit, git push
>   4. If the push is rejected non-fast-forward, origin/<pr-branch> advanced (not the base) -- run git fetch origin <pr-branch> && git merge origin/<pr-branch>, then push again; do NOT force.
>   5. Then run (cd <repo> && gh pr merge --squash <pr>).
> ```

## Applicability

The contract binds **any turn-ending assistant message that awaits user
input or reports a stop**, formal or informal:

- a formal gate (merged / gated / needs-human / cancelled /
  awaiting-approval renders),
- a clarifying question (triage or approval),
- a gated feedback-mode reply,
- post-merge QA answers,
- an escalation,
- a terminal completion report.

The plan-approval message (a step-3 end condition) is a named instance
of the awaiting-approval render: `**Needs attention:**` carries
before→after changes and high-stakes decisions with the option chosen
and why (`## Definitions` above), plus one `Scope: N tasks, M files`
line — task titles and file lists are never echoed, only the plan path
under `**Next action:**`.

Mid-turn progress narration is out of scope — the block marks the
_pause point_, not every message.

## Omit-when-empty

Slot omission is **unconditional**: an empty slot is dropped, never
rendered as `**Unsolved:** none`. There is **no discretionary "trivial
answer" escape hatch** — a trivial answer collapses naturally to the
STATUS heading + `**TLDR:**` + `**Next action:**`, which is already the
minimal legal block: the answer itself lives as prose above the block
(see `## Definitions`'s Q&A rule), never as unlabeled prose inside or
after the block. If you find yourself wanting to skip the block because
the message is short, the short block _is_ the compliant form.

## Closing-summary

The pause block is the **closing summary of the message**, not its
body. Detail — analysis prose, file excerpts, tables, and any Q&A
answer — lives above the block; the block distills it into slots.
Nothing may be forced under a wrong label, and nothing may leak into
open prose after the block. The block is always the last thing in the
message.

## Gate-grammar reconciliation

Formal helper-rendered blocks — `flow-gate-summary` and
`flow-pipeline-summary` — **satisfy this contract via their own
grammar**: `STATUS:` is the status heading, `TLDR:` is `**TLDR:**`,
`NEEDS ATTENTION:` is `**Needs attention:**`, `MANUAL ACTION:` is
`**Manual action:**`, `UNTRACKED:` is `**Untracked:**`, `NEXT ACTION:`
is `**Next action:**`. A gate render is never duplicated, re-wrapped, or
followed by a second markdown pause block over the same content. The
markdown block form below is only for the informal sites the helpers do
not cover (clarifying questions, feedback replies, post-render QA
prose).

## Worked examples

The language-side before/after pairs for these same pause points live
in `## Language contract` above; the examples below show the full slot
grammar in context (calibration samples 1, 3, 5, and 6 — full derivation
in a feature plan's calibration appendix).

**Plan ready (calibration sample 1):**

> ### ⏸ Plan ready for review
>
> **TLDR:** CI waiting becomes crash-proof: a suspended laptop can no
> longer produce a false "CI stuck" escalation.
> **Unsolved:** Q2–Q6 all have a recommended default (keep the
> `flow-ci-wait` name; drop the transient-`gh` hang path; cap the
> waiter at 9 min) — reply `answer: …` only to override.
> **Needs attention:** state shape changes — CI anchors now persist in
> `~/.flow/state/<slug>.json` (before: none; after:
> `ciWait.startedAt`), chosen over stateless GitHub-only anchors
> because a slept process needs a durable start time. Risk: two
> binaries instead of one.
> **Next action:** `approve` · `redirect: …` · `answer: …` · `cancel`
> — plan: /Users/gavingolden/code/me/flow-f3-ci-check-split/.flow-tmp/plan.md
> (safe to `/clear`)
>
> ```
> STATUS: AWAITING APPROVAL
> NEXT ACTION: reply approve / redirect <new direction> / cancel
>   - /Users/gavingolden/code/me/flow-f3-ci-check-split/.flow-tmp/plan.md
> ```

**GATED, judgment needed (calibration sample 3):**

> ### ⏸ GATED — PR #640, 2 checks need you
>
> **TLDR:** `/clear` in a finished flow window now fires an
> orientation turn naming the merged PR; two hand checks remain.
> **Needs attention:** SUBJECTIVE — in a real tmux window at `merged`,
> `/clear` fires a turn within ~10s → https://github.com/gavingolden/flow/pull/640
> · ask a follow-up there and confirm the answer is repo-grounded.
> **Manual action:** whenever — `flow install --upgrade` is queued
> post-merge; verify only after it runs.
> **Untracked:** none — #641, #642 already filed.
> 16 findings fixed, 0 deferred (the one real defect was a
> docs claim; fixed in prose).
> **Next action:** tick the two boxes and say `merge`, or report an
> issue.

**MERGED, nothing outstanding (calibration sample 5):**

> ### ✅ MERGED — PR #644
>
> **TLDR:** Plan review now runs on Gemini 3.7 Flash by default
> (benched: same defect catch rate, ~2× faster) →
> https://github.com/gavingolden/flow/pull/644
> **Untracked:** none — #651 (bench the flash-medium/-low tiers) filed
> at merge.
> 5 findings fixed, 0 deferred.
> **Next action:** none — `flow done re-run-flow-model-benchmark` when
> you like.

**GATED, Q&A above the block (calibration sample 6):**

> Your three questions, answered: the baseline run draws on the Max
> subscription's quota, not a per-call dollar cost (`claude auth
status` shows the active plan); "just gatekeeper" already means the
> haiku-routed `/flow-pr-review` step 1.5 agent, nothing else changed;
> report-model choice is unaffected by anything in this PR.
>
> ### ⏸ GATED — PR #660, baseline recording is yours
>
> **TLDR:** Your three questions are answered above; the baseline run
> draws on Max quota, not dollars, and nothing here decides your
> report-model choice.
> **Unsolved:** `.flow/epics/…/status.json` on `main` already says f1
> merged (PR #660 is still open) — harmless until merge, don't trust
> it for `flow epic run` yet.
> **Manual action:** before merge — run the baseline-recording script
> from a plain shell, then commit + push on this branch; then tick the
> validate/self-compare step.
> **Next action:** run the baseline, tick the boxes, say `merge`.

**Don't (negative example — open prose, no block):**

> I fixed the popover bug and re-ran verify, everything passes now. There
> are still a couple of unchecked test steps on the PR so you'll want to
> take a look at those when you get a chance, and let me know how you'd
> like to proceed!

No status heading, the remaining work and the ask are buried in a
paragraph, and no reply verbs are named. This is exactly the shape the
contract forecloses.
