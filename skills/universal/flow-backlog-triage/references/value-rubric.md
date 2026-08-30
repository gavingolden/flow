# Value-prop rubric

Canonical text of the value-prop block. It is embedded verbatim (marker-delimited) in `methodology.md`, `flow-product-planning/references/discovery-instructions.md`, `flow-pr-review/references/fix-applier-instructions.md`, and `flow-file-issue/SKILL.md`; `bin/flow-value-rubric-lint.test.ts` fails when any copy drifts.

<!-- flow-value-rubric:begin -->

**Value-prop block** — required before an item is ticked, filed, deferred, or verdicted DO / NEEDS-DECISION.

- **UX:** <who notices, what changes for them, how often / how much> `[anchor: …]` — or `none`
- **Problem:** <the concrete failure or friction this removes> `[anchor: …]` — or `none`
- **Stability/efficiency:** <crash / flake / cost / latency effect, with the reproduced or measured number> `[anchor: …]` — or `none`
- **Value rank:** `1`-`5` `[anchor: …]` — the highest rank whose condition is met: `5` data loss, security exposure, or a broken path with no workaround; `4` a user-visible failure with a workaround recurring on a named cadence; `3` a measured inefficiency with a number; `2` a single-instance annoyance or an unfired latent risk; `1` cosmetic
- **Complexity:** `Trivial` | `Small` | `Medium` | `Large` — <files touched, blast radius>
- **Risk:** `Low` | `Medium` | `High` — <review load, regression risk>
- **If never done:** <what breaks, stays broken, or keeps costing — or `nothing`>
- **Verdict:** `clears bar` | `below bar` — <the decisive line, and why it outweighs (or fails to outweigh) Complexity and Risk>

**Short form.** For a genuinely trivial item (a typo, a dead link), skip the full block and write one line instead: `**Short form:** [V:n|C:x|R:y] <one-line text> [anchor: …]`. The compact tuple keeps the item sortable — the short form drops the prose, never the rank.

**Anchor rule.** Every non-`none` UX / Problem / Stability line, and the Value rank, ends with `[anchor: …]` drawn from this closed list: a `file:line`; a reproduced behaviour (`command → observed output`); a command that fails today; a merged PR or commit; an issue number with its age; a measured number; the user's own words, quoted. A value line with no anchor is `unsubstantiated` and counts as `none`; a rank with no anchor is invalid — it cannot be falsified by opening it. Write file anchors bare (`[anchor: path/to/file.ts:42]`), never wrapped in backticks, so the lint can check the path exists.

**Bar.** `clears bar` requires at least one substantiated value line, a `Value rank` of `2` or higher, a one-line rationale that it outweighs Complexity and Risk, and a non-`nothing` If-never-done line. `Value rank: 2` is the normal clear-bar baseline, not a special case — most items that clear the bar clear it at `2`. Anything else — including unclear — is `below bar`.

**Banned phrasing.** `nicer`, `cleaner`, `could improve`, `might`, `best practice`, `would be good to`, `likely`. An anchor the reader cannot open or run in seconds is worse than `none` — never invent one.

<!-- flow-value-rubric:end -->
