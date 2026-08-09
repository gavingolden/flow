# Triage document template

**Default output path:** `.flow-tmp/triage/backlog-triage-<repo>-<YYYY-MM-DD>.md`,
overridable by an explicit path argument. See SKILL.md "Output path" for
the write-time ignore-ensure step. **Lifecycle note:** this document is a
point-in-time snapshot living in throwaway scratch. Inside a flow
pipeline worktree, `.flow-tmp/` is swept by `flow-remove-worktree` on
worktree teardown. In a plain consumer checkout — this skill's normal
habitat when run standalone — nothing sweeps it, and the write-time
ignore-ensure step also makes it invisible to `git status`, so it can
accumulate unswept and unseen. Either way, act on it in the same
session; to keep it, pass an explicit path up front or copy it out
(e.g. archive under `docs/triage/`).

The document body follows this exact section order.

## Executive summary

Lead with blockers and root-cause links — what's broken and what one fix
collapses multiple items. When grooming mode inferred a provisional
milestone (see `methodology.md` "Surfaced-never-silent milestone
inference"), state that inference here too.

## Closed / rescoped issues

Every issue closed or rescoped in this run, each with its justification
(PR/commit for ALREADY DONE, exact remainder for a rescope comment).

## Prod / CI health snapshot

Covers ONLY what was actually checked during Phase 1 — never a blanket
health claim beyond the verified subset.

## Launched or queued bundles

The DO bundles, each with its size, model/effort, and either "launched"
(milestone mode / opt-in) or "queued" (grooming mode default) disposition.

## Escalations

Numbered questions, each with a **recommendation first**, then the
options. Batch every open question here — never scatter them through the
document. When a milestone was inferred (see Executive summary), question
1 is always: "Confirm or strike the inferred milestone."

## Kill list

Every REJECT verdict, with its one-sentence reasoning, plus every NOT
REPRODUCIBLE IN CODE item flagged for the user to re-check. This section
is **required and non-empty** — a backlog that survives triage untouched
is a triage failure, not a clean backlog.

Each GitHub-issue kill-list entry renders its drafted comment as a
ready-to-run command:

```
gh issue close <n> --comment 'closing as won'\''t-do — <reason>'
```

This does not soften the staged-confirmation rule from `methodology.md`
Phase 4 — the skill never runs this command itself; the user running it
themselves IS the confirmation.

**Shell-safety contract (binds both this kill-list command and the queue
commands below).** `<reason>` and every other interpolated value
(issue titles, note text, bundle titles) is untrusted backlog content —
it can contain `$(...)`, backticks, `$VAR`, `\`, or a bare `"`. Never
interpolate it inside double quotes. Always single-quote it, escaping
any embedded single quote as `'\''` (close-quote, escaped literal quote,
reopen-quote) — the form shown above. This is stricter than, and
supersedes, a "no backticks" rule scoped only to backticks: a
double-quoted `$(...)` or `$VAR` is exploitable with zero backticks
present.

## Disposition table

The full, lossless disposition table. Columns, exactly:

| Ref | Item (short) | Source | Verification | Class | Verdict | Bundle | Reasoning |
| --- | ------------ | ------ | ------------ | ----- | ------- | ------ | --------- |

Row count MUST equal `N+M` from the Phase-0 `Inventory: <N> issues, <M>
notes` line (see `methodology.md` "Phase 0").

## Residue

The verbatim residue section: blank, struck-through, already-rejected, or
externally-referenced items that were never guessed at.

## Queue section (inside "Launched or queued bundles")

**Queue-seed contract**, every emitted command:

- Names the filed bundle issue as design of record — `implement bundle
issue #N — <short title>` — with the full verified evidence living in
  that issue, never restated inline where it would go stale.
- Carries `--tmux` (a plain-backend launch refuses to run off a TTY) and
  an explicit `--slug <bundle-slug>`.
- Contains ZERO backticks in the command text (the fenced/indented block
  around it is display syntax only and does not count).
- Single-quotes the description, per the shell-safety contract above —
  bundle titles are drawn from untrusted issue text.

Shape (see `methodology.md`'s size→model ladder for the full table):

    flow feature create --tmux --model opus --effort low --slug bundle-slug 'implement bundle issue #N — short title'

**Decision-parameter rendering.** A DO bundle carrying a fire-time
parameter renders it inside the quoted description with an explicit
`<value required>` placeholder, plus a one-line note that the command is
not runnable until the user supplies the value.

The queue section CLOSES with a cross-bundle sequencing / surface-overlap
warning list: which bundles touch the same files, and the recommended run
order — so two bundles that would conflict are never launched
concurrently by accident.

## Self-check

Fill this in while generating the document — it is the runtime-visible
half of enforcement (a prose lint cannot police runtime behaviour):

- Kill list non-empty: YES/NO
- Disposition rows == N+M: YES/NO
- Every DO-LATER has a promotion trigger: YES/NO
- Any hedged-completion phrasing used: YES/NO
- Every queue command carries --tmux and --slug, zero backticks, and
  single-quoted interpolated values: YES/NO
- Any hybrid verdict used: YES/NO
- Inferred milestone surfaced as first escalation (or N/A): YES/N-A/NO

## Chat summary shape

After writing the document, summarize in chat: outcome first, then all
blocking questions batched at the end, each with a recommendation.
