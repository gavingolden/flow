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

Response guidelines for any agent working in this repo. The first entry
is an accuracy rule — a precondition for every other rule that emits
prose, citations, or recipes; the remaining bullets are ordered by
token-savings impact (highest first), where "Don't echo file contents
or full diffs into chat." and "Calibrate length to task." are the two
highest-leverage token-savings rules not already covered by Claude
Code's built-in prompt. Source: research consensus from leaked Claude
Code, Cursor, and Aider system prompts plus Anthropic's prompting docs.

- **Verify factual claims before emitting them.** Always try to verify
  factual claims proactively via an API request, doc fetch, or
  filesystem check before propagating them into edits, PR bodies, or
  scripts — especially values that have been latent/unvalidated for a
  while. Concrete trigger categories: SHAs, file paths, line numbers,
  URLs, issue/PR numbers, version strings, env-var names, API surface
  shapes (function names, exported symbols, flag names), dates,
  exemption counts, deprecated CLI flags. Anti-patterns to call out
  explicitly: paraphrasing `AGENTS.md` from memory in a commit-message
  Why-section, copy-pasting a prior PR body section without re-checking
  its citations, citing line numbers from a stale `Read`, claiming an
  exemption count that has since changed, hardcoding a SHA from earlier
  in the session without re-running `git rev-parse`, quoting a CLI flag
  from memory after `--help` shape may have changed. Per-category
  verification recipes — line number: `Read` the file at the exact path
  before citing; SHA: `git rev-parse <ref>`; URL: `curl -sI` or follow
  the link; PR number + state: `gh pr view <n> --json title,state,mergedAt`;
  issue number + state: `gh issue view <n> --json title,state` (the
  PR variant verifies pull requests only — a plain issue lookup against
  `gh pr view` fails or surfaces the wrong record); exemption count or
  any other count: `grep -cE '<anchored-pattern>' <file>` (never
  unanchored substring); CLI flag: `<verb> --help`; file/path
  existence: `test -f <path>`; exported symbol or function name:
  `grep -n '<symbol>' <module>`; version string: `<verb> --version` or
  `jq -r .version package.json`; env-var name: `grep -n '<NAME>' .env.example`
  (presence in the example file is the canonical source-of-truth check);
  date: `git log --format='%ad' --date=short -1 <ref>` for a commit or
  tag, `gh api repos/{owner}/{repo}/issues/<n> --jq .created_at` for an
  issue or PR creation date. The rule is 'always *try*' with
  judgment, not blanket pessimisation — a claim like 'this is a
  TypeScript file' doesn't need a verification round-trip; a claim
  like 'this matches `/foo/` on line 42' does. When in doubt, verify.
- **Treat user prompts as evidence of intent, not exhaustive specifications.**
  User prompts may contain mistakes, incompleteness, unintended scope
  restriction, and misweighted goals. When a prompt names prescribed
  methods (a numbered list, an explicit enumeration of moves) AND a
  stated quantitative target (`<800 lines`, `30% faster`, `≤ 100ms`),
  your job is to (a) identify tensions — prescribed-methods-vs-stated-target,
  under-specification, conflicting constraints — and surface them in the
  artifacts downstream consumers read (the discovery subagent's PRD has
  a dedicated `## Prompt interpretation` section for exactly this; the
  `/new-feature` Critical Analysis adds a row; `/flow-pipeline` Step 3
  routes non-feature tensions to the approval checkpoint), and
  (b) proceed with the most-likely-correct interpretation toward the
  stated goal, not the literal interpretation that fails the goal. The
  eight Task-tool exemptions and other narrow-and-named contracts cap
  the scope you can take on without authorisation; the
  prompt-as-evidence-of-intent rule governs *interpretation* inside an
  authorised scope, not scope expansion past it. PR #170 is the canonical
  precedent: the user named four prescribed trims AND a `<800 lines`
  target; the agent landed all four trims (`-71 lines`, finishing at
  1337 lines — still 537 lines above target) and reported success
  because the prescribed methods all landed, never surfacing that they
  couldn't reach the target. Anti-patterns: (a) reading 4 prescribed
  moves as exhaustive when the stated target needs more — surface the
  gap and name additional safe steps in the plan or critical analysis;
  (b) treating an aspirational quantitative target as wishful when
  prescribed methods come up short — the target is evidence the user
  wants the methods to reach it, not decoration; (c) asking for
  clarification when work-without-stopping is in effect — instead surface
  the tension in artifacts (the discovery PRD's Open Questions, the
  Critical Analysis assessment row) so the user can redirect at the next
  approval checkpoint without an extra round-trip. The structural lint
  for this rule lives at `bin/skill-md-lint.test.ts` and anchors on the
  exact phrase **Treat user prompts as evidence of intent, not exhaustive
  specifications.** — renames must update the lint in the same commit.
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

