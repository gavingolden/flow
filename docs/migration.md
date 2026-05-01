# Migrating off the legacy per-repo `flow install`

flow's redesign installs once globally rather than per-repo (see
[`docs/roadmap.md`](roadmap.md)). Repos that ran `flow install` before
PR 1 have a footprint inside them that needs cleanup. This is a one-shot,
fully scripted migration.

## What's getting cleaned up

Per-repo footprint that legacy `flow install` left behind:

```
<repo>/
  .claude/skills/                 # symlinks under # managed by flow install-skills
  scripts/                        # symlinks under # managed by flow install-scripts
  .gitignore                      # contains the two managed blocks above
  .orchestrator/                  # state directory (kept by default)
```

## One-pass recipe

```sh
# 1. Update flow source + run global install
cd ~/code/flow && git pull
npm install
bun bin/flow setup

# 2. Per-repo cleanup
cd <repo-with-old-flow>
flow migrate                            # dry-run by default
flow migrate --apply                    # actually clean up
```

Repeat step 2 for each repo, or use `flow migrate --scan ~/code/` to see a
dry-run across every git repo under a path.

## What `flow migrate` does

1. **Inspect** the repo's `.gitignore` for the two managed blocks
   (`# managed by flow install-skills`, `# managed by flow install-scripts`).
2. **Refuse to proceed** if `.orchestrator/tasks/` contains any task with
   non-terminal status — your in-flight work shouldn't be silently
   stranded. Either complete or abort the tasks first, then re-run.
3. **Print** the planned actions: every symlink to be removed, every
   `.gitignore` line to be stripped, presence of `.orchestrator/`.
4. **On `--apply`**: remove each managed-block symlink, strip the two
   managed blocks from `.gitignore`, optionally delete the state directory.

## Safety properties

- `flow migrate` **never deletes a real file**. Only symlinks listed in
  the managed `.gitignore` blocks are touched. If you've replaced a
  managed symlink with your own file, migrate prints a warning and
  leaves it alone.
- `flow migrate` **never touches** `.claude/skills/` entries that aren't
  in the managed block. User-authored skills are preserved.
- `flow migrate` is **idempotent** — re-running it is a no-op.
- `flow migrate` **never deletes `.orchestrator/`** unless you pass
  `--include-orchestrator`. The default keeps your task archive intact.

## What survives the migration

- All open PRs created by old flow runs — they're just normal PRs.
- All worktrees on disk — they're just git worktrees.
- All branches — git is unmodified.
- The `.orchestrator/tasks/archive/` directory if you keep it.

## Cleaning up the global `npm link`

`flow setup` overwrites the old `npm link`-installed `flow` binary
cleanly. No manual `npm unlink` needed. For paranoia:

```sh
cd ~/code/flow && npm unlink && rm -f $(which flow)
bun bin/flow setup
```
