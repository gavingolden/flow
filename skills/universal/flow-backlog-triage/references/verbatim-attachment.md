# Attaching the owner's verbatim notes

This is the full contract for the last mile of Phase 0's verbatim capture
(see [methodology.md](methodology.md) "Verbatim capture") and Phase 4's
"Attach the owner's verbatim notes" step: turning
`.flow-tmp/triage/source-notes-verbatim.md` plus
`.flow-tmp/triage/verbatim-map.json` into one marker-tagged comment per
issue, byte-for-byte.

## Capture-file grammar and quoting contract

The capture file (`.flow-tmp/triage/source-notes-verbatim.md`) carries
two machine-read index lines, in this order:

```
<!-- flow-verbatim-refs: H5, M33, ... -->
<!-- flow-verbatim-source: <path to the original notes file> -->
```

The refs index disambiguates a real block boundary from a
`**word**`-shaped line inside an owner's note body; the source path is
what the byte-for-byte cross-check reads against.

Each captured item is a `**<REF>**` heading (its ref matching the item's
Phase-0 ref) followed by its blockquote body:

```
**H5** — adhoc notes, high priority

> This woudln't work without the migration first.
> Check the migration script first.
```

**Quoting contract: quote EXACTLY.**
Do not fix spelling, grammar, punctuation, or truncation — a typo, a
dangling sentence, or a trailing `?` stays exactly as the owner wrote
it. Never re-quote, summarize, or `[sic]`-annotate. This is what makes
`crossCheckAgainstSource` (in
`bin/flow-verbatim-notes.ts`) meaningful: it strips the `> ` prefix from
each block and asserts the remaining text is a contiguous byte sequence
inside the recorded source file. A block that fails this check is fatal
for the ENTIRE run — nothing is posted for any issue — because a
silently-normalized block means the "verbatim" guarantee already broke
upstream of the attach step, and posting some issues while withholding
others would hide exactly which blocks are trustworthy.

## Map-authoring judgment rules

`.flow-tmp/triage/verbatim-map.json` decides which captured ref attaches
to which issue. This is a judgment call the model makes at Phase 4, not
something the helper infers:

- **Open issues only.** A REJECT close-candidate, a residue item, and an
  issue closed as ALREADY DONE never receive an attachment — there is no
  live surface for the owner's words to inform.
- **Closed-as-superseded routes to the child.** When an issue closes
  because a child issue carries the remaining work, its ref attaches to
  the child, not the closed parent.
- **A ref that lands on no issue is never auto-filed as new issues.** It
  goes in the map's `unattached` array with a reason (e.g. "no matching
  open issue — filed as residue"), which the run reports back to the
  owner in the `### Verbatim note attachment` section and the chat
  tally. The owner decides whether it deserves an issue of its own.
- **Delta re-triage.** On a re-run against a prior triage document, a ref
  that no longer appears in the current notes file is reported unattached
  with that reason, and any comment it previously produced is left
  untouched — the helper never deletes or blanks a prior attachment on
  the strength of an absence.

## Two attributed voices, never reconciled

The attachment is a **comment**, never a body edit — editing the issue
body would collapse two separately authored voices (the triage-authored
description and the owner's own words) into one, and would overwrite
triage-authored evidence that other parts of the triage document point
at.

When the owner's note and a verified Phase-1 finding disagree, the
helper does not reconcile them into a single edited comment — **the
disagreement is the signal**, and it belongs to whoever implements the
issue as two separately authored comments, not a smoothed-over one.

This is also why idempotency is marker-matching, not
`gh issue comment --edit-last`: `--edit-last` targets the current
user's most recent comment on the issue, not a marker-bearing one. A
real precedent from the reference implementation —
`gh issue view 542 --repo gavingolden/econ-data` — already carries both
a triage-authored comment and the verbatim-notes comment on the same
issue; `--edit-last` would have overwritten the wrong one. The helper
instead lists comments and matches on the `<!-- owner-verbatim-notes-v1
-->` marker.

## Rendered comment shape

```
<!-- owner-verbatim-notes-v1 -->

## Owner original note (verbatim)

The text below is copied byte-for-byte from the owner's exact notes
(<triageDates>) — unedited, including any typos or informal phrasing.

It is posted as a second, separately authored voice alongside the
triage findings on this issue. Where the two disagree, the disagreement
is preserved here rather than reconciled into one comment.

**H5** — adhoc notes, high priority

> This woudln't work without the migration first.
> Check the migration script first.

---

<sub>Source of truth: <sourceOfTruth></sub>
```

The marker is the first line of the body — it is what lets a re-run find
and update the same comment instead of stacking a second one.

## Invocation

The parent session runs the helper by its **bare PATH name** — never a
repo-relative `bun bin/...` path, since this skill runs in arbitrary
consumer repos whose cwd is never the flow checkout:

```
flow-verbatim-notes attach --verbatim-file .flow-tmp/triage/source-notes-verbatim.md --map-file .flow-tmp/triage/verbatim-map.json
```

Pass `--dry-run` first to preview `would-create` / `would-update`
outcomes with zero write calls before running for real.

## Reading the envelope

The helper's stdout is a single JSON envelope — see
`bin/flow-verbatim-notes.ts`'s exported `Envelope` type for the exact
shape. Map it onto the document like this:

- `attachments[]` (one entry per map attachment, each with `issue`,
  `refs`, `action`, `reason`, `commentUrl`) drives the
  `### Verbatim note attachment` table's `Issue | Refs attached |
Result` rows — `action` plus `reason` (when present) is the `Result`
  cell.
- `unattached[]` drives the same section's `**Refs on no issue:**` list.
- `duplicateMarkers` — when non-empty, name the affected issues in the
  Decision Brief's Open decisions group; the helper updated the first
  marker-bearing comment and left the rest in place rather than
  deleting anything, so a human should reconcile them.
- The chat-summary tally line
  (`Verbatim notes: <n> issues (<c> created, <u> updated), <s> skipped
(<reason>), <k> refs on no issue.`) is derived by tallying
  `attachments[].action` and counting `unattached[]`.
