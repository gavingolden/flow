# Token-spend analysis

Where flow's Claude quota goes, what each candidate saving would cost in
quality and time, and which checks must run before any of them ships.

## What this is

Over the 30 days ending 2026-09-30, flow's three repos burned about $9,344 of
list-price tokens across 309 sessions (the dollars are a proxy, not a bill;
see the gaps section). The verdict count:
**3 worth it / 6 not worth it / 4 unmeasured / 1 not pursued** (counting rows
in the ranked table). The reader gets a measured map of where the quota goes plus a
ranked hypothesis list: a lever is `worth it` only when its named recall check
has already been run and recorded, and otherwise it stays `unmeasured`, however
plausible it sounds, unless the most the lever could save, measured, is too
small to pay for the check, in which case it is `not worth it` with the check
unrun.

Every spend, token, turn and timing figure below is copied from the committed
baseline ([token-spend-baseline-2026-09.md](eval/token-spend-baseline-2026-09.md)),
which pastes the audit's output verbatim, except two sets of figures. The
cache-lifetime figures come from a second window in
[cache-lifetime-baseline-2026-10.md](eval/cache-lifetime-baseline-2026-10.md)
(2026-08-31 to the 2026-10-04 run). The discovery-payload spend, turn and
payload figures come from
[discovery-payload-2026-10.md](eval/discovery-payload-2026-10.md)
(2026-09-05 to 2026-10-05). Figures marked "derived" are plain division or
addition over those tables. The recall-check results quoted in the ranked table
come from four other committed records: the eval-suite arms in
[scaffold-verdicts.md](eval/scaffold-verdicts.md), the Sonnet-vs-Opus study in
[review-model-recall.md](eval/review-model-recall.md), the Fable-vs-Opus
bug-detection recall check in
[fable-vs-opus-subagents.md](eval/fable-vs-opus-subagents.md), and the
150k-window arms in [review-cost-baseline.md](eval/review-cost-baseline.md).
Nothing is estimated.

## Vendor guidance

What Anthropic, OpenAI and Google currently recommend for keeping long-running
multi-agent work cheap, read live on 2026-09-30. "Measured" means the source
shows its own numbers; "Asserted" means it states a rule without them.

