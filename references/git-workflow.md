# Git workflow deep-dives

Offload target for `AGENTS.md` `## Git workflow` mechanics and several
`## Don'ts` bullet bodies that need a durable home but must not become a
new `## ` section in [exemption-contracts.md](exemption-contracts.md) —
that file's h2 sections are pinned 1:1 to the nine Task-tool exemptions
by `bin/skill-md-lint.test.ts`.

## Session marker + trailer mechanics

Every PR `flow-open-pr` freshly creates inside a Claude Code harness ends
with a single-line, self-describing HTML-comment marker —
`<!-- flow: this PR was created by Claude Code session <id> - transcript
at ~/.claude/projects/<encoded-cwd>/<id>.jsonl on the originating machine
-->` — sourced from the `CLAUDE_CODE_SESSION_ID` env var. It is
best-effort and same-machine-only; absent the env var the PR opens with
no marker. Because the marker is an HTML comment it is invisible in
GitHub's rendered view and stripped by the auto-merge gate before it
counts unchecked `- [ ]` items.

The marker is lost from `git history` on squash-merge, so the same
session ID also reaches `git log` / `git blame` as a
`Claude-Code-Session-Id:` trailer — but via a per-commit git hook, not
step 10. `flow-new-worktree` installs a worktree-scoped
`prepare-commit-msg` hook (scoped via `extensions.worktreeConfig` + a
worktree-scoped `core.hooksPath` so it never fires for the user's primary
repo) that appends `Claude-Code-Session-Id: <id>` to **every individual
commit** made in the worktree when `CLAUDE_CODE_SESSION_ID` is set. gh's
default squash concatenation of the branch's commit messages then carries
the trailer into the squash-merge commit — `/flow-pipeline` step 10 runs
a bare `gh pr merge --squash` with zero `--body` manipulation. The
optional `sessionId` field in `~/.flow/state/<slug>.json` is still
written by `flow-open-pr` for the HTML-comment marker path, but step 10
no longer reads it.

### Why no authored squash body (issue #486)

