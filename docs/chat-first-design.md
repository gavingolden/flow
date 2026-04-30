# Chat-first design

> **Audience:** future agents (LLM and human) picking up a PR from
> [`roadmap.md`](./roadmap.md). This is *not* a getting-started doc and
> not a tutorial. It assumes the reader is implementing or reviewing a
> specific PR and needs the rationale behind the design — the *why*
> behind every load-bearing choice.
>
> For the high-level architecture shape, see
> [`architecture.md`](./architecture.md). For the PR-by-PR plan, see
> [`roadmap.md`](./roadmap.md).

---

## 1. Why chat-first

**What is flow actually for?**

This is the deepest question, and it anchors every scope debate. Two
plausible answers, with very different design implications:

- *"Automate the copy-paste of the task I'm actively working on right
  now."* If this is the goal, pure-skills wins. No CLI, just skills +
  chat. The orchestrator would be an in-session agent dispatching to
  subagents.
- *"Let me queue work and walk away."* If this is the goal, headless
  is mandatory. Today's subprocess-per-phase design is correct.

**The user's stated need is the second.** Multi-task parallelism (PR
15) is load-bearing for the actual workflow, not aspirational. Closing
the laptop and coming back hours later to find PRs merged is the
target experience. This anchors future scope debates: when someone
proposes a change that requires attended runs, point at this section
and ask whether we're abandoning the walk-away property.