<!-- prettier-ignore -->
| Vendor | Recommendation | Source | Measured or asserted | Applies to flow |
|---|---|---|---|---|
| Anthropic | Cache the stable start of every request. Cache reads cost 0.1x the normal input price (0.05x on Opus 5.5, 0.025x on Fable 5.1); a 5-minute write costs 1.25x and a 1-hour write 2x. Any byte change before the cached point invalidates everything after it. | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | Asserted | The audit's price table was checked against these multipliers today. Cache reads are 14,410.73M of flow's tokens against 371.19M written, so a stable start is the load-bearing habit. |
| Anthropic | In the vendor's own test, caching made a claims agent 32% cheaper than no caching, 44% cheaper than an unstable prefix, and 54% cheaper than putting variable content first; one explicit cache point on the shared instructions roughly halved cost per task; the best configuration, which also switched model and effort, cut cost 13x. | https://platform.claude.com/cookbook/cost-optimization-cost-optimization | Measured | A toy ten-claim workload, so the percentages are direction, not forecast. It supports keeping every sub-agent's opening text identical across runs. |
| Anthropic | Clearing old tool results cut that test's cost 12%, server-side compaction 16%, and a hand-rolled prune at task boundaries 29%, but only because the conversation outgrew the window; on short loops neither fired and nothing changed. | https://platform.claude.com/cookbook/cost-optimization-cost-optimization | Measured | Cuts against flow's own measurement that a 150k window raised cost 32-64%. The vendor's runs grew past the trigger; flow's supervisor already carries about 135K after the pipeline loads and 348K at review entry (medians), cached context that a smaller window would make it re-buy. |
| Anthropic | Clearing tool results or thinking blocks breaks the cached prefix at that point; clear enough at once to pay for the re-write. | https://platform.claude.com/docs/en/build-with-claude/context-editing | Asserted | Explains why any window or clearing lever in flow pays a cache re-write each time it fires. |
| Anthropic | Compaction summarizes older turns on the server and keeps the active context small because quality degrades as a conversation grows. | https://platform.claude.com/docs/en/build-with-claude/compaction | Asserted | Quality, not cost, is its stated purpose. flow has tried it only through Claude Code's auto-compact setting (the 150k test below). |
| Anthropic | Effort is the main dial for intelligence, latency and cost; lower effort means fewer and terser tool calls. Opus 5.5 defaults to medium, Opus 5 and Sonnet 5.5 default to high, and low is suggested for sub-agents. | https://platform.claude.com/docs/en/build-with-claude/effort | Asserted | Two Opus generations sit under flow's Opus sub-agents with different silent defaults, so "no effort set" means different things. Sweep on your own evals first, the page says. |
| Anthropic | Changing effort in the middle of a conversation invalidates the cache; hold it constant or use the per-message form. | https://platform.claude.com/cookbook/cost-optimization-cost-optimization | Asserted | Any effort pin should be set per sub-agent at launch, never changed mid-run. |
| Anthropic | A sub-agent runs in its own context window, sends its own requests that count toward the same usage limits, inherits the main conversation's model when its definition names none, and inherits the session's thinking setting; its effort can be set separately. | https://code.claude.com/docs/en/sub-agents | Asserted | Sub-agents are not free quota. A sub-agent without a model pin on a Fable session runs on Fable. |
| Anthropic | Handing a bulky self-contained subtask to a cheap sub-agent that returns one line cut the test's cost 78%. A separate routing test using sub-agents on condensed rules came in about 90% under the Opus baseline but denied a routine claim in both trials, because the condensed rules dropped an exception. | https://platform.claude.com/cookbook/cost-optimization-cost-optimization | Measured | Isolation pays when the subtask is bulky and its result is short. flow's review lenses and discovery need the detail, which is where the vendor's one miss came from. |
| Anthropic | Measure cost per completed task, not per token; fix the quality bar first; caching goes first and stays on; effort and model choice go last. | https://platform.claude.com/cookbook/cost-optimization-cost-optimization | Asserted | The ordering this analysis uses: no lever ships on a dollar figure alone. |
| OpenAI | Reused prompt prefixes are discounted up to 95%; on current models a cache write costs 1.25x and a read 0.1x; the whole prefix must match; entries live about 30 minutes; holding a session does not guarantee a hit. | https://developers.openai.com/api/docs/guides/prompt-caching | Asserted | Same stable-start rule from a second vendor. flow's main loops run on Claude, so this is confirmation, not a lever. |
| OpenAI | Reasoning effort ranges from none to max depending on the model, defaults to medium on current models, and the hidden reasoning tokens are billed as output and occupy the context window. | https://developers.openai.com/api/docs/guides/reasoning | Asserted | Effort is the first cost and quality dial at every vendor, but defaults differ by model, so carry no setting across models. |
| OpenAI | The hosted agents service includes automatic context compaction and multi-agent orchestration; the open runtime leaves the loop and handoffs to the application. | https://developers.openai.com/api/docs/guides/agents | Asserted | The page gives no cost numbers or isolation advice, so it adds nothing flow can act on beyond confirming that vendors treat compaction as a platform feature. |
| Google | Implicit caching is on by default for Gemini 2.5 and newer, savings pass through automatically, the smallest cacheable prompt is 2,048 to 4,096 tokens by model, and large common content should come first. | https://ai.google.dev/gemini-api/docs/caching | Asserted | The page states no discount figure. Another vendor confirming that the stable start goes first. |
| Google | Gemini reasons dynamically by default and is steered with a thinking level (minimal, low, medium, high by model); to cut cost or latency lower the level instead of capping output length, because a cap truncates the answer while still billing the thinking. | https://ai.google.dev/gemini-api/docs/thinking | Asserted | Same lesson as effort: lower the dial, never truncate. The numeric thinking-budget setting the research brief looked for no longer appears on the page. |

