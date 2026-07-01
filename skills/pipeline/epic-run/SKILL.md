---
name: epic-run
description: >-
  Supervisor skill for the epic-orchestrator run phase. Drives one epic toward
  completion inside a single Claude Code session spawned by `flow epic run
  <slug>`: it ticks the deterministic LLM-free reconciler and applies
  event-driven judgment ONLY on a halt or deadlock event — interpreting a halted
  child feature into retry / redirect / escalate and diagnosing a frontier-empty
  deadlock with a probable cause. Use ONLY when invoked by that seed prompt or
  via an explicit `/epic-run`. It never merges a feature PR, never overrides a
  gated verdict, and never authors code in v1. One long-running supervisor turn,
  not a sub-agent.
argument-hint: "<epic-slug>"
---

# Goal

You are the supervisor of one tmux window's **epic-run** pipeline. The user
typed `flow epic run <slug>` from a terminal; tmux opened a window, launched
Claude Code in it, and seeded this chat with a prompt that invokes you. From
here you drive the epic toward completion by **ticking the deterministic
reconciler** — `flow epic run <slug> --once --json` — and applying **LLM
judgment only on an event** (a halted child feature or a DAG deadlock), never on
a green tick. The deterministic reconciler stays the load-bearing, testable
core; you sit **alongside/above** it, interpreting its output and deciding the
next move, so an epic advances with less human babysitting.

This is a different supervisor session from `/flow-pipeline`, and a sibling of
`/epic-create`. `flow epic run <slug>` (default, judgment on) spawns a fresh
top-level `/epic-run` session, so `/flow-pipeline`'s exactly-9 Task-tool
exemptions / two-`AskUserQuestion`-forms invariants are **unaffected** — a
different supervisor in a different window is a different session. In v1 you
spawn **no** Task-tool fan-out and fire **no** `AskUserQuestion` form: you
reason in-process over the deterministically-bounded evidence the
`flow-epic-judge-context` helper assembles.

# When to use

You are invoked by the `flow epic run <slug>` seed prompt, which begins with the
literal prefix:

```
Use the /epic-run skill for: <slug>

EPIC_DIR: .flow/epics/<slug>
```

`flow epic run <slug>` (default path: judgment on, no `--once`, no
`--no-judgment`) writes that prompt; nothing else does. Capture the `<slug>`
after `for:` and the literal `EPIC_DIR` on its own line.

## EPIC_DIR comes from the seed prompt (R1 — never import `bin/lib`)

The CLI (`flow epic run`) is the SOLE evaluator of the epic path contract. It
embeds the resolved **literal** `EPIC_DIR` (e.g. `.flow/epics/<slug>`) on its
own line in the seed prompt. You run cwd'd in a **consumer worktree** where
flow's `bin/lib/*` does NOT exist, so you must **NEVER `import` `bin/lib`** —
that import fails here. Consume the literal `EPIC_DIR` + the **bare-name PATH
helpers** only:

- `flow-epic-judge-context` — the deterministic judgment-context helper (the
  bounded evidence assembler + the run-state recorder).
- `flow new --resume <feature-slug> --force` — the sanctioned retry actuator.
- `flow-notify` — the escalation notifier.
- `jq` — JSON field extraction.

# Hard invariants (read before doing anything)

These are byte-exact, load-bearing, and lint-anchored. You must:

- **`gated ⇒ escalate-only, never override`.** A child feature in `gated` is
  escalate-only. You may interpret _why_ it is gated and what the human should
  do, but you can **never** clear it — a `gated` verdict is terminal, not
  advisory (AGENTS.md hard rule). `gated ⇒ escalate-only`, full stop.
- **Never merge a feature PR.** Merging a feature is the feature pipeline's own
  job behind its own auto-merge gate; the orchestrator never `gh pr merge`s a
  child.
- **Never override a gated verdict.** Even with a clear retry signal, a `gated`
  feature is escalated, never retried-with-an-override and never merged.
- **Never `send-keys` into a feature window.** Retry actuates via a clean
  respawn (`flow new --resume … --force`), never by typing into a live pane.
- **No autonomous redirect / no authored code in v1.** You never author a new
  `flow new` description, never relaunch a feature with an LLM-changed approach,
  and never edit code. `redirect` is actuated as
  **escalate-with-a-suggested-redirect** for the human to apply.

# The tick loop

**On FIRST entry**, stamp the runner marker so the window-launch `consumed()`
predicate (the CLI keys its launch verification on `runnerPhase` advancing to
`running`) is satisfied:

```bash
flow-epic-judge-context record --slug <slug> --runner-phase running
```

Then drive the epic by ticking the deterministic primitive. Each tick:

```bash
TICK=$(flow epic run <slug> --once --json)
EVENT=$(printf '%s' "$TICK" | jq -r '.event.kind')
```

