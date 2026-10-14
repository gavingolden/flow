# Hard rules — detail

The elaboration of each hard rule in `SKILL.md`, moved unchanged. The bold rule sentence stays in `SKILL.md`; what followed it on the same line or in the lines after is here, under a heading naming the rule. This skill's verification list is parked at the end verbatim.

Contents: Sub-agent rule: the rest of the flat-fan-out rationale · Load the Task tool at each spawn site · Detail of exemption 1 · Detail of exemption 2 · Detail of exemption 3 · Detail of exemption 4 · Detail of exemption 5 · Detail of exemption 6 · Detail of exemption 7 · Detail of exemption 8 · Gemini cross-model lens note · Step-3 cross-model plan review note · Step-3 blind method survey note · Headless Claude note · Never bypass the helper scripts · AskUserQuestion: the one named form · Auto-created GitHub issues · Never edit code in the main repo worktree · Never rename or switch branches · Scratch files under .flow-tmp · Anchor tmux self-queries on TMUX_PANE · Verification (this skill)

## Sub-agent rule: the rest of the flat-fan-out rationale

> Each is anchored on its step heading name rather than its number
> so it survives future renumbering. Same narrow-and-named contract as the
> `/flow-pr-review` auto-push and `/flow-pipeline` auto-merge exemptions
> in `.claude/rules/flow-supervisor-contracts.md`. If a future skill needs the same license, add it here
> by name rather than generalising the rule. Each exemption spawns its
> named `agents/flow-*.md` definition via a file-exists guard, addressing
> a plugin-root definition by the plugin-qualified `flow-module-core:<agent>`
> name (a bare agent name fails Task-tool resolution outright on a
> plugin-root install), falling back to `general-purpose` with a loud
> `NOTICE — agent-fallback:` line when the definition is not installed.

## Load the Task tool at each spawn site

> Each of the eight spawn
> procedures below must instruct the supervisor to load the Task tool
> schema via `ToolSearch query="select:Task"` *before* invoking Task (or
> its alias `Agent`). Where neither is surfaced top-level by the harness
> (aliases of the same one-shot subagent-spawn primitive), an unguarded
> invocation silently falls through to in-line execution — the regression
> PR #124 introduced and this preamble prevents. On missing schema,
> escalate `NEEDS HUMAN: task-tool-unavailable: <exemption-name>` rather
> than falling back to in-line execution. See each exemption's spawn procedure
> for the canonical "Load the Task tool before spawning" paragraph and
> `# Failure paths` for the escalation script.

## Detail of exemption 1

> Step 8's up to seven review agents (the seventh, `product`,
> brief-gated) + one diff-only intent-guess agent,
> spawned together ([references/exemption-contracts.md](../../../../references/exemption-contracts.md)).

## Detail of exemption 2

> Step 3's one discovery agent (`flow-discovery`), writing
> `.flow-tmp/plan.md` + `.flow-tmp/pr-description-draft.md`; plus, when a
> product brief resolves, one blind product critic (`flow-product-critic`,
> tools Read/Write, never repository code) spawned by step 3 after the
> wrapper returns, writing `.flow-tmp/product-critique.md` — same
> exemption, no nesting; full contract in
> [references/exemption-contracts.md](../../../../references/exemption-contracts.md).

## Detail of exemption 3

> Step 5's one scout agent (`flow-scout`; wider-scope path
> only — ≤3 affected files skip it), writing `.flow-tmp/scout.md`; full
> contract in [references/exemption-contracts.md](../../../../references/exemption-contracts.md).

## Detail of exemption 4

> Step
> 8's one fix-applier agent (`flow-fix-applier`) for the per-finding
> address loop + commit/push, writing `.flow-tmp/fix-applier-result.json`;
> full contract in [references/exemption-contracts.md](../../../../references/exemption-contracts.md).

## Detail of exemption 5

> Step
> 10's one resolver agent (`flow-merge-resolver`) for the base-branch
> merge + per-file resolution + push (per-pipeline branch only), writing
> `.flow-tmp/merge-resolver-result.json`; full contract in
> [references/exemption-contracts.md](../../../../references/exemption-contracts.md) and
> `../flow-merge-resolver-instructions/SKILL.md`. `maxTurns: 80`; partial-result continuation per `references/partial-result-continuation.md`.

## Detail of exemption 6

> The one edit-applier agent (`flow-edit-applier`) `/flow-coder` spawns when
> `/flow-new-feature` step 5, `/flow-verify` step 3, or `/flow-refactoring` step 3
> takes its wider-scope path — or the `/flow-pipeline` supervisor's interactive
> code-change redirect path fires (see the "Mid-flight code-change redirects"
> section and `references/redirect-handling.md`) — writing
> `.flow-tmp/coder-result.json`; full contract in
> [references/exemption-contracts.md](../../../../references/exemption-contracts.md) and `skills/pipeline/flow-coder/SKILL.md`.

## Detail of exemption 7

> `/flow-pr-review` Step 3.5's one consolidator-validator agent
> (`flow-consolidator`; default Sonnet, no model override), writing
> `.flow-tmp/consolidator-result.json`; full contract in [references/exemption-contracts.md](../../../../references/exemption-contracts.md).