All eleven pages were fetched live on 2026-09-30 and each returned content, so
no fallback to the cache was needed. Two claims in the cached research note did
not survive the live read: that context editing "cost more than it saved" (the
vendor's own run above shows 12% cheaper where the window was outgrown) and
that agent cost grows with the square of turn count or that re-running at
higher effort held pass rate at half the cost (neither statement appears on any
page fetched). Both are treated as unconfirmed. The note's other points, that
list price is not a proxy for subscription quota and that transcripts cannot
rank levers causally, are taken as caveats and carried into the gaps section.

## Where the quota goes

**The supervisor, not the helpers, takes most of it.** Of $9,344 list-price
spend, the in-process supervisor took $5,975 (63.9%) over 28,022 turns and the
sub-agents took $3,370 (36.1%) over 54,999 turns. One repo dominates: flow
itself is $4,859 (52.0%), econ-data $3,951 (42.3%), pokemon $534 (5.7%).

**By phase of work (supervisor only).** The review phase alone is $1,914, a
third of the supervisor's spend (32.0%, or 20.5% of everything). Then
implementation $1,029 (17.2%), the pipeline supervisor's own loop $1,004 (16.8%), planning
$863 (14.4%), the new-feature step $313 (5.2%), and time before any skill
loaded $277 (4.6%). Everything else is under 3% each.

**By helper type (sub-agents only).** Discovery is the biggest at $787 (23.3%),
the edit-applier $739 (21.9%), the fix-applier $307 (9.1%), the scout $200
(5.9%). The review lenses together are about $935 (derived: sum of the eight
review rows, 27.7% of sub-agent spend). The edit-applier is the most
turn-hungry: 18,867 turns, more than a third of all sub-agent turns.

**By model.** Opus 5 carries $5,465 (58.5%), Fable 5.1 $2,139 (22.9%), Sonnet 5
$1,075 (11.5%), Opus 5.5 $351 (3.8%) and Fable 5 $292 (3.1%). Fable 5.1 averages $0.24
a turn against $0.15 on Opus 5 (derived), yet Fable is only 11.7% of turns
(9,733 of 83,021, derived), so it is 26.0% of dollars (derived: 22.9% plus 3.1%). Raw tokens for
the supervisor alone, by model (derived: model total minus the sub-agent
rows): opus-5 5,741.0M, fable-5-1 1,764.5M, opus-5-5 438.3M, fable-5 130.6M, sonnet-5 66.1M, haiku-4-5-20251001 0.3M.

**Per pipeline.** Across the 149 pipelines the telemetry could tie to a
transcript, the median run cost $27.49, the top quarter cost more than $51.31,
and the most expensive cost $151.

**Caching is the real cost shape.** Fresh input is almost free; the bill is
caches. Flow reads 14,410.73M cached tokens and writes 371.19M. Of those writes,
54.4% are the expensive 1-hour kind (202.07M tokens against 169.12M for the
5-minute kind). List-price writes cost $3,432 (about 37% of all spend, derived),
of which the 1-hour writes are $2,400 and the 5-minute writes $1,032. The 1-hour
kind is priced at 2x rather than 1.25x, so it adds $900 over what the same
tokens would have cost at the shorter lifetime.

What that premium bought was measured in a later window (2026-08-31 to
2026-10-05 UTC, the 2026-10 baseline, so its dollars are not comparable to the
$2,400 and $900 above). The audit replays every transcript as if its cache
lived five minutes and charges each read that came more than 5 and at most 60
minutes after the stream's previous request as a re-write. The main conversation
paid a $596 premium on 125.67M 1-hour-write tokens and avoided $3,167 of
re-writes, so a five-minute lifetime would have cost $2,571 more at list price
($2,545 timing the request from the assistant row instead of the preceding user
row). The four sub-agents flow pins paid a $188 premium (derived: sum of four
rows) and avoided $68 of re-writes (13.37M tokens re-read within a spawn plus
0.53M re-read across spawns, derived), so five minutes would have been about
$121 cheaper, and each of the four was cheaper under both timings. These are
list-price figures, not subscription plan usage.

**Where the 1-hour lifetime comes from.** On a Claude subscription within plan
usage, Claude Code requests a one-hour lifetime for the main conversation by
default; flow sets no override of it. Sub-agents and other requests outside the
main conversation default to five minutes, so the 1-hour sub-agent writes in
the window came from flow's per-agent `experimental.cacheTtl: 1h` pins on
discovery, the consolidator, the fix-applier and the UI driver (a retired
verify agent also shows 33 requests). The controls, first match wins:
`FORCE_PROMPT_CACHING_5M=1`; the bucket's environment variable
(`CLAUDE_CODE_PROMPT_CACHE_TTL` for the main conversation,
`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` for everything else); the bucket's
setting (`promptCacheTtl`, `subagentPromptCacheTtl`); a sub-agent's frontmatter
`experimental.cacheTtl`; then `ENABLE_PROMPT_CACHING_1H=1`; then the default.
Source: https://code.claude.com/docs/en/prompt-caching (read 2026-10-04).

## Spend against outcome and time

**Outcomes.** Looking only at real pipelines (those carrying a slug), 95 runs
reached a terminal state in the window: 45 merged, 39 gated for human review, 6
needs-human, 5 cancelled. The raw terminal-event count is misleading: the
telemetry log holds 403 terminal rows, and 291 of them have no slug because
they come from flow's own evaluation harness running disposable child
pipelines. Of the 240 needs-human rows, 229 are those harness children
(direct count of the log, not the audit). Inside the window the harness bucket
is 50 sessions (35 merged, 13 gated, 2 needs-human), kept apart and never
counted as pipelines.

**How runs ended.** Runs end where you would hope: 43 of 45 merged runs finished
in the merging phase and all 39 gated runs in the gating phase. The 6
needs-human runs ended mostly while implementing (4 of 6: an implement failure,
an API limit, an external CI failure, a pending re-anchor), one in the
checkpoint-pending-clear pause and one in merging; two of the six recorded
"verify-exhausted" as the reason, the only reason that repeats. The 5
cancellations ended in five different phases (planning, triaging, plan review,
gated, needs-human), so no single stage loses work.

**Spend against outcome** (derived: medians over the per-pipeline table). Merged
runs had a median of $46.42 (45 runs), gated $52.91 (39), needs-human $19.76
(6), cancelled $9.75 (5), and pipelines with no terminal event yet $14.04 (54).
The runs that fail early cost less than the ones that finish, so no outcome
bucket shows wasted money piling up: flow is not spending heavily on runs that
then die.

**Verification.** 314 of 453 verify attempts passed (69.3%); 139 failed and
were retried. Fixing failed checks is where the fix-applier's $307 goes.

**Time.** These are the median minutes a run spent in each phase before
leaving it. Work phases: reviewing 28.9 minutes (top quarter 45.7),
implementing 27.3 (47.2), planning 18.2 (22.6), the wait before CI reports 9.0 (11.5),
verifying 2.4 (8.9), merging 0.7. The four working phases add to about 77
minutes of medians (derived; a sum of medians, not the median of a sum). Human
waits dwarf that: gated runs wait a median of 432.9 minutes (top quarter
644.8), and plan-pending-review 32.9 (552.0). The first is a person's schedule,
not flow's speed.

**What the join does and does not show.** It ties 201 of 309 sessions (65.0%,
above the 60% line that would have triggered a caveat) to telemetry, which
yields cost, outcome and phase timings for the 149 slugged pipelines. It shows
which runs were expensive and how they ended. It cannot show why a run cost
what it did, whether a cheaper setting would have ended differently, or what
the 108 unjoined sessions looked like; it is correlation, not a controlled
comparison.

## Ranked levers

Grouped by verdict (unmeasured, worth it, not worth it, not pursued), then by the spend each
lever touches within each group, since most have no measured saving yet. "30-day $" is the list-price spend the lever acts on, not the expected
saving. Raw tokens are in millions across all token classes, by model. The
unmeasured levers each name the recall check that would have to run first.

<!-- prettier-ignore -->
| Lever | Verdict | 30-day $ | Raw tokens by model | Turns | Quality cost | Latency cost | Recall check (name, run?) | Existing issue |
|---|---|---|---|---|---|---|---|---|
| Fewer supervisor turns per phase, led by the review phase | unmeasured | $5,975 supervisor, of which review $1,914 | opus-5 5,741.0M, fable-5-1 1,764.5M, opus-5-5 438.3M, fable-5 130.6M, sonnet-5 66.1M, haiku-4-5-20251001 0.3M | 28,022 | Unknown. The worry is the supervisor losing its place in the gate and merge rules when its context is trimmed. | Fewer turns should also be faster; not measured. | Phase-write fidelity eval on the post-change flow: run? no | #835 |
| Effort pins on the Opus judgment sub-agents (lenses, consolidator, scout, discovery) | unmeasured | $1,489.68 on Opus 5 and 5.5 | opus-5 1,498.9M, opus-5-5 283.9M | 17,945 | Unknown. The vendor says "some capability reduction"; its sweeps were not reproduced here. | Fewer tool calls per task, so faster. | Medium vs high effort recall on the review lenses: run? no (the existing model study held effort at medium in both arms, so it is silent on effort) | #832 |
| Edit-applier and fix-applier turn counts | unmeasured | $1,046.50 ($738.96 plus $307.54) | edit-applier: sonnet-5 2,797.8M, sonnet-5-5 60.2M, fable-5-1 42.2M, opus-5 39.9M; fix-applier: sonnet-5 1,100.9M, sonnet-5-5 18.8M, fable-5-1 10.9M, opus-5 8.5M | 29,130 | Unknown. Fewer turns could mean less verifying of its own edits. | Fewer turns is faster. | Re-run recorded edit-sets with a smaller turn budget and compare verify outcomes: run? no | none |
| Low-yield review lenses (performance, supply-chain, security) | unmeasured | $276.22 ($104.32, $54.80, $117.10) | performance: opus-5 62.6M, fable-5-1 7.5M, opus-5-5 5.0M, fable-5 1.5M, sonnet-5 0.4M; supply-chain: opus-5 33.9M, fable-5-1 3.4M, opus-5-5 2.7M, fable-5 1.2M; security: opus-5 75.8M, fable-5-1 8.4M, opus-5-5 7.7M, fable-5 1.7M, sonnet-5 0.8M | 3,239 | Findings lost. They acted on 17, 5 and 40 findings respectively, against 162 for pattern-consistency; security findings can be rare and serious. | Fewer agents in flight. | Does another lens catch what a dropped lens caught? run? no (the existing recall study excluded these three for having too few acted findings) | none |
| Drop flow's 1-hour pin on 4 sub-agents (discovery, consolidator, fix-applier, UI driver) | worth it at list price; plan-usage effect unknown | $503 in 1-hour writes, $188 of it the premium over the 5-minute rate (2026-10 window; derived: sum of four rows) | 1-hour writes 54.23M (derived: sum of four rows); not split by model | 17,518 requests (derived) | None expected, since it changes price not behavior. | Slower first turn back after a 5 to 60 minute pause; the vendor page says it "can be noticeably slower". 86 sub-agent requests followed such a gap inside a spawn (derived: sum of four rows), and cross-spawn first requests re-read 0.53M more tokens after one (the audit prints no request count for those). | Replay of every transcript at a 5-minute lifetime: run? yes; about $121 cheaper over the window, and each of the four cheaper under both send-time readings (the fix-applier by only $3.01 and $2.07) | none |
| Lift the bug-detection Opus cap on Fable sessions (shipped) | worth it | $194, all bug-detection spend in the window; +$1.79 a review on Fable sessions (measured at medium effort); re-check: the next token-spend audit compares flow-review-bug-detection @ Fable 5.1 per-run cost against the measured $2.50 | opus-5 157.0M, opus-5-5 22.4M, fable-5-1 12.7M, sonnet-5 3.7M, fable-5 2.0M | 2,059 | Gains findings: Fable re-found 8.7% against Opus 5.5's 3.9% (p = 0.0065) | Fable median 95 s against 46 s in the harness; the review waits on its slowest lens | Fable vs Opus 5.5 bug-detection recall on 3 PRs, 2 runs each: run? yes; cap lifted ([results](eval/fable-vs-opus-subagents.md)) | #890 |
| Keep triage in the main session instead of a cheap-model gatekeeper (already shipped) | worth it | $1.44, what the retired agent still shows in the window | haiku-4-5-20251001 4.4M | 171 | None measured: suite score 0.917 before and after; one scenario already failing with or without the agent. | None measured. | Gate-score and cost comparison on the eval suite: run? yes, cost fell 29% (27% with a Sonnet parent) | none |
| Move the main conversation to 5-minute cache writes | not worth it | $1,590 in 1-hour writes, $596 of it the premium over the 5-minute rate (2026-10 window) | 1-hour writes 125.67M; not split by model | 24,539 requests | None expected, since it changes price not behavior. | Slower first turn back after every 5 to 60 minute pause; the vendor page says the first turn after the cache expires "can be noticeably slower". 1,276 main-conversation requests followed such a gap in the window. | Replay of every transcript at a 5-minute lifetime: run? yes; 5 minutes cost $2,571 more at list price ($2,545 by assistant-row send time) | none |
| Discovery instruction payload | not worth it | $786.20 | opus-5 606.5M, opus-5-5 151.7M, fable-5-1 145.8M, fable-5 11.8M, sonnet-5 6.3M | 5,453 | Unknown, unmeasured; only 14,157 of 55,653 tokens sit in gated sections, 10,014 of them behind gates the sub-agent judges itself | Not measured; loading is a few reads at the start of a 42- to 53-turn Opus run | Plan quality with trimmed instructions on recorded tasks: run? no — a split's ceiling is $0.20 a plan on Opus 5.5 (5.2%), short of the Large refactor and new eval it needs ([record](eval/discovery-payload-2026-10.md)) | #891 (closed, not planned); #818 related |
| Cap the session context at 150k (`--autocompact 150k`) | not worth it | not shipped | not measured | turns rose in all five scenarios (for example 6 to 9) | Fidelity held, 5 of 5 | More turns | Phase-write fidelity, two arms: run? yes; cost rose 32.5% to 64.1% | none |
| Route bug-detection and pattern-consistency lenses to Sonnet | not worth it | $387.06 is the pool on those two lenses | opus-5 311.0M, opus-5-5 45.0M, fable-5-1 26.2M, sonnet-5 7.1M, fable-5 4.2M | 4,106 | Sonnet re-found 0.6% and 0.0% of the reference findings against Opus 4.8% and 6.0% | none | Sonnet vs Opus recall on 3 PRs, 2 runs each: run? yes | none |
| Remove the checkpoint-pause step | not worth it | not measured | not measured | no change on any metric | Suite score fell from 0.983 to 0.975 | None measured; every cost and context metric read the same | Eval suite with and without the step: run? yes; nothing cut, score fell | none |
| Isolate the verify loop in its own sub-agent | not worth it | $5.02, what the retired agent still shows | sonnet-5 9.0M | 173 | none | Removing it made the loop slightly faster, not slower | Eval A/B with and without: run? yes; cost +0.3% and +0.6% when removed | none |
| Sub-agents inheriting the Fable session model | not pursued | $666.39 across 3,379 sub-agent turns | fable-5-1 365.7M, fable-5 25.8M | 3,379 | Planning: not measured — planning tracks the session model by the user's deliberate choice; per finished run Fable discovery costs $5.34 against $3.85 on Opus 5.5 (+$1.49) and $5.57 on Opus 5. Bug-detection: cap lifted (own row above). The product review lens is now pinned to Opus at medium effort ($0.55 a review against Fable's $1.10) | Fable bug-detection median 95 s against 46 s on Opus 5.5; discovery median 10.0 min against 12.3 | Fable vs Opus 5.5 bug-detection recall on 3 PRs, 2 runs each: run? yes; Fable materially better, cap since lifted (own row above) ([results](eval/fable-vs-opus-subagents.md)) | #890 |

