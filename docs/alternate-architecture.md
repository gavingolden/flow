# Alternate architectures considered

This document captures three radically different architectures that were
sketched as alternatives to flow's current orchestrator-driven design. Each
makes a different choice about *where state lives* and *where the user-facing
interface lives*, which is the most consequential axis for how the system
feels day-to-day.

This is a living reference, not a decision record. None of these have been
adopted; they're documented so the trade-offs are recoverable later if the
question is reopened.

## Why this exists

The current orchestrator solves a real problem (auto-progression through
plan → implement → CI → review → merge, with parallelism and resumability)
but imposes real costs on a single-user setup:

- A new vocabulary to internalise: phases, gates, `task.md`,
  `.orchestrator/`, `flow-status`, `flow-watch`, `flow-approve`,
  `flow-revise`, `flow-add`.
- Logs live in places the user has to *remember to look* rather than where
  they naturally land. Stalls require knowing which CLI verb surfaces them.
- The "no LLM in the orchestrator" rule (load-bearing for sub-agent depth
  and context-window safety) requires a parallel Node-side state machine
  that mirrors much of what the skills already understand.
- Status visibility is indirect — `flow status` is a snapshot, `flow watch`
  is a peephole. Neither matches the at-a-glance feel of a board view or a
  scrollable per-task window.

The automation core (auto-progression + detached execution) carries most of
the value. The interface and abstractions (CLI verbs, custom gates, custom
state directory) carry most of the cost. Each design below keeps the
automation core but moves the interface layer somewhere different.

## Restated minimum requirements

The designs are evaluated against this seven-item baseline:

1. From a chat or issue, kick off planning for a feature; pause for
   approval.
2. After approval: worktree + implement + PR — unattended.
3. Wait for Copilot to finish reviewing the PR, *then* run `/pr-review`.
4. After `/pr-review`: auto-merge if low-risk, otherwise stop and surface.
5. Run N pipelines in parallel without N attended terminals.
6. At-a-glance status for all in-flight pipelines.
7. One-click drilldown to logs / chat for any pipeline.

Reuse the existing `/product-planning` and `/pr-review` skills as-is.

---

## Design A — GitHub is the interface

> If GitHub already shows PRs, issues, labels, and a Projects board, we
> shouldn't be building a second UI.

**Mental model.** Every pipeline is a GitHub Issue. State is encoded in
labels. A small worker (local cron / launchd, or a GitHub Action) advances
issues based on labels and posts status as comments. The GitHub Projects
board *is* the status board.

**Lifecycle.**
1. User opens a GitHub Issue with a feature description, labels it
   `flow:plan`.
2. Worker sees `flow:plan` → spawns `claude -p '/product-planning ...'`,
   posts plan as an issue comment, swaps label to `flow:awaiting-approval`.
3. User reacts ✅ on the comment (or comments `/approve`) → worker swaps
   to `flow:implement`, creates a worktree, runs implementation, opens a
   PR linked to the issue, swaps the PR to `flow:awaiting-copilot`.
4. Worker polls Copilot review state. When Copilot is done, swap to
   `flow:review`.
5. Worker runs `/pr-review` skill → posts findings as inline PR comments.
6. If review confidence is high and findings are info-only, label
   `flow:auto-merge` and let `gh pr merge --auto --squash` handle it.
   Otherwise, label `flow:human-review` and notify the user (terminal
   bell + macOS notification).

**State machine** (labels are source of truth):

| Label | Tick action |
|---|---|
| `flow:plan` | Run `/product-planning`, post plan, swap to `flow:awaiting-approval`. |
| `flow:awaiting-approval` | Wait for ✅ reaction or `/approve` comment, swap to `flow:implement`. |
| `flow:implement` | Worktree + implementation subprocess + open PR, swap PR to `flow:awaiting-copilot`. |
| `flow:awaiting-copilot` | Poll PR review state; when Copilot is done, swap to `flow:review`. |
| `flow:review` | Run `/pr-review`. If high-confidence + clean → `flow:auto-merge`, else → `flow:human-review`. |
| `flow:auto-merge` | `gh pr merge --auto --squash`. Done. |
| `flow:human-review` | Notify; terminal action. |

**Implementation shape.** A single Bun script `flow-tick.ts` on a 60s
launchd timer. Per-issue lock files at `.flow/locks/<issue>.lock` prevent
double-work. Long phases (plan, implement) run detached and write to
`.flow/logs/<issue>/<phase>.log`.

