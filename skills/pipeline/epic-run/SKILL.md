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
  gated verdict, and never authors feature code. One long-running supervisor
  turn, not a sub-agent.
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
different supervisor in a different window is a different session. You spawn
**one** sanctioned judgment sub-agent per halt/deadlock event (a named
`/epic-run`-session Task surface — see below) so the large tail-bounded
CI-failure log lands in the sub-agent's isolated context, not this
long-running supervisor's, while still firing **no** `AskUserQuestion` form.
The sub-agent DECIDES over the deterministically-bounded evidence the
`flow-epic-judge-context` helper assembles; this supervisor ACTUATES.

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
  bounded evidence assembler + the run-state recorder, including the
  `record --action redirect --relaunch-slug <newslug>` repoint).
- `flow new --resume <feature-slug> --force` — the sanctioned retry actuator.
- `flow new "<changed-approach description>"` — the sanctioned redirect
  actuator (a fresh pipeline for the changed approach).
- `flow-notify` — the escalation / redirect notifier.
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
- **Autonomous redirect is gated, bounded, and never fires on a gated feature.**
  When the `AUTO_REDIRECT: on` seed line is present (default-on; opt out per run
  with `flow epic run --no-auto-redirect` or globally with `epic.autoRedirect:
false`), a `redirect` judgment for a **non-gated**, non-`redirectExhausted`
  feature IS actuated autonomously: you author the changed-approach `flow new`
  **description** inline and relaunch the feature (see the REDIRECT branch).
  Authoring that description inline is **not** authoring feature code, and it
  spawns **no** Task/Agent fan-out — the zero-exemption invariant holds; you
  never edit feature code. The redirect budget is `epic.maxRedirects` (default
  1); once `redirectExhausted` (`redirectCount >= epic.maxRedirects`), or when
  `AUTO_REDIRECT: off`, or the feature is `gated`, you fall back to the
  unchanged v1 **escalate-with-a-suggested-redirect** path. **Redirect never
  fires on a gated feature** (a corollary of `gated ⇒ escalate-only`).

# Named Task surface: judgment sub-agent

**Task-tool fan-out: /epic-run → judgment sub-agent (per halt/deadlock event).**
On each halt or deadlock event you spawn **one** one-shot judgment sub-agent to
DECIDE the interpretation, so the large tail-bounded CI-failure log lands in the
sub-agent's isolated context rather than accumulating in this long-running
supervisor's transcript. This is a separate `/epic-run`-session surface, **NOT**
a tenth `/flow-pipeline` exemption — `/flow-pipeline`'s exactly-9 Task-tool
exemptions / two-`AskUserQuestion`-forms invariants are untouched, because a
different supervisor in a different window is a different session.

**Load the Task tool before spawning.** In Claude Code sessions where neither
`Task` nor its alias `Agent` is surfaced top-level by the harness (both are
aliases of the same one-shot subagent-spawn primitive), the spawn silently
falls through to in-line execution unless the schema is loaded first. Before
each Task call, run `ToolSearch query="select:Task"` and confirm the response
contains either a `<function>{"name": "Task", ...}</function>` or a
`<function>{"name": "Agent", ...}</function>` line. If it does not, **do not
fall back to in-line reasoning** — that reintroduces the unbounded CI-log
context this surface exists to remove — escalate
`NEEDS HUMAN: task-tool-unavailable: epic-run-judgment` and exit.

The sub-agent DECIDES only (writes a typed decision artifact + returns a brief
summary); this supervisor ACTUATES and re-enforces every invariant. The
sub-agent's full contract lives in
[references/judgment-instructions.md](references/judgment-instructions.md).

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
CI-failure-surfaced-as-`needs-human` / `orphan`). For **each** halted id, the
**sub-agent DECIDES** and this **supervisor ACTUATES**. The bounded-evidence
read (`flow-epic-judge-context context …`) moves entirely into the sub-agent's
`references/judgment-instructions.md` so its tail-bounded CI-failure log never
lands here — it is NOT run inline, not even "for logging".

For **each** halted id:

1. **Load the Task tool** (the `ToolSearch query="select:Task"` guard from the
   `## Named Task surface: judgment sub-agent` section above; escalate
   `NEEDS HUMAN: task-tool-unavailable: epic-run-judgment` on a miss).