Reading the table: the top three rows are where the money is and all three are
still hypotheses. Three levers have a recorded check that clears the bar. Two
have shipped: the gatekeeper removal, the smallest row, because what remains in
the window is pre-removal residue, and the lifted bug-detection cap, which adds
spend on purpose (+$1.79 a review on Fable sessions) to buy the findings Opus
misses. The sub-agent pin drop is worth it at list price only: the saving is
about $121 over the window, and the vendor publishes no weighting of 1-hour
writes against subscription plan usage, so its effect on plan usage is unknown.

## Not worth it

Each closed below with its measured number.

1. **Cap the session context at 150k (`--autocompact 150k`).** Cost rose in all
   five test scenarios, by 58.6%, 32.5%, 51.2%, 51.7% and 64.1%, with context
   per turn down about 78K and turns up (6 to 9, 10 to 11, 6 to 7, 6 to 7, 5 to
   7). One arm cost $13.19 and the other $19.09. Fidelity held (5 of 5 against
   4 of 5), so it is safe but dearer. The likely reason is buying evicted
   context back at the fresh-input price; that mechanism is an inference, not
   measured. The vendor's own cookbook agrees a window only pays when a
   conversation outgrows it. A third-party figure of 5-10x higher cost from
   small windows appears in the cached research, but its magnitude is
   unverified; flow's own +32% to +64% is the number to use.
