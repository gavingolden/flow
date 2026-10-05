# Discovery instruction payload (issue #891)

A one-off measurement, not a committed eval suite. Local transcripts are
deleted after about 30 days, so the scans behind these numbers cannot be
re-run later; this file is the record.

## Question

Issue #891 says discovery's instruction file
(`skills/pipeline/flow-product-planning/references/discovery-instructions.md`)
is a ~55K-token payload paid on every plan, and proposes a lean core plus
on-demand references. Two questions:

1. What does the file actually cost each plan, and how much of a plan is that?
2. How much of it could a split stop loading without making plans worse?

## Method

- **Payload size.** The Read tool's own token count for the full file on main
  (`428642c`): 55,653 tokens for 1,950 lines, 157,626 characters, 158,733
  bytes, so about 2.8 characters a token rather than the usual 4.
- **Per-run cost and turns.** `bun docs/eval/token-spend-audit.ts --since
2026-09-05`, run twice on 2026-10-05: once at planning time and again at
  implementation time. The two runs differ because transcripts aged out and new
  runs landed in between; both are given below.
- **Payload per plan (derived).** The file is read on the first turn, written to
  the cache once, then re-read from the cache on every later turn of the run:

  `payload $ = 55,653 × (cache-write price + cache-read price × (turns − 1)) / 1,000,000`

  using the 5-minute cache-write price, because PR #895 dropped the sub-agents'
  1-hour cache pin and new runs write at the 5-minute rate. Prices per million
  tokens, from the audit's price table:

  | Model     | 5-minute write | 1-hour write | Cache read |
  | --------- | -------------- | ------------ | ---------- |
  | Opus 5.5  | $5.00          | $8.00        | $0.20      |
  | Opus 5    | $6.25          | $10.00       | $0.50      |
  | Fable 5.1 | $12.50         | $20.00       | $0.25      |

- **Window share.** A one-off transcript scan over every priced feature-mode
  discovery run since 2026-09-05, charging each run its own model's prices and
  its own write lifetime (1-hour or 5-minute), against that run's full cost.
- **Gated sections.** Sections of the file that only some plans need were sized
  by their share of the file's characters (applied to the 55,653 tokens), and
  their firing rate was counted from spawn-prompt markers, plan headings and
  tool commands across the planning-time snapshot of 137 runs. Expected saving
  per plan = section tokens × the share of runs that did not need it.

The scan scripts were not committed: the transcripts they read expire within
about 30 days, so a committed script could not reproduce these numbers.

## Results

### The payload is real and loaded every time

- Read in every priced feature-mode run: 136 of 136 at planning time, 121 of
  121 at implementation time. The Read tool stops at 25,000 tokens a read, so
  each load takes at least three reads.
- The file is not in the first request. The scan finds the first Read in the
  first assistant turn, so the file reaches the model from the second request
  on. Discovery's median first-turn cache write (37,318 tokens; 38,218 at
  planning time) matches the fix-applier (40,014) and the general-purpose agent
  (38,114), neither of which reads the file. The first-turn table therefore
  measures standing context and task text, not flow's instructions.

### What it costs a plan

Per finished run, from the implementation-time audit (planning-time figures in
brackets):

| Model     | Runs    | Median turns | Median $ a run | Payload a plan (derived) | Share of the plan |
| --------- | ------- | ------------ | -------------- | ------------------------ | ----------------- |
| Opus 5.5  | 35 [35] | 53 [44]      | $3.78 [$3.03]  | $0.857 [$0.757]          | 22.7% [25%]       |
| Opus 5    | 64 [77] | 42 [42]      | $6.25 [$5.95]  | $1.489 [$1.489]          | 23.8% [25%]       |
| Fable 5.1 | 28 [31] | 17 [17]      | $7.00 [$7.31]  | $0.918 [$0.918]          | 13.1% [13%]       |