The two schema validators `flow-pr-review-result-schema` and
`flow-agent-finding-schema` are ALSO symlinked onto PATH by `flow setup` —
but sourced from `bin/lib/*-schema.ts` via an explicit-allowlist
`discoverValidators` (distinct from `discoverHelpers`' auto-pickup of every
`bin/*.ts`), so pipeline skills invoke them by bare name regardless of cwd.

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
`claude -p ...` subprocesses, **with eight narrowly-named exceptions**
— see the eight `**Task-tool exemption: ...**` bullets under
`## Don'ts` below, preceded by a single shared-rationale preamble.
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
- **Inline intent annotations:** review-time-scoped per-hunk rationale
  authored by `/new-feature` Step 5b as inline review comments on the
  PR diff (`**why:** <1-2 sentences>` + `<!-- flow-intent-v1 -->`
  integrity suffix, prefix disjoint from `/pr-review`'s Conventional
  Comments vocabulary). These inline intent annotations live on the PR
  diff and do **not** appear in `git log` / `git blame` after merge —
  durable rationale still
  belongs in commit-body Why-sections and the PR body's `## Why`. See
  `skills/pipeline/new-feature/SKILL.md` Step 5b for the trigger contract
  (rules a/b/c, per-file dedup, ≤8/PR cap, overflow bullet) and
  `skills/pipeline/pr-review/SKILL.md` Step 3 for how `/pr-review`
  consumes the annotations as `{{EXISTING_INTENT_COMMENTS}}` context.

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

## CI

`.github/workflows/ci.yml` runs `npm run verify` (`typecheck:scripts` +
vitest) on every pull request and every push to `main`. It is the
server-side backstop for the local-only `flow-pre-commit` gate, which a
human pushing a PR outside `/flow-pipeline` never invokes and which an
in-pipeline run can pass falsely against stale PATH-symlinked code. The
runner installs both Node and Bun — the vitest suite spawns `bun` as a
subprocess. **Make the `verify` job a required status check** via branch
protection on `main` (Settings → Branches) so a red PR cannot be merged;
this is a repo-admin setting, not something the workflow file can enforce.

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

## Consumer-repo notes