2. **Run the bug-detection and pattern-consistency lenses on Sonnet.** Recall
   against the 134 reference findings was 0.6% for Sonnet against 4.8% for Opus
   on bug-detection (p = 0.030) and 0.0% against 6.0% on pattern-consistency (p
   = 0.008); Sonnet raised 28 concerns to Opus's 102 across the study. Test
   coverage was inconclusive (p = 0.108). Absolute recall is low by design
   (each lens is one of six), so read it as a direction.
3. **Isolate the verify loop in a sub-agent to save supervisor context.**
   Removing the isolation changed cost by +0.3% and +0.6% and context by +4.4%
   and +3.3%, all inside tolerance: the isolation bought nothing measurable.
4. **Remove the checkpoint-pause step.** Removing it cut nothing measurable
   (every cost and context metric read the same) and lowered the suite score
   from 0.983 to 0.975, so it stayed.
5. **Move the main conversation to 5-minute cache writes.** In the 2026-10
   baseline window the main conversation paid a $596 premium on 125.67M
   1-hour-write tokens and avoided $3,167 of re-writes, so five minutes would
   have cost $2,571 more at list price ($2,545 by assistant-row send time):
   1,276 requests re-read 399.27M tokens after a 5 to 60 minute pause that a
   five-minute cache would have lost. The main conversation keeps Claude
   Code's 1-hour default. The replay credits every such read to the 1-hour
   lifetime even when a parallel session in the same directory would have
   refreshed the prefix sooner, so the $3,167 is an upper bound, though it
   would need to be overstated about fivefold to flip the verdict.
