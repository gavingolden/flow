# Triage document template

**Default output path:** `.flow-tmp/triage/backlog-triage-<repo>-<YYYY-MM-DD>.md`,
overridable by an explicit path argument. See SKILL.md "Output path" for
the write-time ignore-ensure step. **Lifecycle note:** this document is a
point-in-time snapshot living in throwaway scratch. Inside a flow
pipeline worktree, `.flow-tmp/` is swept by `flow-remove-worktree` on
worktree teardown. In a plain consumer checkout — this skill's normal
habitat when run standalone — nothing sweeps it, and the write-time
ignore-ensure step also makes it invisible to `git status`, so it can
accumulate unswept and unseen. Either way, act on it in the same
session; to keep it, pass an explicit path up front or copy it out
(e.g. archive under `docs/triage/`).

**Document shape.** The top of the document carries a line the run
emits at write time: `**This document:** <absolute path>`. The run
also prints that same absolute path in the chat summary, so the reader
can open the file without hunting for it. This document is ONE
document, never two files — the brief and the appendix below
(`## Decision Brief` and `## Audit Appendix`) are two sections of the
same file, not a split output.

The document body follows a two-layer section order: `## Decision
Brief` comes first, for a reader who wants the outcome and the open
questions; `## Audit Appendix` comes second, holding the full verified
evidence trail underneath it.

## Decision Brief

**At a glance.** Lead with blockers and root-cause links — what's
broken and what one fix collapses multiple items. When grooming mode
inferred a provisional milestone (see `methodology.md`
"Surfaced-never-silent milestone inference"), state that inference
here too, and name what would reorder if the inferred milestone is
struck — which specific bundles or verdicts move, and that a strike
changes ordering, not verdicts, unless explicitly stated otherwise.

This brief assumes its reader understands the product, has not read
the tickets, and wants a recommendation, not a raw list. Inside this
Decision Brief: no internal codenames or mechanism language — no issue
numbers, ref codes, or implementation mechanics. This ban scopes to
the At-a-glance opener and the bundle cards. `### Not doing (kill
list)` and `### Launch queue (grouped by tier)` are command-rendering
surfaces: they keep their issue numbers, refs, and verbatim commands,
and the shell-safety contract's `'\''` form below MUST be reproduced
literally, never paraphrased for readability. The Audit Appendix
below, and the filed bundle issue each queued command points at, also
keep the mechanism language; the opener and cards stay in outcomes.
The `[anchor: …]` tail on a value line is the one sanctioned exception —
it is what makes the line checkable.

Group every DO bundle into one of these **recommendation tiers**,
introduced here and used throughout the Launch queue below: **Fix now
(active problems)**, **Stability insurance**, **High-value
improvements**, **When you schedule it**. Tiers are renameable and
mergeable to fit the backlog's actual shape, and a tier with nothing in
it is simply omitted — but never introduce a fifth tier without saying
why the four defaults didn't fit this backlog.

Each DO bundle gets one card, each facet its own list item so the
card renders as four facets — the value facet carrying its nested
value-prop block — never one run-on paragraph:

- **Outcome:** <one plain-language sentence — what a user or the
  business gets>
- **What changes / who notices:** <who is affected and how>
- **Why it's worth it:** the value-prop block, rendered as six nested
  sub-bullets (UX / Problem / Stability-efficiency / Cost / If never
  done / Verdict) — or the honest case against, if it's marginal
  - **UX:** <who notices, what changes, how often> `[anchor: …]` — or `none`
  - **Problem:** <the concrete failure or friction this removes> `[anchor: …]` — or `none`
  - **Stability/efficiency:** <crash / flake / cost / latency effect> `[anchor: …]` — or `none`
  - **Cost:** <files touched, blast radius, review load, regression risk>
  - **If never done:** <what breaks, stays broken, or keeps costing> — or `nothing`
  - **Verdict:** clears bar — <the decisive line>
- **Size:** S / M / L <sourced from Phase 3's Small/Medium/Large
  sizing>

Keep the brief to at most two pages (a DO card's nested value-prop
block counts toward that budget — trim prose, never the block): one
card per bundle, never per item — items collapse into their bundle's
single card. Separate
consecutive cards with a blank line so they never merge into one
blob.

### Not doing (kill list)

Every REJECT verdict, with its one-sentence reasoning, and every
DO-LATER verdict, with its concrete promotion trigger, plus every NOT
REPRODUCIBLE IN CODE item flagged for the user to re-check. Each REJECT
and DO-LATER entry also carries `Verdict: below bar — <decisive line>`
per `methodology.md`'s value-prop gate; a NOT REPRODUCIBLE IN CODE entry
carries no Verdict line — methodology.md's gate does not require one for
it. This section is **required and non-empty** — a backlog that survives
triage untouched is a triage failure, not a clean backlog.

Each GitHub-issue kill-list entry renders its drafted comment as a
ready-to-run command:

```
gh issue close <n> --comment 'closing as won'\''t-do — <reason>'
```

This does not soften the staged-confirmation rule from `methodology.md`
Phase 4 — the skill never runs this command itself; the user running it
themselves IS the confirmation.

**Shell-safety contract (binds both this kill-list command and the queue
commands below).** `<reason>` and every other interpolated value
(issue titles, note text, bundle titles) is untrusted backlog content —
it can contain `$(...)`, backticks, `$VAR`, `\`, or a bare `"`. Never
interpolate it inside double quotes. Always single-quote it, escaping
any embedded single quote as `'\''` (close-quote, escaped literal quote,
reopen-quote) — the form shown above. This is stricter than, and
supersedes, a "no backticks" rule scoped only to backticks: a
double-quoted `$(...)` or `$VAR` is exploitable with zero backticks
present.