## Detail of exemption 8

> Step 6's one browser-drive agent (`flow-ui-driver`), spawned only on a
> `ran:true`/`bootstrap` `flow-ui-validate` verdict (never on an
> `mcp-not-available` / `browser-profile-busy` skip), for the per-route ×
> per-viewport `chrome-devtools` drive, writing
> `.flow-tmp/ui-driver-result.json`; resolves `config.models.uiDriver //
> "sonnet"` — config-only, never inherited; full contract in
> [references/exemption-contracts.md](../../../../references/exemption-contracts.md).

## Gemini cross-model lens note

> When the supervisor invokes `/flow-pr-review` in step 8
> and the consumer has opted into `review.gemini`, `/flow-pr-review` Step 3
> runs ONE additional cross-model reviewer (Gemini) via `flow-delegate`
> (agy) as a Bash subprocess (`flow-gemini-lens`), ALONGSIDE exemption
> #1's seven-agent Multi-Agent Review Task fan-out. It spawns no Task, so
> the eight-exemption count above is unchanged — this is a sibling note in
> the same F2 "not an eighth exemption" shape as the "Load the Task tool at
> each spawn site" guard above, NOT an `#8` exemption block. The lens is
> config-gated, default off, and a graceful skip on any failure (it never
> hard-fails the review). Documented bidirectionally in `.claude/rules/flow-supervisor-contracts.md`
> `## Don'ts` and `skills/pipeline/flow-pr-review/SKILL.md` Step 3.

## Step-3 cross-model plan review note

> When the consumer has opted into `review.gemini` and plan.md
> carries a `## Decision analysis` section, step 3 runs ONE cross-model plan
> reviewer (AGY / Gemini) via `flow-delegate` as a Bash subprocess
> (`flow-plan-review`) to pressure-test the PRD's consequential decisions
> before the plan-pending-review gate. It spawns no Task, so the
> eight-exemption count above is unchanged — a sibling note in the same F2
> "not an eighth exemption" shape as the Gemini-lens note above, NOT an `#8`
> exemption block. It reuses the SAME `review.gemini` gate key, is default
> off, and gracefully skips on any failure (it never blocks the plan gate).
> Documented bidirectionally in `.claude/rules/flow-supervisor-contracts.md` `## Don'ts` and this file's
> step 3.

## Step-3 blind method survey note

> Before forced research and
> discovery, step 3 runs two model-pinned agy judges over a goal-only
> brief (`flow-blind-survey`) via `flow-delegate-fanout` as a Bash
> subprocess. It spawns no Task — a sibling note in the same F2 shape as
> the two notes above, NOT an `#8` exemption. Gated on `state.interview`
> non-empty; gracefully skips on any failure. Documented bidirectionally
> in `.claude/rules/flow-supervisor-contracts.md` `## Don'ts` and `references/blind-survey.md`.

## Headless Claude note