6. **Split discovery's instructions into a lean core plus on-demand references
   (#891).** The file is 55,653 tokens and about a quarter of an Opus plan's
   cost ($0.86 of a $3.78 Opus 5.5 run, derived), but 75% of it applies to
   every plan. A full split stops loading about 12,731 tokens a plan: $0.20 a
   plan on Opus 5.5, $0.34 on Opus 5 and $0.21 on Fable 5.1, about $25 a month
   at the current Opus 5.5 rate, and it means updating the 11 test files that
   point at the current file, plus a plan-quality eval flow does not have. Re-open when the file passes 75,000
   tokens or a plan-quality eval lands
   ([record](eval/discovery-payload-2026-10.md)).

## Revised verdicts

- **"240 of 403 needs-human" is demoted.** The figure counted runs from the
  evaluation harness: 229 of the 240 needs-human rows are slug-less harness
  children and only 11 are real pipeline rows. By session, taking each run's
  last outcome, real pipelines ended needs-human 6 times out of 95, about 6.3%
  (derived), and the reasons are all different apart from one repeat.
  This is not evidence of a systemic stall.
- **"The supervisor is 69% of spend" is revised to 63.9%.** The open issue
  headline says 69%; this audit, which drops repeated API rows and prices the
  two cache lifetimes separately, finds $5,975 of $9,344. Still the largest
  single share, but a lower one.
- **The earlier review-phase dollar figures are not comparable.** The
  2026-09-08 baseline put the supervisor's review-phase spend at $5,597 and the
  reviewers at $4,086; this audit shows the review segment at $1,914. The two
  differ by method (repeat rows, cache pricing, window) and by the review-phase
  change that landed on 2026-09-09 and 2026-09-10, so neither should be cited
  against the other.
- **The cached research claim that context editing costs more than it saves is
  superseded** by the vendor's live run (12% cheaper where the window was
  outgrown).
