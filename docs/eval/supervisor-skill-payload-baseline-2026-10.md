# Supervisor skill payload baseline (2026-10)

The dated BEFORE measurement of what the `flow-pipeline` supervisor skill
costs and how much of it survives a compaction, taken on the unsplit tree at
HEAD `8e5c823`, before the core-plus-step-docs split. The decision rule is in
[supervisor-skill-payload.md](supervisor-skill-payload.md); this file is only
the measured numbers, so the after arm compares against them instead of a
guess.

## Production baseline

Reproduce with:

```sh
bun docs/eval/supervisor-skill-payload.ts --since 2026-09-25 --format md
```

- Recorded: **2026-10-14**.
- Source: main transcripts under `~/.claude/projects` for the `flow`,
  `pokemon` and `econ-data` repos (the `supervisor-turns.ts` repo set) whose
  first timestamp is on or after 2026-09-25 UTC and that loaded the
  `flow-pipeline` skill.
- Context added by a load is the context of the request after the skill body
  arrived minus the request that called `Skill`. Both are measured token
  counts from the transcripts' usage records, not a chars/4 estimate.
- A re-attachment is the `invoked_skills` attachment Claude Code writes after
  a compaction; its length is the skill content the platform kept.

| Measure                                                | Value           |
| ------------------------------------------------------ | --------------- |
| Supervisor sessions                                    | 102             |
| Skill loads                                            | 103             |
| Median context added by a skill load (tokens)          | 90,195          |
| Median supervisor turns per session                    | 95              |
| Sessions that compacted                                | 22              |
| Compacted sessions that re-loaded or re-read the skill | 7               |
| Re-attachments of the skill                            | 16              |
| Re-attached length (chars, min / max)                  | 20,000 / 20,000 |

| Doc Read                                  | Reads | Sessions | Of  |
| ----------------------------------------- | ----- | -------- | --- |
| references/step3-threading.md             | 31    | 24       | 102 |
| references/interview-playbook.md          | 14    | 14       | 102 |
| references/skill-overlay.md               | 11    | 11       | 102 |
| SKILL.md                                  | 20    | 8        | 102 |
| references/prompt-sanity.md               | 3     | 3        | 102 |
| references/redirect-handling.md           | 1     | 1        | 102 |
| references/merge-resolver-spawn-prompt.md | 1     | 1        | 102 |
| references/ui-smoke-pass.md               | 1     | 1        | 102 |
| references/headless-claude.md             | 1     | 1        | 102 |
| references/pause-output-contract.md       | 1     | 1        | 102 |
| references/blind-survey.md                | 1     | 1        | 102 |

Difference from the plan's Measurements table, per the script output winning:
the script finds 102 supervisor sessions and 103 loads where the plan counted
107 and 108 (the script's repo filter skips sessions outside the three repos),
and a median of 95 supervisor turns per session, counted as de-duplicated API
requests with usage (the plan's 200 is a different count). The load delta
(90,195 vs 90,193 tokens), the 22 compacted sessions, the 7 that re-loaded or
re-read, the 16 re-attachments at exactly 20,000 chars and the 20 `SKILL.md`
reads agree. `step3-threading.md` shows 31 reads across 24 sessions where the
plan listed 26.

## Static sizes (unsplit tree)

Reproduce with:

```sh
bun docs/eval/supervisor-skill-payload.ts --static
```

On the unsplit tree the whole file is resident from the first turn, so the
resident text at the entry to every step is the full core. Claude Code keeps
only the first 20,000 chars of it after a compaction.

Core (SKILL.md): 221,764 chars

| Doc                                       | Chars  |
| ----------------------------------------- | ------ |
| references/merge-resolver-spawn-prompt.md | 2,656  |
| references/partial-result-continuation.md | 4,572  |
| references/redirect-handling.md           | 52,589 |
| references/blind-survey.md                | 13,691 |
| references/headless-claude.md             | 8,231  |
| references/failure-recovery.md            | 51,732 |
| references/step3-threading.md             | 31,709 |
| references/model-routing.md               | 12,564 |
| references/ui-smoke-pass.md               | 29,433 |
| references/interview-playbook.md          | 19,114 |
| references/auto-merge-rubric.md           | 17,582 |
| references/pause-output-contract.md       | 23,600 |
| references/prompt-sanity.md               | 6,102  |
| references/skill-overlay.md               | 6,794  |
| references/solution-fit.md                | 2,266  |
| references/polling-protocol.md            | 48,095 |

| Resident text at entry to step | Chars   |
| ------------------------------ | ------- |
| 0                              | 221,764 |
| 1                              | 221,764 |
| 2                              | 221,764 |
| 3                              | 221,764 |
| 4                              | 221,764 |
| 5                              | 221,764 |
| 6                              | 221,764 |
| 7                              | 221,764 |
| 8                              | 221,764 |
| 9                              | 221,764 |
| 10                             | 221,764 |
| 11                             | 221,764 |
| 5.5                            | 221,764 |

Largest sections by their own text (a section's size stops at its first
sub-heading), from `sectionSizes` in `discovery-payload-parse.ts`:

| Section (top 12 by size)      | Chars  |
| ----------------------------- | ------ |
| ## Step 3 — Plan              | 33,964 |
| # Hard rules                  | 18,509 |
| ## Step 7 — CI + Copilot wait | 17,191 |
| ## Step 9 — Auto-merge gate   | 16,231 |
| # Resume mode                 | 14,191 |
| ## Step 5 — Implement         | 8,424  |
| ## Step 8 — Review            | 6,709  |
| ## Step 11 — Local follow-ups | 6,335  |
| ## Step 10 — Merge            | 5,572  |
| ## Step 6 — Local verify      | 5,452  |
| ## Step 4 — Approval handling | 4,819  |
| # Failure paths               | 4,415  |
