# Methodology

This is the full four-phase methodology for `/flow-backlog-triage`. It is
already-reasoned — derived from comparing two real triage runs over the
same backlog and diagnosing exactly where each one failed. Implement it as
written; do not re-derive, re-litigate, or soften any rule below.

## Prime directive

**Nothing in the backlog is a mandate.** Every issue and every note —
including ones the user wrote imperatively — is an idea that must earn its
existence. "It was requested" is not a justification. Rejecting the user's
own ideas is explicitly in-bounds and expected.

## Mode selection

Two modes, selected by whether the user supplies a milestone:

- **Milestone mode** — the user names a current goal; all value judgments
  rank against it first, generic value second.
- **Grooming mode** (default when no milestone is given) — no goal to rank
  against; judge on fundamentals, with a default-decay bias. Include this
  block substantially as written:

  > There is no milestone to rank against. Judge value on fundamentals
  > only: system value (correctness, reliability, cost, security,
  > performance) and user value (would a real user notice and care?
  > "nicer" is not value). Every surviving item has a carrying cost —
  > re-reading, re-triaging, crowding out signal. When value is unclear,
  > the default verdict is REJECT or DO-LATER with a concrete promotion
  > trigger, not "keep just in case." Age is evidence: an item untouched
  > for months with no observed harm is data about its real priority.
  > Grooming success is measured by how much the backlog SHRINKS while
  > keeping everything that genuinely matters — not by how well the
  > survivors are organized.

**Invocation arguments.** `milestone: <goal>` selects milestone mode
directly against that goal. `no milestone` selects grooming mode and
suppresses milestone inference entirely — no provisional milestone is
adopted even when the notes source names an explicit goal item. Absent
either argument, grooming mode is the default and inference stays live.
Grooming mode's default lens, absent any other signal, is PM-shaped:
app stability, bug fixes, and high-value features/enhancements.

**Surfaced-never-silent milestone inference.** In grooming mode, when the
notes source contains an explicit goal item, adopt it as a **provisional**
milestone — never silently switch to milestone-mode ranking. State the
inference in the Decision Brief's at-a-glance opener, and make "confirm
or strike the inferred milestone" the FIRST numbered question in the
Decision Brief's Open decisions group, every time inference fires.
Name what would reorder if the inferred milestone is struck — the
specific bundles or verdicts that move — and
state that a strike changes ORDERING, not verdicts, unless explicitly
stated otherwise.

## Phase 0 — Lossless inventory

Assign a stable ref per item: an issue number, or a notes ref like `H3` /
`M7` that preserves the source list's own numbering. Every item appears
exactly once in the final disposition table. Blank, struck-through,
already-rejected, or externally-referenced items (screenshots, linked
notes not provided) go to a verbatim residue section — never guess at
missing context.

**Count assertion (mandatory).** Emit a literal `Inventory: <N> issues, <M> notes` line, and state that the disposition table has EXACTLY N+M rows.
A mismatch is a self-evident truncation failure — treat it as one.
For a large backlog, append disposition rows to the output file
incrementally as verification batches return, rather than holding every
row in context until the end.

**Verbatim capture (mandatory when a notes source is given).** On any
run that reads a notes source, emit
`.flow-tmp/triage/source-notes-verbatim.md` alongside the disposition
table. Quoting contract: quote EXACTLY — copy the owner's original text
byte-for-byte, blockquoted with `> `.
Do not fix spelling, grammar, punctuation, or truncation; a typo, a
dangling sentence, or inconsistent capitalization in the source stays
exactly as written. Each captured item is a `**<REF>**` heading followed
by its blockquote body, where `<REF>` matches the item's Phase-0 ref (an
issue number or a notes ref like `H3`/`M7`) whenever the owner's own
numbering supplies one. Precede the blocks with a
`<!-- flow-verbatim-refs: <comma-separated refs> -->` index line naming
every ref the file contains, and a
`<!-- flow-verbatim-source: <path to the original notes file> -->`
provenance line naming the notes file the text was copied from — both
machine-read by the attachment helper: the index disambiguates block
boundaries and the source path drives the byte-for-byte cross-check.
When a ref was assigned by the model rather than taken from the owner's
own numbering, say so in a preamble sentence before the first block.
The block count MUST equal `M` from the `Inventory: <N> issues, <M>
notes` assertion above. Sequence this write AFTER the existing
`mkdir -p .flow-tmp/triage` + `.git/info/exclude` ensure block
(SKILL.md), never before it — the capture file lands in the same
gitignored scratch directory the disposition table does.

## Delta re-triage

When the input is a **prior triage document** — this skill's own prior
output — rather than a fresh backlog, run this mode instead of a
cold-start Phase 0/1 pass:

- Compute the **merge delta**: everything that landed since the prior
  document was written. `git log --oneline --since='<prior-doc-date>'` for
  code, `gh pr list --state merged --search 'merged:>=<date>'` for
  merged PRs.
- Phase 0's lossless inventory and the N+M assertion still hold over
  the CURRENT backlog, not the prior document's snapshot — a delta run
  is not exempt from either.
- Re-verify each prior verdict against the merge delta using the SAME
  five Phase-1 verdicts above — no sixth verdict for "unchanged since
  last time." A prior verdict that re-verifies unchanged may be carried
  forward WITH its citation rather than re-derived from scratch; a
  verdict the delta contradicts (e.g. the underlying code moved, a
  cited PR merged) gets re-adjudicated fresh.
- **Re-stage** the prior document's **unconfirmed kill list** — REJECT
  close-candidates the user never ran the drafted `gh issue close`
  command for — rather than assuming silence meant confirmation or
  meant withdrawal. Give each one a fresh look against current state.

## Phase 1 — Verify before judging (mandatory)

Fan out **parallel read-only subagents** to check claims against code,
merged PRs, CI/workflow runs, and live state where checkable. See
[verification-fanout.md](verification-fanout.md) for the spawn contract.
Verdicts:

- **CONFIRMED** — cite `file:line` or a run ID, plus the mechanism.
- **ALREADY DONE** — cite the PR or commit.
- **STALE-PARTIAL** — state exactly what remains.
- **NOT REPRODUCIBLE IN CODE** — current code shouldn't produce the
  reported behavior; ask the user to re-verify. Never close on this basis.
- **UNVERIFIABLE** — needs a runtime repro.

**"Likely fixed" is a banned verdict** — and so is the whole hedged-
completion phrase class: "likely fixed", "probably fixed", "presumably
resolved", "appears to be done" are all banned. Verify the claim, or call
it UNVERIFIABLE — there is no verdict-shaped middle ground for a guess.

**Hunt for shared root causes** while verifying. This was the single most
valuable finding in the real run: two separate red CI signals — a failing
prod smoketest and an active Terraform drift — turned out to be one
missing set of secrets. Root-cause links collapse multiple items into one
fix and change the priority order.

## Phase 2 — adjudicate value

Classify each item, then verdict it, using this canonical block verbatim
in substance:

    Classify each item: bug / hardening / enhancement / feature / research /
    product-decision / ops-manual / tooling-outside-this-repo.
    Then a verdict, with one-sentence reasoning tied to value:
    - DO: clear system value (cost, correctness, reliability, security, perf) or user
      value (a real user would notice and care), proportionate to effort. "Nicer" is
      not value.
    - DO-LATER: real value, but not now — and ONLY valid with a concrete promotion trigger
      ("revisit when <event/metric/next time X is touched>").
      A DO-LATER without a trigger is a REJECT; do not use DO-LATER as a polite
      way to avoid killing something.
    - NEEDS-DECISION: value depends on a product call only the user can make; give a
      recommendation and the 2-3 options.
    - REJECT: weak/negative value, conflicts with stated product principles, solved
      differently already, or cost exceeds plausible benefit. Say why. When value is
      unclear, REJECT is the default — every survivor has a carrying cost, and
      rejecting the user's own ideas is in-bounds and expected.
    Use age as evidence: an item untouched for months with no observed harm is data
    about its real priority — cite that when it informs a verdict.
    Detect and surface CONFLICTS between items (two notes pulling opposite directions)
    as a single decision point with a recommendation — never silently pick one.

