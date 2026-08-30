# Value-prop rubric

Canonical text of the value-prop block. It is embedded verbatim (marker-delimited) in `methodology.md`, `flow-product-planning/references/discovery-instructions.md`, and `flow-pr-review/references/fix-applier-instructions.md`; `bin/flow-value-rubric-lint.test.ts` fails when any copy drifts.

<!-- flow-value-rubric:begin -->

**Value-prop block** — required before an item is ticked, filed, deferred, or verdicted DO / NEEDS-DECISION.

- **UX:** <who notices, what changes for them, how often / how much> `[anchor: …]` — or `none`
- **Problem:** <the concrete failure or friction this removes> `[anchor: …]` — or `none`
- **Stability/efficiency:** <crash / flake / cost / latency effect, with the reproduced or measured number> `[anchor: …]` — or `none`
- **Cost:** <files touched, blast radius, review load, regression risk>
- **If never done:** <what breaks, stays broken, or keeps costing — or `nothing`>
- **Verdict:** `clears bar` | `below bar` — <the decisive line, and why it outweighs (or fails to outweigh) Cost>

**Anchor rule.** Every non-`none` UX / Problem / Stability line ends with `[anchor: …]` drawn from this closed list: a `file:line`; a reproduced behaviour (`command → observed output`); a command that fails today; a merged PR or commit; an issue number with its age; a measured number; the user's own words, quoted. A value line with no anchor is `unsubstantiated` and counts as `none`. Write file anchors bare (`[anchor: path/to/file.ts:42]`), never wrapped in backticks, so the lint can check the path exists.

**Bar.** `clears bar` requires at least one substantiated value line, a one-line rationale that it outweighs the Cost line, and a non-`nothing` If-never-done line. Anything else — including unclear — is `below bar`.

**Banned phrasing.** `nicer`, `cleaner`, `could improve`, `might`, `best practice`, `would be good to`, `likely`. An anchor the reader cannot open or run in seconds is worse than `none` — never invent one.

<!-- flow-value-rubric:end -->
