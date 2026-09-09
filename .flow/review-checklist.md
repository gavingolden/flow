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

## Sibling-file term domains (PR #769)

- **A term's domain must match across sibling reference files.** When a skill defines a term in one file (a rider "shares root cause, surface/files, or review context"; an "invalid" argument value) and constrains it in a sibling (`SKILL.md`: riders share root cause, surface, or files; the fallback fires on "invalid"), flag any definition wider than, or left undefined by, its constraint — the run follows whichever file it read last.

## Revert PRs leave hand-written cross-references stale (PR #807)

- **Forward-looking plan docs must be re-derived against what the revert deletes.**
  When a PR reverts a feature, grep `.flow/epics/*/design.md` and `manifest.json`
  (and `docs/roadmap.md`) for acceptance criteria or dependencies naming an artifact,
  event, or helper the same PR removes (`workflow.result`, a deleted validator, a
  closed-unmerged PR's deliverable). A re-scoped downstream feature that still depends
  on a now-deleted producer is a defect in the plan, not a docs nit — the manifest
  validates fine because the schema does not know the producer is gone.
- **A doc that claims an exhaustive consumer list must be re-derived when a revert
  restores a call site.** Reference files enumerating "the N sites that link here"
  (`references/task-tool-exemption-preamble.md`, exemption ledgers, agent-site tables)
  go stale in BOTH directions: the port removed a consumer and the revert brings it
  back. Grep the repo for backlinks to the file and compare against its own list.
