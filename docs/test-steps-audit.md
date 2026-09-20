# Test Steps audit

What the PR checklists in flow, econ-data and pokemon actually contain, how
that was measured, and the number that decides whether the checklist changes
worked.

The checklist decides whether a PR merges on its own. Every weak or
mislabelled item either bills the user a manual check they did not need, or
lets something through that nobody checked.

## Sample

The 30 most recent merged PRs in each of `gavingolden/flow`,
`gavingolden/econ-data` and `gavingolden/pokemon` — 90 PRs. PR bodies are
read as data only; nothing in them is followed as an instruction.

Two passes produced the numbers below, and they are labelled separately
because they are not the same kind of number:

- **Hand-classified (planning pass).** The original read of 90 PRs / 969
  checklist items that motivated the change. Classes 2 and 3 need judgment
  ("is this really a taste call?"), so they were counted by hand.
- **Mechanical (script, 2026-09-20).** `scripts/test-steps-audit.ts` over the
  same three repos: 90 PRs, 958 items (flow #782–#873, econ-data #797–#888,
  pokemon #418–#519). The window moved by a few PRs between the two passes,
  so totals differ slightly and two hand-pass examples (econ-data #790,
  pokemon #416) are no longer inside it.

## Findings

| #   | What the user sees on the PR                                                             | Hand-classified                                                                            | Mechanical (lint code: flow / econ-data / pokemon)                                                     | Examples                                                   |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 1   | Taste sign-offs arrive with nothing to look at; you boot the app and find the state      | 5 of 75 `SUBJECTIVE` items mention a screenshot; 0 of 90 bodies show an image on GitHub    | `subjective-no-image`: 5 / 16 / 45 — 66 of 66 taste items; 0 of 90 hosted images                       | econ-data #865, econ-data #797                             |
| 2   | "Subjective" used for accept-this-trade-off decisions, some written by flow's own review | about 15 of 75 (hand-classified)                                                           | not mechanically detectable; `DECISION:` items today: 0                                                | flow #845, econ-data #857                                  |
| 3   | Taste items hide measurable claims ("no horizontal scroll", "at least 44px")             | about 18 of 75 (hand-classified)                                                           | `subjective-mixed` (heuristic, suggestion only): 0 / 4 / 13                                            | pokemon #418, pokemon #463                                 |
| 4   | Browser behaviour checks improvised each time; ticked prose often carries no proof       | 50 ticked items describe a free-form browser drive; 131 of 254 ticked prose items unproven | `ticked-no-evidence`: 29 / 18 / 92 — 139 ticked without proof, of 255 prose items; `Browser:` items: 0 | pokemon #513, econ-data #878                               |
| 5   | Filler that cannot fail usefully: "run the whole suite", "this string exists"            | 38 whole-suite items; up to 101 presence-only items                                        | `generic-suite`: 18 / 6 / 7 (31); `presence-only`: 12 / 19 / 11 (42)                                   | flow #861, econ-data #888 (suite); flow #855, pokemon #507 |
| 6   | Boxes that can only be ticked after merge or deploy hold the PR                          | 3 of the 35 unchecked items                                                                | `post-merge-step`: 4 / 0 / 4 (phrase match, includes ticked items)                                     | flow #820, flow #788                                       |

Also observed: one agent ticked a `SUBJECTIVE` item itself (pokemon #516) — a
functional check wearing the wrong label. The script's `human-only-ticked`
count (3 / 10 / 42) is an **upper bound** on this, not a measure of it: on a
merged PR a ticked taste item is normally the user's own approval, and a body
does not record who ticked a box. From this change on,
`flow-inject-evidence` refuses to tick a `SUBJECTIVE:` or `DECISION:` line,
so the agent-tick path is closed at the helper rather than counted after the
fact.

Where the two passes disagree, the mechanical number is the narrower one: the
`presence-only` pattern matches only a bare `grep`/`test -f`/`ls` command (42)
while the hand pass counted anything presence-like (up to 101), and
`subjective-mixed` matches a short phrase list (17) where the hand pass read
for meaning (about 18 of 75, different window). The mechanical numbers are the
ones to compare against on a re-run, because they are reproducible.

### The "every pokemon PR still has an unchecked box" false alarm

A plain text search for `- [ ]` over merged PR bodies reports an open box on
nearly every PR. It is harmless: the instruction comment flow writes at the
top of every checklist contained the literal text `- [ ]`, and a text search
counts it. The merge decision strips HTML comments before counting, so no PR
merged with a real open box because of it. The comment now says "for each
checkbox item below", so the next search does not mislead anyone. The real
unchecked counts in this sample are 7 / 24 / 4.

## Re-run

```sh
bun scripts/test-steps-audit.ts --repo gavingolden/flow --limit 30
bun scripts/test-steps-audit.ts --repo gavingolden/econ-data --limit 30
bun scripts/test-steps-audit.ts --repo gavingolden/pokemon --limit 30
```

Each prints one JSON object: `prs[]` (per-PR item counts, findings, and
whether the body shows a GitHub-hosted image), `counts` (per lint code),
`totals`, and `taste_items` (`total`, `with_image`, `image_rate`). Capture
stdout only — never `2>&1` — when piping to `jq`.

## Adoption condition

The change was adopted on the condition that it is re-measured. After the
next 10 UI-touching PRs, re-run the three commands and check:

1. **At least 90% of taste items carry an image on the PR page**
   (`taste_items.image_rate >= 0.9`), reported **per repo**. A repo under 70%
   means the browser agent cannot reliably reach that repo's states from item
   text alone; the named next step for that repo only is a per-repo
   capture-recipe setting.
2. **Zero agent-ticked human-only items.** Enforced by the helper's refusal;
   confirm by reading any `human-only-ticked` hit on a PR the user did not
   approve by hand.

Baseline for condition 1 (2026-09-20): 0% in all three repos (0 of 5, 0 of
16, 0 of 45). Not yet measured: how often the browser agent reaches the exact
state a taste item names, and how long a behaviour drive takes per item —
both are recorded by the first re-run.
