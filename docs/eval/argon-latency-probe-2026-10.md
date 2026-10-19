# Stage 0: Argon latency probe (2026-10)

Raw records and sized limits: [`argon-latency-probe-2026-10.json`](argon-latency-probe-2026-10.json).
Harness and sizing rule: [`argon-latency-probe/`](argon-latency-probe/).

Measured 2026-10-19: 29 calls on `Gemini 4 Argon (High)` and `Gemini 4 Argon (Medium)`, no
quota refusal, no empty answer, no timeout, no refused tool. Each call used the
step's production prompt builder and production read-access or web-search
posture, ran serially under a 20-minute cap, and read the committed inputs in
[`argon-latency-probe/inputs/`](argon-latency-probe/inputs/). Wall seconds are
the delegate call's own duration.

## Answer times and sized limits

| Step                                     | Model  | n   | Median  | Slowest | Empty  | Timed out | sizeLimit (limit, verdict) |
| ---------------------------------------- | ------ | --- | ------- | ------- | ------ | --------- | -------------------------- |
| Research gather                          | High   | 3   | 415.4 s | 522 s   | 0 of 3 | 0 of 3    | 20m, limit-mismatch        |
| Research gather                          | Medium | 3   | 387.9 s | 536 s   | 0 of 3 | 0 of 3    | 20m, fits                  |
| Research gather, capped search (variant) | High   | 3   | 308.4 s | 376.4 s | 0 of 3 | 0 of 3    | 16m, fits                  |
| Plan reviewer #1                         | High   | 3   | 256.3 s | 306.5 s | 0 of 3 | 0 of 3    | 13m, fits                  |
| Plan reviewer #1                         | Medium | 3   | 129.7 s | 162.8 s | 0 of 3 | 0 of 3    | 10m, fits                  |
| Method-survey judge A                    | High   | 3   | 96 s    | 100.9 s | 0 of 3 | 0 of 3    | 10m, fits                  |
| Method-survey judge A                    | Medium | 3   | 66.7 s  | 88.6 s  | 0 of 3 | 0 of 3    | 10m, fits                  |
| PR intent guess                          | High   | 2   | 37.1 s  | 37.6 s  | 0 of 2 | 0 of 2    | 10m, fits                  |
| PR intent guess                          | Medium | 2   | 23.1 s  | 25.4 s  | 0 of 2 | 0 of 2    | 10m, fits                  |
| Gemini review lens                       | High   | 2   | 153.3 s | 176.5 s | 0 of 2 | 0 of 2    | 10m, fits                  |
| Gemini review lens                       | Medium | 2   | 106.1 s | 117 s   | 0 of 2 | 0 of 2    | 10m, fits                  |

`sizeLimit` is the larger of 10 minutes and 3x the median, rounded up to the
minute and capped at 20 minutes. The capped-search row is a variant of the
gather, not a production step.

## Findings

- **Steps that stall on High but fit on Medium:** none.
- **Limit mismatch: research gather on Argon High.** 3x the 415 s median is 20.8
  minutes, which rounds up to 21 and is over the 20-minute cap, so the step ships
  at the cap and is reported as a mismatch. Argon Medium fits at 20m (3x its
  388 s median is 19.4 minutes).
- **Capped-search gather variant not shipped.** Telling the gather to use at most
  3 searches and 8 pages gave a median of 308 s against 415 s uncapped, 1.35x
  faster and below the 2x bar, so the gather prompt is unchanged.
- **The earlier 3-minute empties fit these times for two of three steps.** Argon
  High's median is 256 s for plan review and 415 s for the research gather, both
  past 3 minutes. The survey judge is the exception: it answered in 96 s median
  (slowest 101 s), so the empty survey in this pipeline is not explained by
  answer time.

## Resulting limits

| Step                                      | Old limit | New limit |
| ----------------------------------------- | --------- | --------- |
| Research (gather and fact-check share it) | 3m        | 20m       |
| Plan reviewer #1                          | 3m        | 13m       |
| Method-survey judge A                     | 3m        | 10m       |
| PR intent guess                           | 5m        | 10m       |
| Gemini review lens                        | 8m        | 10m       |

Worst-case waits at these limits: the survey 16 minutes (judge A 10m plus judge B
6m); research 20 minutes, plus a 5-minute give-up margin; plan review give-up
18 minutes standard and 33 minutes deep (reviewer #1 13m, plus reviewer #2 15m
on the deep tier, plus 5 minutes).

## Gap

The research limit is shared with the Claude fact-check (`researchRefute`),
which Stage 0 did not time. Its 20-minute limit is the gather's, not a
measurement of the fact-check's own answer time.
