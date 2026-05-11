# flow — agent guide

`flow` has two responsibilities in one repo:

1. A **tmux-driven multi-phase pipeline supervisor**. Each `flow new
   "<description>"` opens a tmux window running Claude Code, and the
   `/flow-pipeline` supervisor skill drives the full pipeline (triage →
   plan → worktree → implement → verify → CI → review → gate → merge)
   inside that one chat session. Sub-skills load in-process; helper
   scripts under `bin/` are Bash tool calls.
2. A **curated skill library** at `skills/` plus the helper binaries at
   `bin/` they shell out to. Both are distributed by `flow setup` (the
   global install). Skills are usable independent of the supervisor; the
   wrapper is just one consumer.

This file is the entry point for any agent (human or AI) working on flow.
Read it once at the start of a session.

## Where to look

| You want | Read |
|---|---|
| The supervisor's behaviour and contracts | `skills/pipeline/flow-pipeline/SKILL.md` |
| The skill library structure | `skills/` (categorized: `pipeline/`, `universal/`, `stacks/`) |
| Generic engineering rules to copy into a new repo | `templates/AGENTS.md.template` |
| Historical context on the old Node orchestrator (deleted) | `docs/architecture.md`, `docs/phases/*.md` (kept as historical artefacts) |

## Current state

The redesign from a Node orchestrator to a tmux-driven supervisor is
complete: `src/`, the per-repo `flow install`, and the orchestrator-
only skills (`flow-add`, `flow-approve`, `flow-revise`, `flow-watch`,
`flow-status`) are deleted. The wrapper at `bin/flow` is Bun; it
dispatches verbs natively (`new`, `ls`, `attach`, `done`, `setup`,
`migrate`) with no passthrough fallback.

Note: `docs/phases/m2-plan.md`, `docs/phases/m3-plan.md`, and the rest
of `docs/phases/` describe the deleted orchestrator's phase contracts
— historical artefacts kept for context.

## Code conventions

- **Runtime:** Bun for everything under `bin/`. `package.json`
  declares `engines.node >= 20` so `npm install` and `npm run test`
  (vitest) still work, but no shipped code is Node-specific.
- **Style:** small, single-purpose modules. Target < 200 lines/file.
- **Comments:** default to none. Add one only when the *why* is non-obvious
  (a constraint, a workaround, a subtle invariant). Don't restate what the
  code does.
- **Errors:** validate at boundaries (CLI args, subprocess output, parsed
  YAML). Trust internal callers. No defensive checks for things that can't
  happen.
- **No premature abstractions.** A phase is just a function. Don't introduce
  a `Phase` class hierarchy until two phases share enough behaviour to
  justify it.
- **No backwards-compat shims.** flow has no users yet. Refactor freely.

## Output style

Token-efficient response guidelines for any agent working in this repo.
Ordered by token-savings impact (highest first); rules #1 and #4 are the
two highest-leverage rules not already covered by Claude Code's built-in
prompt. Source: research consensus from leaked Claude Code, Cursor, and
Aider system prompts plus Anthropic's prompting docs.

- **Don't echo file contents or full diffs into chat.** Read with tools
  and reference findings as `path:line`. The user can open the file;
  pasting it back wastes tokens and clutters scrollback.
- **No preambles.** Skip "Let me…", "I'll go ahead and…", "First, I'm
  going to…". State the action in one sentence and call the tool.
- **No end-of-turn summary unless asked.** The diff and the tool calls
  are the record. A trailing recap of what the user just watched you
  do is noise.
- **Calibrate length to task.** Prose paragraphs over bullets for
  analyses and explanations — bullets fragment reasoning that flows
  better as connected sentences. One-line answers for one-line
  questions. Don't expand a yes/no into a structured response.
- **No sycophantic openers.** "Great question", "Excellent point",
  "You're absolutely right" add nothing. Same for self-celebratory
  updates ("Successfully implemented…", "I've now perfectly…").
- **No emojis unless the user uses them first.** Match the user's
  register; don't introduce decoration they didn't invite.
- **Don't apologize for errors — just correct.** "Sorry, you're right,
  let me fix that" is filler. Make the correction.
- **Don't narrate internal deliberation.** Think between tool calls,
  not in chat. The user does not need to read your reasoning loop;
  they need the conclusion and the next action.