`flow-pre-commit` is the verify gate that `/flow-pipeline`, `/verify`,
and `/coder` rely on, so consumer repos that wire it in as their sole
gate need to know its surface area. Scope detection is prefix- and
extension-based against the diff: `src/` trips `src`; `scripts/`,
`templates/scripts/`, and `bin/` all trip `scripts`; any file with the
`.md` extension trips `docs`; any changed file with the `backend/`
prefix trips `backend`, which runs `go vet -C backend ./...` and
`go test -C backend ./...` (prefix-only — `backend/go.mod` and
`backend/go.sum` edits also re-run the gate, since `go vet`/`go test`
walk Go packages on their own). Workflow YAML edits under
`.github/workflows/` with a `.yml` or `.yaml` extension ADDITIONALLY
trip the `actions` scope, which runs `actionlint .github/workflows/`
— and they still trip `scripts` via the existing `.github/workflows/`
prefix, so the same edit runs both `bin/`'s workflow-shape regression
tests AND `actionlint` (different defect classes). `actionlint` is
treated as an OPTIONAL tool: when it isn't installed on `PATH`, the
check emits a per-result `skipReason: 'actionlint-not-installed'` and
counts as `passed: true` rather than failing the gate (parallel to how
`filterDefinedChecks` handles missing npm scripts). `go` is treated
the same way: when it isn't installed on `PATH`, both `backend` checks
emit a per-result `skipReason: 'go-not-installed'` and count as
`passed: true` rather than failing the gate. When **no** specific
scope matched anything in a non-empty diff, the entire diff lands in
the `root-fallback` pseudo-scope, which runs `npm run typecheck` and
`npm run test` from the consumer's repo root — so a monorepo with
sources under `apps/<pkg>/src/` or `packages/<pkg>/src/` still gets a
real verify pass without flow having to learn every layout. The
fallback is **mutually exclusive** with every specific scope
(including `backend`): a mixed diff like `src/a.ts` + `apps/web/src/b.ts`
matches `src` and runs `src`'s checks only — `root-fallback` does not
also fire; a backend-only diff like `backend/handler.go` matches
`backend` and `root-fallback` does not fire either. The orphan
`apps/web/src/b.ts` still surfaces in `unmatchedFiles` for visibility,
but it doesn't trip an extra check round.

For the fallback to do anything, the consumer's root `package.json`
must define `typecheck` and `test` scripts; `filterDefinedChecks` in
`bin/flow-pre-commit.ts` drops any check whose npm script is absent.
When a non-empty diff produces zero checks (no matching npm scripts
defined), the helper signals `allPassed: false` and emits
`reason: "no-checks-defined"` rather than silently exiting `0` — the
old silent-pass hole is closed.

## Don'ts

- Don't bypass the helper scripts. The supervisor must always call
  `flow-new-worktree` / `flow-remove-worktree` / `flow-state-update`
  rather than reimplementing their behaviour with raw `git` / `gh` calls.
- Don't spawn sub-agents from the supervisor. See above. The eight
  named exceptions are `/pr-review`'s Independent Multi-Agent Review
  step, `/product-planning`'s Independent Discovery Subagent,
  `/new-feature`'s Independent Scout Subagent, `/pr-review`'s
  Fix-Applier Subagent, `/flow-pipeline` step 10's Merge-Conflict
  Resolver Subagent, `/coder`'s Independent Edit-Applier
  Subagent, `/pr-review` Step 1.5's Independent Gatekeeper
  Subagent, and `/pr-review` Step 3.5's Independent
  Consolidator-Validator Subagent — all eight covered by "Task-tool
  exemption" bullets below; no other skill or step may call Task.
