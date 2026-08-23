# Repo-specific review checklist

Project-specific patterns surfaced by `/flow-pr-review` retrospectives. Each entry
names WHAT to look for; entries never suppress findings.

## SKILL.md prose as code (PR #664)

- **New helper flag → every call site.** When a PR adds a flag to a `bin/` helper
  (e.g. `--tldr`, `--untracked-file`), grep every `flow-<helper> --status` invocation
  in `skills/**/SKILL.md` and `references/*.md`; a site that documents a slot but
  does not pass the input that renders it is a defect, not a docs nit.
- **Renderer consumes every documented input.** A pure renderer (`renderAwaitingApproval`
  etc.) that ignores an input the prose says it renders is the same defect on the code side.
- **Seed/append commands must be idempotent on re-entry.** Any SKILL.md step that
  appends to persistent state (`flow-untracked add`, `flow-followups add`) runs again on
  resume and fix loops; check for dedup in the helper or a guard in the prose.
- **Standalone-mode guard.** A `/flow-pr-review` / `/flow-verify` step that needs a
  pipeline slug or `state.json` must be guarded (named no-op) — these skills run standalone.
- **Worked examples agree with definitions.** A calibration example in a contract
  file must not use a form the definition above it forbids.

## Runbook shell-variable continuity (PR #666)

- **Shell variables do not persist across bash blocks.** A `bash` block in a runbook
  (`skills/**/SKILL.md`, `references/*.md`) that reads `$SLUG`, `$PR`, `$WORKTREE`, or
  any other variable set in an EARLIER block silently expands it to empty at runtime —
  the supervisor runs each block as a separate Bash tool call. Flag any new or edited
  block that references a variable without (re)deriving it in the same block.