> Any skill the supervisor loads — including
> consumer-repo skills invoked during implement — may run a fixed-model,
> fixed-effort `claude -p` ONLY through `flow-claude-headless`, which
> allowlists the child env (`FLOW_SLUG`/`TMUX_PANE` never leak, issue
> #618), caps spend, refuses to nest, and returns one envelope carrying
> `total_cost_usd`. It spawns no Task, so the eight-exemption count is
> unchanged. Documented bidirectionally in `.claude/rules/flow-supervisor-contracts.md` `## Don'ts` and
> `references/headless-claude.md`.

## Never bypass the helper scripts

> Always call
> `flow-new-worktree`, `flow-remove-worktree`,
> `flow-fetch-pr-review`, `flow-reply-pr-comments`, and
> `flow-followups` rather than reimplementing their behaviour with
> raw `git` / `gh` calls. The helpers handle edge cases (existing
> worktrees, branch collisions, review-comment ID mapping,
> allowlist enforcement on auto-run) that are easy to get wrong.

## AskUserQuestion: the one named form

> There is
> no candidate-issues form: discovery lists follow-up candidates in
> the plan, ticked (`- [x]`) only when their value-prop block clears the
> bar, and the plan-review checkpoint (step 3's `--details`
> disclosure, step 4's `drop candidate #N` / `drop all candidates` /
> `file candidate #N` / `defer task #N` replies) is the single curation
> surface — a mechanical
> reply-and-helper loop, never a form. Same narrow-and-named contract as
> the Task-tool exemptions above: `AskUserQuestion` is a different
> primitive (synchronous user prompt, not a sub-agent fan-out), but a
> small named set keeps the supervisor's user-prompt surface auditable.
> This form is the **only** authorised user-prompt surface — no other
> skill or step may call `AskUserQuestion`. If a future skill needs the
> same license, add it here by name rather than generalising the rule.

## Auto-created GitHub issues

> `flow-create-issue` may fire only from (a) `/flow-pr-review`'s Step 6
> deferral path (including the fix-applier's single consolidated issue when a PR
> merges mid-review — the same deferral path under a mandatory trigger), (b) `/flow-pr-review`'s Step 5 retrospective generic-gap
> capture, (c) `/flow-pipeline`'s Step 10 post-merge sweep (one issue per
> `- [x]` item in plan.md's `# Candidate follow-up issues` section), (d) a
> user-instructed `flow-untracked file <n>` reply, and (e) the
> `/flow-file-issue` skill's hand-filed path. A new fire site needs a named
> exemption in `.claude/rules/flow-supervisor-contracts.md` "Don'ts" first — same narrow-and-named contract
> as the auto-merge and Task-tool exemptions — because indiscriminate issue
> auto-creation pollutes user backlogs with low-confidence noise and races
> on `gh` rate limits.

## Never edit code in the main repo worktree

> Every code
> change happens inside the per-task worktree directory created by
> `flow-new-worktree` in step 2 (the absolute path the helper prints,
> exposed as `$WORKTREE` in this skill). The main worktree is
> read-only from this skill's perspective.

## Never rename or switch branches

> Branch renames and cross-branch switches
> are the failure mode that opened the door to the 2026-05-01
> worktree-contamination incident: a peer supervisor renamed this
> pipeline's branch and committed its own work into this worktree.
> The supervisor only operates on its own pipeline's branch, captured
> at step 2 from `flow-new-worktree`'s output. If a phase ever needs
> to switch branches, that's a sign of confusion — escalate
> `NEEDS HUMAN: cross-branch-operation-attempted` instead. The
> mechanical guard in `flow-state-update` will also refuse the next
> phase transition (`branch-mismatch`), but don't rely on the guard
> as a license to run the dangerous command in the first place.

## Scratch files under .flow-tmp

> Every
> transient file the supervisor or a sub-skill produces — PR body
> drafts, commit-message scratch, intermediate logs, mocked-input
> fixtures — lives at `$WORKTREE/.flow-tmp/<name>` rather than `/tmp/`.
> `/tmp` is shared across every parallel pipeline on the host and was
> the source of the Item 7 cross-pipeline body-file overwrite (PR opened
> with stale content from another window's prior session). The
> per-worktree path inherits the worktree's isolation guarantees for
> free. The directory is created lazily by whoever writes first
> (`mkdir -p "$WORKTREE/.flow-tmp"`); cleanup is automatic — `git
> worktree remove` (run by `flow-remove-worktree` after step 10's
> merge) deletes the whole worktree tree, scratch dir included. The path is registered
> in the worktree's per-checkout `.git/info/exclude` by
> `flow-new-worktree`, so it stays untracked without polluting the
> consumer repo's `.gitignore`.

## Anchor tmux self-queries on TMUX_PANE

> When you need
> to read or target your own tmux window — pane id, window name,
> session name, sending keys to yourself, gating logic on "is this
> me?" — pass `-t "$TMUX_PANE"` to every `tmux` invocation.
> Untargeted queries like `tmux display-message -p '#S:#W'` or format
> strings like `#{session_name}` resolve against tmux's *current
> client* — whichever window the user most recently activated — which
> races across parallel pipelines and silently returns another
> supervisor's identity. `$TMUX_PANE` is set by tmux at process spawn
> and is immutable for the life of this process; it is the only safe
> self-anchor. Different failure family from the `git branch -m` rule
> above (it would not have prevented 2026-05-01) but adjacent — both
> are parallel-pipelines self-identification hazards.

# Verification (this skill)

After each phase transition:

- `~/.flow/state/<slug>.json` reflects the new `phase`, the populated
  `worktree` (post-step-2) and `pr` (post-step-5) fields, and a
  fresh `updatedAt`.
- `flow ls` (run from a terminal inside this pipeline's repo, or with
  `--all-repos` from anywhere else) shows the right phase **and PR
  number** for this pipeline's window.
- The supervisor never invoked the `Task` / `Agent` tool, **except**
  via the eight named exceptions in "Hard rules" above:
  `/flow-pr-review`'s "Independent Multi-Agent Review",
  `/flow-product-planning`'s "Independent Discovery Subagent",
  `/flow-new-feature`'s "Independent Scout Subagent",
  `/flow-pr-review`'s "Fix-Applier Subagent",
  step 10's "Merge-Conflict Resolver Subagent",
  `/flow-coder`'s "Independent Edit-Applier Subagent",
  `/flow-pr-review`'s "Independent Consolidator-Validator Subagent",
  and `/flow-verify`'s "Independent UI-Driver Subagent".
  No other skill or step may call Task.
- The supervisor never spawned a raw `claude -p` subprocess — only
  `flow-claude-headless` calls.

When the pipeline ends, scrollback contains exactly one of `MERGED`
/ `GATED: <url>` / `NEEDS HUMAN: <reason>` / `cancelled` on its own
line, and the corresponding `phase:` is in state.json.

When `FLOW_NOTIFY=1` is set in the supervisor's environment, every
terminal end-state (`merged`, `gated`, `needs-human`) is preceded
by a `flow-notify` call. The helper is a no-op when the env var is
unset, so the call is unconditional from the skill's perspective.
