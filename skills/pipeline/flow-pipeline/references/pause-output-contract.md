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
2. **Labeled slots (omit-when-empty, in this order):**
   - `**Went wrong:**` — what failed or blocked, if anything. The
     informal synonym of the gate grammar's `WHY:`.
   - `**Remaining:**` — work still outstanding (unchecked items, next
     pipeline steps, deferred fixes).
   - `**Needs your review:**` — items awaiting the user's judgment
     (subjective checks, gated Test Steps, open questions).
   - `**Notes:**` — the catch-all for genuinely unclassifiable content
     (see below).
3. `**Next action:**` (always) — the single most useful thing the user
   can do next, naming the reply verbs the site accepts (e.g. `approve`
   / `redirect: …` / `cancel`, or "tick the Test Steps boxes and say
   `merge`").

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
   `**Needs your review:**` carries the short option list —
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
rows (`  - <item>`) and the `FOLLOW-UPS:` entries. Multi-sentence or
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
pause-block `**Next action:**` slot defined in `## The block` item 3
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
>   3. Once resolved, run git add <resolved-files>, git commit, git push.
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

Mid-turn progress narration is out of scope — the block marks the
_pause point_, not every message.

## Omit-when-empty

Slot omission is **unconditional**: an empty slot is dropped, never
rendered as `**Went wrong:** none`. There is **no discretionary
"trivial answer" escape hatch** — a trivial answer collapses naturally
to the STATUS heading + a `**Notes:**` slot carrying the answer +
`**Next action:**`, which is already the minimal legal block: the
answer still lands in a labeled slot, never as unlabeled prose inside
the block. If you find yourself wanting to skip the block because the
message is short, the short block _is_ the compliant form.

## Closing-summary and Notes catch-all

The pause block is the **closing summary of the message**, not its
body. Detail — analysis prose, file excerpts, tables — lives above the
block; the block distills it into slots. `**Notes:**` exists so that
genuinely unclassifiable content still lands _inside_ the block: nothing
may be forced under a wrong label, and nothing may leak into open prose
after the block. The block is always the last thing in the message.

## Gate-grammar reconciliation

Formal helper-rendered blocks — `flow-gate-summary` and
`flow-pipeline-summary` — **satisfy this contract via their own
grammar**: `STATUS:` is the status heading, `WHY:` is the formal-gate
synonym for `**Went wrong:**` context, `NEXT ACTION:` is
`**Next action:**`. A gate render is never duplicated, re-wrapped, or
followed by a second markdown pause block over the same content. The
markdown block form below is only for the informal sites the helpers do
not cover (clarifying questions, feedback replies, post-render QA
prose).

## Worked examples

The language-side before/after pairs for these same pause points live
in `## Language contract` above; the examples below show the full slot
grammar in context.

**Clarifying question (triage):**

> ### ❓ Clarification needed
>
> **Needs your review:** "make the dashboard faster" — is the target the initial page load or the live-refresh interval?
> **Next action:** Reply with one of the two; I re-enter triage with your answer.

**Gated feedback reply (after a bug callout was fixed):**

> ### ⏸ GATED — fix applied, re-verified
>
> **Remaining:** Test Steps items 2 and 4 are still unchecked on PR #212.
> **Needs your review:** re-check the popover positioning at narrow widths (the reported bug).
> **Next action:** Tick the remaining boxes and say `merge`, or report another issue.

**Post-merge QA answer:**

> ### ✅ Merged — question answered
>
> **Notes:** the wall-clock retry cap lives in `bin/flow-ci-wait.ts` (`maxElapsed`, default 1200s); the squash commit is `abc1234`.
> **Next action:** Nothing pending — this pipeline is complete.

**Don't (negative example — open prose, no block):**

> I fixed the popover bug and re-ran verify, everything passes now. There
> are still a couple of unchecked test steps on the PR so you'll want to
> take a look at those when you get a chance, and let me know how you'd
> like to proceed!

No status heading, the remaining work and the ask are buried in a
paragraph, and no reply verbs are named. This is exactly the shape the
contract forecloses.