**One-primary-verdict rule.** Hybrid verdicts ("REJ residue", "DONE
mostly") are disallowed — every item gets exactly one primary verdict.
User-struck items are residue only, not a verdict. "By design, working as
coded" is REJECT, with evidence. A partially-shipped item is
STALE-PARTIAL, with the remainder given its own separate verdict.
Supersede-closes (a child issue carries the remainder) count as
evidence-based closures eligible for automated close.

**STALE-PARTIAL routing.** STALE-PARTIAL always lands in the
survivors-needing-rescope set and NEVER in the kill list — it is not a
rejection, it is unfinished work with a stated remainder.

**Decision-parameter rule.** When any constituent of a bundle defers a
product call, the bundle cannot silently become DO with an assumed
default. Route it to NEEDS-DECISION, or keep it DO with an explicit
fire-time parameter rendered as a `<value required>` placeholder in the
queued command. Assuming a default inside a queue command — quietly
picking a value for the user rather than surfacing it — is exactly the
tier-mixing failure this rule prevents.

## Phase 3 — bundle for minimum PRs

Bundle by shared root cause, shared surface/files, or shared review
context — NEVER by theme. A "Charts & dashboard editor — UX polish"
grouping of 15 heterogeneous items is a reading aid, not something you can
hand to a pipeline. Test every bundle against: "one coherent PR a reviewer holds in their head." Fold small adjacent items into bundles aggressively
rather than leaving orphans. Never mix verdict tiers in one bundle — no
smuggling a NEEDS-DECISION into a DO bundle.

Size each bundle Small / Medium / Large by files+functions touched and
risk, and map size to the model/effort ladder below. `config.models.*`
per-phase keys still layer underneath this ladder — the ladder picks the
alias/effort pair, config resolves the concrete model for that alias.

| Size   | Model | Effort | Launch command                                                                                                              |
| ------ | ----- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| Small  | opus  | low    | `flow feature create --tmux --model opus --effort low --slug <bundle-slug> 'implement bundle issue #N — <short title>'`     |
| Medium | opus  | high   | `flow feature create --tmux --model opus --effort high --slug <bundle-slug> 'implement bundle issue #N — <short title>'`    |
| Large  | fable | medium | `flow feature create --tmux --model fable --effort medium --slug <bundle-slug> 'implement bundle issue #N — <short title>'` |

`--tmux` is mandatory — a plain-backend launch refuses to run off a TTY.
`--slug <bundle-slug>` is a real validated flag — always pass an explicit,
already-lowercase-hyphenated slug; never rely on auto-slugify. Valid
`--model` values are `opus` / `haiku` / `sonnet` / `fable`. Valid
`--effort` values are `low` / `medium` / `high` / `xhigh` / `max`.
`<short title>` is drawn from untrusted issue text — single-quote it as
shown (see output-template.md's shell-safety contract); the surrounding
inline-code backticks above are markdown display syntax, not command
text, and do not violate the zero-backticks rule.

## Phase 4 — act

Use this canonical block verbatim in substance. The load-bearing
distinction: **evidence-based closures are automated, judgment-based closures are staged.**

    - Close issues verified ALREADY DONE or duplicate, with an evidence comment (PR#,
      file paths). Add rescope comments to PARTIAL issues stating exactly what remains.
    - For REJECT verdicts on GitHub issues: do NOT close them yet — list them in the
      kill list as close-candidates, each with its drafted "closing as won't-do — <reason>"
      comment ready to post. Close only the ones the user confirms. (Closing verified-done
      work is safe to automate; closing on opinion is not.)
    - For REJECT verdicts on adhoc notes: they die in the kill list; do not file issues
      for them.
    - For every surviving DO / DO-LATER adhoc note that has no GitHub issue: file one
      issue per BUNDLE (not per note), carrying the verified evidence and the bundle
      contents — the groomed backlog must live in the tracker, not in a notes file.
    - Pipeline launching is OFF by default in grooming mode: output a ready-to-launch
      queue instead — exact launch command per DO bundle, ordered by value, with
      size→model already applied. In milestone mode, or when the user opts in, launch
      DO bundles that are bugs/hardening and Medium-or-smaller, capped at a configurable
      concurrency (default 4), and queue the rest.
    - Anything requiring credentials, dashboards, purchases, or manual ops goes to the
      Decision Brief's Open decisions group as a runbook step, never into the queue.

Every emitted launch command in the queue follows the queue-seed format
from [output-template.md](output-template.md): `--tmux`, an explicit
`--slug`, zero backticks in the command text, and every interpolated
untrusted value (issue/bundle title, close reason) single-quoted per
that file's shell-safety contract.

**Who acts.** The PARENT SESSION executes the evidence-based `gh issue
close` and rescope-comment calls in this phase — not a Phase-1 verifier
subagent. The read-only constraint from
[verification-fanout.md](verification-fanout.md) binds the Phase-1
verifier subagents only; it does not extend to the parent session's own
Phase-4 actions.

**Attach the owner's verbatim notes.** After the evidence-based and
staged actions above, attach each captured ref's verbatim text to the
GitHub issue it belongs to per
[verbatim-attachment.md](verbatim-attachment.md). Only open issues
receive an attachment — a REJECT close-candidate, a residue item, and
an issue closed as ALREADY DONE never do; an issue closed as superseded
routes its ref to the child issue that carries the remaining work
instead. When the owner's note and a verified Phase-1 finding disagree,
never reconcile them into one edited comment —
the disagreement is the signal, and belongs to the user as two
separately authored comments, not a single smoothed-over one. A ref
that lands on no open issue is
reported in the Verbatim note attachment section with a reason; it is
never auto-filed as new issues on its own. On a delta re-triage run, a
ref absent from the current notes file is reported unattached and any
prior comment for it is left untouched.
