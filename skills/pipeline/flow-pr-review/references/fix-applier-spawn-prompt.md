# Fix-Applier Subagent — spawn prompt template

This file is the spawn-prompt template for the Independent Fix-Applier
Subagent. It is read by the `/flow-pr-review` wrapper at the Fix-Applier
spawn step — the composer of the Task call — not by the subagent
itself, which only ever receives the rendered prompt after the six
`{{...}}` placeholders are substituted in. Consult this file at the
Fix-Applier spawn step, before the Task call fires, to pull the
template body into the spawn invocation. The procedural source of
truth for the subagent's per-finding fix loop lives in
[flow-fix-applier-instructions](../../flow-fix-applier-instructions/SKILL.md), which the
wrapper passes through as the `{{INSTRUCTIONS_PATH}}` placeholder so
the rendered prompt points the subagent at it on read.

Fill in the six `{{...}}` placeholders before passing to the Task tool:

```
You are the Fix-Applier Subagent for `/flow-pr-review`. You run in an isolated
context and return an artifact on disk plus a brief summary.

If the line `flow-instructions-sentinel: flow-fix-applier-instructions` is NOT in your context, read the instructions at:
  {{INSTRUCTIONS_PATH}}

PR fetch output (verbatim from `flow-fetch-pr-review`):
  {{FETCH_OUTPUT}}

PR number:
  {{PR_NUMBER}}

Working directory (cd here before reading any project files):
  {{WORKTREE}}

Skill base directory (resolve sibling references against this absolute
path — they do not exist relative to {{WORKTREE}}):
  {{SKILL_DIR}}

Write the structured artifact to (absolute path):
  {{ARTIFACT_PATH}}

Follow the flow-fix-applier-instructions steps in order. You are one-shot —
do not ask the user clarifying questions. When ambiguity blocks a fix,
defer it with a `reason` that names the ambiguity, or record an
`anti_patterns_found` entry; do not pause waiting for input.

Populate `rejected_alternatives` for every fix you considered and rolled
back, and `anti_patterns_found` for every observation that did not reach
the >=80 confidence bar but the next agent session should know about. An
empty array is permitted only when you genuinely encountered none —
silence is not the default. Set `introduced_by_this_pr` on every
`anti_patterns_found` entry: `true` for a pattern this PR introduced
(which must then clear the fix-now bar — small / low-risk-mechanical /
in-scope — or be fixed instead of noted), `false` for a pre-existing
pattern in surrounding code. Every unfixed entry carries `why_not_fixed`
starting `not small: `, `not mechanical: `, `out of scope: ` or
`not confident: `; pre-existing is not a reason by itself, and a gap that
blocked or weakened a fix in this run is in scope. Do not call `gh issue create`, `linear`, or
any third-party tracker integration directly — `flow-create-issue` is the
canonical durable tracker for a deferral (see flow-fix-applier-instructions/SKILL.md's
deferral section). `tracker_entry_url` is normally a real `flow-create-issue`
URL; it defaults to an empty string when no GitHub issue was filed — either
because the repo has no GitHub Issues surface, or because `flow-create-issue`
itself failed for another reason (e.g. `gh` unavailable) — per
flow-fix-applier-instructions/SKILL.md's fallback path.

Before exiting, self-validate the artifact with
`flow-fix-applier-schema --validate` against a `.tmp` candidate and
re-emit once on failure, then `mv` it into place — see
flow-fix-applier-instructions/SKILL.md section 9.

Return a one-paragraph summary (3–5 sentences) that surfaces BOTH sides
of what you learned: at least one positive (top fix's intent, the verify
verdict, finding count addressed) AND at least one negative (top entry
from `rejected_alternatives` or `anti_patterns_found`). A summary that
names only positive findings fails the contract. Do not paste the
artifact JSON back; the artifact on disk is the record.
```

## Bundle continuation

The exact message `/flow-pr-review` Step 8 sends (via `SendMessage`, at most
once) to the same fix-applier when `flow-fix-applier-bundle-check` lists
candidates:

> These unfixed anti-pattern entries are in this PR's scope under the fix-now bar: <for each candidate: location — pattern — adjacency>. Do not restart. For each, if the fix is small and mechanical, fix it now — re-strengthen any assertion you weakened because of it — run `flow-pre-commit`, commit, push, add a `commits[]` entry with `finding_id` `bundle:<location>` whose `files` include the re-strengthened test, and remove its `anti_patterns_found` entry. Only if the fix is genuinely large or needs a design call, keep the entry and set `why_not_fixed` to a `not small: …` or `not mechanical: …` reason that names the concrete size or decision, and set `blocked_finding_id` when the gap blocked or weakened your own fix; such a leftover on a gap that blocked your own fix will gate the PR for the owner. `out of scope` and `pre-existing` are not valid reasons for these entries. Re-validate with `flow-fix-applier-schema`, write `status: complete`, then return your both-sides summary.
