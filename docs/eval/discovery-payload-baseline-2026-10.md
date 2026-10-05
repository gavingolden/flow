# Discovery instruction payload baseline (2026-10)

The dated measurement of what a discovery sub-agent pays at start-up, taken
before any change to `discovery-instructions.md` (issue #891). The
interpretation lives in [token-spend-analysis.md](../token-spend-analysis.md),
whose discovery-instruction-payload row cites $786.20 of 30-day discovery
spend; this file is only the measured numbers, so the before and after arms
compare against them instead of a guess.

## Production baseline

Reproduce with:

```sh
bun docs/eval/discovery-payload.ts --since 2026-09-05 --sections skills/pipeline/flow-product-planning/references/discovery-instructions.md
```

- Recorded: **2026-10-05**, at HEAD `428642c` (the script is the version
  added alongside this file).
- Runs: **129** discovery sub-agent transcripts under `~/.claude/projects`
  with `agentType: flow-module-core:flow-discovery`, modified on or after
  2026-09-05.
- Of those, **105** runs carry an attributed instruction read: either a
  Read of `discovery-instructions.md`, or a shell `cat` of it followed by a
  Read of the spilled output file (a `tool-results/*.txt` path). The other
  24 runs never loaded the file at all.
- Dollars are list-price equivalents from the script's dated price table
  (2026-09-30), not a bill.

### All 129 runs

| Metric                                 | Median | p25    | p75    |
| -------------------------------------- | ------ | ------ | ------ |
| First request context (tokens)         | 50,014 | 48,801 | 53,407 |
| First-turn write (tokens)              | 36,248 | 30,589 | 49,530 |
| Task text (chars)                      | 5,009  | 4,123  | 6,512  |
| Instruction read (tokens, upper bound) | 65,252 | 41,287 | 70,161 |
| Instruction read chunks                | 4      | 3      | 5      |
| Turns after instructions               | 20     | 9      | 41     |
| USD per run                            | 5.21   | 3.78   | 7.37   |

### The 105 runs with an attributed instruction read

| Metric                                 | Median | p25    | p75    |
| -------------------------------------- | ------ | ------ | ------ |
| First request context (tokens)         | 51,195 | 48,929 | 53,566 |
| First-turn write (tokens)              | 38,070 | 32,315 | 51,093 |
| Task text (chars)                      | 5,312  | 4,146  | 6,881  |
| Instruction read (tokens, upper bound) | 66,665 | 58,999 | 71,205 |
| Instruction read chunks                | 4      | 4      | 5      |
| Turns after instructions               | 27     | 16     | 45     |
| USD per run                            | 5.31   | 3.82   | 7.37   |

### USD per run by model (all 129 runs)

| Model            | Runs | Mean USD per run |
| ---------------- | ---- | ---------------- |
| claude-opus-5-5  | 36   | 3.99             |
| claude-opus-5    | 64   | 6.02             |
| claude-fable-5-1 | 28   | 7.35             |
| claude-sonnet-5  | 1    | 1.85             |

### Instruction read share

Computed over the same 105 attributed runs from the same transcripts, using
the script's parser:

- **Share of start-up payload:** the instruction read is 56.4% of
  (first request context + instruction read tokens), summed over the 105
  runs. The file arrives on later requests as 3 to 5 chunks, so it more
  than doubles what the first request already carries (median 51,195
  tokens).
- **First-turn write is not the instruction file.** The median first-turn
  write (38,070 tokens) is standing context and task text; the
  instruction read lands on requests 2 onward. A saving of 20% of the
  first-turn write is about 7.6K tokens of instruction read.
- **Share of discovery spend:** about **18% to 22%** of the modeled spend
  of the 129 runs ($736.61), i.e. roughly **$139 to $175** of the
  $786.20 30-day discovery spend. The low end prices the instruction
  tokens at each model's 5-minute write rate, the high end at its 1-hour
  write rate; both add the cache re-read of every instruction token on
  every later turn (median 27 turns).

### Reference open rates (all 129 runs)

| Reference                 | Opened | Runs | Rate |
| ------------------------- | ------ | ---- | ---- |
| prd-template.md           | 57     | 129  | 44%  |
| architecture-patterns.md  | 7      | 129  | 5%   |
| discovery-playbook.md     | 9      | 129  | 7%   |
| example-prd.md            | 26     | 129  | 20%  |
| discovery-instructions.md | 105    | 129  | 81%  |

The sibling references the instructions tell discovery to read are opened
on 5% to 44% of runs, so any block moved out of the core file needs an
explicit gate-site pointer or spawn-prompt name rather than reliance on an
optional read.

### Section sizes of `discovery-instructions.md`

Characters from each heading to the next heading of any level, largest 25;
headings inside code fences are ignored.

| Section (top 25 by size)                                       | Chars  |
| -------------------------------------------------------------- | ------ |
| ## 1.5. Web-grounded research pre-check                        | 25,813 |
| ## 7. Draft PR Description                                     | 18,096 |
| ## 3. Discovery — make informed assumptions, surface ambiguity | 14,359 |
| ### Candidate follow-up issues (optional)                      | 13,718 |
| ### Open Questions (resolution-first)                          | 8,891  |
| ## 5. Draft the PRD                                            | 7,093  |
| ## 6. Task Breakdown                                           | 6,162  |
| ### Prompt interpretation (conditional)                        | 6,060  |
| ## 1.6. Design-artifact fidelity pre-pass                      | 5,803  |
| # Verification                                                 | 4,888  |
| ### Layout Intent                                              | 4,030  |
| ## Revision pass mode                                          | 3,691  |
| ## Question-gate contract                                      | 3,653  |
| ### Request vetting                                            | 3,440  |
| ### Decision analysis                                          | 3,181  |
| ## 1.9. Product brief                                          | 3,003  |
| ## 4. Architecture Checkpoint                                  | 2,948  |
| ### Recommendation                                             | 2,530  |
| ## 1.7. Epic-membership detection                              | 2,478  |
| ## 1.8. Blind survey context → Method selection                | 2,262  |
| ## 9. Return a brief summary                                   | 1,619  |
| ### Visual Spec                                                | 1,430  |
| # Troubleshooting                                              | 1,387  |
| # Discovery instructions                                       | 1,382  |
| ### Alternatives considered                                    | 1,377  |

## Method

- **Instruction tokens** are the cache write on the assistant request
  immediately after each tool result that carries the instruction file —
  a Read of it, a shell command naming it, or a Read of the
  `tool-results/` file the shell output spilled to. That is an **upper
  bound**: the same request also writes anything
  else new in that turn (the model's own reasoning from the prior turn, other
  tool results arriving in the same turn).
- **Instruction chunks** is the number of such tool results; **turns after
  instructions** is the count of distinct assistant requests after the last
  one. A request is one `message.id`; the script keeps the LAST line per id
  because earlier lines of a streamed request carry a placeholder
  `output_tokens`.
- **First request context** is input plus cache-read plus cache-creation
  tokens of the first assistant request; **first-turn write** is its
  cache-creation tokens; **task text** is the length of the first user
  message.
- Quantiles use linear interpolation between ranks. USD per run prices every
  request of a run from the dated table; the model is the first request's.
- **Eval-child transcripts** are measured from flow-eval's
  `run-*/stream.jsonl` via `--stream-dir <out>`: rows carrying a
  `parent_tool_use_id` are the discovery sub-agent's rows (the eval child
  spawns exactly one discovery Task). Pass `--instructions <path|basename>`
  once per file for an arm that splits the instructions across several
  references, so every matched read sums into the instruction read.
