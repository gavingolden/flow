<!-- flow-verbatim-refs: H5, M33, H9 -->
<!-- flow-verbatim-source: bin/fixtures/verbatim-notes/notes-source.md -->

Refs below were taken from the owner's own high/medium-priority numbering
in the source notes; none were assigned by the model. The capture below
includes H9 even though it lands on no issue (see `unattached` in
verbatim-map.json) — the capture-file contract requires the block count
to equal the full Phase-0 inventory, not just the refs a map ultimately
attaches.

Correction to a prior inline review annotation on this file: H5's body
does not carry a tab-indented sub-bullet — `npm run lint` (Prettier)
reformats a literal tab in a Markdown fixture on every save, so a tab
byte cannot survive here. The tab sub-bullet regression case lives only
in `bin/flow-verbatim-notes.test.ts`'s inline `CAPTURE`/`NOTES_SOURCE`
constants (outside Prettier's scope), which is the correct home for it.

**H5** — adhoc notes, high priority

> This woudln't work without the migration first.
>
> 1. Check the migration script
>
> ---
>
> ?

**M33** — adhoc notes, medium priority

> Should we redesign the settings page or just patch it for now.
> Low priority — revisit after the Q3 launch.

**H9** — residue, no matching open issue

> Not sure this is even worth doing — parking it here for now.