`flow epic run <slug> --once --json` runs **one** deterministic reconcile tick —
it classifies the board, launches the capped ready frontier as parallel `flow
new` windows (the reconciler's existing job, unchanged), and emits a single JSON
object carrying `board`, `summary`, `epicStatus`, `toLaunch`, and the `event`
classification (`green` | `halt` | `deadlock` | `done`). Branch on `.event.kind`.

## green — continue ticking, NO judgment

In-flight / ready work, nothing halted. Apply **no** judgment. Sleep briefly,
re-tick. This is the common case and must stay LLM-free per tick.

## halt(ids) — interpret each halted feature

`.event.haltedIds` lists the halted child features (`gated` / `needs-human` /
CI-failure-surfaced-as-`needs-human` / `orphan`). For **each** halted id, gather
the bounded evidence and reason in-process:

```bash
flow-epic-judge-context context --slug <slug> --feature <id>
```

This returns the feature `state.json`, a tail-bounded CI-failure log, the PR
review state, the manifest dependency neighbourhood, `retryCount`, and the
derived flags `overridable` (`false` for a `gated` feature) and
`budgetExhausted` (`retryCount >= epic.maxRetries`). Reason over that evidence
and decide **retry** | **redirect** | **escalate**:

- **RETRY** — only when **NOT** `budgetExhausted` AND the failure looks
  recoverable / transient (a flaky CI run, a fixable `needs-human`). Actuate:

  ```bash
  flow-epic-judge-context record --slug <slug> --feature <id> \
    --action retry --reason "<one-line interpreted reason>" --increment-retry
  flow new --resume <feature-slug> --force
  ```

  The `--force` reclaims the live-idle feature pane via a clean respawn — never
  `send-keys`.

- **ESCALATE** — when `budgetExhausted` OR `overridable:false` (a `gated`
  feature: `gated ⇒ escalate-only, never override`) OR the failure is
  non-recoverable. Actuate:

  ```bash
  flow-epic-judge-context record --slug <slug> --feature <id> \
    --action escalate --reason "<interpreted reason>"
  flow-notify "epic <slug>: <id> escalated — <reason>"
  ```

  Halt only that subtree (the reconciler's existing behaviour: a halted feature
  withholds only its dependents while independent ready branches keep launching).

- **REDIRECT** — actuated as **escalate-with-a-suggested-redirect** in v1
  (record + `flow-notify` + render the suggested redirect to scrollback). NO
  autonomous relaunch, NO LLM-authored new approach — the human applies it.

## escalate-on-exhaustion contract

**escalate-on-exhaustion**: when a feature's `retryCount` has reached the budget
(`budgetExhausted:true`), the judgment layer escalates instead of retrying. This
is the bounded-retry guardrail — it mirrors the deterministic
`LAUNCH_STALL_BUDGET` so an over-eager judged retry can never churn feature
windows and burn quota against a non-recoverable failure. The budget is
`epic.maxRetries` (default 2); a `--increment-retry` retry that crosses it makes
the next halt escalate.

## deadlock — diagnose a probable cause

`epicStatus === "blocked"` with NO halted blockers and not all merged (the
frontier is empty but the epic is not done). Gather the deadlock evidence:

```bash
flow-epic-judge-context context --slug <slug> --deadlock
```

This returns the board, run-state, per-feature manifest neighbourhoods, and a
`manifestDrift` flag. Reason over it to name a **probable cause** (e.g. an
`orphan` / stuck-non-terminal feature, a silently-cancelled dependency, manifest
↔ run-state SHA drift) **plus a suggested resolution** — never the generic
"frontier empty" message alone. Then **escalate-with-context**: set
`runnerPhase` blocked, fire `flow-notify`, and render the reasoning to
scrollback.

```bash
flow-epic-judge-context record --slug <slug> --runner-phase blocked
flow-notify "epic <slug>: deadlock — <probable cause>"
```

## done — render completion and end

All features merged. Render the completion summary, set `runnerPhase` done, run
resource cleanup, and **END the turn**:

```bash
flow-epic-judge-context record --slug <slug> --runner-phase done
```

# Resume mode

`flow epic run <slug>` is **idempotent and resumable by construction**: the
deterministic reconciler rebuilds its view from the committed
`.flow/epics/<slug>/manifest.json` (read-only) + each feature's
`~/.flow/state/<slug>.json` + the epic `run.json` on every tick. A crashed
`/epic-run` session re-launched in its window simply re-stamps the runner marker
and re-enters the tick loop from the current on-disk board — there is no
approval to replay and no PR to re-open (the orchestrator opens none). Print
`RESUMING AT: tick-loop` on its own line before re-entering so the user reading
scrollback can confirm, then continue ticking.

## What this supervisor does NOT do

- It does **not merge** a feature PR — ever, on the fresh path or the resume
  path.
- It does **not override** a gated verdict — `gated ⇒ escalate-only`.
- It does **not `send-keys`** into a feature window — retry is a clean respawn.
- It does **not author code** or an autonomous redirect in v1.
- It does **not** change `reconcile()` / the DAG frontier — it CONSUMES the
  deterministic tick's JSON output only.

# Resource cleanup

The only resources this supervisor spawns are the per-feature `flow new` windows
the deterministic reconciler launches — and those are **owned by their own
pipelines**, which clean up their own worktrees on merge. The orchestrator never
opens a worktree of its own and writes only the per-machine `run.json` (a
recomputable cache that can be removed by hand). On `done` / `deadlock`, render
the terminal state and end the turn; leave the feature windows and their state
in place for their own pipelines. The markdown manifest + `~/.flow` JSON remain
the only store — no DB.
