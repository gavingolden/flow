---
paths:
  [
    "skills/**",
    "agents/**",
    "references/**",
    "templates/**",
    "bin/skill-md-lint.test.ts",
  ]
---

# Supervisor contracts (loaded when you Read/Edit a file under skills/, agents/, references/, templates/, or bin/skill-md-lint.test.ts)

## Don'ts

Universal Don'ts (helper-script bypass, scope creep, optional-module
degrade, unverified claims, no database) live only in `AGENTS.md`'s
`## Don'ts` — not duplicated here. This file adds the sub-agent /
resource-cleanup / auto-commit / exemption rules its title promises;
the tmux-pane / port-override / post-commit-diff rules live in
`flow-bin-conventions.md`.

- Don't spawn sub-agents from the supervisor. See `AGENTS.md`
  `## Supervisor and sub-skills: in-process only`. The eight
  named exceptions are the `**Task-tool exemption: ...**` bullets below
  (one each for `/flow-pr-review` Multi-Agent Review, `/flow-product-planning`
  Discovery, `/flow-new-feature` Scout, `/flow-pr-review` Fix-Applier,
  Merge-Conflict Resolver, `/flow-coder` Edit-Applier, `/flow-pr-review`
  Consolidator-Validator, `/flow-verify` UI-Driver); no other skill or
  step may call Task.