PR #213 removed an earlier `--body` composed FROM THE PR DESCRIPTION
because it landed the description's `## Why` / `## What` markdown
headings verbatim in `git log` — its stated goal was for the squash
body to read as concatenated conventional commits instead, which the
bare `gh pr merge --squash` above delivers by construction (gh's
default concatenation of the branch's own commit subjects).

Issue #486 re-raised this: the merge-resolver's `chore: merge
origin/<base> into <branch> to resolve conflicts` commit is itself a
conventional commit, so it already satisfies that goal — but #486's
underlying premise, that this line actually leaks into a later PR's
default squash body as noise, is UNDETERMINED. No authoritative GitHub
documentation confirms or denies it either way for this repo's history.

Weighing against implementing it: GitHub composes the squash body
server-side when no `--body` is passed (`setCommitBody: false`),
appending a `---------` separator and a collected `Co-authored-by:`
footer that a client-side `--body` would have to replicate by hand.
Passing `--body` flips `setCommitBody: true` and replaces that whole
server-side composition, suppressing any forge-appended trailer for
every consumer repo — observably the `Co-authored-by:` collection, and
plausibly (on GitHub Enterprise) a DCO `Signed-off-by:` or other policy
trailer. That GHE consequence is recorded here to weigh, not verified
against a real GHE instance.

Decision: wontfix, with a deliberately LOW-BAR re-open trigger — a
single observed `* chore: merge origin/...` line inside a squash body
on `main` is sufficient to re-open; no one needs to first argue it is
noise.

**Settled (2026-08-02), issue #486 closed as not-reproducible.** PR #500's
branch carried 26 commits including two merge commits, one matching the
resolver's exact predicted subject:

```
177a06c4c Merge remote-tracking branch 'origin/main' into merge-resolver-marker…
507bb52a5 chore: merge origin/main into merge-resolver-marker-and-squash-body
```

Its squash-merge commit on `main` (`6fb1ce0`) contains exactly 24 `* `
lines — 26 minus the two merge commits, both excluded from the squash
body by construction. A sweep of every squash commit on `main`
(`git log --format=%H main`, grepping each commit's full body for a
leading `* chore: merge origin/` or `* Merge remote-tracking branch` /
`* Merge branch` line) found zero matches across the repo's history.

This settles both the general premise (do merge-commit subjects enter
GitHub's default squash body at all) AND the resolver's exact subject
line — the caveat in the prior "Observed" paragraph, that only the
general case had been tested, no longer applies. The low-bar re-open
trigger has not fired and the evidence available says it structurally
cannot: GitHub's squash-body composition already excludes merge commits'
own subjects from the concatenated list. Re-open only on a genuine
future observation of `* chore: merge origin/...` noise in a squash body
on `main`, per the original low-bar trigger.

## Base-branch guard

`flow feature create` best-effort-installs a `pre-commit` hook
(`installBaseBranchGuard` in `bin/lib/base-branch-guard.ts`) that refuses
a commit landing directly on the repo's default branch. It is narrowed by
**two session gates**, both required: `CLAUDE_CODE_SESSION_ID` (set by
Claude Code) AND a flow slug, resolved env-first from `FLOW_SLUG` and
falling back to the tmux `@flow-slug` pane option. Without both, the
user's own hand-driven commits — including a manual commit on `main` — are
never blocked; the guard only ever fires inside a flow-supervisor session.

**Ownership and versioning.** The hook body opens with a self-identifying
marker, `# flow:base-branch-guard v<N>` (`BASE_BRANCH_GUARD_MARKER` +
`BASE_BRANCH_GUARD_VERSION`), matched by substring-contains rather than a
byte-exact compare — a byte-exact compare misclassified a still-installed
older hook body as a foreign hook forever instead of upgrading it in
place. Three prior bodies (v1: tmux-only, pre-marker; v2: env-first
`FLOW_SLUG`, pre-marker; v3: marker-carrying, path-scoped epic-status
carve-out) are registered in `LEGACY_HOOK_BODIES` and still classify as
flow-owned. **Any edit to the hook body requires bumping
`BASE_BRANCH_GUARD_VERSION` AND registering the prior body** in
`LEGACY_HOOK_BODIES` plus a matching `bin/fixtures/<role>-guard-v<N>.sh`
fixture — `base-branch-guard.test.ts`'s `version-drift lock` enforces this
mechanically and never downgrades a hook carrying a newer marker version
than the running flow build.

**Target resolution.** `bin/lib/hooks-target.ts`'s `resolveHooksTarget`
installs into the repo's **main worktree** — never the ephemeral
per-worktree checkout a pipeline runs from — honouring an absolute or
relative `core.hooksPath`. A husky-managed hooks dir (its generated `_`
subdirectory) is always treated as foreign: husky regenerates `_` on every
run, so anything flow wrote there would be silently destroyed.

**Foreign-hook path.** When the repo's `pre-commit` is not flow's (a
genuine user hook, or husky), nothing is written into the repo. The guard
is instead ensured at a machine-global sidecar,
`~/.flow/hooks/base-branch-guard.sh`, and a one-line, source-safe opt-in
snippet is printed to stderr so it can be pasted into any pre-commit hook
— including a tracked, team-shared one — without breaking a teammate who
doesn't have flow installed.

**Contrast with the session-trailer hook.** This is the deliberate
opposite polarity of the `prepare-commit-msg` hook described just above:
that hook resolves the WORKTREE-scoped `core.hooksPath` because the
session-id trailer must apply only inside one worktree, while the
base-branch guard resolves the MAIN worktree because it must protect the
base branch's own checkout regardless of which worktree
`flow feature create` runs from. The two installers look symmetric on
purpose — they are not meant to be unified.

### Auto-commit exemption: flow-epic-sync --commit