**Where state lives.** GitHub: labels + comments.

**Where logs live.** Posted as issue/PR comments at every transition.
Detailed per-phase logs in `.flow/logs/`.

**Where approvals happen.** GitHub: reaction or `/approve` comment.

**Status surface.** GitHub Projects board filtered to `label:flow:*`,
grouped by label. Backup: `gh issue list --label flow:* --json
number,title,labels`.

**Parallelism.** Effectively unlimited. Each issue is independent.

| Pros | Cons |
|---|---|
| Zero new UI to learn | Requires a long-running worker (launchd or Action) |
| Logs travel with the artifact (the PR) | GH Actions runtime costs $ if used as the host |
| State is durable + multi-device (approve from phone) | Tweaking a plan is a comment thread, not a chat |
| Trivially parallel; status scales past 10 in-flight | Webhook setup if event-driven instead of polling |

---

## Design B — `tmux` is the interface

> Your old workflow was already great — it just had too many manual
> button-presses. Don't replace it; remove the button-presses.

**Mental model.** One tmux window per pipeline (the old "terminal per PR"
approach), but the agent inside the window auto-advances through the
phases so the user doesn't trigger each one by hand. The only new code is
a small shell function (`flow new`, `flow ls`, `flow a`) that spawns
windows and finds them.

**Lifecycle.**
1. `flow new "add CSV export"` → creates worktree, opens tmux window
   named `csv-export`, starts Claude Code in it, sends initial prompt:
   *"Run the planning + implementation + review pipeline for this
   feature: …"*.
2. Inside the window, the agent invokes `/product-planning`, prints the
   plan, *waits for the user to type 'approved' or to redirect*.
3. User attaches (`tmux a -t flow:csv-export`), reads, approves, detaches.
4. Agent implements, opens PR, polls Copilot in a loop, runs `/pr-review`
   when Copilot is done, decides merge vs. stop.
5. Window persists with full scrollback either way.

**Implementation shape.** ~50 lines of shell. No state files: the tmux
window *is* the state. Window name encodes phase
(`csv-export:planning`, `csv-export:awaiting-copilot`).

**Where state lives.** tmux server + git worktrees.

**Where logs live.** tmux scrollback.

**Where approvals happen.** Type into the tmux window's chat.

**Status surface.** `tmux ls` + window names. A 10-line script can scrape
`tmux list-windows` into a pretty status table.

**Parallelism.** Unlimited tmux windows.

| Pros | Cons |
|---|---|
| Closest to the original "terminal per PR" workflow | Approving N tasks = attaching to N windows |
| Logs ARE the chat — no separate viewer to learn | No durability if the laptop dies (unless tmux runs on a persistent host) |
| Almost nothing new to learn | Status is a flat list — fine to ~5 tasks, harder past 10 |
| Easy to redirect mid-flight ("actually, also do X") | Single-machine by default; phone-driven approval not feasible |

---

## Design C — One Claude Code supervisor session

> Claude Code already has a background-task primitive. Use that instead of
> reinventing one in Node.

**Mental model.** A single long-running Claude Code chat is the
"supervisor." Each new feature spawns a `Task` (background agent) via
`TaskCreate`. The supervisor's `TaskList` is the status view. The user
drills into any task with `TaskOutput`. Approvals happen by chatting back
to the supervisor, which forwards them via `SendMessage`.

**Lifecycle.**
1. Supervisor chat: *"Kick off a pipeline for: add CSV export."*
2. Supervisor calls `TaskCreate` with a canonical prompt: *"Run the full
   plan→implement→review pipeline; pause and ask before implementing."*
   The subagent creates the worktree itself.
3. Subagent runs `/product-planning`, surfaces the plan, awaits a
   message.
4. User: *"approve csv-export"* — supervisor calls `SendMessage` to the
   relevant task.
5. Subagent implements, opens PR, polls Copilot in a loop, runs
   `/pr-review`, either merges (if high-confidence + clean) or sends a
   `TaskUpdate` saying "human review needed."
6. Supervisor surfaces status on demand: *"status of all flow tasks"* →
   `TaskList` rendering.

**Implementation shape.** Almost nothing. A project-level `CLAUDE.md`
section defining the canonical pipeline prompt subagents follow. Possibly
a slash command in `.claude/commands/` that wraps the `TaskCreate`
invocation.

