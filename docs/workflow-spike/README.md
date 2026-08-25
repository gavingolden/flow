# Workflow-runtime spike (f5-workflow-spike)

Throwaway spike for epic `modernize-flow-s-supervisor-architecture` feature
`f5-workflow-spike`. It exercises the four capabilities the steps-5–10 port
(`f6`) depends on against the Claude Code dynamic-workflow runtime (docs:
https://code.claude.com/docs/en/workflows.md), and the verdict is recorded in
the ADR at `docs/workflow-spike/adr.md`. Nothing under this directory is
installed or shipped — `flow install` only discovers `bin/*.ts`; `docs/` is
never scanned.

## Files

- [probe-capabilities.workflow.js](./probe-capabilities.workflow.js) —
  capabilities 1, 2a, 2b, 3.
- [probe-resume.workflow.js](./probe-resume.workflow.js) — capabilities 4a,
  4b.
- [probe-invalid-agent.workflow.js](./probe-invalid-agent.workflow.js) —
  negative registry probe.
- `evidence/` (created by the runbook below) — the raw captured outputs of
  each launch.

## Preconditions

1. Run from the `/flow-pipeline` supervisor session (the `Workflow` tool is a
   session tool; CI installs no `claude`; the session must have been launched
   by `flow feature create` so the plugin root `flow-module-core` is loaded
   via `--plugin-dir`).
2. Confirm `printenv CLAUDE_CODE_SUBAGENT_MODEL` prints nothing — it
   overrides every frontmatter model pin.
3. Confirm `command -v flow-gate-decide flow-state-update` both resolve
   under `~/.local/bin`.
4. Create the scratch state with an explicit allowlist:

   ```sh
   jq '{slug: "zz-spike-wf-scratch", phase, repo, updatedAt, phaseLog: []}' \
     ~/.flow/state/f5-workflow-spike.json > ~/.flow/state/zz-spike-wf-scratch.json
   ```

   This is an allowlist, not a copy, because carrying more fields over would
   corrupt the probes: `autoMerge:false` would force `flow-gate-decide` to
   `gated` regardless of the PR's real state; `epic` would make epic helpers
   treat the scratch slug as an `f5` member; `pid`/`procStartedAt`/`worktree`
   would couple the scratch state to the live pipeline process. `phase` must
   stay non-terminal and must not be `starting` (`flow ls` reaps `starting`
   orphans on every invocation).

5. Pick an open PR for the read-only gate probe (at authoring time #674) and
   record its before-state:

   ```sh
   gh pr view 674 --json state,mergedAt > docs/workflow-spike/evidence/gate-before-after.txt
   ```

6. Reset the marker files:

   ```sh
   mkdir -p <worktree>/.flow-tmp
   rm -f <worktree>/.flow-tmp/spike-phase-a.done <worktree>/.flow-tmp/spike-release-b
   ```

7. Generate a nonce: `NONCE=f5spike-$(date -u +%Y%m%dT%H%M%SZ)`.
8. Every helper call inside the scripts carries both `FLOW_SLUG=zz-spike-wf-scratch`
   and `--slug zz-spike-wf-scratch`, because the supervisor session exports
   `FLOW_SLUG=f5-workflow-spike` — an unqualified call would silently advance
   the LIVE pipeline's state.

## Launches

Each launch's `Workflow` tool input has the shape:

```json
{
  "scriptPath": "<abs worktree>/docs/workflow-spike/<script>",
  "args": {
    "pr": 674,
    "scratchSlug": "zz-spike-wf-scratch",
    "worktree": "<abs worktree>",
    "nonce": "<NONCE>"
  }
}
```

1. **`probe-invalid-agent`** (run first — cheapest, and settles registry
   resolution before spending budget on the other probes). Capture the
   completion as `evidence/run-4-invalid-agent.json` (numbering follows the
   plan's capability order, not launch order).
2. **`probe-capabilities`**. Capture the return value verbatim as
   `evidence/run-1-capabilities.json`, and note the script path the tool
   reports into `evidence/script-path.txt`.
3. **`probe-resume`, interrupt + resume:**
   - Start it.
   - Poll for phase A's marker (Bash, timeout ≤ 600000 ms):
     `until [ -f <worktree>/.flow-tmp/spike-phase-a.done ]; do sleep 2; done`.
   - Confirm phase B has started (it blocks on `spike-release-b`).
   - Call `TaskStop` on the workflow task id. Record `evidence/run-2-interrupt.json`
     (the stop result, the task id, and the run id) and
     `jq .phaseLog ~/.flow/state/zz-spike-wf-scratch.json` as `afterRun2Interrupt`.
   - Relaunch the SAME `scriptPath` + `args` with `resumeFromRunId: "<runId>"`.
   - Once it is running, `touch <worktree>/.flow-tmp/spike-release-b`.
   - Capture the completion as `evidence/run-2-resume.json` and the phaseLog
     as `afterRun2Resume`. Expect exactly ONE `verifying` entry (phase A
     served from cache, never re-executed) and one `ci-wait` entry.
4. **`probe-resume` again, WITHOUT `resumeFromRunId`** (a fresh run).
   Capture the completion as `evidence/run-3-fresh.json`; expect
   `ran: {a:false,b:false}` and the phaseLog unchanged (`afterRun3`) — the
   state.json-keyed skip is the cross-session anchor.

Also write `evidence/phaselog.json` as
`{ afterRun2Interrupt, afterRun2Resume, afterRun3 }`.

## Locating agent transcripts

After the runs: `grep -rl "<NONCE>" ~/.claude/projects/ --include='*.jsonl'`
lists every workflow-spawned agent's transcript (`sub-agents.md` documents
`<sessionId>/subagents/agent-<id>.jsonl`; the nonce grep tolerates a
different layout). For each transcript file:

- `grep -o '"model":"[^"]*"' <file> | sort -u`
- `grep -oE '"(effort|thinking)"[^,}]*' <file> | sort -u`
- `grep -o '"name":"[A-Za-z_]*"' <file> | sort | uniq -c` (tool_use names)

Write one line per transcript into `evidence/models.txt`:
`<label> <file basename> <model> <effort-field-or-none> <tools>`.

Expected: the gatekeeper probe resolves to a haiku model id, the control
resolves to the session model, the fix-applier probe resolves to the session
model, and the bug-detection transcript shows no `Bash` tool_use.

## Teardown

```sh
rm -f ~/.flow/state/zz-spike-wf-scratch.json
rm -f <worktree>/.flow-tmp/spike-phase-a.done <worktree>/.flow-tmp/spike-release-b
gh pr view 674 --json state,mergedAt >> docs/workflow-spike/evidence/gate-before-after.txt
npx prettier --write docs/workflow-spike/evidence
test ! -e ~/.flow/state/zz-spike-wf-scratch.json
```

The re-recorded `gh pr view` output must be byte-identical to the
before-state captured in Preconditions step 5. `npx prettier --write` only
reflows `jq` output's whitespace; evidence content is untouched.

Note: the `Workflow` tool persists each run's script under the session
directory in `~/.claude/projects/`, not in the worktree. If a
`.claude/workflows/` directory appears in the worktree, remove it —
`docs/workflow-spike/` is the only committed surface.

## Evidence files

| File                       | Holds                                                        |
| -------------------------- | ------------------------------------------------------------ |
| `run-1-capabilities.json`  | `probe-capabilities`'s return value.                         |
| `run-2-interrupt.json`     | The `TaskStop` result, task id, and run id.                  |
| `run-2-resume.json`        | The resumed `probe-resume` run's completion.                 |
| `run-3-fresh.json`         | The fresh (non-resumed) `probe-resume` run's completion.     |
| `run-4-invalid-agent.json` | `probe-invalid-agent`'s return value.                        |
| `models.txt`               | Per-transcript model/effort/tool_use greps.                  |
| `phaselog.json`            | `{ afterRun2Interrupt, afterRun2Resume, afterRun3 }`.        |
| `gate-before-after.txt`    | `gh pr view` output before and after the spike (must match). |
| `env-precheck.txt`         | The Preconditions env checks (subagent model, helper paths). |
| `script-path.txt`          | The script path the `Workflow` tool reported for launch 2.   |
