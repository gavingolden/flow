# Repo-specific review checklist (flow)

Project-specific checks at the same standing as the lens checklists. Entries describe WHAT to look for; they never instruct a reviewer to skip files or suppress findings.

## Runbook shell-variable continuity (SKILL.md / references prose)

A `bash` block in a runbook (`skills/**/SKILL.md`, `references/*.md`) that reads `$SLUG`, `$PR`, `$WORKTREE`, or any other variable set in an EARLIER block silently expands it to empty at runtime — the supervisor runs each block as a separate Bash tool call. What to look for: any new or edited block that references a variable without (re)deriving it in the same block (e.g. `SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)` / `resolveSlugFromEnv` / `jq ... ~/.flow/state/"$SLUG".json`). Surfaced by Copilot on PR #666 (SKILL.md step 7 `waitForCopilot` read).
