# Getting started with flow

Your first pipeline, from install to merged PR. Every console transcript in this doc is contrived and clearly marked as such — flow's real output is more verbose.

## Install

Follow the Quickstart in the [README](../README.md#quickstart): clone, `npm install`, `bun bin/flow install`, then confirm `flow ls` prints an empty pipeline list. Module selection, upgrades, and every config knob are covered in [configuration.md](configuration.md).

## Your first pipeline

`cd` into any project that is a git repo with a GitHub remote, and describe the change you want:

```sh
flow feature create "add CSV export"
```

Claude Code launches as a foreground process in your terminal (the plain shell is the default; tmux is a separate opt-in — see [the README's power-users section](../README.md#power-users-the-tmux-launcher)). The supervisor triages the request, drafts a plan, and — because this is feature work — pauses once for your approval. Type `approved`, type a redirection to reshape the plan, or type `cancel` to stop.

The transcript below is **illustrative — not exact output**:

```text
$ flow feature create "add CSV export"

[plan] feature detected — drafting plan, pausing for approval
  Plan: add a CSV exporter behind a flag, with tests.
    Task 1: exporter module + unit tests
    Task 2: wire the --csv flag into the report command
  approve? > approved

[implement] worktree ready at ../myrepo-add-csv-export
[implement] applying edits ... running verify ... ok
[ci]       PR #142 opened — waiting for checks ............... green
[review]   multi-agent review + Copilot ... 2 findings fixed
[gate]     Test Steps all checked → auto-merge

MERGED
```

Everything happens in a dedicated git worktree in a sibling directory (`<repo>-<slug>`), so your own checkout is never touched and parallel pipelines stay isolated. Non-feature changes (a bugfix, a docs tweak) run straight through with no approval pause.

## Reading the run

Every pipeline ends by printing one of four terminal states:

| terminal state          | what it means                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MERGED`                | the PR merged. Done.                                                                                                                                 |
| `GATED: <url>`          | the run finished but the merge gate wasn't clear (an unchecked Test Steps item, or you passed `--no-auto-merge`). Open the URL and merge when ready. |
| `NEEDS HUMAN: <reason>` | the supervisor hit something it can't resolve alone — read the reason and step in.                                                                   |
| `cancelled`             | you cancelled at the plan-approval pause.                                                                                                            |

To check on runs — including pipelines launched from other terminals — use:

```sh
flow ls           # every pipeline and its current phase
flow ls --cost    # add per-pipeline spend (--detail for a breakdown)
```

## Resuming

The plain launcher holds your terminal until the run ends. If you close that terminal or the process dies, nothing is lost — state lives at `~/.flow/state/<slug>.json` plus the worktree plus the PR. Re-launch with:

```sh
flow feature resume add-csv-export
```

The transcript below is **illustrative — not exact output**:

```text
$ flow ls
  add-csv-export     review    not running
  fix-login-redirect ci        running

$ flow feature resume add-csv-export
RESUMING AT: review (PR #142, 2 findings open)
[review] multi-agent review + Copilot ... resolving findings ...
```

`flow feature resume` refuses if the pipeline is actually still running. Under the tmux launcher you rarely need it at all: detach with `Ctrl-b d` and come back with `flow attach <name>` — the run never stopped.

> [!TIP]
> **Long run filling up the context?** Say "checkpoint this" (the `/flow-checkpoint` skill) and the supervisor flushes conversational state to disk and tells you it's safe to `/clear`. After you clear, a `SessionStart` hook auto-resumes the pipeline in the fresh session and re-injects the checkpoint. A `/clear` without a prior checkpoint clears normally.

## Cleaning up

When a run reaches a terminal state, close it out:

```sh
flow done add-csv-export   # close one finished pipeline (tmux: closes its window)
flow done --merged         # sweep every pipeline that reached a terminal state
flow done --orphans        # clean up state left behind by dead runs
```

## Next steps

- **Tune models and config** — route expensive models to planning and cheap ones to verify: [configuration.md](configuration.md)
- **Run pipelines in parallel / walk away** — the opt-in tmux launcher: [README](../README.md#power-users-the-tmux-launcher)
- **Bigger than one PR?** — `flow epic create` designs a multi-pipeline epic and `flow epic run` drives it; see `flow help`
- **Working on flow itself** — [CONTRIBUTING.md](../CONTRIBUTING.md)