- **No other previously ticked candidate was supplied with this analysis,** so
  none is demoted here beyond those above. Any candidate resting on the raw
  terminal-event count should be rechecked against the slugged-run table.

## Open measurement gaps

- **Unjoined sessions.** 108 of 309 sessions (35.0%) have no telemetry match,
  so their cost, outcomes and timings are missing from the per-pipeline view,
  and the audit does not print what they cost.
- **Background sub-agents.** Sub-agents launched in the background are visible
  only through their own records; their result never appears in the parent, so
  attribution depends on their metadata.
- **Quota vs list price.** The subscription quota is weighted by model and its
  weights are unpublished, so the vendor says sub-agent requests count toward
  the same limits but not by how much. Dollars rank spend; they do not predict
  when the quota runs out. Report raw tokens by model alongside them, as the
  table above does. The cache-read discounts also differ per model (Opus 5.5
  and Fable 5.1 are cheaper than the standard rate), which list price models
  but the quota may not. The same holds for cache lifetime: the prompt-caching
  page (read 2026-10-04) says 1-hour writes bill at a higher rate but publishes
  no plan-usage weighting for them, so the sub-agent pin-drop saving is a
  list-price saving only.
- **Cross-session cache reads.** The cache-lifetime replay looks only inside one
  transcript stream (plus same-type sub-agent spawns in the same directory), so
  a read served by a parallel session's fresher write is credited to the 1-hour
  lifetime. That overstates what the 1-hour lifetime bought, most of all for the
  main conversation.