The v4+ base-branch guard allowlist carves out exactly one narrow shape,
CONDITIONAL on the hook actually installed in the repo: a commit whose
entire staged set matches `.flow/epics/<epic>/status.json` is let through
on the base branch inside a flow session only when the installed hook is
v4-or-newer, mirrored in TS by `isCommittableOnBaseBranch`
(`bin/lib/base-branch-guard.ts`) and re-exported from
`bin/lib/epic-metadata-commit.ts`. `installedGuardCapability` (same file)
is the SINGLE producer both `bin/flow-stop-guard.ts` (route-naming) and
`commitEpicStatus` (the actual commit, including its self-heal of an
outdated flow-owned hook) read — the guard's promise and the helper's
outcome cannot diverge, because there is exactly one source of truth for
"does the installed hook honor this allowlist." An outdated flow-owned
hook (v1–v3, or a marker-bearing-but-unbumped intermediate) is upgraded
in place at commit time, gated on the on-disk body being byte-identical
to a body flow has ever shipped — a hand-edited hook is left untouched
and the commit falls through to `commit-refused` instead. A foreign or
husky-managed hook is never touched, and the stop guard downgrades to a
diagnostic (exit 0) rather than naming an unsatisfiable route. The board
qualifies where
`manifest.json` does not: it is machine-derived (`deriveBoard` in
`bin/flow-epic-sync.ts`, never hand-authored), one-way-latched
(`advanceStatus` — a shipped row never regresses), canonically serialized
(`serializeEpicStatus` — a byte-stable diff), and fully re-derivable with
`--rederive` — so a wrong commit is mechanically repairable, not a
judgment call that deserves review. `manifest.json`, `design.md`, and every
other epic-metadata path stay on the authored-scope side: they deserve
review, so they keep the branch-and-PR route (see `flow-epic-run`'s
amend-manifest recipe).

The commit itself is PATH-SCOPED — `bin/lib/epic-metadata-commit.ts`'s
`commitEpicStatus` runs `git add -- <path>` then `git commit -m <msg> --
<path>`, never a bare, whole-index `git add` followed by a bare
`git commit` — so an unrelated file some other actor left staged can never
join the board commit and get swept through the allowlist alongside it.
The rendered sh hook additionally runs a jq-gated staged-content sanity
check on the allow path only (parses each staged board with `jq -e .`,
refusing a malformed one), fail-open when `jq` is absent — this check must
never reach, let alone block, the common non-flow commit path. Every other
`.flow/epics/**` path — and every path outside `.flow/epics/` entirely —
still hits the verbatim two-line refusal unchanged.

Which board a `--commit`/`--push` invocation acts on is resolved
cwd-PREFERRED, not cached-only: `flow-epic-sync.ts` tries a manifest inside
the operator's OWN cwd repo first (falling through to the cached
`manifestPath` when the cwd carries no such epic, and finally to an
unconditional cwd-derived path when there is no cached `manifestPath` at
all) — a stale cached path can then only ever be the write target when the
operator's own repo has nothing to offer, and the pre-write containment
gate below still refuses that fallback if it lands outside the operator's
repository. Read-only invocations (`--check`/`--json`/a bare derive) skip
the cwd preference and resolve cached-first, unconditionally falling back
to the cwd-derived path only when no cached `manifestPath` exists.

The write itself, and the commit and push that follow it, all refuse with
`foreign-repo` when the resolved board path is not inside the current
directory's repository, so a stale absolute `manifestPath` cached in
`~/.flow/epics/<slug>/run.json` can never write, commit, or push into
another checkout. Containment compares `git rev-parse --git-common-dir`
(`resolveGitCommonDir` in `bin/lib/repo-root.ts`), not `--show-toplevel`,
so sibling git worktrees of the same repository are NOT foreign — only a
genuinely different repository is refused.

### Auto-push exemption: flow-epic-sync --push (and flow epic done's board heal)

Narrower than the `pr-review` auto-push exemption above: `--push` targets
only a branch that ALREADY EXISTS on origin (`bin/lib/epic-metadata-commit.ts`'s
`pushEpicStatus` gates on `git ls-remote --exit-code --heads origin <branch>`
before ever pushing), never `--force`/`--force-with-lease`/`-f`, never
`-u`/`--set-upstream`, never creating a remote ref, and never opening a
GitHub object of any kind.

