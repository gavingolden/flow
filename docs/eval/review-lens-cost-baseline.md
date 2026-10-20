# Review-lens cost baseline (before-state, de-duplicated)

Per-lens spend of the seven `flow-review-*` lens subagents, the before-state
for any lens-side cost change. Every cell is a **per-run mean**
over lens transcripts modified on or after **2026-09-11**, all repos under
`~/.claude/projects/`, with usage counted once per `message.id` (Claude Code
writes one line per content block of a message; summing lines inflates
turns and dollars 2-3x, which is the unit error corrected in
`docs/eval/review-cost-baseline.md`).

Dollars price each model with `bin/lib/cost-pricing.ts`; a model with no
exact entry (for example `claude-opus-5`) is priced at its family's entry,
so the dollar column is an API-equivalent estimate, not an invoice. Pass
`--model-prices <json>` to override.

> **Erratum:** the measurement below kept the first transcript line per
> message, whose output count is a streaming placeholder. That dropped 86% of
> lens output tokens and left lens runs at $789.52 counted against an actual
> $930.09 (+17.8%; $140.57, 15.1% of the actual lens dollars, was missing).
> Corrected for version 3 rows (PR #896); the table is not re-rendered.

## Measurement (2026-09-30)

| Lens                | Runs | Turns | Reads | Greps | Distinct files | Cache-write tok | Cache-read tok | Output tok | $    |
| ------------------- | ---- | ----- | ----- | ----- | -------------- | --------------- | -------------- | ---------- | ---- |
| bug-detection       | 59   | 17.2  | 13.7  | 7.6   | 11.7           | 112155          | 1427537        | 1975       | 4.39 |
| security            | 56   | 10.6  | 9.2   | 4.0   | 8.1            | 77181           | 590831         | 1347       | 2.43 |
| pattern-consistency | 59   | 16.4  | 13.9  | 8.5   | 12.0           | 110469          | 1351001        | 1694       | 4.23 |
| performance         | 56   | 9.5   | 9.2   | 3.0   | 8.2            | 74048           | 502110         | 1135       | 2.23 |
| supply-chain        | 39   | 9.2   | 6.9   | 4.4   | 5.9            | 49391           | 335112         | 984        | 1.50 |
| test-coverage       | 58   | 14.2  | 12.6  | 5.7   | 10.8           | 97642           | 1060871        | 1513       | 3.54 |
| product             | 59   | 9.9   | 10.0  | 3.8   | 8.8            | 77700           | 530500         | 1581       | 1.98 |

## Reproduce

```sh
bun docs/eval/review-lens-cost.ts --since 2026-09-11
bun docs/eval/review-lens-cost.ts --since 2026-09-11 --json | jq .
```

The transcript window rolls, so a later run reproduces a different sample;
this table is the committed before-state.

## Not committed here

The supervisor's own review-phase figure (about 45 turns and $11 per
review) is cited from a scratch script under `~/.flow/audits/`; it is not
committed, and #835 owns turning it into a committed script. It is the
only number in this comparison that this file does not re-derive.
