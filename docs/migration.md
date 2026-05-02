# Migrating off the legacy per-repo `flow install`

flow's redesign installs once globally rather than per-repo (see
[`docs/roadmap.md`](roadmap.md)). The legacy `flow install` command
itself was deleted in PR 5; repos that ran it earlier still carry a
footprint inside them that needs cleanup. `flow migrate` is the
fully-scripted one-shot.

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

If flow was ever installed via `npm link` (or `npm install -g`) **before**
the `bin` field was removed from `package.json`, you must run
`npm uninstall -g flow` before `flow setup`. Skipping this step will
silently leave the old install in place: the npm-managed symlinks at
`$(npm prefix -g)/bin/flow` linger after the `bin` field is gone (npm
only writes new symlinks; it never sweeps stale ones), and depending on
PATH ordering they may shadow `~/.local/bin/flow` and keep resolving the
deleted `dist/cli.js` from the original checkout. The failure mode is
quiet — `flow --version` keeps working — so you may not notice for a
while.

```sh
npm uninstall -g flow                 # required if you ever ran npm link / npm install -g
rm -f $(which flow) 2>/dev/null       # belt-and-suspenders: drop any leftover symlink
bun bin/flow setup                    # writes ~/.local/bin/flow
which flow                            # confirm it now resolves to ~/.local/bin/flow
```

If you've never installed flow globally via npm, only the last two
commands are needed.