- The share-of-spend range in "Instruction read share" is an estimate built
  from the same parser plus the price table, not a script output: write
  price times instruction tokens, plus read price times instruction tokens
  times turns after instructions, per run, summed over the attributed runs and divided by the
  129 runs' modeled total.

## Before arm

Recorded 2026-10-05 on the unsplit instruction file, tree `eb4e5d7`, Claude
Code 2.1.289, discovery sub-agent on `claude-opus-5-5` (parent pinned to
`opus` in the suite), with a fresh `FLOW_RESEARCH_CACHE_DIR`:

```sh
bun bin/flow-eval.ts run --suite discovery-plan-quality --out <dir> --runs 2 --concurrency 5
bun docs/eval/discovery-payload.ts --stream-dir <dir>
```

- Report: [before/report.json](discovery-payload/before/report.json),
  [before/summary.md](discovery-payload/before/summary.md).
- Quality: 5/5 scenarios pass; every gating grader (plan written,
  plan-lint, no agent fallback, and each scenario's branch grader) passed
  on all 10 runs.
- Eval spend: $19.18 for the 10 runs.

| Metric (10 discovery runs)             | Median | p25    | p75    |
| -------------------------------------- | ------ | ------ | ------ |
| First request context (tokens)         | 22,791 | 22,628 | 22,844 |
| First-turn write (tokens)              | 15,108 | 14,945 | 15,123 |
| Task text (chars)                      | 3,173  | 2,810  | 3,305  |
| Instruction read (tokens, upper bound) | 70,991 | 69,019 | 78,082 |
| Instruction read chunks                | 4      | 4      | 4      |
| Turns after instructions               | 12     | 9.3    | 14.8   |
| USD per discovery run                  | 0.95   | 0.72   | 1.01   |

The eval fixture is small, so its first-turn write (15K) is far below
production's (38K). The go/no-go bar therefore uses the production median
first-turn write: 20% of 38,070 tokens is **7,614 tokens** of instruction
read per run.

## After arm

Pending.
