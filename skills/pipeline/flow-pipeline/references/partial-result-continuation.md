# Partial-result continuation contract

Shared contract for every exemption spawn site that owns a `maxTurns`-
budgeted agent. This is a bounded `SendMessage` continuation **inside**
the owning exemption's Task-tool call — never a ninth Task-tool site
(`AGENTS.md`'s "eight" count and the nine-site "Load the Task tool
before spawning" suite are unaffected).

## When this branch fires

All three must hold:

1. The Task result is marked **partial** — on Claude Code ≥ 2.1.246 a
   partial result carries the line `NOTE: this agent stopped at its
<N>-turn limit before finishing` and an `agentId: <id>` line (measured
   verdict recorded in `docs/subagent-features-probe.md`'s
   `max-turns-partial` probe).
2. The result carries a recoverable **agent id** (the `agentId: <id>`
   line above).
3. The site's own completeness check finds the artifact **missing, OR
   present with `status: "partial"`** (not merely `test -s`).

On Claude Code < 2.1.246 no partial marker appears, so this branch never
fires and the site falls straight through to its existing missing-
artifact handling — unchanged behavior on older installs.

## Continuation procedure

1. Load `SendMessage` via `ToolSearch query="select:SendMessage"` before
   calling it, mirroring the Task-tool load guard at each of the nine
   spawn sites.
2. Send **exactly one** message to the recovered `agentId`:

   ```
   You stopped at your turn budget and now have a fresh one. Do not
   restart. Inspect each remaining file before editing and skip any
   change already present on disk. finish the remaining entries in
   order, refresh the checkpoint after each, run verify, then write the
   artifact at $ARTIFACT_PATH with `status: "complete"`, using only the
   terminal values your own artifact schema defines (e.g. `succeeded` /
   `failed` / `skipped` for the merge-resolver's `push_status` — never an
   ad hoc value like "partial" or "exhausted" that Step 10 or the
   consuming wrapper doesn't handle; pick whichever defined value is most
   honest about how far you got), then return your both-sides summary.
   ```

3. Re-run the completeness check once. Where the site has a schema
   validator (`flow-fix-applier-schema`, `flow-agent-finding-schema`, or
   a `jq -e '.verify_status'` shape check), run it too — an invalid
   artifact counts as missing, same as an absent one. This step never
   loops: one continuation, one re-check, done.
4. **Still missing, invalid, or `status: "partial"`** → fall through to
   the site's existing missing-artifact handling: each of the eight
   top-level exemption sites escalates its own named
   `NEEDS HUMAN: <site>-missing-artifact` tag exactly as it would
   without this branch.
5. **A partial result WITH a `status: "complete"` valid artifact** is
   consumed normally; the partial marker is informational only and does
   not itself trigger a continuation.

## Stall branch

A Task result whose failure reads `Agent stalled: no progress for 600s
(stream watchdog did not recover)` gets exactly ONE `SendMessage` resume
attempt (same message as above). If refused, or the artifact is still
not `status: "complete"` afterward, consume the partial artifact and
route never-started entries through loss accounting (`flow-untracked
add`) — never finish the work inline. Then run `flow-pre-commit --json`
once: a red tree with never-started entries escalates
`NEEDS HUMAN: <site>-partial-tree-red`; a green tree proceeds.

## Scope note

This file is referenced by every exemption whose agent carries a
`maxTurns` pin (Fix-Applier, Merge-Conflict Resolver, Edit-Applier) and
by the pause-points in `flow-pipeline/SKILL.md` step 6 and step 10,
`flow-pr-review/SKILL.md` Step 8, and
`flow-coder/SKILL.md` step 4. It documents one bounded behavior inside
each owning exemption — it does not create a new spawn site. The
completeness check (missing, OR present with `status: "partial"`) is the
shared predicate every referencing site uses, not a bare `test -s`.