### Open decisions

Numbered questions, each with a **recommendation first**, then the
options. Batch every open question here — never scatter them through the
document. When a milestone was inferred (see the Decision Brief's
at-a-glance opener), question 1 is always: "Confirm or strike the
inferred milestone" — and that question states what would reorder if
the inferred milestone is struck.

### Launch queue (grouped by tier)

The DO bundles, each with its size, model/effort, and either "launched"
(milestone mode / opt-in) or "queued" (grooming mode default)
disposition. Emitted as `tiered groups` — grouped under the
recommendation tiers above — never a flat list.

**Queue-seed contract**, every emitted command:

- Names the filed bundle issue as design of record — `implement bundle
issue #N — <short title>` — with the full verified evidence living in
  that issue, never restated inline where it would go stale.
- Carries `--tmux` (a plain-backend launch refuses to run off a TTY) and
  an explicit `--slug <bundle-slug>`.
- Contains ZERO backticks in the command text (the fenced/indented block
  around it is display syntax only and does not count).
- Single-quotes the description, per the shell-safety contract above —
  bundle titles are drawn from untrusted issue text.

Shape (see `methodology.md`'s size→model ladder for the full table):

    flow feature create --tmux --model opus --effort low --slug bundle-slug 'implement bundle issue #N — short title'

**Decision-parameter rendering.** A DO bundle carrying a fire-time
parameter renders it inside the quoted description with an explicit
`<value required>` placeholder, plus a one-line note that the command is
not runnable until the user supplies the value.

The queue section CLOSES with a cross-bundle sequencing / surface-overlap
warning list: which bundles touch the same files, and the recommended run
order — so two bundles that would conflict are never launched
concurrently by accident.

## Audit Appendix

### Closed / rescoped issues

Every issue closed or rescoped in this run, each with its justification
(PR/commit for ALREADY DONE, exact remainder for a rescope comment).

### Prod / CI health snapshot

Covers ONLY what was actually checked during Phase 1 — never a blanket
health claim beyond the verified subset.

### Disposition table

The full, lossless disposition table. Columns, exactly:

| Ref | Item (short) | Source | Verification | Class | Verdict | Bundle | Issue | Reasoning |
| --- | ------------ | ------ | ------------ | ----- | ------- | ------ | ----- | --------- |

The `Issue` cell holds the issue number the ref's verbatim text attaches
to (see "Verbatim note attachment" below), or `—` when the ref lands on
none.

Row count MUST equal `N+M` from the Phase-0 `Inventory: <N> issues, <M>
notes` line (see `methodology.md` "Phase 0").

### Residue

The verbatim residue section: blank, struck-through, already-rejected, or
externally-referenced items that were never guessed at.

### Verbatim note attachment

The outcome of running the attachment helper (see
[verbatim-attachment.md](verbatim-attachment.md)) against
`.flow-tmp/triage/source-notes-verbatim.md` and its `verbatim-map.json`,
sourced from the helper's JSON envelope:

| Issue | Refs attached | Result |
| ----- | ------------- | ------ |

**Refs on no issue:** <ref list, or "none">, each with the reason it was
left unattached.

The map file this section is driven from has this shape:

```json
{
  "version": 1,
  "sourceOfTruth": "<path>",
  "preamble": { "triageDates": "<string>" },
  "attachments": [
    {
      "issue": <number>,
      "refs": [{ "ref": "<REF>", "label": "<string>" }]
    }
  ],
  "unattached": [{ "ref": "<REF>", "reason": "<string>" }]
}
```

### Self-check

Fill this in while generating the document — it is the runtime-visible
half of enforcement (a prose lint cannot police runtime behaviour):

- Kill list non-empty: YES/NO
- Disposition rows == N+M: YES/NO
- Every DO-LATER has a promotion trigger: YES/NO
- Any hedged-completion phrasing used: YES/NO
- Every queue command carries --tmux and --slug, zero backticks, and
  single-quoted interpolated values: YES/NO
- Any hybrid verdict used: YES/NO
- Inferred milestone surfaced as the first Open decision (or N/A): YES/N-A/NO
- Decision Brief is the first section and every DO bundle has a card: YES/NO
- Verbatim capture emitted and ref-block count == M: YES/NO/N-A
- Every attached issue reported with its envelope `action` (`created` /
  `updated` / `unchanged` / `skipped` with a named reason, or
  `would-create` / `would-update` on a dry run): YES/NO/N-A
- Every DO / NEEDS-DECISION card carries a value-prop block with an
  anchor on each non-`none` value line: YES/NO

## Chat summary shape

After writing the document, summarize in chat, in this order: the
document's absolute path; the top recommendation tier(s) from the
Decision Brief, given inline as the actual recommendations — not a
pointer back to the document; then every blocking question batched at
the end, each with a recommendation.

When a verbatim-notes attachment run happened, append a tally line in
this shape:

```
Verbatim notes: <n> issues (<c> created, <u> updated, <e> unchanged), <s> skipped (<reason>), <k> refs on no issue.
```