The chat-first front door is the natural complement: capture happens
in the place the user already is (a Claude Code chat), but the
pipeline runs as detached OS processes that survive chat closure,
laptop sleep, even Mac reboot (with PR 16's resume affordance).

---

## 2. User journey overview

### 2.1 Capture-to-merge stages

The full path from "I have an idea" to "code is merged," with what the
user actually wants at each stage and how the system can fail them.

| Stage | User input | Expected output | What "good" feels like | Failure modes |
|---|---|---|---|---|
| **Capture** | rough one-liner | something durable | <10s of friction | tool-switching kills the urge to log it |
| **Refine** | conversation | a precise spec | 1-3 pushback questions, alternatives surfaced | yes-man triage; 15-question interrogation for a one-line fix |
| **Plan** | spec + repo state | PRD + task breakdown | a believable outline that *cites the actual code* | invents abstractions; ignores existing patterns |
| **Implement** | plan + clean worktree | code + tests + PR | passes locally first try | plausible-looking code that doesn't compile |
| **Verify** | implementation | green test/lint/types | distinguishes "real fail" from "flake" | hides errors; pretends to fix |
| **Open PR / CI** | green commit | PR with structured body, CI running | descriptive body, manual-validation section honest | CI red; bot reviewers trip on noise |
| **Self-review** | open PR | inline findings the implementer missed | high signal-to-noise | performative comments; review theater |
| **Gate** | reviewed PR | "merge now" or "human, please look" | calibrated trust — risky things flagged, trivial things flow | over-cautious or over-confident |
| **Merge** | gated PR | squash, delete branch, prune worktree | invisible | leaves debris |

### 2.2 The five things the user cares about

1. **Send-and-forget** — low context-switch cost. Kick it off, close
   the laptop if you want.
2. **Notify on the *interesting* events**, not every state transition.
   Phase-start spam is noise; "needs-human" is signal.
3. **Easy resume / redirect** when something gets stuck. Don't punish
   me for needing to interject.
4. **Multiple things in flight at once** — without them stepping on
   each other.
5. **Calibrated auto-merge trust** — never surprised by what landed.
   Risky changes get flagged; trivial changes flow through.

These are the design constraints that justify
chat-first-with-subprocess over alternatives. Every chunk of the
design below traces back to one of these five.

---

## 3. Component architecture

The system has three layers: the chat session (front door), the CLI
(backend), and the per-phase subprocesses. They communicate exclusively
through the task file on disk.

```
┌────────────────────────────────────────────────────────────────┐
│  Claude Code session (the user's chat — the "front door")      │
│                                                                │
│  Skills (markdown, live in .claude/skills/):                   │
│    /flow add "<prompt>"      ← triage + kickoff                │
│    /flow status [<id>]       ← read .orchestrator/tasks/*      │
│    /flow watch <id>          ← tail phase log                  │
│    /flow pause <id>          ← drop a flag file                │
│    /flow resume <id>         ← clear flag + relaunch           │
│    /flow abort <id>          ← terminal mark + cleanup         │
│    /flow approve <id>        ← clear plan checkpoint           │
│    /flow revise <id>         ← send plan back with feedback    │
└─────────────────────────┬──────────────────────────────────────┘
                          │ spawns (detached) via Bash tool
                          ▼
┌────────────────────────────────────────────────────────────────┐
│  flow CLI (Node, no LLM context)                               │
│                                                                │
│   flow run <id> [--detach]                                     │
│   flow run --all --max N                                       │
│                                                                │
│   Per task: a state machine that reads task.md, picks the      │
│   next phase, spawns a phase subprocess, parses result,        │
│   writes back, repeats. Crashes are safe to re-enter.          │
└─────────────────────────┬──────────────────────────────────────┘
                          │ spawns one subprocess per phase
              ┌───────────┴───────────┐
              ▼                       ▼
┌──────────────────────┐  ┌────────────────────────────────────┐
│ Script phases (Bun)  │  │ LLM phases (claude -p, fresh ctx)  │
│                      │  │                                    │
│ • worktree           │  │ • plan      → /product-planning    │
│ • ci-wait (poll)     │  │ • implement → /new-feature         │
│ • gate (parse body)  │  │ • verify    → /verify              │
│ • merge              │  │ • review    → /pr-review           │
└──────────────────────┘  └────────────────────────────────────┘
                          │ all phases read/write
                          ▼
              ┌─────────────────────────────────┐
              │  .orchestrator/tasks/<id>.md    │
              │  (single source of truth)       │
              └─────────────────────────────────┘
```

**Key invariant:** the chat session never hosts a phase. It only spawns
`flow run --detach` and queries task files. Close the chat, the pipeline
keeps running.

This invariant is what makes walk-away work. If a phase ever ran inside
the chat session's process tree (e.g. via the Agent tool), closing the
session would kill the phase — the laptop-sleep / chat-close case
becomes lossy. Detached subprocesses owned by the OS scheduler are the
only way to satisfy "send and forget."

---

## 4. Pipeline state machine

The pipeline is a state machine over the task file's `status` field.
Phases transition status; loop-backs are explicit edges, not implicit
retries.

> The diagram below illustrates the *flow* and the loop-back edges.
> The canonical list of `status` values lives in
> [`task-schema.md`](./task-schema.md#status-state-machine); the
> names there are the source of truth (e.g. `verifying`, `ci`,
> `gated`). The diagram uses descriptive names like `local-verifying`,
> `ci-wait`, `gating` for readability — when the schema and the
> diagram disagree on naming, the schema wins. PRs in
> [`roadmap.md`](./roadmap.md) that introduce new transitions are
> expected to update both.

```
                      triaged
                         │
                         ▼
                  creating-worktree ────► (script)
                         │
                         ▼
                    worktree-ready
                         │
                         ▼
                      planning ─────────► /product-planning   ─┐
                         │                                     │ retry 1x on parse fail
                         ▼                                     │
                       planned                                 │
                         │
                  ┌──────┴──────┐
                  │  optional   │  default for `feature` intent: pause here, ask user
                  │  checkpoint │  [y]es / [e]dit / [n]o
                  └──────┬──────┘
                         ▼
                   implementing ───────► /new-feature (mode: create | fix)
                         │
                         ▼
                       pr-open   (push + gh pr create)
                         │
                         ▼
                  local-verifying ────► /verify
                         │   ▲
                  green   │   │ red, retry up to 3x with truncated log
                         ▼   │ exhaust → needs-human
                       ci-wait ─────────► (script: poll gh)
                         │   │
                  green  │   │ red ─────────► loop back to implementing (fix mode)
                         │   │                cap 3 ci→implement cycles
                         ▼   ▼
                      reviewing ─────────► /pr-review (fresh ctx)
                         │   │
                  clean  │   │ critical ────► loop back to implementing (fix mode)
                         │   │                cap 2 review→implement cycles
                         ▼   ▼
                       gating  ──────► (script: parse PR body)
                         │
              ┌──────────┴──────────┐
              │ manual_validation   │ manual_validation
              │ = false             │ = true
              ▼                     ▼
           merging               needs-human   (user merges manually)
              │                     │
              ▼                     ▼
            merged ◄────────── (after user merges)

         any state ──► aborted        (terminal, user-initiated)
         any state ──► needs-human    (transient, user resumes)
```

**Loop-back targets: always `implementing`.** Verify can't fix what
implement broke; only re-running implement can. The same is true of
review: a critical finding means the implementer made a mistake the
reviewer caught, and the only fix is for the implementer to try again
with the finding in hand. Each loop-back enters implement in **fix
mode** with the failure log appended to the prompt.

**Fresh context per LLM phase.** Every `claude -p` is a brand-new
process. The orchestrator passes the task.md path + the relevant
failure log; the skill reads what it needs. No conversation continuity
between phases. This is what keeps each phase cheap (no session bloat)
and what makes the review phase a genuine second look (see [section
5.3](#53-review-fresh-context-always)).

---

## 5. Phase shape: scripts vs LLM phases

The pipeline mixes two kinds of phases. The split isn't accidental —
it's "use the LLM where judgment is needed, use a script where it
isn't."

### 5.1 Script phases

The script phases are **worktree**, **ci-wait**, **gate**, and
**merge**. Each is a small Bun script with no LLM cost. They're chosen
for these characteristics:

- The work is mechanical (parse JSON, poll a URL, run `git`).
- Failure modes are well-defined (network error, parse error, exit
  code).
- Re-entry is trivially idempotent (re-running re-reads state from
  ground truth).

#### ci-wait (the polling logic, in detail)

This phase shows the pattern most clearly. It's a deterministic Bun
script. No LLM, no cost, idempotent on re-entry.

```
phase: ci-wait                         inputs:  task.md (pr=189)
                                       outputs: status, ci log, bot review log

┌────────────────────────────────────────────────────────────────┐
│  loop {                                                        │
│    checks   = gh pr checks 189 --json                          │
│    reviews  = gh pr view 189 --json reviews                    │
│                                                                │
│    bots_pending = configured_bots - reviews.author.login set   │
│    checks_terminal = all checks in {success,failure,cancelled, │
│                                     skipped,neutral}           │
│                                                                │
│    if checks_terminal && bots_pending == ∅:                    │
│      break (clean exit)                                        │
│                                                                │
│    if elapsed > 60min:                                         │
│      if not checks_terminal: needs-human (CI hang)             │
│      else: proceed (bot timed out, that's fine)                │
│                                                                │
│    sleep 30s                                                   │
│  }                                                             │
│                                                                │
│  classify:                                                     │
│    any check red       → status=ci-red, write logs, return     │
│    all green           → status=ci-clean, attach bot reviews,  │
│                          return                                │
└────────────────────────────────────────────────────────────────┘
```

**Why a script and not an LLM:** the work is "ask GitHub if it's
done." Zero judgment. Polling for 30 minutes inside a Claude session
would burn tokens for no reason. A 50-line Bun script does it for ~$0.

**Resilience:** if the script crashes mid-poll, re-running `flow run
<id>` enters ci-wait fresh. Re-querying GitHub is idempotent.

### 5.2 LLM phases — implement create vs fix

The LLM phases are **plan**, **implement**, **verify**, and
**review**. Each runs as a fresh `claude -p` invocation reading the
task file and any relevant failure logs.

The implement phase is the most subtle: today's runner conflates two
modes. The redesign separates them explicitly:

```
implementPhase({ taskPath, mode })

  mode = "create":
    claude -p "/new-feature
      Read task.md at <path>. Read the plan section. Implement.
      Run verify locally before opening the PR. Open the PR with
      structured body including ## Manual validation."

  mode = "fix":
    claude -p "/new-feature
      Read task.md at <path>. The PR is open at #<pr>.
      Branch is <branch>. The previous attempt failed at the
      <ci|review> phase with this log:
      <truncated failure log>
      Fix the failures. Re-run verify locally. Push to the same
      branch. Do not open a new PR."
```

Both modes spawn fresh `claude -p`. Both read the same task.md. The
difference is the skill prompt and the loop-back log it sees.

This explicit split — instead of the implicit `task.pr != null`
branch the current runner uses — makes loop-backs predictable and
testable. The current behaviour ("on second invocation, behave
differently because PR exists") is correct in practice but wrong in
shape: the runner is now sensitive to two unrelated state bits at
once. The PR 3 split decouples them.

### 5.3 Review: fresh context, always

The review phase **never** continues from implement. Reasons:

- The point of a self-review is a second look. An implementer-continued
  reviewer rationalises its own code.
- `/pr-review` reads the PR diff via `gh pr diff` — that's the artifact
  it needs.
- Bot reviews (Copilot, etc.) collected in ci-wait are ALSO second
  opinions; they get passed in as additional context.

```
reviewPhase({ taskPath })
  bot_reviews = read from task.md (collected by ci-wait)
  claude -p "/pr-review
    Read PR #<pr> via gh. Diff via gh pr diff.
    Bot reviews to consider:
    <bot review excerpts>
    Post inline comments for findings. Categorize by confidence.
    Return JSON: { critical: [...], minor: [...] }"
  parse JSON → if critical.length > 0: status=ci-red equivalent
                                       loop back to implementing(fix)
              else: status=reviewed, advance
```

The fresh-context invariant holds even if the implement phase already
made a "self-review pass" inline (some skills do). The review phase is
a *second* observer reading the same artifact (the PR diff). That
observation is what catches mistakes the implementer's own pass missed
— rationalisation is the failure mode being designed against.

---

## 6. Parallelism model

The unit of parallelism is the **task**, not the phase. Each task is
an OS process tree.

```
$ flow run --all --max 3

shell ───┬──► flow run task-A  (Node) ─┬─► claude -p plan      (subprocess)
         │                              ├─► claude -p implement (subprocess)
         │                              ├─► bun ci-wait         (subprocess)
         │                              └─► claude -p review    (subprocess)
         │
         ├──► flow run task-B  (Node) ─┬─► …same shape…
         │                              └─► …
         │
         └──► flow run task-C  (Node) ─┬─► …same shape…
                                       └─► …
```

Each task lives in its own worktree. Each phase invocation is a fresh
subprocess. The OS scheduler handles everything. No shared memory, no
shared session, no shared context.

**Coordination on shared state:**

- `.orchestrator/tasks/<id>.md` — atomic write (write `.tmp`, rename)
  so a reader never sees a half-written file.
- Task pickup race (two `flow run --all` invocations both seeing the
  same `triaged` task): cross-process file lock via atomic rename of
  `triaged-<id>.lock` → `claimed-<id>.lock`. Loser skips the task.
  This is PR 2.
- Worktrees: per-task path means no working-tree conflicts.
- GitHub: PRs are independent; rate limits shared but rare in practice.

**Cap-N parallelism:** the parent `flow run --all --max N` is just a
worker pool. It pulls from `.orchestrator/tasks/*.md` where status ∈
{triaged, needs-human-after-resume}, claims one, spawns
`flow run <id>` as a child, and refills as children exit. This is PR
15.

The "one task = one OS process tree" choice is what makes parallelism
robust. There's no shared in-process state between tasks; the
operating system already knows how to schedule N independent process
trees against M cores. flow doesn't need its own work-stealing
scheduler or dependency graph — those would be reinvented if we ever
made the orchestrator process its own daemon (see [section 10.2 on
the rejected `flowd` design](#102-event-driven-daemon-flowd)).

---

## 7. Logging stack

The user wants to: see Claude work, walk away, run parallel tasks,
stay terminal-native. Seven options were considered; the ranking
below drives the roadmap.

### 7.1 Option 1 (DEFAULT, PR 6): jsonl logs + `flow log <id> --follow`

`claude -p --output-format stream-json --verbose` writes events to
`.orchestrator/tasks/<id>/logs/<phase>-<ISO>.jsonl`. `flow log` reads
and pretty-prints; `--follow` tails the active phase.

- **Pro:** hits every need without tmux; detach is free; replayable;
  greppable across runs; cost accounting from `result.usage`.
- **Con:** logs are chatty (~MB per phase), need rotation.
- **Right when:** always. This is the load-bearing layer.

### 7.2 Option 2 (later if reached for): tmux session per task

`flow run <id>` runs inside a tmux session named `flow-<id>`.
`flow attach <id>` reattaches — see live `claude -p` printing tool
calls, edits, thinking like an interactive session.

- **Pro:** "feels like interactive Claude" with scrollback, mouse,
  detach via Ctrl-b d.
- **Con:** tmux dependency (most engineers have it; not universal);
  tmux state is local — `flow attach` from another machine requires
  shared tmux setup.
- **Right when:** you specifically miss the interactive-session feel
  after Option 1 ships.

### 7.3 Option 3 (PR 11): inline `/flow watch` chat skill

Skill is a thin Bash wrapper around `flow log <id> --follow` invoked
from chat, with PR 11 bounding the output (default 30s or N events)
so long phases don't burn arbitrary chat-session tokens. Pretty-prints
recent events into the chat session.

- **Pro:** convenient spot checks without leaving chat.
- **Con:** burns chat-session tokens (events become part of chat
  context); bad for long phases.
- **Right when:** in chat already, want a peek, don't want to switch
  terminals.

### 7.4 Option 4 (PR 17, opt-in): macOS notifications on phase boundaries

`terminal-notifier`/`osascript` fires on phase start/end and errors.

- **Pro:** "I have other work to do" mode; low cognitive load.
- **Con:** no observability into *what* a phase is doing, only *that*
  it's running; debugging stuck phases requires reading logs anyway.
- **Right when:** you trust the pipeline and want to know when it
  needs you.

### 7.5 Option 5 (PR 19, optional later): TUI dashboard (`flow tui`)

Ink-based mission control. Lists all in-flight tasks with current phase
+ heartbeat; attach to any task's log stream.

- **Pro:** mission control for parallel queues; cost/status at a glance.
- **Con:** real engineering effort.
- **Right when:** parallel queues become routine and `flow status`
  polling proves insufficient. YAGNI by default.

### 7.6 Option 6 (REJECTED): foreground-only

`flow run <id>` foregrounds; pretty-prints stream events to stdout.

- **Pro:** simplest; no logs/tmux.
- **Con:** kills walk-away. Can't watch parallel tasks.
- **Why rejected:** user explicitly wants to walk away. This violates
  the load-bearing constraint from [section 1](#1-why-chat-first).

### 7.7 Option 7 (REJECTED): snapshot polling

No streaming; `flow status` shows current state + last activity line.

- **Pro:** minimal infra.
- **Con:** loses "watch Claude work" entirely; only summaries.
- **Why rejected:** user explicitly wants to watch. The "see Claude
  work" need is real and unsatisfied by status-only views.

### 7.8 How they compose

A reasonable minimum: **Option 1 + 3 + 4** gives replay, snapshots,
and event alerts with zero exotic dependencies. Tmux/TUI become
opt-in upgrades once you find yourself wanting "active session
attach" specifically. The roadmap lands the minimum first (PR 6 +
PR 11 + PR 17), defers the dependencies-required upgrades (tmux
indefinitely; TUI as PR 19, "only if reached for").

---

## 8. User flow scenarios

These ten scenarios concretise the design. Each shows what the user
sees and does at a key point in the lifecycle. Together they cover
the cases the design must serve.

### 8.1 Kicking off a new task from chat

User in their normal Claude Code session, mid-conversation about
something else.

```
user: /flow add "add CSV export to portfolio table"

Claude (in /flow skill):
  Quick triage:
  - Desktop view only, or mobile too?
  - Should the CSV include hidden columns, or only visible ones?

user: desktop only, only visible columns

Claude:
  Got it. One more — should the export respect the current sort
  order, or always export in the underlying data order?

user: current sort

Claude:
  Scope confirmed:
  - Desktop only
  - Visible columns only
  - Respects current sort order

  Writing task.md and starting the pipeline.

  ✓ Task: 2026-04-28-csv-export
  ✓ Pipeline started (detached). Logs:
      .orchestrator/tasks/2026-04-28-csv-export/logs/

  Use /flow status to check progress, or /flow watch to tail logs.
```

The chat session is free again immediately. The user can keep working
on whatever they were doing before.

### 8.2 Checking on running tasks

Hours later, the user wants to know what's happening.

```
user: /flow status

Claude (in /flow status skill, runs `flow status` and renders):

ID                              STATUS         PHASE        PR     UPDATED   COST
2026-04-28-csv-export           merged         —            #189   2h ago    $0.74
2026-04-28-fix-login-bug        implementing   implement    —      30s ago   $0.18
2026-04-28-refactor-cache       needs-human    verify       —      45m ago   $0.91
                                                                             ─────
                                                                     today:  $1.83

  - csv-export merged cleanly
  - fix-login-bug is mid-implement
  - refactor-cache is paused: verify exhausted (3/3). Last log:
      "TypeError: Cannot read property 'foo' of undefined at cache.ts:42"
    Run /flow watch refactor-cache to see full context, or fix and
    /flow resume.
```

The chat skill summarizes the table. For deep dives, the user attaches
to a specific task.

### 8.3 Watching a task work in real time

User wants to see what an implementer is currently doing.

**Path A — via `flow log` viewer (default):**

```
$ flow log fix-login-bug --follow

[implement phase, started 2m ago]
● Read src/lib/auth/login.ts
● Edit src/lib/auth/login.ts
  - removed 3 lines, added 18 lines
● Bash: npm run typecheck
  ✓ no errors
● Read src/lib/auth/login.test.ts
● Edit src/lib/auth/login.test.ts
  - added 2 test cases for empty-password edge
● Bash: npm run test -- auth
  ✓ 14 passed
[ thinking... ]
The fix needs to handle the case where the auth provider returns a
synchronous error before the promise resolves. Let me check that path.
● Read src/lib/auth/providers/local.ts
...
```

Detach with Ctrl-C; the pipeline keeps running.

**Path B — via inline `/flow watch` skill in chat:**

```
user: /flow watch fix-login-bug

Claude (in /flow watch skill):
  Tailing implement phase. Last 10 events:

  ● Edit src/lib/auth/login.ts (-3, +18)
  ● Bash: npm run typecheck ✓
  ● Read src/lib/auth/login.test.ts
  ● Edit src/lib/auth/login.test.ts (+24)
  ● Bash: npm run test -- auth ✓ 14 passed
  ● Read src/lib/auth/providers/local.ts
  ...

  (Watching for 30s, then I'll stop tailing — let me know if you want
  more.)
```

**Path C — via tmux attach (after Option 2 ships):**

```
$ flow attach fix-login-bug
[reattaches to tmux session running flow run for that task,
 you see the live claude -p stream with full scrollback]
```

Each path serves a different moment: `flow log` for terminal sessions
where you're focused on one task; `/flow watch` for spot checks while
you're chatting; `flow attach` for the "I want to feel like I'm
watching interactive Claude" mode.

### 8.4 Redirecting mid-flight

User realises they want a different approach partway through implement.

```
user: /flow pause fix-login-bug

Claude (in /flow pause skill):
  Pausing. Current phase (implement) will finish naturally; pipeline
  will then stop with status `needs-human` (reason: user-paused).
  Use /flow status to see when it's safely paused.

[3 minutes later]

user: /flow status fix-login-bug

Claude:
  Status: needs-human
  Reason: user-paused
  Phase: implement (completed)
  PR: not yet opened

  You can edit .orchestrator/tasks/fix-login-bug.md to refine the
  spec, then /flow resume fix-login-bug to continue.

[user edits task.md, refines the clarifications]

user: /flow resume fix-login-bug

Claude:
  Resuming. Pipeline picks up from current phase (implement, fix mode
  with refined spec). /flow status to track.
```

Pause is best-effort: the current phase runs to completion (no mid-tool
interruption), then the runner stops cleanly.

### 8.5 Managing parallel tasks

User has three unrelated tasks queued and wants to bound concurrency.

```
user: /flow add "add dark mode toggle"
   ... triage ...
   ✓ Task: 2026-04-28-dark-mode
   ✓ Pipeline started (detached).

user: /flow add "fix off-by-one in pagination"
   ... triage ...
   ✓ Task: 2026-04-28-pagination-fix
   ✓ Pipeline started (detached).

user: /flow add "extract the auth middleware to its own module"
   ... triage ...
   ✓ Task: 2026-04-28-auth-extract
   ✓ Pipeline started (detached).
```

Each `/flow add` triages the task and shells out to `flow run <id>
--detach`, so by default all three tasks run in parallel — one OS
process tree per task, each in its own worktree. If the user wants
to bound concurrency (e.g. on a small machine), they pause the
extras and use the worker-pool flow instead from a terminal:

```
$ flow run --all --max 2
  ✓ Picked up: 2026-04-28-dark-mode (worker 1)
  ✓ Picked up: 2026-04-28-pagination-fix (worker 2)
  - Queued: 2026-04-28-auth-extract (will start when a worker frees up)
```

`flow run --all --max N` (PR 15) pulls from `.orchestrator/tasks/`
where status ∈ {triaged, needs-human-after-resume}, claims via PR 2's
cross-process primitive, and refills as children exit. The user's
chat session is free throughout — they can keep working, or ask
`/flow status` periodically.

### 8.6 The plan checkpoint (high-leverage pause)

For `feature` intent, the pipeline pauses after plan to let the user
sanity-check the approach before tokens get spent on implement.

```
[pipeline runs through plan, pauses]

[notification fires — macOS: "flow: dark-mode plan ready for review"]

user: /flow status

Claude:
  2026-04-28-dark-mode is at plan-pending-review.

  PRD summary (from .orchestrator/tasks/dark-mode.md ## Phase outputs > plan):
    - Add a theme toggle to the user menu
    - Persist preference in localStorage
    - Default to system preference if unset
    - Update theme.svelte to read the preference
    - Affected files: 4 (theme.svelte, user-menu.svelte,
      app.layout.svelte, theme.test.ts)

  /flow approve dark-mode  to proceed to implement
  /flow revise dark-mode   to send it back with feedback
  /flow abort dark-mode    to stop entirely

user: /flow approve dark-mode

Claude:
  Approved. Pipeline resuming → implementing.
```

This is the highest-leverage human-in-loop point. Catching a wrong
direction here costs only the plan tokens; catching it after implement
costs the implement tokens plus the time to redo. PR 12 lands this
checkpoint; it pauses by default for `intent: feature` tasks and
flows straight through for other intents.

### 8.7 Target repo migration (econ-data, pokemon)

Existing target repos already have flow installed (skills + scripts
symlinked, `.orchestrator/` directory). The migration to chat-first is
a single command per repo.

```
$ cd ~/code/me/econ-data

$ cd ~/code/me/flow && git pull
Already up to date.

$ flow install --upgrade
Checking ~/code/me/econ-data...
  ✓ skills symlinks updated:
      .claude/skills/flow-add → /Users/.../flow/skills/pipeline/flow-add
      .claude/skills/flow-status → ...
      .claude/skills/flow-watch → ...
      .claude/skills/flow-pause → ...
      .claude/skills/flow-resume → ...
      .claude/skills/flow-abort → ...
      .claude/skills/flow-approve → ...
      .claude/skills/flow-revise → ...
  ✓ scripts symlinks updated (3 new, 0 removed)
  ✓ Created .orchestrator/logs/
  ✓ Updated .gitignore managed blocks

Migration complete. New chat-first workflow:
  /flow add "your prompt"   in any Claude Code session

Old workflow still works (deprecated):
  flow start "your prompt"
  flow run

$ cd ~/code/me/pokemon
$ flow install --upgrade
... same output ...
```

The old `flow start` / `flow run` keeps working through PR 17. In-flight
tasks (if any) keep their state — task.md schema is additive. After
PR 18, `flow start` is removed and `flow install --upgrade` cleans up
the deprecated references.

### 8.8 First-time install in a new repo

New repo, never had flow. User wants to set it up.

```
$ cd ~/code/me/new-project
$ flow install
Checking ~/code/me/new-project...
  - .claude/skills/ (created)
  - scripts/ (created)
  - .orchestrator/ (created)
  - .gitignore (added managed blocks)

  Symlinked 8 skills, 3 scripts.

Ready. Open Claude Code in this repo and run:
  /flow add "your prompt"
```

No daemon to start. No config to edit. The skills are usable immediately
in any Claude Code session opened in the repo.

### 8.9 When the gate kicks back to a human

Some changes are too risky to auto-merge. The implementer flags them
in the PR's `## Manual validation` section; the gate phase reads the
section and pauses for human review.

```
[pipeline runs through review, gate parses PR body]

[notification: "flow: csv-export needs manual validation"]

user: /flow status

Claude:
  2026-04-28-csv-export is at gated.

  PR: #189 (https://github.com/user/repo/pull/189)
  Manual validation needed:
    - Test export with a portfolio containing >1000 rows
    - Verify CSV opens correctly in Excel and Google Sheets
    - Check that hidden columns are correctly excluded

  After validating, merge the PR manually via gh or the GitHub UI.
  flow will detect the merge and finalize the task.
```

The user does the validation, merges in GitHub. The next `flow run`
(or the next time the worker pool is invoked via `flow run --all
--max N`) detects `merge_commit` populated and transitions the task
to `merged`, prunes the worktree, archives the task file.

### 8.10 Aborting a task

User decides a task isn't worth pursuing.

```
user: /flow abort 2026-04-28-bad-idea

Claude (in /flow abort skill):
  Confirm: this will set status=aborted, close the PR if open,
  and prune the worktree. The task file will be moved to
  .orchestrator/tasks/archive/.

  Proceed? (yes/no)

user: yes

Claude:
  ✓ Status set to aborted
  ✓ PR #192 closed (no merge)
  ✓ Worktree removed: ~/code/me/flow-2026-04-28-bad-idea
  ✓ Branch deleted: agent/2026-04-28-bad-idea
  ✓ Task archived to .orchestrator/tasks/archive/
```

Aborted is a terminal state. The task file is preserved (in archive)
for postmortem.

---

## 9. Success and error paths

### 9.1 Success path narrative

Illustrative timeline for a "small feature" task. Numbers are
representative, not literal.

```
T+0:00  user (in chat): /flow add "add CSV export to portfolio table"
T+0:05  Claude (in /flow skill): triage conversation
        - "is this for the desktop view only or mobile too?"
        - "should the CSV include hidden columns?"
        - confirms scope, writes task.md
        - shells out: `flow run 2026-04-28-csv-export --detach`
        - tells user: "Task started. /flow status to check."

T+0:30  worktree phase (script):
        - new branch, new worktree, .orchestrator symlink
        - status: worktree-ready

T+0:35  plan phase (claude -p /product-planning):
        - reads task.md, writes plan section
        - status: planned
        - [optional checkpoint] — for `feature` intent, pause + notify

T+1:00  implement phase (claude -p /new-feature, mode=create):
        - reads task.md + plan
        - writes code + tests
        - runs `npm run verify` locally — green
        - pushes branch, gh pr create with structured body
        - status: pr-open, frontmatter.pr=189

T+1:02  ci-wait phase (script):
        - polls gh pr checks every 30s
        - polls gh pr view --json reviews
        - waits up to 60min for terminal + bot reviews

T+5:00  CI green, Copilot review posted (one minor suggestion)
        - status: ci-clean
        - bot reviews captured into task.md ## Phase outputs > ci

T+5:05  review phase (claude -p /pr-review, fresh ctx):
        - reads PR diff, considers Copilot's suggestion
        - posts 2 inline comments, none critical
        - status: reviewed

T+5:30  gate phase (script):
        - reads PR body, manual_validation section is empty
        - status: gating → merging

T+5:32  merge phase (script):
        - gh pr merge --squash --delete-branch
        - removes worktree, archives task.md
        - status: merged (terminal)

User checks chat hours later: /flow status
                              → table shows task-csv-export merged
```

The timeline shape — minutes through gate, real wait inside ci-wait —
is the typical case for a small feature. Larger features stretch
implement and verify; integration-heavy features stretch ci-wait.
Everything between kickoff and merge happens without the user
present.

### 9.2 Error narratives

Six representative failure paths. Each shows where the pipeline lands,
what the user sees, and what they can do.

#### 9.2.1 Local verify exhausts retries

```
implement (create) → verify red → retry 1 → red → retry 2 → red
                  → retry 3 → red
  → status: needs-human
  → reason: "verify exhausted (3/3 attempts failed)"
  → log: last failure tail saved to ## Phase outputs > verify
User options:
  - investigate, fix manually, then /flow resume <id>
  - /flow abort <id>
```

#### 9.2.2 CI red, recoverable

```
implement → pr-open → ci-wait (red, lint check failed)
  → status: ci-red
  → loop counter: ci→implement = 1/3
  → spawn implement (mode: fix) with CI log
  → implement reads log, fixes, re-runs local verify (must be green)
  → push (same branch, same PR)
  → ci-wait again
  → green → review → … continue
```

#### 9.2.3 CI red, exhausts cap

```
ci → implement → ci → implement → ci → implement (3/3) → ci red
  → status: needs-human
  → reason: "ci→implement loop exhausted"
  → log: last 3 CI failure summaries
```

#### 9.2.4 Critical review finding

```
ci-clean → review → 1 critical finding ("missing input validation")
  → status: review-critical
  → loop counter: review→implement = 1/2
  → implement (fix mode) with review log
  → verify → push → ci-wait → reviewing → … continue
```

#### 9.2.5 User redirect mid-flight

```
T+1:00  implement is running
T+1:05  user: /flow pause 2026-04-28-csv-export
        → drops a .pause flag in .orchestrator/
        → current phase (implement) finishes naturally
        → runner sees flag, sets status: needs-human, reason: "user-paused"
        → exits

T+1:10  user edits task.md (refines the spec)
T+1:11  user: /flow resume 2026-04-28-csv-export
        → removes flag
        → spawns flow run <id> --detach
        → runner sees status, picks up from current phase
```

#### 9.2.6 Crash recovery

```
flow run task-A is running implement; Mac sleeps; OS kills child processes.
On wake, the user runs `flow run task-A` again (or reruns
`flow run --all --max N` if they are using the PR 15+ worker-pool flow).
Runner reads task.md, sees status=implementing, restarts the implement phase.
The phase is idempotent on re-entry (re-reads files, re-runs verify, only
opens a PR if frontmatter.pr is null — otherwise pushes to existing branch).
```

These six paths cover the classes of failure the design has to
gracefully handle: local-verify failure, CI failure (recoverable and
exhausted), review failure, user-initiated pause, and process death.
Each lands in a state the user can act on; none silently drops a
task.

---

## 10. Alternatives considered

The chat-first-with-subprocess-pipeline design was selected after
considering eight alternatives. Each is documented here so future
readers asking "why didn't we do X?" find the answer.

### 10.1 Pure-skills orchestration (Claude as orchestrator, no headless)

Single Claude session per task; orchestrator agent dispatches phases
to subagents via Agent tool. No subprocess fan-out.

- **Why rejected:** can't satisfy walk-away (close terminal →
  orchestrator dies); multi-task parallelism is fundamentally awkward
  (Agent calls block parent, parent context fills with N task states);
  long-running session means context bloats and cost compounds;
  bounded retries become probabilistic instead of mechanical.

### 10.2 Event-driven daemon (`flowd`)

Long-running process watches `.orchestrator/tasks/` plus GitHub
webhooks. Workers subscribe to state-change events. SQLite + Ink TUI.

- **Why rejected:** daemon lifecycle to manage; webhook setup per
  repo; violates "no long-running daemon" principle. Worth revisiting
  if polling cost ever becomes a real pain.

### 10.3 GitHub-Actions-native pipeline

Triage local; rest of pipeline as Actions jobs (Claude Code Action).

- **Why rejected:** 30-60s cold start per phase; YAML; hard to
  iterate locally; secrets in GH; loses local-and-fast property.

### 10.4 One long-running agent with subagent delegation

Single Claude session per task; orchestrator + planner/implementer/
reviewer subagents. Subagents return summaries to keep parent context
small.

- **Why rejected:** hits the *exact* depth-limit constraint flow
  exists to dodge. Once you fix it via subprocess fan-out, you've
  reinvented today's design.

### 10.5 Pull-based phase-worker pool

Tasks declare `desired_state: merged`. Pool of stateless workers each
owns one transition. Cheap models for verify, Opus for implement.

- **Why rejected:** effectively a build system for agents (Make/Bazel
  shape); race conditions; harder mental model. Today's design is
  this collapsed into a single sequential driver per task.

### 10.6 Conversational, no CLI

Drop `flow start` / `flow run`. Open Claude in repo, agent runs full
pipeline as one chat with skills mapped to tools.

- **Why rejected:** hits context-bloat constraint immediately;
  subagent-depth limit constrains structure; concurrency is hard.

### 10.7 Branch-per-phase, PR-as-state-machine

Push commit per phase to task branch. PR description IS the task.md.
GitHub is the state store.

- **Why rejected:** commit clutter (squash fixes); network per read;
  PR description length limits; no offline. Audit-via-git-log appeal
  is real but doesn't outweigh the costs.

### 10.8 Declarative `flow.yml` DAG

Pipeline-as-config: stages, retries, gates, parallelism. Runtime
executes the DAG; skills are pluggable.

- **Why rejected:** YAML hell; loses opinionated defaults; validation
  surface area. Right call if flow ever needs per-repo pipeline
  customization (Rust shop adds `cargo audit`, etc.) — revisit then.

---

## 11. Migration plan summary

The full PR-by-PR plan lives in [`roadmap.md`](./roadmap.md). The
shape, in four phases:

- **Phase 1 — foundation (PRs 1-3).** Logging plumbing, detached
  subprocesses, cross-process claim primitive, implement create/fix
  split. No user-visible change. Lays the load-bearing infrastructure
  for everything else.
- **Phase 2 — pipeline buildout (PRs 4-8).** ci-wait, verify, `flow
  log` viewer, review + critical loop-back, gate + merge. Every phase
  in the state machine becomes real.
- **Phase 3 — entry point + UX (PRs 9-12).** `/flow add` becomes the
  documented front door; `/flow status`, `/flow watch`, plan
  checkpoint land. Old `flow start` keeps working.
- **Phase 4 — cutover + parallelism (PRs 13-19).** Deprecate `flow
  start`; `flow install --upgrade` for target repos; `--all --max N`
  parallelism; pause/resume/abort; opt-in macOS notifications;
  remove `flow start`; optional `flow tui` dashboard.

**Per-target-repo migration** is `flow install --upgrade` (PR 14).
One command. Both `flow start` and `/flow add` work in parallel from
PR 9 through PR 17 — no flag day required. Hard removal of `flow
start` waits until PR 18 (post stable use). The task.md schema is
additive — old in-flight tasks keep working through the migration.

The 19-PR sequence is ordered for a reason: later PRs depend on
constraints earlier ones impose. The cross-process claim primitive
(PR 2) is required before parallelism (PR 15). The detached
subprocess plumbing (PR 1) is required before `/flow add` can shell
out without blocking (PR 9). The `flow log` viewer (PR 6) is
required before `/flow watch` can wrap it (PR 11). Don't reorder
without checking the dependency.