- Don't leave spawned resources running. Three layers, in order:
  (1) point-of-use teardown first — close what you opened, on every
  exit path; (2) `flow-browser-teardown --reap --record` at every
  terminal state as the guaranteed registry-driven backstop, never
  `|| true`-swallowed, its outcome recorded in
  `~/.flow/state/<slug>.json` and surfaced as the gate summary's
  CLEANUP row; (3) `flow reap` as the crash-path net, never the
  primary — it covers both registered rows left by a crashed session
  and shape-heuristic strays, and stays report-only without `--yes`.
  See `skills/pipeline/flow-pipeline/SKILL.md` "Resource cleanup".
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
  - **Auto-commit exemption: `flow-epic-sync --commit`.** One status.json
    path, base-branch-legal via the installed guard's status.json allowlist
    (self-healed in place when outdated).
  - **Auto-push exemption: `flow-epic-sync --push`** (and `flow epic
done`'s heal): that one commit, never forced. Both contracts:
    [git-workflow.md](../../references/git-workflow.md).
  - **Auto-merge exemption: `/flow-pipeline` step 10.** Exempt for one
    narrow, named operation: `gh pr merge --squash <PR>` inside step 10,
    only on an auto-merge gate verdict (`flow-gate-decide` returns
    `auto-merge`), only on a PR `/flow-pipeline` opened itself. The
    exemption does **not** extend to a `gated` verdict: a `gated` PR is
    merged only through the fresh-confirmation gate-override path
    (`AskUserQuestion`, recorded by `flow-merge-guard --record-override`,
    enforced by the step-10 backstop). Full anti-pattern catalogue and
    the `--no-auto-merge` opt-out are at
    [references/git-workflow.md](../../references/git-workflow.md).
  - **Shared rationale for the eight Task-tool exemptions below**: the
    supervisor is depth 1, so its own Task calls are never nested; flow
    chooses flat one-shot fan-out despite nesting being
    platform-possible — none of the eight sites below nests; each subagent
    is one-shot; and each is documented bidirectionally with
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules". Full
    five-point rationale and each exemption's unique contract (spawn
    site, artifact path, typed fields, model override) are at
    [references/exemption-contracts.md](../../references/exemption-contracts.md);
    only the byte-exact opener and a one-line summary remain below.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-pr-review` Independent
    Multi-Agent Review.** Step 8's up to seven review agents (the seventh,
    `product`, brief-gated) plus one intent-guess agent, in one fan-out
    message re-fanned at most once on a widen.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-product-planning`
    Independent Discovery Subagent.** Step 3's one discovery agent + one
    blind `flow-product-critic`.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-new-feature`
    Independent Scout Subagent.** Step 5's one scout agent, wider-scope
    path only.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-pr-review` Fix-Applier
    Subagent.** Step 8's one fix-applier agent for the per-finding
    address loop + commit/push.
  - **Task-tool exemption: `/flow-pipeline` → Merge-Conflict Resolver
    Subagent.** Step 10's one resolver agent for the base-branch merge +
    per-file resolution + push, per-pipeline branch only.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-coder` Independent
    Edit-Applier Subagent.** The edit-applier agent `/flow-coder` spawns
    when `/flow-new-feature` step 5, `/flow-verify` step 3, or
    `/flow-refactoring` step 3 takes its wider-scope path — or the
    supervisor's **interactive code-change redirect** path; full
    contract in `skills/pipeline/flow-coder/SKILL.md`.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-pr-review` Independent
    Consolidator-Validator Subagent.** Step 3.5's one consolidator
    agent, default Sonnet.
  - **Task-tool exemption: `/flow-pipeline` → `/flow-verify` Independent
    UI-Driver Subagent.** The browser-drive agent (`flow-ui-driver`), on a
    `ran:true`/`bootstrap` `flow-ui-validate` verdict only, writing
    `.flow-tmp/ui-driver-result.json`; default `sonnet`, never inherited.
    Two callers, one exemption: `/flow-verify` UI-smoke and
    `/flow-pr-review` 8c.iii. These are the **only eight**
    authorised Task-tool fan-out sites from `/flow-pipeline`; no other
    skill or step may call Task.
  - **Task-tool spawn sites must load Task first.** Each of the nine
    sites above must load the Task schema via
    `ToolSearch query="select:Task"` before invoking Task (or its alias
    `Agent`); on a missing schema, escalate
    `NEEDS HUMAN: task-tool-unavailable: <exemption-name>` rather than
    falling back inline. Enforced by `bin/skill-md-lint.test.ts`'s "Load
    the Task tool before spawning" check at all nine sites.
  - **A `SendMessage` continuation of a partial agent stays inside its
    exemption — not an eighth site** (`references/partial-result-continuation.md`).
  - The `/flow-pr-review` Gemini lens, the cross-model intent guess
    (`flow-gemini-intent-guess`), the `/flow-pipeline` Step-3
    **cross-model plan review**, and the Step-3
    **blind method survey** are a
    **Bash fan-out, not an eighth exemption** —
    `flow-delegate`/`flow-plan-review`/`flow-blind-survey` calls, no
    Task, graceful skip sans agy. The same holds for **headless Claude
    via `flow-claude-headless`** (contract:
    `skills/pipeline/flow-pipeline/references/headless-claude.md`).
  - **AskUserQuestion exemption: `/flow-pipeline` step 9 gate-override
    sub-step.** The single confirmation form fired when the user
    instructs the supervisor to merge a `gated` PR anyway — a _fresh_
    confirmation, not an inference from an earlier instruction. This
    named form is the **only** authorised `AskUserQuestion` site.
  - **The intent interview's two pauses (`triage-pending-interview`,
    `plan-pending-interview`) are ordinary markdown chat pauses, NOT
    `AskUserQuestion`** — no new exemption, one-form rule unaffected;
    full contract in
    `skills/pipeline/flow-pipeline/references/interview-playbook.md`.
  - **Auto-issue-create exemption: `/flow-pr-review` Step 6 deferral path,
    `/flow-pr-review` Step 5 retrospective generic-gap capture,
    `/flow-pipeline` Step 10 post-merge sweep, a user-instructed
    `flow-untracked file <n>` reply, and `/flow-file-issue`'s hand-filed
    path.** `flow-create-issue` fires only from these five sites;
    `flow-untracked` only lists, never files itself. Curation and the
    checkpoint-free `advance-to-step-5` route are detailed at
    [references/git-workflow.md](../../references/git-workflow.md).
  - **`/flow-epic-create` is a separate sanctioned supervisor session.**
    `flow epic create` spawns a fresh top-level `/flow-epic-create` session, so
    `/flow-pipeline`'s exactly-7 and one-form rule are unaffected by its
    two named surfaces: **Task-tool fan-out: `/flow-epic-create` →
    /flow-product-planning MODE: epic designer.** and **AskUserQuestion
    form: `/flow-epic-create` clarification round.** Its
    **cross-model design review** is a
    **Bash fan-out, not an eighth exemption** —
    `review.gemini`-gated `flow-plan-review` over `design.md`; no Task,
    no form.
  - **`/flow-epic-run` is a separate sanctioned playbook session.**
    `flow epic run <slug>` opens a fresh `/flow-epic-run` playbook
    session — a playbook, not a loop, reconciling the manifest against
    GitHub/git truth. Zero named fan-out: **no** Task/Agent sub-agent,
    **no** `AskUserQuestion` form. `gated ⇒ escalate-only`, never merges
    a feature PR.
  - **`/flow-backlog-triage` is a separate sanctioned standalone
    session,** so `/flow-pipeline`'s exactly-7 and one-form rule are
    unaffected by its one named surface: One Task-tool fan-out (Phase-1
    verification via `flow-backlog-verifier`), zero `AskUserQuestion`
    forms; contract in `skills/universal/flow-backlog-triage/SKILL.md`.

Static agent-type definitions live at **`agents/<moduleId>/*.md`** (today
only `core/`), symlinked as ONE dir per module (`flow-module-<id>/agents`;
Claude Code follows symlinked dirs, not files). Frontmatter pins are
enumerated by `AGENT_FRONTMATTER_POLICY` in `bin/skill-md-lint.test.ts`;
per-spawn `model:` wins. In-process skills pin `effort:`, never `model:`.