- **The mid-window review change.** The review phase changed on 2026-09-09
  (#829) and 2026-09-10 (#830), inside this window, so the review-phase rows mix
  before and after. A window starting 2026-09-10 would give a clean read and
  costs one re-run.
- **The 30-day garbage window.** Local transcripts older than about 30 days are
  deleted, so the earliest days are partial and a comparison window must be
  recorded before it ages out.
- **Lens accounting.** The lens yield numbers mixed three token-accounting
  sources. Re-deriving the lens runs whose transcripts are still available
  gives the identical tokens-per-acted-finding ordering of all seven lenses;
  magnitudes were about 1.7x overstated. A separate first-line output
  undercount (the summers kept the first line per message, whose output count
  is a streaming placeholder) counted all transcripts since 2026-09-04 at
  $8,692 against an actual $9,131 (+5.0%) and lens runs at $789.52 against an
  actual $930.09 (+17.8%; $140.57, 15.1% of the actual lens dollars, was
  missing). Both are fixed for version 3 rows (PR #896); the figures in this
  document were not re-rendered.
- **Instruction payload: isolated for discovery only.** The table of first-turn
  cache writes (discovery median 43,445 tokens against about 14,500 for the
  built-in explorer to 20,300 for the heaviest review lens) measures, for
  discovery, standing context (system prompt, tools, project instructions and
  task text) and not flow's instructions: discovery reads its instruction file
  after its first turn. Six agents preload an instruction skill through
  `skills:` frontmatter, so for them the first-turn figure does include flow's
  instructions and still bounds rather than measures the payload: flow-scout,
  flow-fix-applier, flow-edit-applier, flow-consolidator, flow-merge-resolver
  and flow-ui-driver. Discovery's payload is now measured on its own
  ([record](eval/discovery-payload-2026-10.md)); other sub-agents' instruction
  payloads are still not isolated.
- **Per-turn multiples are confounded.** The per-turn price of discovery on
  Fable 5.1 against Opus mixes price with turn count. Split per finished run
  (`token-spend-audit.ts --since 2026-09-11`): Fable lists at 2x Opus 5's
  input and output price and 2.5x Opus 5.5's, costs 2.0x and 3.7x as much per
  discovery turn, but finishes in 41% and 37% of the turns (18 against 44 and
  48.5), so a planning run costs $5.34 on Fable against $5.57 on Opus 5 and
  $3.85 on Opus 5.5. The per-turn multiple overstates the per-task gap.
- **Causality.** Transcripts identify candidates but cannot rank them; only a
  controlled comparison with a named recall check can.
- **Pricing table.** The audit prices from a hand-maintained table verified
  against the vendor's pricing page on 2026-09-30; flow's built-in cost table
  is stale (open issue #597) and was not used.
