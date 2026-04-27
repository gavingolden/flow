---
name: remove-worktree
description: >-
  Safely remove a git worktree and optionally delete its branch. Use when user
  says "remove worktree", "delete worktree", "clean up worktree", or "worktree
  cleanup".
disable-model-invocation: true
argument-hint: "worktree-path-or-branch [--delete-branch]"
---

# Goal

Safely remove a git worktree and optionally delete the associated branch.

# When to Use

- User is done with parallel agent work and wants to clean up the worktree
- User says "remove worktree", "delete worktree", "clean up worktree", "worktree cleanup"

# When NOT to Use

- If the worktree has uncommitted code changes — handle those manually first
- For creating a worktree — use `/add-worktree`

# Context

- `scripts/remove-agent-worktree.ts` — handles worktree removal and branch deletion
- `.env` and `.claude/settings.local.json` are symlinked (not copied) into worktrees,
  so no file sync is needed on removal

# Instructions

## 1. Identify the Worktree

- If `$ARGUMENTS` is provided, parse it as the worktree path or branch name. Include
  `--delete-branch` flag if present.
- If `$ARGUMENTS` is empty, ask the user which worktree to remove. Accept either:
  - A **path** (e.g., `../my-repo-improve-tooltips`)
  - A **branch name** (e.g., `agent/improve-tooltips`)
- Ask whether to **delete the branch** as well (default: no).

## 2. Run the Removal Script

- Execute:
  ```bash
  ./scripts/remove-agent-worktree.ts <worktree-path-or-branch> [--delete-branch]
  ```

## 3. Report Results

- Confirm the worktree was removed.
- If the branch was kept, remind the user to delete it later when ready.

# Verification

- Worktree has been removed (not listed in `git worktree list`)
- Branch status reported (deleted or retained)

# Constraints

- NEVER delete the branch without explicit user approval.
