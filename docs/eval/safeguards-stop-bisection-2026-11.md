# Safeguards-stop bisection, November 2026

Issue #1050: from 2026-11-04 some sub-agents spawned by flow in the econ-data
repository were stopped by Anthropic safeguards ("Agent terminated early due to
an API error ... safeguards flagged this message"). This note records what the
local transcripts show about the trigger.

## Method

Retrospective analysis of local Claude Code transcripts, with no live
re-triggering: repeated flags risk account-level filtering (see
<https://support.claude.com/en/articles/8106465>). Each sub-agent transcript is
one run. A run is "padded" when its text contains a run of 1,000 or more
repeated spaces or dashes, and "stopped" when it ends with the safeguards
failure text. The counts come from `scripts/safeguards-audit.ts`.

## Results

Two windows, split at 2026-11-04. Counts are the audit's output, run on
2026-11-10 over every econ-data subagent transcript since 2026-10-01. A run
counts as stopped only when the agent's own transcript ends in a safeguards
API-error entry; a transcript that merely quotes the error is not a stop.

| Window                   | Runs | Padded | Stopped |
| ------------------------ | ---- | ------ | ------- |
| 2026-10-01 to 2026-11-03 | 741  | 107    | 0       |
| 2026-11-04 to 2026-11-10 | 679  | 82     | 19      |

All 19 stops were padded runs; none of the 597 unpadded runs in the second
window stopped. The hit rate given padding is 19 of 82 (23%). By agent type:
pattern-consistency lens 8 of 20 padded runs, edit-applier 5 of 30, all
others 6 of 32. In all 19 stops the padding first entered the agent's context
through a tool result (a file read, or the PR diff), not through Claude Code's
injected rule content.

## Trigger file

econ-data `.claude/rules/ci-parity.md`: 138,429 bytes, of which about 110 KB is
markdown-table alignment padding (27,773 bytes once collapsed). It carries
`paths:` frontmatter (`.github/workflows/**`, `.github/dependabot.yml`,
`.githooks/**`, smoke and offline tests), so Claude Code also attaches it
automatically whenever an agent reads or edits a matching file. Six of the 19
stops came during the review of PR #1144, which edited that file.

## Ruled out

- econ-data `AGENTS.md`: unpadded, and present in all 597 unpadded, unstopped runs.
- flow's own skill docs: present in stopped and unstopped runs alike.

## Inconclusive

These points stay inconclusive after the analysis:

- The classifier mechanism.
- The inferred server-side change around 2026-11-04 (the file was unchanged,
  and there were 0 stops before that date).
- Why stripping `skill_docs` cleared the coder stops when `skill_docs` never
  contained `ci-parity.md` (likely fewer reads of path-matching files, or
  chance).
- Whether Claude Code's path-scoped rule loading can carry the file in
  shapes the audit does not see: the audit classifies padding found inside
  message blocks only, and found none arriving through injected rule content.
  The source fix covers that route either way.

## Remediation

- flow's two padded tables are collapsed, and `bin/guidance-padding.test.ts`
  keeps padding out of shipped guidance.
- `/flow-coder` and `/flow-pr-review` retry a safeguards stop at most once,
  with a fresh spawn over collapsed or stripped input (see
  `skills/pipeline/flow-pipeline/references/safeguards-stop-retry.md`).
- The owner runs `flow-safeguards compact --in-place .claude/rules/ci-parity.md`
  in econ-data to fix the source once.

## Re-run

```sh
bun scripts/safeguards-audit.ts --projects-dir ~/.claude/projects/-Users-gavingolden-code-me-econ-data --since 2026-11-04
```
