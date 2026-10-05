# Cache-lifetime baseline (2026-10)

The dated measurement of what flow's 1-hour cache writes bought against a
5-minute cache lifetime, across the `flow`, `pokemon` and `econ-data` repos.
The interpretation lives in
[token-spend-analysis.md](../token-spend-analysis.md); this file is only the
measured numbers, so a later window compares against them instead of a guess.
The spend baseline it extends is
[token-spend-baseline-2026-09.md](token-spend-baseline-2026-09.md).

## Method

Reproduce with:

```sh
bun docs/eval/token-spend-audit.ts --since 2026-08-31
```

Recorded **2026-10-04** (the audit's own header prints 2026-10-05, because it
reports the UTC date). The script is the version committed in `890988c`; the
output was captured once from that same file and is pasted verbatim, not
re-run while writing, so a later re-run over the same `--since` will differ
slightly (the window keeps growing and old days are garbage-collected).
Dollars are list-price equivalents priced from the script's dated inline
table, not a bill.

The replay treats each transcript stream (the main conversation file, and
each sub-agent file) as if its cache lived 5 minutes: a read more than 5 and
at most 60 minutes after the stream's previous request would have missed, so
those tokens are charged at the 5-minute write rate minus the read rate. It
also credits a sub-agent spawn's first request against earlier spawns of the
same agent type in the same working directory. The 1-hour premium
(1-hour write rate minus 5-minute write rate) is what the 1-hour lifetime
costs; the net column is premium saved minus re-writes added, so a negative
net means 5 minutes is cheaper.

Privacy: aggregates only. No prompt text and no session ids.

## Coverage

- Run date: 2026-10-05 (--since 2026-08-31, UTC)
- Pricing table last verified: 2026-09-30
- Sessions covered: 272 (2026-08-31 to 2026-10-05); repos: flow, pokemon, econ-data
- Sessions from worktree cwds: 9
- Telemetry join rate: 212/272 (77.9%)
- Parse errors (whole files, not window-filtered): 0
- Assistant rows with no usage: 0
- Unknown models: 0
- Spend (list price): supervisor $5021, sub-agents $2760, total $7781
- Cache writes: 5m 131.54M tokens, 1h 180.20M tokens (57.8% are 1h)
- Cache-write spend (list price): 5m $759, 1h $2094; the 1h premium over the 5m rate is $785

## Cache lifetime

Window: 2026-08-31 to 2026-10-05 (request send dates, UTC)

| stream                       | requests | 1h-write tokens | 1h-write $ | 1h premium $ | tokens re-read 5-60 min later | cross-spawn tokens re-read 5-60 min later | requests re-reading after 5 min | re-write $ at 5m | net $ at 5m (negative = 5m cheaper) | net $ at 5m, assistant-row send time | first-request reads (unattributed) |
| ---------------------------- | -------- | --------------- | ---------- | ------------ | ----------------------------- | ----------------------------------------- | ------------------------------- | ---------------- | ----------------------------------- | ------------------------------------ | ---------------------------------- |
| main conversation            | 24539    | 125.67M         | $1590      | $596         | 399.27M                       | 0.00M                                     | 1276                            | $3167            | $2571                               | $2545                                | 7.49M                              |
| sub-agent: flow-discovery    | 5063     | 28.71M          | $358       | $134         | 4.10M                         | 0.30M                                     | 17                              | $44.72           | -$89.39                             | -$102                                | 1.09M                              |
| sub-agent: flow-consolidator | 1339     | 6.24M           | $66.87     | $25.08       | 0.33M                         | 0.06M                                     | 6                               | $2.15            | -$22.92                             | -$22.93                              | 0.06M                              |
| sub-agent: flow-fix-applier  | 8630     | 14.97M          | $60.80     | $22.80       | 8.49M                         | 0.11M                                     | 61                              | $19.79           | -$3.01                              | -$2.07                               | 0.18M                              |
| sub-agent: flow-ui-driver    | 2486     | 4.31M           | $17.26     | $6.47        | 0.45M                         | 0.06M                                     | 2                               | $1.18            | -$5.29                              | -$5.29                               | 0.06M                              |
| sub-agent: flow-verify       | 33       | 0.31M           | $1.24      | $0.47        | 0.00M                         | 0.01M                                     | 0                               | $0.02            | -$0.44                              | -$0.44                               | 0.01M                              |
| **TOTAL**                    | 42090    | 180.20M         | $2094      | $785         | 412.65M                       | 0.54M                                     | 1362                            | $3235            | $2450                               | $2413                                | 8.90M                              |

Requests skipped for a non-finite send time (unreplayable): 0

Limitations: reads served by a parallel session's fresher write are not attributed; cross-spawn grouping assumes the same agent type in the same directory shares a prefix; dollars are list price, not subscription plan usage.

## Limitations

- Cross-session cache reads are not attributed: a read served by a parallel
  session's fresher write of the same prefix is credited to the 1-hour
  lifetime, which overstates what the 1-hour lifetime bought.
- The cross-spawn replay assumes spawns of one agent type in one working
  directory share a prefix; the vendor page scopes the cache to one machine
  and directory, but a changed prompt would break the assumption.
- List price is not subscription plan usage: the vendor publishes no weighting
  of 1-hour writes against plan usage, so a dollar saving here is not a
  measured plan-usage saving.
- Send time is approximated two ways: the timestamp of the nearest preceding
  user row, and the assistant row's own timestamp. The two net columns bracket
  that error; neither is the exact request send time.
- The window is 2026-08-31 to the run date, which differs from the 2026-09
  baseline's, and older transcripts age out after about 30 days, so the two
  baselines are not directly comparable.

## Verdict inputs

The two net columns copied from the table above (negative means a 5-minute
lifetime is cheaper), per pinned sub-agent and for the main conversation.

| stream                       | net $ at 5m | net $ at 5m, assistant-row send time | both negative |
| ---------------------------- | ----------- | ------------------------------------ | ------------- |
| main conversation            | $2571       | $2545                                | no            |
| sub-agent: flow-discovery    | -$89.39     | -$102                                | yes           |
| sub-agent: flow-consolidator | -$22.92     | -$22.93                              | yes           |
| sub-agent: flow-fix-applier  | -$3.01      | -$2.07                               | yes           |
| sub-agent: flow-ui-driver    | -$5.29      | -$5.29                               | yes           |
