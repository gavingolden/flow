# Partial-result continuation contract

Shared contract for every exemption spawn site that owns a `maxTurns`-
budgeted agent. This is a bounded `SendMessage` continuation **inside**
the owning exemption's Task-tool call — never an eighth Task-tool site
(`AGENTS.md`'s "seven" count and the seven-site "Load the Task tool
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
3. The site's own existence check (`test -s "$ARTIFACT_PATH"`) finds the
   artifact **missing**.

On Claude Code < 2.1.246 no partial marker appears, so this branch never
fires and the site falls straight through to its existing missing-
artifact handling — unchanged behavior on older installs.

## Continuation procedure

1. Load `SendMessage` via `ToolSearch query="select:SendMessage"` before
   calling it, mirroring the Task-tool load guard at each of the seven
   spawn sites.
2. Send **exactly one** message to the recovered `agentId`:

   ```
   You stopped at your turn budget. Do not restart. Write the artifact
   at $ARTIFACT_PATH now from your current state, using only the
   terminal values your own artifact schema defines (e.g. `succeeded` /
   `failed` / `skipped` for the merge-resolver's `push_status` — never an
   ad hoc value like "partial" or "exhausted" that Step 10 or the
   consuming wrapper doesn't handle; pick whichever defined value is most
   honest about how far you got), then return your both-sides summary.
   ```

3. Re-run the existence check once. Where the site has a schema
   validator (`flow-fix-applier-schema`, `flow-agent-finding-schema`, or
   a `jq -e '.verify_status'` shape check), run it too — an invalid
   artifact counts as missing, same as an absent one. This step never
   loops: one continuation, one re-check, done.
4. **Still missing or invalid** → fall through to the site's existing
   missing-artifact handling: each of the seven top-level exemption
   sites escalates its own named `NEEDS HUMAN: <site>-missing-artifact`
   tag exactly as it would without this branch.
5. **A partial result WITH a valid artifact** is consumed normally; the
   partial marker is informational only and does not itself trigger a
   continuation.

## Scope note

This file is referenced by every exemption whose agent carries a
`maxTurns` pin (Fix-Applier, Merge-Conflict Resolver, Edit-Applier) and
by the pause-points in `flow-pipeline/SKILL.md` step 6 and step 10,
`flow-pr-review/SKILL.md` Step 8, and
`flow-coder/SKILL.md` step 4. It documents one bounded behavior inside
each owning exemption — it does not create a new spawn site.
