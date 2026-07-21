# flow — agent guide

`flow` has two responsibilities in one repo:

1. A **multi-phase pipeline supervisor**. Each `flow feature create
   "<description>"` launches a Claude Code session — in the caller's
   plain shell by default, or a tmux window when the tmux launcher is
   opted into — and the `/flow-pipeline` supervisor skill drives the
   full pipeline (triage → plan → worktree → implement → verify → CI →
   review → gate → merge) inside that one chat session. Sub-skills load
   in-process; helper scripts under `bin/` are Bash tool calls.
2. A **curated skill library** at `skills/` plus the helper binaries at
   `bin/` they shell out to. Both are distributed by `flow install` (the
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

The redesign from a Node orchestrator to a plain-shell-default pipeline
supervisor (tmux is now an opt-in launcher) is complete: `src/`, the
per-repo `flow install`, and the orchestrator-only skills (`flow-add`,
`flow-approve`, `flow-revise`, `flow-watch`, `flow-status`) are deleted.
The wrapper at `bin/flow` is Bun and dispatches verbs natively with no
passthrough fallback.

## Code conventions

- **Runtime:** Bun for everything under `bin/`. `package.json` declares `engines.node >= 20` so `npm install` and `npm run test` (vitest) still work, but no shipped code is Node-specific.
- **Style:** small, single-purpose modules. Target < 200 lines/file.
- **Comments:** default to none. Add one only when the *why* is non-obvious. Don't restate what the code does.
- **Errors:** validate at boundaries (CLI args, subprocess output, parsed YAML). Trust internal callers.
- **No premature abstractions.** A phase is just a function.
- **No backwards-compat shims.** flow has no users yet. Refactor freely.

## Output style

Response guidelines for any agent working in this repo. The first entry is
an accuracy precondition; the rest are ordered by token-savings impact.
Each bullet is the binding rule; full rationale, precedents, and recipes
are at [references/output-style.md](references/output-style.md).

- **Verify factual claims before emitting them.** Verify SHAs, paths, line numbers, URLs, PR/issue numbers, versions, env-var names, API surfaces, dates, counts, and CLI flags against their source before citing them — never from memory or a stale `Read`. See the reference for the per-category recipe.
- **Treat user prompts as evidence of intent, not exhaustive specifications.** When a prompt names prescribed methods AND a quantitative target, surface tensions between them in the artifact downstream consumers read, and proceed toward the stated goal rather than the literal reading that fails it. PR #170 is the canonical precedent (four prescribed trims landed, the `<800 lines` target missed, no tension surfaced).
- **Consider the middle ground when a request is framed as a binary choice.** A binary framing ("A or B?") is evidence of how the user is thinking, not a constraint — name a middle-ground option and surface the trade-off in the artifact, then proceed with the best guess.
- **Understand the ultimate goal behind the request, not just the literal ask.** Infer the goal in one line and proceed for ambiguous/high-blast-radius requests; run expert/trivial/time-critical requests literally. Never interrogate.
- **Fix cheap, in-scope robustness issues now rather than deferring them.** A small, low-risk/mechanical, in-scope fix belongs in the PR, not in `anti_patterns_found` as a deferred trade-off.
- **Treat every request as production-bound, not a hobby project.** Include cohesive work in-task (don't dodge it via a follow-up issue) and hold a production bar — error handling, edge cases, accessibility, tests — on the surface you touch.
- **Satisfy local, reversible preconditions before gating a Test Step as manual.** Start the dev server, seed the local DB, drive the headless browser yourself — reserve the manual gate for genuinely external/irreversible/subjective items.
- **Non-trivial UI appearance changes need an authored SUBJECTIVE: approval step the agent can't tick.**

See the reference for the remaining response-hygiene conventions (no
preambles, no sycophantic openers, no emoji unless invited, calibrate
length to task, fenced blocks only for runnable code, etc.).

## Scripts: Bun runtime, distributed via symlinks

Source for shipped helper binaries lives in **`bin/`**. User-callable
helpers (`flow-new-worktree`, `flow-pre-commit`, `flow-state-update`,
`flow-notify`, `flow-ui-validate`, `flow-delegate`, `flow-research-cache`,
etc.) live there with `.ts` extensions, Bun shebangs, and tests next door
(`<name>.test.ts`, skipped when `flow install` symlinks into
`~/.local/bin/<name>`). The three schema validators
(`flow-pr-review-result-schema`, `flow-agent-finding-schema`,
`flow-fix-applier-schema`) are also symlinked, sourced from
`bin/lib/*-schema.ts` via an explicit-allowlist `discoverValidators`
(distinct from `discoverHelpers`'s auto-pickup of every `bin/*.ts`).
`bin/flow` itself is Bun and dispatches every verb natively.

Static agent-type definitions live in **`agents/`** (`*.md` frontmatter),
discovered by `discoverAgents` and symlinked to `~/.claude/agents/`:
13/14 carry `tools:` allowlists (flow-discovery: none); 2 mechanical
roles (`flow-fix-applier`, `flow-verify`) pin `effort: low`, the
gatekeeper (`flow-gatekeeper`) pins `model: haiku`; per-spawn `model:`
still wins.

Conventions for any script under `bin/`: `#!/usr/bin/env bun` + `chmod
+x`; gate `main()` with `import.meta.main` (not an
`import.meta.url`/`process.argv[1]` comparison, which breaks through a
symlink); tests live next door and run via `npm run test`. Default new
scripts to Bun; deviating (e.g. a Node-only dependency) needs user
confirmation and an inline comment.

## Supervisor and sub-skills: in-process only

The load-bearing constraint for `/flow-pipeline`: the supervisor is one
Claude Code chat session, sub-skills load in-process via the `Skill`
tool, and helper scripts under `bin/` are Bash tool calls. The
supervisor never spawns the `Task` / `Agent` tool and never invokes
`claude -p ...` subprocesses, **with nine narrowly-named exceptions** —
the `**Task-tool exemption: ...**` bullets under `## Don'ts` below. This
sidesteps two limits: the one-level sub-agent cap, and context bloat from
a long-running supervisor with sub-agents. A standalone leaf skill
(`/flow-research` run directly) firing `claude -p` is a context this
constraint never governed.

Logic needing a separate LLM session belongs in an in-process sub-skill
or a non-LLM helper, not here.

## Compact Instructions

When the harness compacts the conversation (near the context limit, or on `/compact`), load-bearing pipeline state must survive. Claude Code reads
the "Compact Instructions" section from `CLAUDE.md` / `AGENTS.md` to decide
what to preserve (flow's `CLAUDE.md` is `@AGENTS.md`). See
code.claude.com/docs/en/how-claude-code-works.

- **KEEP**: current pipeline phase, PR number, worktree path, the
  `.flow-tmp/plan.md` and `.flow-tmp/scout.md` artifact paths, current pipeline
  step, and any `NEEDS HUMAN: <reason>` — the supervisor's resume anchors;
  lose them and it cannot tell what it has done.
- **DROP**: verify failure-log excerpts, raw tool outputs, and CI poll progress.
  These are high-volume and reconstructable (`state.json`, the PR, and a
  fresh `gh` / `flow-pre-commit` re-derive them).

## Git workflow

- **Branches:** short, descriptive. The supervisor uses `flow-new-worktree` to create per-pipeline branches from the slug; humans can use `<type>/<topic>` for non-supervisor work.
- **Commits:** conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). Imperative summary ≤ 50 chars. Body explains *why*. Trivial changes may omit the body.
- **PRs:** Why / What / Key decisions / User-facing changes / Test Steps, in that order. The Test Steps section is also the auto-merge gate signal — zero unchecked `- [ ]` items ⇒ auto-merge, one or more unchecked items ⇒ gated. See `skills/pipeline/flow-pipeline/references/auto-merge-rubric.md`.
- **Never amend pushed commits.** Make a new commit instead.
- **Never force-push** without explicit user request.
- **Inline intent annotations** and the **session-marker + trailer** mechanics (how a PR's Claude Code session ID reaches both an HTML-comment marker and a `Claude-Code-Session-Id:` git trailer) are documented in full at [references/git-workflow.md](references/git-workflow.md).

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
npm run verify             # typecheck:scripts + test + lint
bun bin/flow install         # global install (skills, agents, helpers, wrapper)
```

No `npm run build` — flow ships `bin/flow` via Bun, no compile step.

## CI

`.github/workflows/ci.yml` runs `npm run verify` (`typecheck:scripts` +
vitest + lint) on every PR and push to `main` — the server-side backstop
for the local-only `flow-pre-commit` gate. The runner installs Node and
Bun (vitest spawns `bun`). **Make the `verify` job a required status
check** via a branch ruleset on `main` — select job name `verify` (shown
`CI / verify` in the checks tab). A repo-admin setting, not
workflow-enforceable.

## What flow is *not*

- The supervisor does not re-implement Claude Code skills in its own
  process. It hosts a skill library at `skills/` distributed via
  `flow install`; `bin/flow` only routes verbs to helper scripts and the
  launcher (plain shell by default, tmux when opted into).
- It is not a full SDLC tool. It hosts no web UI, Slack posts, Jira
  tickets, or permission management.
- It is not a long-running daemon. Each `flow` invocation does one thing
  and exits. Per-pipeline state persists in `~/.flow/state/<slug>.json`
  plus the worktree plus the PR; under the tmux launcher, the window's
  scrollback is a convenience for re-attaching, not the persistence
  store.

## Consumer-repo notes

`flow-pre-commit` is the verify gate `/flow-pipeline`, `/flow-verify`, and
`/flow-coder` rely on. It auto-detects scope from the diff (`src/`,
`scripts/`/`bin/`, `.md`/`.template` → `docs`, `backend/`, workflow YAML
→ `actions`) plus a monorepo auto-detect + three-layer command
resolution for `apps/<pkg>/`/`packages/<pkg>/` workspaces, a host-wide
test-concurrency cap, a host-wide research cache, an optional
`.flow/ui-validation.json` manifest, and an optional
`.flow/design/foundation.md` design contract. Full surface area —
scope-detection rules, the concurrency-cap formula, the cache TTL, the
three-layer resolution table, and the manifest/foundation fields — is at
[references/consumer-repo-contract.md](references/consumer-repo-contract.md).

## Don'ts

- Don't bypass the helper scripts. The supervisor must always call
  `flow-new-worktree` / `flow-remove-worktree` / `flow-state-update`
  rather than reimplementing their behaviour with raw `git` / `gh` calls.
- Don't spawn sub-agents from the supervisor. See above. The nine
  named exceptions are the `**Task-tool exemption: ...**` bullets below
  (one each for `/flow-pr-review` Multi-Agent Review, `/flow-product-planning`
  Discovery, `/flow-new-feature` Scout, `/flow-pr-review` Fix-Applier,
  Merge-Conflict Resolver, `/flow-coder` Edit-Applier, `/flow-pr-review`
  Gatekeeper, `/flow-pr-review` Consolidator-Validator, and Verify-Retry-Loop);
  no other skill or step may call Task.
- Don't add features beyond the task's stated scope.
- Don't treat an absent optional-module skill as a hard failure — check
  `flow-module-status --check-skill <name>` and degrade to a named skip.
- Don't propagate unverified factual claims. See `## Output style`
  'Verify factual claims before emitting them.' — latent values rot
  (line numbers shift, SHAs advance, CLI flags get renamed), eroding the
  textual evidence the rest of the pipeline relies on.
- Don't introduce a database. Markdown plan files plus
  `~/.flow/state/<slug>.json` are the state store; if the queue ever
  outgrows that, swap in Beads via an adapter rather than building
  bespoke storage.
- Don't leave spawned resources running. See
  `skills/pipeline/flow-pipeline/SKILL.md` "Resource cleanup".
- Don't auto-commit or auto-push outside an explicit user instruction —
  this default always holds on `main` (or any base branch). **On a
  feature/PR branch, a user invoking a code-editing skill
  (`/flow-new-feature`, `/flow-refactoring`, `/flow-pr-review`, `/flow-pipeline`, etc.)
  is itself an instruction to commit the skill's edits to that branch —
  leave the tree clean before returning.** On `main`, pause and ask
  before committing even when running a code-editing skill. Pushing
  remains gated by the named exemptions below; creating PRs counts as
  user-visible action — confirm before pushing.
  - **Auto-push exemption: `pr-review`.** Invoking `/flow-pr-review` is
    itself the user's explicit instruction to commit and push the
    review-fix commit in the same run. Named and narrow — no other skill
    is authorised to bypass the default.
  - **Auto-merge exemption: `/flow-pipeline` step 10.** Exempt for one
    narrow, named operation: `gh pr merge --squash <PR>` inside step 10,
    only on an auto-merge gate verdict (`flow-gate-decide` returns
    `auto-merge`), only on a PR `/flow-pipeline` opened itself. The
    exemption does **not** extend to a `gated` verdict: a `gated` PR is
    merged only through the fresh-confirmation gate-override path
    (`AskUserQuestion`, recorded by `flow-merge-guard --record-override`,
    enforced by the step-10 backstop). Full anti-pattern catalogue and
    the `--no-auto-merge` opt-out are at
    [references/git-workflow.md](references/git-workflow.md).
  - **Shared rationale for the nine Task-tool exemptions below**: the
    supervisor is a top-level session (the one-level sub-agent cap
    doesn't bind its own Task calls), each subagent is one-shot, and
    each exemption is documented bidirectionally with
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules". Full
    five-point rationale and each exemption's unique contract (spawn
    site, artifact path, typed fields, model override) are at
    [references/exemption-contracts.md](references/exemption-contracts.md);
    only the byte-exact opener and a one-line summary remain below.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-pr-review` Independent
    Multi-Agent Review.** Step 8's six parallel review agents plus one
    diff-only intent-guess agent, spawned in the same fan-out message;
    each of the six writes its own `agent-output-<lens>.json`, the
    intent-guess agent writes `.flow-tmp/intent-guess.json`.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-product-planning`
    Independent Discovery Subagent.** Step 3's one discovery agent,
    writing `.flow-tmp/plan.md` + `.flow-tmp/pr-description-draft.md`.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-new-feature`
    Independent Scout Subagent.** Step 5's one scout agent (wider-scope
    path only — ≤3 affected files skip it), writing `.flow-tmp/scout.md`.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-pr-review` Fix-Applier
    Subagent.** Step 8's one fix-applier agent for the per-finding
    address loop + commit/push, writing `.flow-tmp/fix-applier-result.json`.
  - **Task-tool exemption: `/flow-pipeline` → Merge-Conflict Resolver
    Subagent.** Step 10's one resolver agent for the rebase + per-file
    resolution + force-push (per-pipeline branch only), writing
    `.flow-tmp/merge-resolver-result.json`.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-coder` Independent
    Edit-Applier Subagent.** The one edit-applier agent `/flow-coder` spawns
    when `/flow-new-feature` step 5, `/flow-verify` step 3, or `/flow-refactoring`
    step 3 takes its wider-scope path — or the `/flow-pipeline`
    supervisor's interactive code-change redirect path fires — writing
    `.flow-tmp/coder-result.json`; full contract in
    `skills/pipeline/flow-coder/SKILL.md`. These are the **only nine**
    authorised Task-tool fan-out sites from `/flow-pipeline`; no other
    skill or step may call Task.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-pr-review` Independent
    Gatekeeper Subagent.** `/flow-pr-review` Step 1.5's one gatekeeper agent
    with a `model: "haiku"` cost-routing override, writing
    `.flow-tmp/gatekeeper-result.json`.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-pr-review` Independent
    Consolidator-Validator Subagent.** `/flow-pr-review` Step 3.5's one
    consolidator-validator agent (default Sonnet, no model override),
    writing `.flow-tmp/consolidator-result.json`.
  - **Task-tool exemption: `/flow-pipeline` → Verify-Retry-Loop
    Subagent.** Step 6's one verify-retry-loop agent owning the
    3-outer-attempt `/flow-verify` loop, so the re-pasted failure JSON
    never accumulates in the supervisor's own context across attempts;
    writing `.flow-tmp/verify-loop-result.json`.
  - **Task-tool spawn sites must load Task first.** Each of the nine
    sites above must load the Task schema via
    `ToolSearch query="select:Task"` before invoking Task (or its alias
    `Agent`); on a missing schema, escalate
    `NEEDS HUMAN: task-tool-unavailable: <exemption-name>` rather than
    falling back inline. Enforced by `bin/skill-md-lint.test.ts`'s "Load
    the Task tool before spawning" check at all nine sites — a sibling
    guard, not a tenth exemption.
  - The `/flow-pr-review` Gemini lens, the cross-model intent guess
    (`flow-gemini-intent-guess`), and the `/flow-pipeline` Step-3
    **cross-model plan review** are all a
    **Bash fan-out, not a tenth exemption** —
    `flow-delegate`/`flow-plan-review` calls, no Task, graceful skip
    sans agy.
  - **AskUserQuestion exemption: `/flow-pipeline` candidate-issues
    form (two firing locations).** The multi-select form that picks
    which orthogonal candidates to file post-merge, fired from step 4's
    Affirmative branch and step 3's `advance-to-step-5` non-feature
    branch (so non-feature pipelines still get offered discovered
    follow-ups). Full detail at
    [references/git-workflow.md](references/git-workflow.md).
  - **AskUserQuestion exemption: `/flow-pipeline` step 9 gate-override
    sub-step.** The single confirmation form fired when the user
    instructs the supervisor to merge a `gated` PR anyway — a *fresh*
    confirmation, not an inference from an earlier instruction. These
    two named forms are the **only** authorised `AskUserQuestion` sites.
  - **Auto-issue-create exemption: `/flow-pr-review` Step 6 deferral path
    and `/flow-pipeline` Step 10 post-merge sweep.** `flow-create-issue`
    fires only from these two named sites, both with explicit user
    opt-in. Full detail at
    [references/git-workflow.md](references/git-workflow.md).
  - **`/flow-epic-create` is a separate sanctioned supervisor session.**
    `flow epic create` spawns a fresh top-level `/flow-epic-create` session, so
    `/flow-pipeline`'s exactly-9 and two-form rules are unaffected by its
    two named surfaces: **Task-tool fan-out: `/flow-epic-create` →
    /flow-product-planning MODE: epic designer.** and **AskUserQuestion
    form: `/flow-epic-create` clarification round.** Its
    **cross-model design review** is a
    **Bash fan-out, not a tenth exemption** —
    `review.gemini`-gated `flow-plan-review` over `design.md`; no Task,
    no form.
  - **`/flow-epic-run` is a separate sanctioned playbook session.**
    `flow epic run <slug>` opens a fresh `/flow-epic-run` playbook
    session — a playbook, not a loop, reconciling the manifest against
    GitHub/git truth. Zero named fan-out: **no** Task/Agent sub-agent,
    **no** `AskUserQuestion` form. `gated ⇒ escalate-only`, never merges
    a feature PR.
