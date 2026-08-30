---
name: Issue
about: File an issue with the justification a triager needs to rank it
title: ""
labels: ""
assignees: ""
---

<!--
This template prompts; it does not gate. GitHub cannot reject a body from the
web UI, so filing here with the sections deleted still works.

The mechanical bar lives at `flow-create-issue`, which every agent path and the
`/flow-file-issue` skill go through — a body missing these sections is rejected
there with exit 3 before it reaches the tracker. Filing from the browser is the
one surface that check cannot reach.

Note also that `flow install` ships `skills/`, `agents/`, and `bin/` — it does
not copy `.github/`. This template therefore covers this repo's own web UI only;
a consumer repo gets the portable half (the `/flow-file-issue` skill).

Every non-`none` UX / Problem / Stability line, and the Value rank, ends with an
`[anchor: …]` drawn from this closed list: a `file:line`; a reproduced behaviour
(`command → observed output`); a command that fails today; a merged PR or commit;
an issue number with its age; a measured number; the user's own words, quoted.
A value line with no anchor is `unsubstantiated` and counts as `none`; a rank
with no anchor is invalid, because it cannot be falsified by opening it. Write
file anchors bare (`[anchor: path/to/file.ts:42]`), never wrapped in backticks.

Avoid: `nicer`, `cleaner`, `could improve`, `might`, `best practice`,
`would be good to`, `likely`. An anchor the reader cannot open or run in seconds
is worse than `none` — never invent one.

TRIVIAL ITEMS: for a typo or a dead link, delete everything below and write one
line instead:

**Short form:** [V:1|C:Trivial|R:Low] Dead install link in the README [anchor: README.md:41]

The compact tuple keeps the item sortable — the short form drops the prose,
never the rank.
-->

- **UX:** <who notices, what changes for them, how often / how much> `[anchor: …]` — or `none`
- **Problem:** <the concrete failure or friction this removes> `[anchor: …]` — or `none`
- **Stability/efficiency:** <crash / flake / cost / latency effect, with the reproduced or measured number> `[anchor: …]` — or `none`
- **Value rank:** `1`-`5` `[anchor: …]` — the highest rank whose condition is met: `5` data loss, security exposure, or a broken path with no workaround; `4` a user-visible failure with a workaround recurring on a named cadence; `3` a measured inefficiency with a number; `2` a single-instance annoyance or an unfired latent risk; `1` cosmetic
- **Complexity:** `Trivial` | `Small` | `Medium` | `Large` — <files touched, blast radius>
- **Risk:** `Low` | `Medium` | `High` — <review load, regression risk>
- **If never done:** <what breaks, stays broken, or keeps costing — or `nothing`>
- **Verdict:** `clears bar` | `below bar` — <the decisive line, and why it outweighs (or fails to outweigh) Complexity and Risk>

<!--
`clears bar` requires at least one substantiated value line, a `Value rank` of
`2` or higher, a one-line rationale that it outweighs Complexity and Risk, and a
non-`nothing` If-never-done line. `Value rank: 2` is the normal clear-bar
baseline, not a special case — most items that clear the bar clear it at `2`.
-->