2. **Spawn exactly ONE** Task sub-agent to DECIDE:

   ```
   subagent_type: general-purpose
   description:   Judgment for /epic-run halt
   prompt: |
     Read references/judgment-instructions.md and follow it.
     slug: <slug>
     EPIC_DIR: <the literal EPIC_DIR from the seed prompt>
     MODE: halt <id>
     ARTIFACT_PATH: ~/.flow/epics/<slug>/judgment/epic-judgment-<id>.json
   ```

3. **Existence-check the artifact.** `test -s ~/.flow/epics/<slug>/judgment/epic-judgment-<id>.json`;
   on absence escalate `NEEDS HUMAN: epic-judgment-missing-artifact` and skip
   actuation for this id.
4. **Read the decision** via bare `jq` (`action`, `reason`, `flags.overridable`,
   `flags.budgetExhausted`, `flags.redirectExhausted`) and **RE-ENFORCE the
   invariants** here in the supervisor.
5. **ACTUATE** — record the decision (passing the flags so the record seam's
   backstop can downgrade `retry`→`escalate` when `overridable:false` or
   budget-exhausted):

   ```bash
   flow-epic-judge-context record --slug <slug> --feature <id> \
     --action <action> --reason "<reason>" \
     --overridable <flags.overridable> \
     $( [ "<flags.budgetExhausted>" = true ] && echo --budget-exhausted ) \
     $( [ "<action>" = retry ] && echo --increment-retry )
   ```

   Gate `--increment-retry` on the sub-agent's **decided** `<action>` (read in
   step 4, before this record runs) — not on the post-record action, which
   isn't known yet. The record seam already suppresses the increment when it
   downgrades a `retry`→`escalate` (its `!downgraded` guard), so passing the
   flag on a decided `retry` is safe even when the downgrade fires.

   Then branch on the **recorded** action (post-downgrade — re-read the record's
   `lastJudgment.action` from the echoed result):
   - recorded **retry** → `flow new --resume <feature-slug> --force`. The
     `--force` reclaims the live-idle feature pane via a clean respawn — never
     `send-keys`.
   - recorded **escalate** →
     `flow-notify "epic <slug>: <id> escalated — <reason>"`. Halt only that
     subtree (the reconciler's existing behaviour: a halted feature withholds
     only its dependents while independent ready branches keep launching).
   - recorded **redirect** → actuate the **REDIRECT** branch below (the
     autonomous changed-approach relaunch when enabled, else the
     escalate-with-a-suggested-redirect fallback).

The record seam downgrades a `retry` decision to `escalate` when the supervisor
passes `--overridable false` or `--budget-exhausted` (a `gated` feature:
`gated ⇒ escalate-only, never override`; or `budgetExhausted`), and it does
NOT increment retry on a downgraded escalate — the supervisor passes the flags
so that backstop fires even if the sub-agent's honest read was `retry`.