The base-branch-only gate is not a style preference: `git push origin
HEAD:<branch>` publishes **every** local commit on that branch, not just
the board commit, so from a mid-implementation feature-pipeline worktree —
where the branch already exists on origin, so the no-remote-branch gate
does not catch it — an ungated `--push` would publish unverified code past
the pipeline's own verify/CI gate. `--push` therefore only ever runs when
the current branch equals the repo's resolved default branch, AND
`pushEpicStatus` additionally diffs `<remote-sha>..HEAD` (via `git diff
--no-renames --name-only`, `--no-renames` for the same allowlist-escape
reason as the base-branch-guard hook) through `isCommittableOnBaseBranch`
before pushing — if that local-vs-remote delta carries anything beyond
the allowlisted board path, the push bails with `extra-local-commits`
rather than publishing it.

Every failure mode (`not-committed`, `detached-head`, `not-base-branch`,
`no-remote`, `no-remote-branch`, `non-fast-forward`, `push-failed`,
`extra-local-commits`, `foreign-repo`)
is a stderr warning plus an envelope field — never a retry, and never a
forced push. A
`non-fast-forward` is reported with the exact remedy `flow-epic-sync`
names on stderr: run `git pull --rebase` and re-run with `--push`; the
caller then abandons the attempt rather than looping. `flow epic done`'s
close-out heal (`healCommittedStatusBeforeArchive` in `bin/lib/epic.ts`)
pushes its board write unconditionally — no `--push` flag gates it —
because `flow epic done` is a human-typed verb: invoking it **is** the
instruction, and it runs at the last moment anyone looks at this board
before `deleteEpicRunState` drops the per-machine run-state cache that
both writers depend on. Neither the commit nor the push can block the
archive; only the reported message degrades.

## Inline intent annotations

Review-time-scoped per-hunk rationale from `/flow-new-feature` Step 5b as
inline PR-diff comments (`**why:** <1-2 sentences>` + `<!--
flow-intent-v1 -->` suffix, disjoint from `/flow-pr-review`'s Conventional
Comments vocab; a fix-shaped hunk states the causal pair — what was wrong
and why this edit fixes it — within the same cap). Not in `git
log`/`git blame` post-merge — durable
rationale belongs in commit-body Why-sections + PR body's `## Why`, with
the exception of surplus (capped-out) hunks: those are pointed at the
commit messages via an `overflowNote` callout appended to the END of the
PR body (outside `## Why`) rather than inlined under it. See
`skills/pipeline/flow-new-feature/SKILL.md` Step 5b (rules a/b/c,
per-file dedup, floor/ratio/ceiling scaling cap — `flowAnnotatePr`
override in `~/.flow/config.json`, `overflowNote`) and
`skills/pipeline/flow-pr-review/SKILL.md` Step 3 for `/flow-pr-review`'s
`{{EXISTING_INTENT_COMMENTS}}` consumption.

## Shared rationale for the nine Task-tool exemptions

`/flow-pipeline`'s "Hard rules" forbid the supervisor from calling the
`Task` / `Agent` tool, with nine named exceptions. The same rationale
covers all nine: (a) the supervisor is itself a top-level Claude Code
session at depth 1, so its own Task calls are never themselves nested;
flow chooses flat one-shot
fan-out even though nesting is now platform-possible — with one
sanctioned nested site, verify-loop → edit-applier, inside the
Verify-Retry-Loop exemption; (b) each subagent is one-shot (returns an artifact + brief
summary, then exits), so the context-bloat constraint doesn't apply
either; (c) every exemption is anchored on its step _heading name_, not
its number, so it survives renumbering; (d) every exemption is documented
bidirectionally in `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules"
and the consumed skill's own SKILL.md; (e) the narrow-and-named-contract
discipline applies — each names exactly one spawn site, and a future
skill needing the same license must be added here by name rather than
generalising the rule. Each exemption's unique contract — spawn site /
triggering step, artifact path, typed artifact fields, model override,
edge-case prose — lives in
[exemption-contracts.md](exemption-contracts.md).

## AskUserQuestion exemption bodies

**Step 9 gate-override sub-step.** The single confirmation form fired
during step 9's "Gate override (post-verdict, opt-in)" sub-step, when the
user instructs the supervisor to merge a `gated` PR anyway — a _fresh_
confirmation that puts the gate verdict in front of the user rather than
inferring authorisation from an earlier instruction. An affirmative
answer is recorded by `flow-merge-guard --record-override` and enforced
by the step-10 backstop.

This named form is the **only** authorised `AskUserQuestion`
site, documented bidirectionally with
`skills/pipeline/flow-pipeline/SKILL.md`. Candidate follow-up issues are
no longer curated via a form: discovery lists them in the plan, ticked
only when the value-prop block clears the bar,
and the user curates by replying `drop candidate #N` / `drop all
candidates` / `file candidate #N` / `defer task #N` at plan review
(step 4) rather than answering a multi-select.