**Where state lives.** Claude Code's task store + git.

**Where logs live.** `TaskOutput` per task.

**Where approvals happen.** The supervisor chat.

**Status surface.** `TaskList` in the supervisor.

**Parallelism.** Whatever Claude Code's task system supports.

**Critical constraint.** Sub-agents can't spawn sub-agents (one-level
cap — the same constraint that drove the orchestrator's
"no-LLM-in-orchestrator" design). The subagent must invoke `/pr-review`
as a *skill* (in-process instructions), not as a sub-subagent. Skills
work in-process so this is feasible, but worth verifying before
committing.

| Pros | Cons |
|---|---|
| Almost zero new infrastructure; reuses Claude Code primitives | Long-running supervisor session — context bloat over days/weeks is real |
| One chat surface for everything (kickoff, approve, status, drilldown) | Sub-agent depth cap requires `/pr-review` to run as in-process skill |
| Trivial to extend (new pipeline = new prompt) | Hour-long pipelines bet on Claude Code's background-task durability |
| Polling Copilot = the subagent's own sleep+poll loop | Supervisor crash mid-day loses in-memory task state (PRs survive on disk) |

---

## Comparison

| Axis | A: GitHub-native | B: tmux | C: Claude supervisor |
|---|---|---|---|
| Where state lives | GitHub labels + comments | tmux server + git | Claude Code task store + git |
| Where logs live | PR/issue comments + `.flow/logs/` | tmux scrollback | `TaskOutput` |
| Where approvals happen | GitHub comment / reaction | tmux window chat | Supervisor chat |
| Lines of code to build | ~300–500 (worker) | ~50 (shell) | ~0–50 (mostly prompts) |
| Durability if laptop dies | ✅ (state in GitHub) | ❌ (unless remote tmux host) | ⚠️ (depends on Claude Code task durability) |
| At-a-glance status | ✅✅ (Projects board) | ✅ (`tmux ls`) | ✅ (`TaskList`) |
| Drill into one task | Open the issue/PR | `tmux a -t name` | Ask the supervisor |
| Cost to learn | ~0 (already use GH) | ~0 (already use tmux/CLI) | ~0 if comfortable with `Task`s |
| Cost to maintain | Low — GH does heavy lifting | Lowest — barely any code | Lowest — barely any code |
| Multi-machine ready | ✅ | ❌ | ❌ |
| Scales to 10+ in-flight | ✅✅ | Degrades past ~5 | Linear log; fine but not visual |
| Mid-flight redirect ergonomics | Comment thread | Inline chat | Inline chat |

## How to choose between them

The discriminating questions:

- **Is the bottleneck status visibility, or is it button-presses?** If
  visibility (i.e. "I'd run more tasks if I could track them"), Design A
  is the only one that *qualitatively* improves visibility past ~5
  in-flight. If button-presses, Design B is the closest path.
- **Does durability across laptop sleep / device switch matter?** Only
  Design A is durable by default.
- **How chatty are plan iterations?** A plan you redirect 3 times in a
  row is much more pleasant in B or C (live chat) than A (comment
  thread).
- **Are the Claude Code sub-agent constraints comfortable to live
  with?** If yes, C is the cheapest to build by far. If unsure, A or B
  side-step the question.

## What each replaces from the current orchestrator

- **Replaces in all three:** the `flow-*` CLI verbs, the
  `.orchestrator/` state directory, the formal phase docs and gates
  concept, the cross-phase `task.md` contract.
- **Reused in all three:** the `/product-planning` and `/pr-review`
  skills (called via `claude -p` headlessly or invoked in-process).
- **Reused only in A:** the `flow install` symlink-distribution pattern
  for skills + scripts (orthogonal to the orchestrator and useful on
  its own).
- **Reused only in B:** the git-worktree-per-task discipline.

## Open questions

- For Design A: local `launchd` vs. GitHub Actions vs. a small always-on
  host as the worker location. Each has different durability /
  latency / cost trade-offs.
- For Design A: aggressive vs. conservative auto-merge policy beyond
  "high `/pr-review` confidence" — should CI green and Copilot approval
  also be required?
- For Design C: empirical durability of Claude Code background tasks
  across hour-scale runs is unverified.
- All designs: notification surface for `flow:human-review` (terminal
  bell, macOS notification, GitHub email, Slack, …) is a small but
  unspecified detail.
