# Phase 1 — worktree

Pure script phase. No LLM involvement. Runs as the *first* post-triage
phase so every later phase, including plan, executes inside the per-task
worktree. Calls the target repo's `scripts/new-agent-worktree.ts` to
create a parallel worktree on a new feature branch, records the
worktree path and branch name in the task frontmatter, and creates a
`.orchestrator` directory symlink so the new worktree shares task state
with the main repo.

**Status: shipped (M2).**

## Inputs

- A task file with `status: triaged` and a populated
  `target_repo` frontmatter pointing at a git repo that contains
  `scripts/new-agent-worktree.ts`.

## Outputs

- `frontmatter.worktree` — absolute path to the created worktree.
- `frontmatter.branch` — the new branch name (e.g.
  `agent/add-portfolio-chart`).
- `<worktree>/.orchestrator` — directory symlink pointing at
  `<target_repo>/.orchestrator`.
- `## Phase outputs > worktree` populated with branch + path.

Status transitions: `triaged → creating-worktree → worktree-ready`.

## Branch naming

```
<author-prefix>/<id-slug>
```

`<author-prefix>` defaults to `agent` (configurable in M5+ via
`.orchestrator/config.toml`). `<id-slug>` is the task id minus the
`YYYY-MM-DD-` prefix. So `2026-04-27-add-portfolio-chart` →
`agent/add-portfolio-chart`. See `src/state/ids.ts`.

## Implementation note: bun shebang

The m2-plan.md spec example invokes the worktree script via
`npx tsx <script>`. **That doesn't work for econ-data**, whose
`scripts/new-agent-worktree.ts` starts with `#!/usr/bin/env bun`.
Running it through `tsx` would skip Bun-specific APIs the script uses
(`Bun.spawnSync`).

The phase therefore executes the script **directly** —
`execa(scriptPath, [branch])` — which respects the shebang and
delegates to whichever interpreter the script declared. This works
because the file is `chmod +x`. Future target repos can ship their
worktree script in any language they like, as long as it's executable
and accepts a single branch-name argument.

If we need to support repos whose script lacks the executable bit, the
fallback is to read the shebang and invoke the interpreter explicitly.
Defer until a real repo asks for it.

## Implementation note: detecting the worktree path

The m2-plan.md spec offered two options: parse the script's stdout for
the worktree path, or query `git worktree list --porcelain` after the
script returns. econ-data's script produces decorated output (emojis,
multi-line summary, "Directory: <path>" interleaved with other log
lines), so stdout parsing is brittle.

The phase uses `git worktree list --porcelain` instead. It splits the
output into stanzas, finds the one whose `branch refs/heads/<branch>`
line matches the branch we just created, and returns that stanza's
`worktree <path>` line. This is robust to changes in the script's
human-readable output and gives us a stable contract independent of
the target repo.

## Side effects

After the script returns successfully, the phase creates a
`.orchestrator` symlink inside the new worktree pointing at the main
repo's `.orchestrator/` directory:

```
<worktree>/.orchestrator → <target_repo>/.orchestrator
```

This is what makes worktree-first ordering work: the plan phase (and
every later phase) runs inside the worktree, but their writes to
`.orchestrator/tasks/<id>-plan/` resolve through the symlink to the
single shared task store on the main repo. Multiple concurrent `flow
run` invocations against the same repo therefore see consistent task
state regardless of which worktree they execute from.

The symlink creation is idempotent: a re-run leaves an existing
correct symlink alone, replaces a wrong-target symlink, and refuses to
overwrite a regular file or directory at the path (returns `failed`
rather than destroying user data).

The bundled `templates/scripts/new-agent-worktree.ts` deliberately
does **not** know about `.orchestrator/`. Keeping that script
flow-agnostic lets target repos use it for ad-hoc parallel agent
sessions; flow's worktree phase wrapper owns the flow-specific
symlink.

## Orphan-branch preflight

Before invoking the script, the phase runs a preflight check for the
"branch exists ∧ worktree missing" orphan condition (a prior crash
between `git branch` and `git worktree add`):

- `git show-ref --verify refs/heads/<branch>` reports the branch.
- `git worktree list --porcelain` does not list a worktree for it.

If both are true, the phase exits with `failed` and a reason that
includes the exact remediation command:

```
branch agent/<slug> already exists but has no matching worktree —
delete the orphan with: git -C <target_repo> branch -D agent/<slug>
```

The preflight does **not** auto-delete the branch. Auto-`--force` on
stale branches is a footgun; the user resolves manually and re-runs.
Status is left at `creating-worktree` so the next run re-enters the
phase cleanly.

## Failure modes

| Symptom | Reason | Fix |
|---|---|---|
| `target repo missing scripts/new-agent-worktree.ts` | Script not present in the target | Run `flow install` from inside the target repo to symlink it from flow's bundled `templates/scripts/`. flow does not auto-install — it has to be opt-in per repo |
| `branch <name> already exists but has no matching worktree` | Orphan branch from a prior crash between `git branch` and `git worktree add` | Run the printed `git -C <repo> branch -D <branch>` and re-run `flow run <id>` |
| `worktree script exit <N>` | Script ran but failed (branch already exists, dirty index, etc.) | Investigate target repo state; do not `git worktree remove --force` blindly |
| `script success but branch not found in 'git worktree list'` | Script printed success but didn't actually register a worktree (rare) | Open an issue against the target repo's script |
| `<path>/.orchestrator exists and is not a symlink — refusing to overwrite` | Pre-existing regular file or directory at the symlink target | Inspect the file; remove or rename it, then re-run |

No retry for any of these — the worktree phase aborts (`status: failed`)
on first error per m2-plan.md §"On failure". Manual investigation is
faster than blind retry for filesystem state.

## Idempotency / resume

If `frontmatter.worktree` is already set and the directory exists, the
phase short-circuits to `status: ok` (and bumps status to
`worktree-ready` if it was left at `creating-worktree` from a crashed
prior run). This means re-running `flow run <id>` after a partial
crash is safe — the script is not invoked twice.

## Implementation

| File | Role |
|---|---|
| `src/pipeline/phases/worktree.ts` | Phase entry; runs the target script, parses `git worktree list --porcelain`, writes frontmatter |
| `src/state/ids.ts` | `deriveBranchName`, `slugFromId` |
| `src/state/task-file.ts` | `updateTaskFrontmatter`, `transitionStatus` |