## Auto-merge exemption detail (`/flow-pipeline` step 10)

The exemption covers exactly one operation: `gh pr merge --squash <PR>`
inside step 10, only when the auto-merge gate fires (`flow-gate-decide`
returns `auto-merge` — the Test Steps section has zero unchecked items)
and only on a PR opened by `/flow-pipeline` itself. It does **not**
extend to a `gated` verdict: a `gated` verdict is terminal, and a `gated`
PR is merged by `/flow-pipeline` only through the fresh-confirmation
gate-override path (a new, unambiguous, in-context user instruction
confirmed via `AskUserQuestion`, recorded by `flow-merge-guard
--record-override`, enforced by the `flow-merge-guard` step-10 backstop).
The supervisor may never substitute its own judgment for a `gated`
verdict — see
`skills/pipeline/flow-pipeline/references/auto-merge-rubric.md` "A
`gated` verdict is terminal, not advisory".

**Anti-patterns this exemption explicitly forecloses:** (a)
reclassifying an unchecked functional Test Steps item as "subjective UX"
so the gate verdict comes out as `auto-merge`; (b) merging a `gated` PR
on the strength of a stale or inferred "merge" / "ship it" instruction
given before the gate verdict was surfaced.

Invoking `/flow-pipeline` is itself the user's authorisation; opt out
per-pipeline with `flow feature create --no-auto-merge` (the supervisor
stops at the gated state regardless of the gate verdict).

## Auto-issue-create exemption detail

`flow-create-issue` may fire only from two named sites: (a)
`/flow-pr-review` deferring a finding past the 3-criterion bar
(`--label flow-agent,deferred-review`), and (b) `/flow-pipeline` step
10's post-merge sweep (`--label flow-agent,out-of-scope-discovery`, once
per `- [x]` candidate in plan.md). Indiscriminate auto-creation pollutes
backlogs and races on `gh` rate limits. Feature and `route-to-step-4`
pipelines curate the ticked set at plan review (candidates are ticked
only when their value-prop block clears the bar, and the `--details`
echo plus the `drop candidate #N` / `file candidate #N` / `pull #N into
the plan` reply verbs let the user drop, file, or
defer any it doesn't want before approval); step 3's `advance-to-step-5`
route has no plan-review checkpoint, so its ticked candidates and
bundled tasks proceed as discovery authored them, disclosed post-hoc in
the PR body and the terminal recap, with post-merge off-ramps (revert a
bundled line, close an unwanted issue) as the correction path. Documented
bidirectionally in
`skills/pipeline/flow-pipeline/SKILL.md`,
`skills/pipeline/flow-pr-review/SKILL.md` Step 6, and
`bin/flow-create-issue.ts`.

## `/flow-epic-create` and `/flow-epic-run` detail

`flow epic create` spawns a fresh top-level `/flow-epic-create` session,
so `/flow-pipeline`'s exactly-9 and one-form rule are unaffected by its
two named surfaces (distinct openers, in
`skills/pipeline/flow-epic-create/SKILL.md`): **Task-tool fan-out:
`/flow-epic-create` → /flow-product-planning MODE: epic designer.** and
**AskUserQuestion form: `/flow-epic-create` clarification round.** Its
cross-model design review is a Bash fan-out, not a tenth exemption —
`review.gemini`-gated `flow-plan-review` over `design.md`; no Task, no
form; graceful skip sans agy.

`flow epic run <slug>` opens a fresh `/flow-epic-run` playbook session
(invariants unaffected) — a playbook, not a loop: an LLM reconciles the
manifest against GitHub/git truth and repairs run.json drift via
`flow epic bind` / `flow epic launch`, one human-in-the-loop step at a
time. Zero named fan-out: no Task/Agent sub-agent, no AskUserQuestion
form. `gated ⇒ escalate-only`, never merges a feature PR.
