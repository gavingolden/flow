# Lens cache-prefix baseline (2026-10)

The dated measurement behind issue #889, which asked whether the review lenses
launched together in `/flow-pr-review` share an opening prompt-cache prefix;
this file records what the transcripts show. The interpretation lives in
[token-spend-analysis.md](../token-spend-analysis.md); this file is only the
measured numbers, so a later window compares against them instead of a guess.
The sibling cache measurement is
[cache-lifetime-baseline-2026-10.md](cache-lifetime-baseline-2026-10.md).

## Method

Recorded **2026-10-05** on Claude Code 2.1.289. Each sub-agent transcript's
`.meta.json` `agentType` picks the lens. Usage is the LAST transcript line per
`message.id`, and the first turn is the first distinct `message.id`. A review
is the lens spawns in one session whose first-line timestamps fall within 120 s
of the first. "Concurrent" means all spawns within 1 s. Dollars are list price
from the `PRICES` table in `docs/eval/token-spend-audit.ts`, not a bill (Opus
5.5: 5-minute write $5/M, read $0.20/M; Opus 5: $6.25/M, $0.50/M).

Privacy: aggregates only. No session ids and no prompt text beyond the shape of
the pointer line each lens receives: "You are the Bug Detection review agent
for PR #900 … Read your shared context block at
`.flow-tmp/review-context-bug-detection.md`".

## Coverage

- Window: 2026-09-05 to 2026-10-05, all repos under `~/.claude/projects/`
- 731 lens spawns (opus-5 499, opus-5-5 173, fable-5-1 53, sonnet-5 6)
- 97 reviews with five or more lenses: 62 sequential (spawns seconds apart,
  last on 2026-09-22) and 35 concurrent (from 2026-09-22)

## Measurements

By spawn timing:

<!-- prettier-ignore -->
| spawn timing | lens spawns | first turns reading 0 cached tokens | later lenses that read nothing | later lenses that read | first-turn write p50 per lens | first-turn write p50 per review |
|---|---|---|---|---|---|---|
| Concurrent | 264 | 202 | 175 of 229 | 54 of 229, reading 3,019–4,602 tokens (includes a traced case of another pipeline's review 7 s earlier) | 16,331 | 118,124 |
| Sequential | 427 | — | — | 353 of 365, reading 2,652–4,587 tokens (p50 2,926) | 18,188 | 115,061 |

The discovery run counted only the block-reading later lenses in the
sequential set. It did not split out zero-read first turns or the 12 later
lenses outside the 2,652–4,587 cluster, so those two cells are left blank
rather than estimated.

Spend split (lens list price $862):

| class              | list price | share                  |
| ------------------ | ---------- | ---------------------- |
| cache writes       | $428       | 49.6% of the $862      |
| cache reads        | $273       |                        |
| output             | $162       |                        |
| first-turn writes  | $78        | 18.1% of write dollars |
| second-turn writes | $73        |                        |

Shared-block size by agent type (first-turn read clusters, tokens):

| agent type       | first-turn read |
| ---------------- | --------------- |
| review lenses    | 2,652–4,602     |
| consolidator     | 2,050–3,383     |
| backlog-verifier | 3,356–3,816     |
| edit-applier     | 7,769–8,419     |
| general-purpose  | 16,367–21,721   |

Same-type control: 6 back-to-back backlog-verifier pairs read 3,816 of 16,842
tokens.

Where flow's text sits: each lens's agent definition becomes its system prompt
and differs from its first line
(`agents/core/flow-review-bug-detection.md` against
`agents/core/flow-review-security.md`); the live spawn prompt is a short
pointer; the shared context block reaches each lens only as a file read on its
second turn.

Stagger arithmetic: 7 × 4,050 × ($5 − $0.20)/M = $0.136 a review gross on Opus
5.5 (a full review spawns 8 agents: seven lenses plus intent-guess; the first
writes the tool block, the other 7 would read it). The 4,050-token block is
the discovery run's working figure for the lens tool block; it sits inside the
concurrent read cluster (3,019–4,602) and above the sequential p50 (2,926). At
that p50 the gross falls to $0.098 a review, which only strengthens the
verdict. The supervisor's request at
the spawn re-read 357,815 and 397,743 cached tokens on the two 2026-10-05
reviews checked (about $0.08 at $0.20/M), leaving about $0.05 net. Over the 35
concurrent reviews the gross was $4.70 (summed over each review's actual spawn
count and model, so it is not exactly 35 × $0.136). The monthly figures in
the analysis are derived from the per-review rates: 97 reviews in the 30-day
window × $0.136 ≈ $13 a month gross, and 97 × ~$0.05 ≈ $5 a month net. Both are
list-price, Opus 5.5 rates; most spawns in the window ran on Opus 5, which is
priced differently, so read them as an order of magnitude. Break-even formula:
staggering saves money only if
`N_lenses × T_block × (P_write − P_read) > S_supervisor_tokens × P_read`.

## Reproduce

`bun docs/eval/token-spend-audit.ts --since <date>` prints the per-type
first-turn `median read tokens` and `zero-read first turns` columns in its
`## First-turn cache-write per sub-agent type` table. A re-check compares those
against this file: concurrent spawns show up as a high zero-read count, and a
Task-tool fan-out hold would show lenses reading the ~4K block again. The
column inherits the write column's window semantics (a spawn straddling
`--since` has its first in-window turn counted as its first turn). The
concurrent/sequential review split and the stagger arithmetic were a one-off
discovery run and are not in the repo.

Mechanism sources (read 2026-10-05):

- <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>:
  writes only at breakpoints; for concurrent requests a cache entry only
  becomes available after the first response begins.
- <https://code.claude.com/docs/en/prompt-caching>: a sub-agent starts its own
  conversation with its own system prompt and tool set; Claude Code holds
  same-prefix workflow fan-outs up to 5 s, Task-tool spawns get no such hold.

## Not committed here

The per-session extraction script and any session ids or prompt text are not
committed. The transcripts roll off after about 30 days, so the underlying
sessions cannot be re-read after that.