- **Default to no code comments.** Add one only when the *why* is
  non-obvious (a constraint, a workaround, a subtle invariant).
  Restating what the code does is noise. (Same rule as `## Code
  conventions` above; repeated here because comment-bloat is one of
  the top sources of agent token waste.)
- **Implement fully — no `// rest of code` placeholders.** Stay in
  scope: don't refactor unrelated code, don't introduce new
  abstractions the task didn't ask for, don't half-finish.
- **Fenced blocks only for multi-line runnable code.** Use inline
  backticks for paths, identifiers, flags, and short snippets. A
  fenced block around a single command or filename is visual
  overhead.

## Scripts: Bun runtime, distributed via symlinks

Source for shipped helper binaries lives in **`bin/`**. The user-callable
helpers — `flow-new-worktree`, `flow-remove-worktree`, `flow-pre-commit`,
`flow-fetch-pr-review`, `flow-reply-pr-comments`, `flow-state-update`,
`flow-notify`, `flow-stop-guard` — live there with `.ts` extensions, Bun
shebangs, and tests next door (`<name>.test.ts`). `flow setup` symlinks each into
`~/.local/bin/<name>` (extensionless on PATH).

The `flow` wrapper itself is also Bun, at `bin/flow`. It dispatches every
verb natively — there is no passthrough or legacy entry point.

Conventions for any script under `bin/`:

