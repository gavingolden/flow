---
name: flow-epic-run
description: >-
  Playbook skill for driving an epic, one reconciled step at a time. Spawned by
  `flow epic run <slug>` (or invoked directly as `/flow-epic-run <slug>` in any
  session), it reconciles the committed manifest (the plan) against GitHub/git
  truth, repairs run.json drift with safe-write primitives (`flow epic bind` /
  `flow epic launch`), and takes ONE deliberate, human-in-the-loop step at a
  time. There is no tick loop, no polling, no judgment sub-agent, and no
  autonomous redirect — it spawns NO Task/Agent fan-out and fires NO
  AskUserQuestion form. It never merges a feature PR, never overrides a gated
  verdict, and never authors feature code.
argument-hint: "<epic-slug>"
---

# Goal

You drive one epic toward completion as a **playbook** — a set of judgment
recipes you follow, not a loop you run. Each time the user asks you to make
progress ("run the next part of epic X", "reconcile X", "what's the state of
X"), you **reconcile the plan against reality**, repair any drift, then take
**one deliberate step** and stop. The human stays in the loop; you never walk
away and autonomously churn feature windows.

## The core mental model (plan / truth / hint)

An epic is three things:

- **`manifest.json`** — the committed feature DAG. This is **the plan**.
- **`design.md`** — the committed human-readable reference.
- **`run.json`** — a **per-machine, recomputable cache**. This is a **stale
  hint, never the source of truth**.

The **source of truth for progress** is **GitHub** (merged / open PRs) plus
**git** (branches, worktrees), reconciled against the manifest. **Assume
nothing is perfectly in sync.** run.json can lag reality in three ways you must
expect and repair: a feature's flow session was recreated under a new slug; work
merged out of band with no flow pipeline; or the manifest drifted from what
actually shipped. Your job is to reconcile the cache back to the truth before
you act on it.

# When to use

You are invoked by the `flow epic run <slug>` seed prompt, which begins with the
literal prefix:

```
Use the /flow-epic-run skill for: <slug>

EPIC_DIR: .flow/epics/<slug>
```

Capture the `<slug>` after `for:` and the literal `EPIC_DIR` on its own line.
You are **also** directly invocable as `/flow-epic-run <slug>` inside any existing
Claude session — the playbook is the same either way; the seed prompt just opens
a dedicated window for it.

## EPIC_DIR comes from the seed prompt (R1 — never import `bin/lib`)

The CLI (`flow epic run`) is the SOLE evaluator of the epic path contract. It
embeds the resolved **literal** `EPIC_DIR` (e.g. `.flow/epics/<slug>`) on its
own line. You run cwd'd in a **consumer worktree** where flow's `bin/lib/*` does
NOT exist, so you must **never import `bin/lib`** — that import fails here.
Consume the literal `EPIC_DIR` + the **bare-name PATH helpers** only.

# Hard invariants (read before doing anything)

These are byte-exact, load-bearing, and lint-anchored. You must:

- **Never merge a feature PR.** Merging a feature is the feature pipeline's own
  job behind its own auto-merge gate; the orchestrator never `gh pr merge`s a
  child.
- **`gated ⇒ escalate-only, never override`.** A child feature in `gated` is
  escalate-only — surface it to the human. You may interpret _why_ it is gated
  and what the human should do, but you can **never override a gated verdict**
  (a gated verdict is terminal, not advisory — AGENTS.md hard rule) and never
  merge it. **Escalate to the human.**
- **Never `send-keys` into a feature window.** A retry is a clean respawn —
  `flow feature resume <feature-slug> --force` — never typing into a live pane.
- **Never hand-edit run.json.** Repoint or adopt a binding with `flow epic
bind`; record an out-of-band completion with `flow epic bind --external`;
  create+bind atomically with `flow epic launch`. Hand-editing the cache is the
  exact failure mode the safe-write primitives exist to prevent.
- **`escalate-on-exhaustion`.** You are human-in-the-loop and bounded by
  construction: after a reasonable attempt to reconcile or relaunch, if a
  feature still will not progress, **escalate to the human** rather than
  churning windows. There is no autonomous retry/redirect budget to burn.

You spawn **no Task/Agent sub-agent** and fire **no AskUserQuestion form** — the
playbook is plain in-session judgment plus bare-name PATH helpers. This keeps
`/flow-pipeline`'s exactly-nine-Task-exemption and two-AskUserQuestion-forms
invariants untouched: a different supervisor in a different window is a different
session, and this one has zero named fan-out surfaces.

# Your hands (the bare-name PATH helpers)

| Hand                                                                       | What it does                                                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `flow epic status <slug> --json`                                           | The board as a machine-readable **hypothesis** derived from the possibly-stale run.json — always verify it against GitHub/git before acting. |
| `flow-epic-dag --validate <manifest>`                                      | Shape + DAG well-formedness gate for the committed manifest.                                                                                 |
| `flow-epic-dag --frontier <manifest> --completed <ids> [--launched <ids>]` | The exact ready-frontier math for the completed/launched sets YOU supply from your reconciliation (NOT read from run.json).                  |
| `flow-epic-manifest-schema --validate <manifest>`                          | Manifest shape gate (used after an `amend-manifest` edit).                                                                                   |
| `flow-epic-judge-context context --slug <epic> --feature <id>`             | Bounded evidence for ONE halted feature (status, PR, tail-bounded CI failure, manifest neighbourhood, `flags.overridable`). Read-only.       |
| `flow epic bind <epic> <id> <slug> [--force]`                              | Repoint or adopt a run.json binding safely (the #1 drift tool).                                                                              |
| `flow epic bind <epic> <id> --external "<ref>" [--force]`                  | Record a completed out-of-band feature (a PR/issue, no live slug).                                                                           |
| `flow epic launch <epic> <id> [--force]`                                   | Atomic manifest-read → `flow feature create` → binding recorded.                                                                             |
| `flow epic ls` / `flow epic done <slug>`                                   | List epics / remove the per-machine run.json cache.                                                                                          |
| `flow feature create "<desc>"` / `flow feature resume <slug> --force`      | Launch a fresh pipeline / clean-respawn a stalled one (the sanctioned retry actuator).                                                       |
| `gh`, `git`, `jq`                                                          | The truth probes + JSON extraction.                                                                                                          |

# The four recipes

## reconcile-drift

Reconcile the cache (run.json) against the truth (GitHub/git) BEFORE any launch.

1. Read the hypothesis: `flow epic status <slug> --json`. Treat every row as a
   **hypothesis to verify**, not fact — the `source` field says so.
2. For **each** node, verify against truth:
   - **GitHub:** `gh pr list --search "<feature branch or title>"` (and
     `gh pr view <n>`) — did this feature's PR merge? Is one open under a slug
     the cache doesn't know?
   - **git:** `git branch --all` and `git worktree list` — is there a live
     branch/worktree the cache missed, or a recorded slug with nothing behind it?
   - **feature state:** the recorded slug's `~/.flow/state/<slug>.json` phase (a
     halted feature ⇒ read `flow-epic-judge-context context --slug <epic>
--feature <id>` for bounded evidence).
3. Repair the drift with safe-writes (never hand-edit run.json):
   - **Recreated slug** (session relaunched under a new slug) →
     `flow epic bind <epic> <id> <new-slug> --force` (the old slug moves to
     `priorSlugs`).
   - **Merged out of band** (a PR merged with no flow pipeline) →
     `flow epic bind <epic> <id> --external "PR #<n>"`.
4. If the manifest itself drifted from what shipped, run **amend-manifest**.

A `gated` feature surfaced here is **escalate-only** — tell the human; never
clear it.

## launch-next

Launch the next ready feature(s) — but only AFTER reconcile-drift and a
duplicate-check.

1. Compute the frontier from YOUR reconciled sets (not the raw cache):
   `flow-epic-dag --frontier <manifest> --completed <verified-done-ids>
--launched <verified-in-flight-ids>`.
2. **REQUIRED duplicate-check (never skipped, even on a terse "run the next
   part" prompt).** Immediately before launching any feature id, confirm nothing
   is already doing that work: `gh pr list` (an open/merged PR for it?),
   `git worktree list` (a live worktree?), and grep the manifest + open PRs for
   the id. If any hit, do NOT launch — reconcile the binding instead.
3. Launch atomically: `flow epic launch <epic> <id>` (create + bind in one
   command, so the binding can never be lost). `launch` and `bind` both refuse an
   already-bound node without `--force`, but the duplicate-check is your first
   line of defence.
4. Stop after launching the step. You are human-in-the-loop — report what you
   launched and wait for the next instruction.

## amend-manifest

When scope changed and the committed manifest must change:

1. Edit `.flow/epics/<slug>/manifest.json`.
2. Validate: `flow-epic-manifest-schema --validate <manifest>` then
   `flow-epic-dag --validate <manifest>` (both must pass).
3. Commit the change with a small, focused commit.

## delete-when-done

When the epic is fully shipped (every manifest feature merged, verified against
GitHub), remove the per-machine cache: `flow epic done <slug>`. This does NOT
touch the design window or feature pipeline state.

# Resume mode

`flow epic run <slug>` is **idempotent and resumable by construction** — the
playbook reconstructs its whole view from the committed manifest (read-only) +
GitHub/git truth + the run.json cache every time. A re-launched session simply
re-reads the board and continues. Print `RESUMING AT: playbook` on its own line
before re-entering so the user reading scrollback can confirm, then reconcile
and proceed.

# What this playbook does NOT do

- It does **not merge** a feature PR — ever.
- It does **not override** a gated verdict — `gated ⇒ escalate-only`.
- It does **not `send-keys`** into a feature window — retry is a clean respawn.
- It does **not hand-edit run.json** — it uses `flow epic bind` / `flow epic
launch`.
- It does **not author feature code**, run a tick loop, poll, or spawn a
  judgment sub-agent.

# Resource cleanup

The only resources this playbook touches are the per-feature `flow feature`
windows that `flow epic launch` opens — and those are **owned by their own
pipelines**, which clean up their own worktrees on merge. The playbook opens no
worktree of its own and writes only the per-machine `run.json` cache (removable
by hand or via `flow epic done`). The markdown manifest + `~/.flow` JSON remain
the only store — no DB.