- **REDIRECT** — a changed-approach relaunch (distinct from RETRY's
  same-approach resume). Read the `AUTO_REDIRECT` seed line and check the flags.

  **When `AUTO_REDIRECT: on` AND the feature is non-gated
  (`flags.overridable` / `status !== "gated"`) AND NOT `redirectExhausted`**,
  actuate autonomously. Author the changed-approach description **inline** from
  the sub-agent's returned decision (its `reason` diagnosis — the sub-agent
  already read the bounded CI-failure tail / PR review, so you do NOT re-gather
  that evidence here and it never re-enters this supervisor's context) — no
  Task/Agent fan-out, no feature-code edits. **That decision text can echo
  UNTRUSTED feature-PR / CI output — it must never be evaluated as shell.** So do
  NOT interpolate the description into a `"..."` command string (where `$(...)`,
  backticks, and `${...}` in the untrusted text would execute before `flow new`
  ever sees the argv). Instead author it into a temp file via a
  **quoted-delimiter** heredoc (the quoted `'REDIRECT_DESC_EOF'` writes any
  `$(...)`/backtick/`${...}` literally, never executing it), then pass the
  file's contents to `flow new` as a single shell-inert argv — the `--`
  end-of-options guard plus the double-quoted `"$(cat …)"` make it ONE argument
  (the substitution runs `cat`, not the file contents). Then relaunch and
  repoint:

  ```bash
  mkdir -p "$WORKTREE/.flow-tmp"
  # Quoted 'REDIRECT_DESC_EOF' ⇒ the body is written verbatim as inert data;
  # no command substitution / backtick / ${...} expansion runs on it. The
  # closing delimiter must sit at column 0 (a leading space breaks the heredoc).
  cat > "$WORKTREE/.flow-tmp/redirect-desc.txt" <<'REDIRECT_DESC_EOF'
  <changed-approach description — authored here verbatim, treated as inert data>
  REDIRECT_DESC_EOF
  # `--` ends option parsing; "$(cat …)" is ONE quoted argv, so the untrusted
  # description is never re-parsed as shell.
  OUT=$(flow new -- "$(cat "$WORKTREE/.flow-tmp/redirect-desc.txt")")
  # The authoritative slug is the `flow:<slug>` FIRST stdout line — NEVER
  # re-derive it from the description (flow new may auto-suffix on collision,
  # and a drifted slug silently stalls the reconciler forever).
  NEWSLUG=$(printf '%s' "$OUT" | head -n1 | sed 's/^flow://')
  flow-epic-judge-context record --slug <slug> --feature <id> \
    --action redirect --relaunch-slug "$NEWSLUG" \
    --reason "<one-line interpreted reason>"
  flow-notify "epic <slug>: <id> redirected → $NEWSLUG — <reason>"
  ```

  The repoint sets `FeatureRunRecord.slug` to the relaunched pipeline, pushes
  the abandoned slug onto `priorSlugs`, and increments `redirectCount`; the next
  reconcile tick then reads the new slug's state and classifies the node
  `running`. The `flow-notify` is **informational** (progress, not a halt). The
  **old** stalled pipeline (its window / worktree / PR) is left **intact** —
  only its slug is recorded in `priorSlugs` for a human to inspect; you never
  `send-keys` it, never touch its PR.

  **When `AUTO_REDIRECT: off`, OR the feature is `gated`, OR
  `redirectExhausted`**, fall back to the unchanged v1
  **escalate-with-a-suggested-redirect** path (record the escalate, `flow-notify`,
  and render the suggested redirect description to scrollback for the human to
  apply) — NO autonomous relaunch. **Redirect never fires on a gated feature.**

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
frontier is empty but the epic is not done). The **sub-agent DECIDES** the
diagnosis and this **supervisor ACTUATES**. The deadlock-evidence read
(`flow-epic-judge-context context --slug <slug> --deadlock`, returning the
board, run-state, per-feature manifest neighbourhoods, and a `manifestDrift`
flag) moves entirely into the sub-agent's `references/judgment-instructions.md`
— it is NOT run inline here.

1. **Load the Task tool** (the same `ToolSearch query="select:Task"` guard;
   escalate `NEEDS HUMAN: task-tool-unavailable: epic-run-judgment` on a miss).
2. **Spawn exactly ONE** judgment sub-agent to DECIDE:

   ```
   subagent_type: general-purpose
   description:   Judgment for /epic-run deadlock
   prompt: |
     Read references/judgment-instructions.md and follow it.
     slug: <slug>
     EPIC_DIR: <the literal EPIC_DIR from the seed prompt>
     MODE: deadlock
     ARTIFACT_PATH: ~/.flow/epics/<slug>/judgment/epic-deadlock.json
   ```

3. **Existence-check** `test -s ~/.flow/epics/<slug>/judgment/epic-deadlock.json`;
   on absence escalate `NEEDS HUMAN: epic-judgment-missing-artifact`.
4. **Read** `probableCause`, `suggestedRedirect`, and `reason` via bare `jq`.
   The sub-agent names a concrete **probable cause** (an `orphan` /
   stuck-non-terminal feature, a silently-cancelled dependency, manifest ↔
   run-state SHA drift) **plus a suggested resolution** — never the generic
   "frontier empty" message alone.
5. **ACTUATE** — **escalate-with-context**: set `runnerPhase` blocked, fire
   `flow-notify`, and render the reasoning to scrollback.

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
- It does **not author feature code**; it actuates an autonomous redirect only
  when enabled and never on a gated feature (authoring the `flow new`
  description inline is not authoring feature code).
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