- Don't add features beyond the task's stated scope.
- Don't propagate unverified factual claims. If you're about to emit
  a SHA, file path, line number, URL, PR number, issue number,
  version string, env-var name, API surface shape, date, exemption
  count, or deprecated CLI flag into an edit, PR body, commit
  message, or script, verify the value live against its source
  (`Read`, `git rev-parse`, `gh pr view` for PRs, `gh issue view`
  for issues, `grep`, `--help`) before emitting it. The
  operational detail and per-category verification recipes live in
  `## Output style` under 'Verify factual claims before emitting
  them.' Latent values that were correct at a past read silently rot
  — line numbers shift, SHAs advance, exemption counts grow, CLI
  flags get renamed — and the aggregate erodes the textual evidence
  the rest of the pipeline (auto-merge gate, multi-agent review,
  fix-applier) relies on.
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
  - **Shared rationale for the eight Task-tool exemptions below.**
    `/flow-pipeline`'s "Hard rules" forbid the supervisor from calling
    the `Task` / `Agent` tool, with eight named exceptions. The same
    rationale covers all eight, so it is stated here once: (a) the
    supervisor is itself a top-level Claude Code session (started by
    `flow new` opening tmux + `claude`), so the one-level sub-agent cap
    doesn't apply to *its* Task calls; (b) each exemption's subagent is
    one-shot — it returns an artifact plus a brief summary then exits —
    so the long-running context-bloat constraint doesn't apply either;
    (c) every exemption is anchored on its step *heading name* rather
    than its number so it survives future renumbering; (d) every
    exemption is documented bidirectionally in
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" and the
    consumed skill's own SKILL.md; (e) the narrow-and-named-contract
    discipline applies — each exemption names exactly one spawn site,
    and a future skill needing the same license must be added here by
    name rather than generalising the rule. Each bullet below carries
    only its unique contract: spawn site / triggering step, artifact
    path, typed artifact fields, and any model override.
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` Independent
    Multi-Agent Review.** `/flow-pipeline` step 8 loads `/pr-review`;
    at the "Independent Multi-Agent Review" step, six review agents are
    spawned in parallel via the Task tool. No single aggregated result
    artifact — each agent persists its own
    `$WORKTREE/.flow-tmp/agent-output-<lens>.json`, and the
    Consolidator-Validator step produces `consolidator-result.json`; the
    Multi-Agent Review fan-out itself emits no consolidated artifact of
    its own. The six agents run inside the supervisor's own in-process
    Skill load (`/pr-review` has no `context: fork` directive).
  - **Task-tool exemption: `/flow-pipeline` → `/product-planning`
    Independent Discovery Subagent.** `/flow-pipeline` step 3 loads
    `/product-planning`, which spawns one discovery agent via the Task
    tool. Artifacts: `.flow-tmp/plan.md` and
    `.flow-tmp/pr-description-draft.md`. Post-merge-fix invariants:
    absolute SKILL_DIR + WORKTREE paths, exactly one Task call per
    invocation, wrapper-owned `mkdir -p .flow-tmp/`, single side-effect
    attribution site, main-session reads each artifact once and never
    re-reads.
  - **Task-tool exemption: `/flow-pipeline` → `/new-feature`
    Independent Scout Subagent.** `/flow-pipeline` step 5 loads
    `/new-feature`, which spawns one scout agent via the Task tool —
    but only on the wider-scope path of its hybrid threshold (≤3
    affected files skips the scout). Artifact: `.flow-tmp/scout.md`.
    The scout adopts the Discovery Subagent's invariants verbatim, plus
    one addition: its return summary must surface both sides — at least
    one positive finding and at least one negative finding (off-limits
    surfaces, rejected approaches, foreclosed shortcuts).
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` Fix-Applier
    Subagent.** `/flow-pipeline` step 8 loads `/pr-review`; at the
    "Independent Fix-Applier Subagent" step, one fix-applier agent is
    spawned via the Task tool to handle the per-finding address loop
    plus pre-commit / commit / push. Artifact:
    `.flow-tmp/fix-applier-result.json` (typed fields `commits`,
    `deferred`, `rejected_alternatives`, `anti_patterns_found`,
    `summary`). The subagent invokes `/verify` against the post-fix
    worktree *before returning*, so a fix's CI breakage surfaces
    in-context while the fix rationale is still live.
  - **Task-tool exemption: `/flow-pipeline` → Merge-Conflict Resolver
    Subagent.** When `/flow-pipeline` step 10's `gh pr merge --squash`
    returns a conflict-class failure (stderr matching the detection
    patterns in
    `skills/pipeline/flow-pipeline/references/merge-resolver-instructions.md`),
    the supervisor spawns one resolver subagent via the Task tool for
    the rebase + per-file resolution + force-push. Artifact:
    `.flow-tmp/merge-resolver-result.json` (typed fields
    `resolved_files`, `ambiguous_resolutions`, `rejected_strategies`,
    `commits`, `force_push_status`, `summary`). After it returns the
    supervisor retries `gh pr merge --squash` exactly once; on second
    failure it escalates `NEEDS HUMAN: merge-failed` with the
    resolver's summary first sentence appended. **Force-push is
    permitted** here because the resolver runs inside `/flow-pipeline`'s
    auto-merge umbrella and is scoped to the per-pipeline branch only —
    never `main`, `master`, or the base branch (the instructions file's
    branch-name guard is mandatory).
  - **Task-tool exemption: `/flow-pipeline` → `/coder` Independent
    Edit-Applier Subagent.** When a pipeline skill reaches its
    hybrid-threshold wider-scope path — `/new-feature` step 5,
    `/verify` step 3, or `/refactoring` step 3 — the wrapper invokes
    `/coder` in-process, and `/coder` spawns one edit-applier agent via
    the Task tool to apply the edit-set and run `flow-pre-commit --json`
    against the post-edit worktree. Artifact:
    `<worktree>/.flow-tmp/coder-result.json` (typed fields `edits`,
    `verify_status`, `rejected_alternatives`, `anti_patterns_found`,
    `summary`). The subagent runs the verify re-run *before returning*
    so an edit's type/lint/test breakage surfaces in-context. Trivially
    scoped edits skip the subagent via each caller's own hybrid
    threshold (see each caller's "Spawn procedure (wider-scope path
    only)" for the canonical bar). The full contract is in
    `skills/pipeline/coder/SKILL.md`'s "Independent Edit-Applier
    Subagent" section. Together with the seven other exemptions in this
    block, these are the **only eight** authorised Task-tool fan-out
    sites from `/flow-pipeline`; no other skill or step may call Task.
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` Independent
    Gatekeeper Subagent.** `/flow-pipeline` step 8 loads `/pr-review`;
    at the "Independent Gatekeeper Subagent" step (Step 1.5), one
    gatekeeper agent is spawned via the Task tool with a per-spawn
    `model: "haiku"` override — the one exemption justified primarily
    by **cost-routing** rather than context isolation. It short-circuits
    the four-agent Sonnet fan-out on closed/merged/trivial/no-new-commits
    PRs from a single `gh pr view --json
    state,isDraft,additions,deletions,commits,author` metadata fetch.
    Artifact: `<worktree>/.flow-tmp/gatekeeper-result.json` (typed
    fields `decision`, `reason`, `skip_kind?`, `summary`). The wrapper
    branches on it: `"skip"` writes a well-formed
    `pr-review-result.json` with `status: "clean"` and
    `completed_steps: ["1", "1.5"]` so Step 8 sees a clean result and
    proceeds to the auto-merge gate; `"proceed"` continues to Step 2
    unchanged.
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` Independent
    Consolidator-Validator Subagent.** `/flow-pipeline` step 8 loads
    `/pr-review`; at the "Independent Consolidator-Validator Subagent"
    step (Step 3.5), one consolidator-validator agent is spawned via
    the Task tool. Unlike the Gatekeeper there is **no** `model:
    "haiku"` override — default Sonnet is used because the
    second-opinion pass needs the larger model's judgment. Artifact:
    `<worktree>/.flow-tmp/consolidator-result.json` (typed fields
    `consolidated_findings`, `dropped_by_validation`,
    `rejected_alternatives`, `anti_patterns_found`, `summary`); the
    wrapper reads it once at Step 4 and reuses the parsed object across
    Steps 4–7. Also documented in
    `skills/pipeline/pr-review/references/consolidator-instructions.md`.
  - **Task-tool spawn sites must load Task first.** Each of the eight
    Task-tool exemption sites above must instruct the supervisor to
    load the Task tool schema via `ToolSearch query="select:Task"`
    before invoking Task (or its alias `Agent`). In Claude Code sessions where neither `Task` nor its alias `Agent`
    is surfaced top-level by the harness (both are aliases of the
    same one-shot subagent-spawn primitive: identical
    `subagent_type` / `prompt` / `description` schema), an unguarded
    invocation silently falls through to in-line execution — the
    inaugural silent-fallback regression was PR #124. On missing
    schema, escalate `NEEDS HUMAN: task-tool-unavailable:
    <exemption-name>` rather than falling back inline; each spawn
    procedure carries the canonical "Load the Task tool before
    spawning" paragraph, and `bin/skill-md-lint.test.ts` enforces
    its presence at all eight sites. Same narrow-and-named hygiene as
    the Task-tool exemptions above — this is a sibling guard, not a
    ninth exemption.
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
