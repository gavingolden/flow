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
to the STATUS heading + the answer + `**Next action:**`, which is
already the minimal legal block. If you find yourself wanting to skip
the block because the message is short, the short block _is_ the
compliant form.

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

**Clarifying question (triage):**

### ❓ Clarification needed

**Needs your review:** "make the dashboard faster" — is the target the initial page load or the live-refresh interval?
**Next action:** Reply with one of the two; I re-enter triage with your answer.

**Gated feedback reply (after a bug callout was fixed):**

### ⏸ GATED — fix applied, re-verified

**Remaining:** Test Steps items 2 and 4 are still unchecked on PR #212.
**Needs your review:** re-check the popover positioning at narrow widths (the reported bug).
**Next action:** Tick the remaining boxes and say `merge`, or report another issue.

**Post-merge QA answer:**

### ✅ Merged — question answered

**Notes:** the retry cap lives in `bin/flow-ci-wait.ts` (`MAX_POLLS`); the squash commit is `abc1234`.
**Next action:** Nothing pending — this pipeline is complete.

**Don't (negative example — open prose, no block):**

> I fixed the popover bug and re-ran verify, everything passes now. There
> are still a couple of unchecked test steps on the PR so you'll want to
> take a look at those when you get a chance, and let me know how you'd
> like to proceed!

No status heading, the remaining work and the ask are buried in a
paragraph, and no reply verbs are named. This is exactly the shape the
contract forecloses.