- `#!/usr/bin/env bun` shebang and `chmod +x`.
- Use `import.meta.main` (Bun's symlink-aware "is this the entry
  point?" check) to gate the `main()` call. Do **not** compare
  `import.meta.url` to `process.argv[1]` — that comparison breaks
  when the script is invoked through a symlink.
- Tests live next door as `<name>.test.ts` and run via vitest
  (`npm run test`). They're flow-internal: `flow setup` skips
  `*.test.ts` files when symlinking, since consumers don't need them
  on PATH.
- Source ≠ install target by design (`bin/` in flow's repo vs
  `~/.local/bin/` on the user's machine). Don't move scripts back to
  the install directory.

When adding a new script, default to Bun. If you need to deviate (e.g.
a Node-only dependency), confirm with the user first and document the
exception inline.

## Supervisor and sub-skills: in-process only

This is the load-bearing constraint for `/flow-pipeline`: the supervisor
is one Claude Code chat session, sub-skills (`/product-planning`,
`/new-feature`, `/verify`, `/pr-review`) load in-process via the `Skill`
tool, and helper scripts under `bin/` are Bash tool calls. The
supervisor never spawns the `Task` / `Agent` tool and never invokes
`claude -p ...` subprocesses, **with six narrowly-named exceptions**
— see the "Task-tool exemption: `/flow-pipeline` → `/pr-review`
Independent Multi-Agent Review", "Task-tool exemption:
`/flow-pipeline` → `/product-planning` Independent Discovery Subagent",
"Task-tool exemption: `/flow-pipeline` → `/new-feature` Independent
Scout Subagent", "Task-tool exemption: `/flow-pipeline` →
`/pr-review` Fix-Applier Subagent", and "Task-tool exemption:
`/flow-pipeline` → Merge-Conflict Resolver Subagent", and
"Task-tool exemption: `/flow-pipeline` → `/coder` Independent
Edit-Applier Subagent" entries under `## Don'ts` below.
This sidesteps two limits at once:

1. Claude Code sub-agents can't spawn sub-agents (one-level cap).
2. A long-running supervisor with sub-agents would bloat past the
   context window.

If you find yourself adding logic that *needs* a separate LLM session,
redesign so the LLM lives in a sub-skill that loads in-process or a
helper script that doesn't need an LLM at all.

## Git workflow

- **Branches:** short, descriptive. The supervisor uses
  `flow-new-worktree` to create per-pipeline branches deterministically
  from the slug; humans can use `<type>/<topic>` for non-supervisor work.
- **Commits:** conventional commits (`feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`, `test:`). Imperative summary ≤ 50 chars. Body explains
  *why* — motivation, non-obvious choices, what was tried and didn't work.
  Trivial changes (typo, dep bump) may omit the body.
- **PRs:** Why / What / Key decisions / User-facing changes / Test Steps,
  in that order. The Why must read as a problem statement, not a feature spec. The
  Test Steps section is also the auto-merge gate signal — zero unchecked `- [ ]`
  items ⇒ auto-merge, one or more unchecked items ⇒ gated. See
  `skills/pipeline/flow-pipeline/references/auto-merge-rubric.md` for the contract.
- **Never amend pushed commits.** Make a new commit instead.
- **Never force-push** without explicit user request.

Pass multi-line messages through a heredoc:

```sh
git commit -F - <<'EOF'
feat: short summary

Why: …
Approach: …
EOF
```

## Development

```sh
npm install                # one-time
npm run typecheck:scripts  # tsc -p tsconfig.scripts.json (bin/)
npm run test               # vitest run (bin/)
npm run verify             # typecheck:scripts + test
bun bin/flow setup         # global install (skills, agents, helpers, wrapper)
```

There is no `npm run build` — flow ships `bin/flow` directly via Bun;
no compile step.

## What flow is *not*

- The supervisor does not re-implement Claude Code skills inside its own
  process. It hosts a skill library at `skills/` and distributes it via
  symlink (`flow setup`); the wrapper at `bin/flow` only routes verbs to
  helper scripts and tmux. Pipeline behaviour lives in the
  `/flow-pipeline` supervisor skill, executed by Claude Code inside a
  tmux window.
- It is not a full SDLC tool. It does not host a web UI, post to Slack,
  open Jira tickets, or manage permissions.
- It is not a long-running daemon. Each `flow` invocation does one thing
  and exits. Per-pipeline state persists in `~/.flow/state/<slug>.json`
  and the tmux window's scrollback.

## Don'ts

- Don't bypass the helper scripts. The supervisor must always call
  `flow-new-worktree` / `flow-remove-worktree` / `flow-state-update`
  rather than reimplementing their behaviour with raw `git` / `gh` calls.
- Don't spawn sub-agents from the supervisor. See above. The six
  named exceptions are `/pr-review`'s Independent Multi-Agent Review
  step, `/product-planning`'s Independent Discovery Subagent,
  `/new-feature`'s Independent Scout Subagent, `/pr-review`'s
  Fix-Applier Subagent, `/flow-pipeline` step 10's Merge-Conflict
  Resolver Subagent, and `/coder`'s Independent Edit-Applier
  Subagent — all six covered by "Task-tool exemption" bullets below;
  no other skill or step may call Task.
- Don't add features beyond the task's stated scope.
- Don't introduce a database. Markdown plan files plus
  `~/.flow/state/<slug>.json` are the state store; if the queue ever
  outgrows that, swap in Beads via an adapter rather than building
  bespoke storage.
- Don't auto-commit or auto-push outside an explicit user instruction —
  this default always holds on `main` (or any base branch). **On a
  feature/PR branch, a user invoking a code-editing skill
  (`/new-feature`, `/refactoring`, `/pr-review`, `/flow-pipeline`, etc.)
  is itself an instruction to commit the skill's edits to that branch —
  leave the tree clean before returning.** A skill that finishes with
  uncommitted changes on a feature branch has not finished: the user
  can otherwise merge the branch or move to the next task without the
  final edits landing. The exemption is scoped to non-base branches:
  on `main`, pause and ask before committing even when running a
  code-editing skill, since direct commits to main bypass review.
  Pushing remains gated by the named exemptions below; creating PRs
  counts as user-visible action — confirm before pushing.
  - **Auto-push exemption: `pr-review`.** The `pr-review` skill is exempt
    from the no-auto-commit and no-auto-push defaults — invoking
    `/pr-review` is itself the user's explicit instruction to commit and
    push the review-fix commit in the same run. The exemption is named
    and narrow: no other skill or agent flow is authorised to bypass the
    default. If a future skill needs the same license, add it here by
    name rather than generalising the rule.
  - **Auto-merge exemption: `/flow-pipeline` step 10.** The
    `/flow-pipeline` skill is exempt from the no-auto-commit / no-auto-
    push default for one narrow, named operation: the documented
    `gh pr merge --squash --delete-branch <PR>` call inside step 10,
    only when the auto-merge gate fires (Test Steps section has no
    unchecked items) and only on a PR opened by `/flow-pipeline` itself.
    Invoking `/flow-pipeline` is itself the user's authorisation; opt
    out per-pipeline with `flow new --no-auto-merge` (the supervisor
    stops at the gated state regardless of the gate verdict). Same
    narrow-and-named contract as the `/pr-review` exemption above.
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` Independent
    Multi-Agent Review.** `/flow-pipeline`'s "Hard rules" section
    forbids the supervisor from calling the `Task` / `Agent` tool,
    with named exceptions only: when `/flow-pipeline` step 8 loads
    `/pr-review` and `/pr-review` reaches its "Independent
    Multi-Agent Review" step, four review agents are spawned in
    parallel via the Task tool. The exemption is anchored on the
    step heading name rather than its number so it survives future
    `/pr-review` renumbering. Rationale: the supervisor is itself a
    top-level Claude Code session (started by `flow new` opening tmux
    + `claude`), so the one-level sub-agent cap doesn't apply to
    *its* Task calls; and the multi-agent review is one-shot, not
    long-running, so the context-bloat constraint also doesn't
    apply. The contract is documented bidirectionally in
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" and
    `skills/pipeline/pr-review/SKILL.md`'s Independent Multi-Agent
    Review preamble. Same narrow-and-named contract as the
    `/pr-review` and `/flow-pipeline` exemptions above.
  - **Task-tool exemption: `/flow-pipeline` → `/product-planning`
    Independent Discovery Subagent.** When `/flow-pipeline` step 3
    loads `/product-planning`, the wrapper spawns one discovery
    agent via the Task tool. The exemption is anchored on the step
    heading name rather than its number so it survives future
    `/product-planning` renumbering. Rationale: the same two
    constraints as above — the supervisor is top-level so the
    one-level sub-agent cap doesn't apply to *its* Task calls; and
    the discovery is one-shot, returning artifacts (`.flow-tmp/plan.md`
    and `.flow-tmp/pr-description-draft.md`) plus a brief summary
    rather than running long. The reason this exemption exists at
    all is the context cost: discovery reads the README, scans the
    skill directory, examines domain models, drafts a PRD — none of
    which the supervisor refers to in steps 5–10, but all of which
    would otherwise sit in the supervisor's transcript for the rest
    of the run. Since the only handoff from `/product-planning` to
    downstream steps is `.flow-tmp/plan.md` already, isolating the
    discovery in a subagent costs nothing the supervisor was using.
    The contract is documented bidirectionally in
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" and
    `skills/pipeline/product-planning/SKILL.md`'s "Independent
    Discovery Subagent" preamble. Same narrow-and-named contract as
    the exemptions above.
  - **Task-tool exemption: `/flow-pipeline` → `/new-feature`
    Independent Scout Subagent.** When `/flow-pipeline` step 5
    loads `/new-feature`, the wrapper spawns one scout agent via
    the Task tool — but only on the wider-scope path of its hybrid
    threshold (≤3 affected files skips the scout entirely). The
    exemption is anchored on the step heading name rather than its
    number so it survives future `/new-feature` renumbering.
    Rationale: the same two constraints as above — the supervisor
    is top-level so the one-level sub-agent cap doesn't apply to
    *its* Task calls; and the scout is one-shot, returning an
    artifact (`.flow-tmp/scout.md`) plus a brief both-sides summary
    rather than running long. The reason this exemption exists at
    all is the context cost: scouting reads source files, scans
    adjacent modules, identifies test coverage, enumerates the
    public API surface, and flags anti-patterns / off-limits
    surfaces — none of which the supervisor refers to in steps
    6–10, but all of which would otherwise sit in the supervisor's
    transcript for the rest of the run. PR #95 is the precedent:
    the same surgery applied to `/product-planning`'s discovery,
    and the `/product-planning` Independent Discovery Subagent
    exemption above bakes its post-merge-fix invariants (absolute
    SKILL_DIR + WORKTREE paths, exactly one Task call per
    invocation, wrapper-owned `mkdir -p .flow-tmp/`, single
    side-effect attribution site, main-session reads the artifact
    once and never re-reads). The `/new-feature` scout adopts those
    invariants verbatim, with one addition specific to this
    exemption: the subagent's return summary must surface both
    sides — at least one positive finding and at least one
    negative finding (off-limits surfaces, rejected approaches,
    foreclosed shortcuts). The contract is documented
    bidirectionally in `skills/pipeline/flow-pipeline/SKILL.md`
    "Hard rules" and `skills/pipeline/new-feature/SKILL.md`'s
    "Independent Scout Subagent" preamble. Same narrow-and-named
    contract as the exemptions above.
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` Fix-Applier
    Subagent.** When `/flow-pipeline` step 8 loads `/pr-review` and
    `/pr-review` reaches its "Independent Fix-Applier Subagent" step,
    one fix-applier agent is spawned via the Task tool to handle the
    per-finding address loop (Steps 6, 7, 7.5 of `/pr-review`, plus
    the pre-commit / commit / push that step 8 used to own) inside
    its own isolated context. The exemption is anchored on the step
    heading name rather than its number so it survives future
    `/pr-review` renumbering. Rationale: the same two constraints as
    above — the supervisor is top-level so the one-level sub-agent
    cap doesn't apply to *its* Task calls; and the fix-applier is
    one-shot, returning a structured artifact
    (`.flow-tmp/fix-applier-result.json` with typed fields `commits`,
    `deferred`, `rejected_alternatives`, `anti_patterns_found`,
    `summary`) plus a brief summary, then exits. The reason this
    exemption exists at all is two-fold: context cost (per-finding
    fix prose, `flow-pre-commit` output, `/verify` re-run transcript
    are by far the largest sink left in `/flow-pipeline` runs after
    PR #95) and the in-context verify re-run — the subagent invokes
    `/verify` against the post-fix worktree *before returning*, so
    CI breakage caused by a fix surfaces in-context where the fix
    rationale is still live, not after the subagent exits and the
    supervisor sees a CI-failed log later in step 7 with no intent
    context. The contract is documented bidirectionally in
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" and
    `skills/pipeline/pr-review/SKILL.md`'s "Fix-Applier Subagent"
    section. Same narrow-and-named contract as the exemptions above.
  - **Task-tool exemption: `/flow-pipeline` → Merge-Conflict Resolver
    Subagent.** When `/flow-pipeline` step 10 fires `gh pr merge
    --squash` and the call returns a conflict-class failure (stderr
    matches the documented detection patterns in
    `skills/pipeline/flow-pipeline/references/merge-resolver-instructions.md`),
    the supervisor spawns one merge-conflict resolver subagent via
    the Task tool to handle the rebase + per-file conflict
    resolution + force-push inside its own isolated context. After
    the subagent returns, the supervisor retries `gh pr merge
    --squash` exactly once; on second failure, escalates
    `NEEDS HUMAN: merge-failed` with the resolver's summary first
    sentence appended to the reason. The exemption is anchored on
    the step heading name rather than its number so it survives
    future `/flow-pipeline` renumbering. Rationale: the same two
    constraints as above — the supervisor is top-level so the
    one-level sub-agent cap doesn't apply to *its* Task calls; and
    the resolver is one-shot, returning a structured artifact
    (`.flow-tmp/merge-resolver-result.json` with typed fields
    `resolved_files`, `ambiguous_resolutions`, `rejected_strategies`,
    `commits`, `force_push_status`, `summary`) plus a brief
    summary, then exits. The reason this exemption exists at all is
    context cost: the rebase output, per-file resolution rationale,
    and force-push transcript would otherwise sit in the
    supervisor's transcript at the latest, most token-expensive
    point in the pipeline — where the supervisor still has the
    post-merge sweep, step 11's local-follow-ups, and the terminal
    print left to do. **Force-push is permitted** because the
    resolver runs as a Task-tool fan-out inside `/flow-pipeline`'s
    existing auto-merge umbrella, and is scoped to the per-pipeline
    branch only — never `main`, `master`, or the base branch (the
    instructions file's branch-name guard is mandatory). The
    contract is documented bidirectionally in
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" and
    `skills/pipeline/flow-pipeline/references/merge-resolver-instructions.md`.
    Same narrow-and-named contract as the exemptions above.
  - **Task-tool exemption: `/flow-pipeline` → `/coder` Independent
    Edit-Applier Subagent.** When `/flow-pipeline` step 5 loads
    `/new-feature` (or step 6 loads `/verify`) and either skill reaches
    its hybrid-threshold wider-scope path, the wrapper invokes `/coder`
    in-process; `/coder` itself spawns one edit-applier agent via the
    Task tool to apply the caller's edit-set, run `flow-pre-commit
    --json` against the post-edit worktree, and write a structured
    artifact at `<worktree>/.flow-tmp/coder-result.json` (typed fields:
    `edits`, `verify_status`, `rejected_alternatives`,
    `anti_patterns_found`, `summary`). The exemption is anchored on
    the step heading name rather than its number so it survives future
    `/coder` renumbering. Rationale: the same two constraints as above
    — the supervisor is top-level so the one-level sub-agent cap
    doesn't apply to *its* Task calls (the call from `/new-feature` or
    `/verify` is itself a top-level-supervisor-loaded skill's call);
    and the edit-applier is one-shot, returning the artifact plus a
    brief both-sides summary, then exits. The reason this exemption
    exists at all is two-fold: context cost (per-edit `Edit`/`Write`
    tool_use bytes and the diff-bearing `tool_result` text are by far
    the largest sink left in `/flow-pipeline` runs after the four
    earlier exemptions landed) and the in-context verify re-run — the
    subagent invokes `flow-pre-commit --json` against the post-edit
    worktree *before returning*, so type/lint/test breakage caused by
    an edit surfaces in-context where the edit rationale is still
    live, not after the subagent exits. Trivially scoped edits skip
    the subagent via each caller's own hybrid threshold
    (`/new-feature` step 5: ≤1 file AND ≤30 LOC AND every file named
    in the prompt; `/verify` step 3: single-line type/lint error in
    one file) and proceed inline. The two thresholds are
    caller-defined — see each skill's "Spawn procedure (wider-scope
    path only)" section for the canonical bar. The contract is
    documented bidirectionally in
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" and
    `skills/pipeline/coder/SKILL.md`'s "Independent Edit-Applier
    Subagent" section. Same narrow-and-named contract as the
    exemptions above. Together with the `/pr-review` Multi-Agent
    Review, `/product-planning` Discovery Subagent, `/new-feature`
    Scout Subagent, `/pr-review` Fix-Applier Subagent, and
    `/flow-pipeline`'s Merge-Conflict Resolver Subagent entries,
    these are the **only six** authorised Task-tool fan-out sites
    from `/flow-pipeline`; no other skill or step may call Task.
  - **Task-tool spawn sites must load Task first.** Each of the six
    Task-tool exemption sites above must instruct the supervisor to
    load the Task tool schema via `ToolSearch query="select:Task"`
    before invoking Task. In Claude Code sessions where `Task` is a
    deferred capability (no top-level schema), an unguarded
    invocation silently falls through to in-line execution — the
    inaugural silent-fallback regression was PR #124. On missing
    schema, escalate `NEEDS HUMAN: task-tool-unavailable:
    <exemption-name>` rather than falling back inline; each spawn
    procedure carries the canonical "Load the Task tool before
    spawning" paragraph, and `bin/skill-md-lint.test.ts` enforces
    its presence at all six sites. Same narrow-and-named hygiene as
    the Task-tool exemptions above — this is a sibling guard, not a
    seventh exemption.
  - **AskUserQuestion exemption: `/flow-pipeline` step 4 candidate-
    issues sub-step.** `/flow-pipeline`'s "Hard rules" forbid arbitrary
    `AskUserQuestion` calls from the supervisor, with one named
    exception: the multi-select form fired during step 4's
    "Candidate follow-up issues sub-step" to let the user pick which
    orthogonal candidates to file post-merge. The exemption is
    anchored on the step heading name rather than its number.
    Rationale: `AskUserQuestion` is a different primitive from
    `Task` (it's a synchronous user prompt, not a sub-agent fan-out)
    so the one-level sub-agent cap doesn't apply, but the
    narrow-and-named hygiene still does — naming the single fire
    site keeps the supervisor's user-prompt surface auditable. Same
    narrow-and-named contract as the Task-tool exemptions above. If
    a future skill needs the same license, add it here by name
    rather than generalising the rule.
  - **Auto-issue-create exemption: `/pr-review` Step 6 deferral path
    and `/flow-pipeline` Step 10 post-merge sweep.** Skills are
    forbidden from calling `flow-create-issue` (or any other
    issue-create surface) outside the two named sites: (a) when
    `/pr-review` defers a finding past the 3-criterion bar, it files
    one issue via
    `flow-create-issue --label flow-agent,deferred-review`;
    and (b) when `/flow-pipeline` step 10 runs the post-merge sweep,
    it fires
    `flow-create-issue --label flow-agent,out-of-scope-discovery`
    once per `- [x]` candidate in plan.md.
    Rationale: indiscriminate issue auto-creation pollutes user
    backlogs with low-confidence noise and races on `gh` rate
    limits; the two named sites have explicit user opt-in (the
    deferral bar for pr-review, the AskUserQuestion form for
    flow-pipeline). Same narrow-and-named contract as the
    exemptions above. The contract is documented bidirectionally in
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules",
    `skills/pipeline/pr-review/SKILL.md` Step 6, and
    `bin/flow-create-issue.ts`. If a future skill needs to file
    issues, add it here by name rather than generalising the rule.
