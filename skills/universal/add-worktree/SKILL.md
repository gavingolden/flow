---
name: add-worktree
description: >-
  Create an isolated git worktree for parallel agent development with automatic
  symlinks (.env, .claude/settings.local.json) and dependency installation. Use
  when user says "add worktree", "create worktree", "new worktree", or "spin up
  a worktree".
argument-hint: "branch-name [base-branch]"
---

# Goal

Create an isolated git worktree so a separate agent can work in parallel without interfering
with the main working directory.

# When to Use

- User needs a parallel development environment for a separate task
- User says "add worktree", "create worktree", "new worktree", "spin up a worktree"

# When NOT to Use

- For same-session isolated work, use Claude Code's built-in `isolation: worktree` agent
  parameter instead
- For removing a worktree — use `/remove-worktree`

# Context

- `scripts/new-agent-worktree.ts` — handles worktree creation, symlinks
  (`.env`, `.claude/settings.local.json`), and dependency installation
- Worktrees are created as siblings of the current workspace directory

# Instructions

## 1. Parse Inputs

- If `$ARGUMENTS` is provided, parse it as: first argument = branch name, second
  argument (optional) = base branch.
  - Example: `/add-worktree feature/my-branch master`
- If `$ARGUMENTS` is empty, ask the user for:
  - **Branch name** (e.g., `feature/new-chart`, `fix/tooltip-bug`)
  - **Base branch** (default: auto-detected from `origin/HEAD`)

## 2. Fetch Latest from Origin

- Refresh remote-tracking refs so the script branches from the latest remote state:
  ```bash
  git fetch origin
  ```

## 3. Run the Worktree Creation Script

- Execute:
  ```bash
  ./scripts/new-agent-worktree.ts <branch-name> [base-branch]
  ```
- Confirm the script completes successfully and note the output path.

## 4. Instruct the User

- Tell the user to start a parallel agent session in the new worktree:
  ```
  claude <worktree-path>
  ```
  Or open the worktree directory in their preferred editor/IDE.
- Each session gets its own independent agent conversation.

## 5. Remind About Cleanup

- After the parallel work is merged, clean up with `/remove-worktree`, or manually:
  ```bash
  git worktree remove <worktree-path>
  git branch -d <branch-name>
  ```

# Verification

- Worktree exists at the expected path
- `.env` and `.claude/settings.local.json` were symlinked to the new worktree
- `npm install` succeeded in the new worktree (handled by the script)
- Instructions for next step displayed to the user

# Constraints

- NEVER create a worktree on the current branch — it must be a new branch.
- NEVER skip `git fetch origin` — the worktree should branch from the latest remote state.
