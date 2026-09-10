# Review-phase cost baseline (before-state)

The review phase is the most expensive thing flow does, and most of that
money is not spent on reviewing. This file records the measured
before-state so a later re-measurement is a comparison rather than a
fresh guess.

Why it has to be committed: the audit script reads a **rolling 30-day
transcript window**, so once a cost change lands the "before" arm becomes
unreproducible. A number nobody can re-derive is not a baseline.

## The measurement

Recorded **2026-09-08** from every Claude Code transcript under
`~/.claude/projects/` for the `flow`, `pokemon` and `econ-data` repos
(main + subagent JSONL, per-turn `usage` + `model`).

Reproduce with:

```sh
bun ~/.flow/audits/transcript-review-segment.ts
```

**Limitation:** `~/.flow/audits/transcript-review-segment.ts` is a machine-local
audit script, not committed to this repo, so the exact reproduce command above
only runs on the machine it was authored on. `docs/eval/review-context-boundaries.ts`
is the closest committed sibling — same rolling-window transcript scan, same
per-turn `usage` read — but it measures **context size at phase boundaries**, not
the segment-cost/turn-count/agent-count figures in the table below, so it does
not reproduce this table byte-for-byte. Re-deriving this exact table on a fresh
machine currently requires re-authoring `transcript-review-segment.ts` from this
description; committing that script (parameterized per
`review-context-boundaries.ts`'s `HOME`/repo-regex fix) is the durable follow-up.

| What was measured                                   | Value                               |
| --------------------------------------------------- | ----------------------------------- |
| Pipelines whose review phase was measured           | 141                                 |
| Supervisor turns spent inside the review phase      | 17,975 (median 110 per pipeline)    |
| Average context carried on every one of those turns | 425,892 tokens                      |
| API-equivalent cost of those turns                  | $5,597 (median $30.10 per pipeline) |
| Shell commands the supervisor ran inside the phase  | 7,949 (≈56 per pipeline)            |
| Review agents it spawned                            | 1,392 (≈10 per pipeline)            |

The reviewers themselves — all six lenses plus the cross-model lens —
cost $4,086 over the same window. The supervisor's own note-taking
costs more than the review it is supervising.

**Pricing basis.** API-equivalent at first-party list price, Opus 5
cached input at **$0.50 per million**, with no long-context premium — so
cost scales linearly with how much conversation each turn re-sends. That
puts a floor of roughly **$0.21 per turn** before the model emits a
single token. These are quota-proxy dollars, not a bill.

**Provenance note.** The figures above are a re-run on 2026-09-08 of the
same script that produced
`~/.flow/audits/pr-review-token-audit-2026-09-08.md`, which recorded 137
sessions / 17,399 turns / $5,454 / 425,682 average context / 7,649 Bash
/ 1,359 Agent. The small drift is the rolling window advancing between
the two runs, not a methodology change.

## Phase-boundary context floors

These decide whether any auto-compact window is safe: they say how much
context the supervisor is already carrying at the moment it loads the
instructions it is about to follow.

Reproduce with the variant script committed beside this file
(`review-context-boundaries.ts`), which differs from
`transcript-review-segment.ts` in one way: instead of summing the review
segment, it records the context size on the **first assistant turn after**
each `Skill` tool-use, per session.

```sh
bun docs/eval/review-context-boundaries.ts
```

| Boundary                              | n   | p25  | median   | p75  |
| ------------------------------------- | --- | ---- | -------- | ---- |
| Context after `/flow-pipeline` loads  | 354 | 128K | **135K** | 145K |
| Context after `/flow-pr-review` loads | 141 | 313K | **348K** | 390K |
| Max context per pipeline session      | 141 | 406K | **450K** | 504K |

**What this implies.** Any window below ~348K compacts at or before
review entry. A 150k window compacts _twice_ before the review even
starts — once before `/flow-pr-review` loads and again as its ~29K body
and references land — which would leave the supervisor running Steps
8-10's gate and merge rules from a summary of its own instructions. That
is why the window is measured before it ships, and why shipping no
window at all is a pre-authorised outcome.

**A note on two different measurement points.** The plan for this change
carried a second set of figures — 60K after `/flow-pipeline` loads, 303K
after `/flow-pr-review` loads, 270K median / 425K p75 peak. Those were
measured at a different point in the turn than the table above, which
samples the first assistant turn _after_ the skill body is already in
context. Both sets agree on the finding that matters and the table above
is the more conservative of the two in the direction that counts: review
entry is higher, not lower, than the plan assumed, so the fidelity
hazard is larger rather than smaller. The table above is the committed
figure because its script ships beside it.

## Re-measuring after the change

The after-arm requires a pipeline **launched after this change is
installed** — the script reads transcripts, so an in-flight session that
predates the install still carries the old shape. Run the same command
and compare the `turns` and `avgContextTokensPerTurn` fields for the
review segment.

## Auto-compact window fidelity measurement

**Arms run (2026-09-08).** `phase-write-fidelity`, 5 scenarios, two arms
on one tree: a freshly recorded no-flag arm and a `--autocompact 150k`
arm.

**Why the committed baseline could not serve as the no-flag arm.** The
plan's ship rule assumed `docs/eval/baseline/phase-write-fidelity.report.json`
_was_ the no-flag arm. It is not, and by three independent axes at once:
it recorded **4 scenarios** where the suite now has 5
(`s5-open-pr-implementing` landed since), on **claude 2.1.252** where
this host runs **2.1.266**, and before three commits that changed both
`flow-pipeline/SKILL.md` and `flow-pr-review/SKILL.md`. Comparing a 150k
arm against it would have confounded the window with all three. So the
no-flag arm was re-recorded on the same tree, the same day, the same CLI
— differing from the candidate by exactly one flag.

**Why `checkpoint-pending-clear` was not run.** Its three scenarios end
at roughly 107K, 107K and 24K of context, so **nothing in it can cross a
150k window**. As a cross-suite control its control value is exactly zero
when no compaction can fire; running it would have bought a green report
that proves only that the flag parses. The narrowing is deliberate and
is recorded here rather than left as an unexplained omission.

**Ordering constraint (load-bearing).** `ownCheckoutRoot()` in
`bin/lib/eval-fixture.ts` resolves to the invoking **worktree**, so the
fixture materialises the worktree's own `skills/` tree. Any arm run after
a change to the fences these suites exercise measures the change, not the
flag. Both arms therefore ran before this branch touched either SKILL.md.

**Reading the result — three rules.**

1. `flow-eval compare` **will** warn that base and candidate carry
   different `childArgvDigest` values. `childArgvDigest` hashes flag
   names, and the arms differ by exactly this flag. The warning is
   correct; record it, do not suppress it. `runner.autocompact` now
   carries the same information in readable form.
2. A pass is only a pass **if a compaction actually fired**, and the
   harness has no compaction detector — there is no occurrence of
   "compact" anywhere in `bin/lib/eval-*.ts` or `bin/flow-eval.ts`. The
   stand-in is `transcript.finalContextTokens`: an arm whose
   `s2-step8-reviewing` still ends near its no-flag value did not
   compact, and its result is **inconclusive, never a pass**.
3. Only `s2-step8-reviewing` can cross a 150k window at all (the other
   scenarios end near 118K). The verdict therefore rests on **one
   scenario**, and must be reported that way.

**Evidentiary ceiling.** Even a clean s2 arm is necessary, not
sufficient. The fixture tops out near 170K where production's review
entry sits at 348K, so the probe tests the right question — does the
supervisor still write the right phase after its instructions were
summarised — at roughly a fifth of the real overflow. A clean arm
justifies shipping a window **with** the compact-instructions reload
rule and a config escape hatch; it does not justify shipping one
without them.

### Result: ship no window

**Verdict: `session.autocompactWindow` does not ship, and neither does
the launch flag.** Not because the measurement was inconclusive — it was
conclusive, in the opposite direction from the one the plan expected.

| Arm                   | Score       | Cost   | `runner.autocompact` |
| --------------------- | ----------- | ------ | -------------------- |
| no flag (re-recorded) | 0.984 (4/5) | $13.19 | `null`               |
| `--autocompact 150k`  | 1.000 (5/5) | $19.09 | `"150k"`             |

**A compaction demonstrably fired.** Rule 2's stand-in is unambiguous —
every scenario's median `transcript.finalContextTokens` fell sharply:

| Scenario                  | no flag | 150k   | delta   |
| ------------------------- | ------- | ------ | ------- |
| `s1-step7-ci-wait`        | 121,195 | 43,398 | −77,797 |
| `s2-step8-reviewing`      | 168,168 | 97,407 | −70,761 |
| `s3-step9-gating`         | 120,572 | 40,576 | −79,996 |
| `s4-step10-merging`       | 120,742 | 41,029 | −79,713 |
| `s5-open-pr-implementing` | 121,018 | 42,080 | −78,938 |

Note that the four ~120K scenarios dropped too, though none of them
approaches a 150k ceiling — so the flag is not only a "compact on
overflow" trigger. The reduction is roughly uniform at ~78K, which is
what a systematically smaller retained context looks like, not adaptive
overflow handling.

**Fidelity held.** The 150k arm passed 5/5 against the no-flag arm's
4/5. The one no-flag failure is `s5-open-pr-implementing`, which fails
_without_ the flag — a pre-existing flake, not a compaction casualty.
Recording a fresh no-flag arm is the only reason that is knowable; the
stale committed baseline does not contain `s5` at all.

**And the lever inverts.** Cost and turns went **up**, consistently,
across all five scenarios:

| Scenario                  | cost delta | turns (no flag → 150k) |
| ------------------------- | ---------- | ---------------------- |
| `s1-step7-ci-wait`        | **+58.6%** | 6 → 9                  |
| `s2-step8-reviewing`      | **+32.5%** | 10 → 11                |
| `s3-step9-gating`         | **+51.2%** | 6 → 7                  |
| `s4-step10-merging`       | **+51.7%** | 6 → 7                  |
| `s5-open-pr-implementing` | **+64.1%** | 5 → 7                  |

**Why (inference, not measured).** The measured facts are: context per
turn down ~78K, turn count up, total cost up 32-64%. The most likely
mechanism is the pricing asymmetry this whole baseline rests on — cached
input is $0.50/M where fresh input is $5/M, a 10x spread. Evicting
context to stay under a ceiling means re-reading it as **fresh** input
later, and needing extra turns to do it. Carrying a large _cached_
conversation is cheaper than repeatedly rebuilding a small one.

**What this means for the cost goal.** Bounding the session's context
window is not a cost lever for flow — it is a cost _penalty_. The
remaining lever is the one that removes work rather than re-doing it:
batching the review phase's mechanical Bash calls into
`flow-review-prep` / `flow-review-finalize`, which cuts turns outright.

**What still ships from this task.** The compaction-survivability work
is independent of the window and lands regardless: `AGENTS.md`'s
review-phase resume anchors and the post-compaction reload rule (detail
in `references/compact-anchors.md`). The harness keeps `--autocompact`
so this question stays answerable — re-run the two arms above to
re-test it against a future CLI, where the cache economics may differ.