Across the window, at each run's own prices: **$172.73 of $689.13 (25.1%)** over
121 runs at implementation time; $198.10 of $768.51 (25.8%) over 136 runs at
planning time. 111 of the 121 runs (130 of 136 at planning time) wrote the
cache at the 1-hour rate, before PR #895 removed that pin.

Discovery's total spend in the audit window: $732, 26.3% of sub-agent spend
($806 and 25.8% at planning time; edit-applier next).

### What a split could remove

Sections that apply only when a gate fires, planning-time snapshot of 137 runs:

| Section                               | Tokens | Runs that needed it | Gate                                 |
| ------------------------------------- | ------ | ------------------- | ------------------------------------ |
| Research procedure                    | 5,260  | 21                  | discovery's own judgment (or forced) |
| Prompt interpretation                 | 1,966  | 11                  | discovery's own judgment             |
| Design-artifact pre-pass, Visual Spec | 1,779  | 0                   | a design spec on disk                |
| Deliberation consult                  | 1,607  | 2                   | discovery's own judgment             |
| Revision pass                         | 1,315  | 19                  | `REVISION:` spawn marker             |
| Layout Intent                         | 1,181  | 11                  | discovery's own judgment             |
| Blind-survey read                     | 559    | 28                  | `SURVEY:` spawn marker               |
| Epic context                          | 490    | 13                  | `EPIC:` spawn marker                 |
| **Total**                             | 14,157 |                     | 25% of the file                      |

Expected tokens a split stops loading per plan: **12,731** (derived). Of those,
2,021 sit behind spawn-prompt markers, 1,779 behind a file on disk, and 8,931
behind gates discovery judges for itself. flow already has a committed record
of discovery skipping a prose-gated procedure even when forced: the research
fan-out, which is why `bin/flow-research-run.ts` now runs it from the
supervisor instead.

The remaining 41,496 tokens (75%) apply to every plan; no split removes them,
only condensing would, and condensing is the vendor's measured failure mode
(a condensed-rules run denied a routine claim in both trials because the
condensed rules dropped an exception; see the vendor table in
[`../token-spend-analysis.md`](../token-spend-analysis.md)).

### The ceiling of a full split (derived)

| Model     | Saved a plan | Share of the plan |
| --------- | ------------ | ----------------- |
| Opus 5.5  | $0.196       | 5.2%              |
| Opus 5    | $0.341       | 5.4%              |
| Fable 5.1 | $0.210       | 3.0%              |

- **Forward-looking, Opus 5.5** (new pipelines default to it): about **$25 a
  month** at the audit's 128 finished runs per 30 days (planning time: $0.173 a
  plan, about $24 a month).
- **At the window's actual model mix:** 12,731 / 55,653 of the window payload,
  about **$40 a month** ($172.73 × 0.229); $45 at planning time.

Either way it is 3-6% of discovery's spend and under 1% of flow's total.

## Verdict

**Not worth it.** The payload is real, about a quarter of an Opus plan, but
three quarters of it is needed on every plan. A full split saves about $0.20 a
plan on Opus 5.5 and needs a Large change: 11 test files name the file (the
skill lint test on 141 lines), and no plan-quality eval exists to show the
split leaves plans as good. A marker-only split (the
deterministic gates) saves about $0.03 a plan. Issue #891 is closed as not
planned.

Not measured: whether a shorter file improves plan quality by diluting
attention less. The plan-quality eval needed to test that does not exist.

## Re-open trigger

Re-measure when either holds:

- The Read tool's count for the file passes **75,000 tokens** (about 214,000
  bytes at the current ratio). The file grew from 137,468 to 157,049 bytes
  between 2026-09-02 and 2026-09-10, then by 1.1% to 158,733 bytes by
  2026-09-20, and has not changed since; at the recent rate there is no
  near-term crossing date, while two more bursts like early September's would
  cross it.
- A plan-quality eval suite lands, since it removes the largest cost of the
  split and lets the attention question be tested.
