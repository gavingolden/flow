# Safeguards-stop retry contract

Shared contract for `/flow-coder` and `/flow-pr-review`: what to do when a
spawned agent is stopped by Anthropic safeguards. The retry is a fresh spawn
**inside** the owning exemption (the Edit-Applier exemption, or the
Multi-Agent Review exemption) — never a ninth Task-tool site.

## Why

Starting 2026-11-04 some econ-data sub-agents were stopped because a
roughly 110 KB markdown-table alignment padding in one rules file reached
their context (read directly, or attached automatically through `paths:`
frontmatter). The measurement and what stays inconclusive are in
[`docs/eval/safeguards-stop-bisection-2026-11.md`](../../../../docs/eval/safeguards-stop-bisection-2026-11.md).
A stopped agent writes no artifact, so without a bounded retry the whole
phase escalates for a cause the owner cannot see.

## Detection

When a Task result reports a failure, write its text to
`.flow-tmp/safeguards-stop-<site>.txt` and run
`flow-safeguards parse --text-file .flow-tmp/safeguards-stop-<site>.txt`.
Only `{"stopped":true,...}` enters this path; anything else keeps today's
handling (including the
[partial-result continuation](partial-result-continuation.md)).

## The bound

The wrapper makes **at most one safeguards re-spawn** per agent per invocation. It is a fresh
spawn, never a `SendMessage` continuation: the stopped context still holds the
flagged content, and the harness's own same-context retry already failed. The
wrapper never does the agent's work itself. Never re-send identical input —
repeated flags count toward account-level filtering. Switching between Claude
models (Sonnet and Opus) is not an option: both stopped on the same content;
the only model change is the lens's Gemini route below.

## Coder shape (`/flow-coder`)

1. Move the partial `coder-result.json` aside to `coder-result.first.json`.
2. `flow-safeguards retry-set --edit-set <edit-set> --partial-result
<first.json> --out <retry-edit-set>` writes the entries still to do, without
   `skill_docs` and with already-applied entries removed.
3. Spawn one fresh edit-applier with the unchanged spawn template rendered over
   the retry edit set.
4. `flow-safeguards retry-set --merge --first <first.json> --second
<result.json> --out <result.json>` merges the two artifacts.
5. Record the outcome (below). A second stop writes no artifact and records
   `stopped-again`; the caller escalates `coder-safeguards-stop`.

## Lens shape (`/flow-pr-review`)

`flow-safeguards lens-retry-plan --lens <lens> --out-dir .flow-tmp/guidance
[--agy-available] <inputs...>` force-collapses the lens inputs and returns a
route:

- `respawn` — the inputs changed, so one fresh Task spawn over the collapsed
  copies is a different request. Map copy paths back with
  `flow-safeguards map-paths` before the consolidator (it only rewrites
  `agent-output-*.json` under the worktree).
- `delegated` — run the lens on Gemini with
  `flow-agy-lenses --force-route safeguards-retry --lenses <lens>`. The helper
  re-checks `review.gemini == true` (and honours a live Google-plan cooldown):
  a lens it returns in `fallback` becomes a skip record, never a Task spawn,
  because that Task would re-send the input that was just flagged.
- `skip` — nothing differs and no other model family is available; write the
  skip record. Never a same-input re-send.

A lens still stopped (or skipped) gets `.flow-tmp/lens-skip-<lens>.json`
(`{ lens, reason, request_ids, model }`); mandatory lenses additionally get a
DECISION Test Step via `flow-safeguards decision-items`. `intent-guess` is
never retried — only a `skipped` line is recorded.

## Recording and reporting

`flow-safeguards record --log $WORKTREE/.flow-tmp/safeguards-retries.jsonl
--json '<RetryRecord>'` appends one line per retry, skip or proactive
collapse. `/flow-pr-review` Step 11 appends `flow-safeguards note --log ...`
to the PR body (replacing any prior callout, so it is idempotent).

## The source fix

When a record names a padded file, run
`flow-safeguards compact --in-place <file>` in that repository and commit; the
retry layer then never fires for it again.
