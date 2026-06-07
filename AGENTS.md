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

Response guidelines for any agent working in this repo. The first
entry is an accuracy rule (a precondition for every other rule that
emits prose, citations, or recipes); the rest are ordered by
token-savings impact, highest first.

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
  issue or PR creation date. Prefer authoritative sources over
  non-authoritative ones: official vendor documentation (Anthropic,
  Google, etc.) and peer-reviewed research outrank random blogs (e.g.
  Medium.com) when researching — especially AI topics — so weight a
  claim's credibility by its source, and verify anything an official
  source can confirm against that source rather than a secondary
  write-up. When in doubt, verify.
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
- **Consider the middle ground when a request is framed as a binary choice.**
  When a prompt poses an either/or — "should it work like A or B?",
  "store it in the URL or the database?", "fast or simple?" — the two
  named poles are evidence of how the user is currently thinking, not a
  constraint on the solution space. The better answer is frequently an
  intermediate option: a subset of A's capability with B's simplicity, a
  phased rollout, a config-gated default, a hybrid that takes the cheap
  80% of each. Your job is to (a) name at least one such middle-ground
  option alongside the two poles rather than silently picking a pole,
  and (b) surface the A / middle / B trade-off in the artifacts
  downstream consumers read (the discovery subagent's PRD Architecture
  Decisions / Open Questions sections, the `/new-feature` Critical
  Analysis "Consider alternatives" bullet) so the user can redirect at
  the next approval checkpoint. Same family as **Treat user prompts as
  evidence of intent, not exhaustive specifications.** above — a binary
  framing is one more way a prompt under-specifies — and the same
  discipline applies: proceed with the most-likely-correct option and
  surface alternatives in artifacts when work-without-stopping is in
  effect.
  The genuinely-binary case still exists (a boolean flag, a yes/no
  migration); the rule is to *check* for a middle ground, not to
  manufacture one where none exists. The structural lint for this rule
  lives at `bin/skill-md-lint.test.ts` and anchors on the exact phrase
  **Consider the middle ground when a request is framed as a binary choice.** — renames must update the lint in the same commit.
- **Fix cheap, in-scope robustness issues now rather than deferring them.**
  When a fix is small (a handful of lines), low-risk/mechanical, AND
  directly related to code the PR touches or to a brittleness the PR
  itself introduced, fix it in-PR — don't defer it to an issue or park
  it in `anti_patterns_found` as an "accepted trade-off" — even when the
  clean fix needs a minimal touch to an adjacent production file.
  "Don't add features beyond the task's stated scope" targets
  unrequested feature creep, not a trivial edit that makes the PR's own
  change robust; deferral stays reserved for genuinely standalone or
  complex work. The full bar and its motivating incident live in
  `templates/AGENTS.md.template` and `/pr-review`'s
  `references/fix-applier-instructions.md`; the lint anchors on the
  exact phrase **Fix cheap, in-scope robustness issues now rather than
  deferring them.** in `bin/skill-md-lint.test.ts`.
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
  Restating what the code does is noise.
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
  Comments vocabulary). They don't appear in `git log` / `git blame`
  after merge — durable rationale still belongs in commit-body
  Why-sections and the PR body's `## Why`. See
  `skills/pipeline/new-feature/SKILL.md` Step 5b for the trigger contract
  (rules a/b/c, per-file dedup, ≤8/PR cap, overflow bullet) and
  `skills/pipeline/pr-review/SKILL.md` Step 3 for how `/pr-review`
  consumes them as `{{EXISTING_INTENT_COMMENTS}}` context.
- **Session marker + trailer:** every PR `flow-open-pr` freshly creates
  inside a Claude Code harness ends with a single-line, self-describing
  HTML-comment marker — `<!-- flow: this PR was created by Claude Code
  session <id> - transcript at ~/.claude/projects/<encoded-cwd>/<id>.jsonl
  on the originating machine -->` — sourced from the `CLAUDE_CODE_SESSION_ID`
  env var. It is best-effort and same-machine-only; absent the env
  var the PR opens with no marker. Because the marker is an HTML comment it is invisible
  in GitHub's rendered view and stripped by the auto-merge gate before
  it counts unchecked `- [ ]` items. The marker is lost from `git
  history` on squash-merge, so the same session ID also reaches `git
  log` / `git blame` as a `Claude-Code-Session-Id:` trailer — but via a
  per-commit git hook, not step 10. `flow-new-worktree` installs a
  worktree-scoped `prepare-commit-msg` hook (scoped via
  `extensions.worktreeConfig` + a worktree-scoped `core.hooksPath` so
  it never fires for the user's primary repo) that appends
  `Claude-Code-Session-Id: <id>` to **every individual commit** made
  in the worktree when `CLAUDE_CODE_SESSION_ID` is set; it is
  idempotent and inert when the env var is unset. gh's default
  squash concatenation of the branch's commit messages then carries the
  trailer into the squash-merge commit — `/flow-pipeline` step 10 runs a
  bare `gh pr merge --squash` with zero `--body` manipulation. The
  optional `sessionId` string field in `~/.flow/state/<slug>.json` is
  still written by `flow-open-pr` at PR-open time for the HTML-comment
  marker path, but step 10 no longer reads it.

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
subprocess. **Make the `verify` job a required status check** via a
branch ruleset (or classic branch protection) on `main` so a red PR
cannot be merged — the status check to select is the job name `verify`
(GitHub may display it as `CI / verify` in the PR checks tab). This is
a repo-admin setting, not something the workflow file can enforce.

## What flow is *not*

- The supervisor does not re-implement Claude Code skills inside its own
  process. It hosts a skill library at `skills/` distributed via
  `flow setup`; `bin/flow` only routes verbs to helper scripts and
  tmux. Pipeline behaviour lives in the `/flow-pipeline` supervisor
  skill, executed by Claude Code inside a tmux window.
- It is not a full SDLC tool. It does not host a web UI, post to Slack,
  open Jira tickets, or manage permissions.
- It is not a long-running daemon. Each `flow` invocation does one thing
  and exits. Per-pipeline state persists in `~/.flow/state/<slug>.json`
  and the tmux window's scrollback.

## Consumer-repo notes

`flow-pre-commit` is the verify gate `/flow-pipeline`, `/verify`, and
`/coder` rely on, so consumer repos wiring it in as their sole gate need
its surface area. Scope detection is prefix- and extension-based against
the diff: `src/` trips `src`; `scripts/`, `templates/scripts/`, and
`bin/` all trip `scripts`; any `.md` or `.template` file trips
`docs`, which runs `flow-md-validate .` (link + frontmatter checks;
`.md`-only, so skips `.template` source), `npm run test` (so
structural-anchor lints — e.g. `bin/skill-md-lint.test.ts` — catch
markdown-only breakage that `.md`/`.template`-only diffs wouldn't reach
via `root-fallback`), and `npm run lint` (the repo-wide `prettier
--check .`, as in `src`/`scripts`/`root-fallback`); the `backend/`
prefix trips `backend`, which runs `go vet -C backend ./...`
and `go test -C backend ./...` (prefix-only — `backend/go.mod`/`go.sum`
edits re-run the gate too). Workflow YAML under `.github/workflows/`
(`.yml`/`.yaml`) ALSO trips `actions` (`actionlint
.github/workflows/` + `npm run lint`) on top of `scripts`, so the same
edit runs both `bin/`'s workflow-shape regression tests AND `actionlint`. `actionlint`
and `go` are OPTIONAL: off `PATH`, the affected check emits `skipReason:
'actionlint-not-installed'`/`'go-not-installed'` and counts `passed: true`
(parallel to `filterDefinedChecks`'s missing-script handling). The
`root-fallback` pseudo-scope (`npm run typecheck` + `npm run test` +
`npm run lint` at the repo root) fires **additively** — appended alongside
matched scopes for any file no other scope claimed (a fully-claimed diff
does not append it). So a root file (`package.json`) is covered identically
alone or bundled. The catch-all reaches every unclaimed
path, so `reason: "unmatched-files"` effectively no longer fires (its code
stays as a defensive guard).
(`filterDefinedChecks` drops any check whose npm script `package.json`
doesn't define; a zero-check non-empty diff signals `allPassed: false` with
`reason: "no-checks-defined"`.)

**Zero-config monorepo auto-detect + three-layer command resolution.**
Before root-fallback claims orphans, a SEPARATE pass over the unclaimed
files recognizes `apps/<pkg>/` and `packages/<pkg>/` dirs that **own a
`package.json`**, mapping each to an auto-detected scope named by its path
(`apps/web`, selectable via `--scope apps/web`; nothing written) — so
`apps/web/src/b.ts` is claimed when its owner exists; a no-owner file falls
to root-fallback. Every scope's commands (built-in OR auto-detected) resolve
through one shared table in `bin/lib/stack-table.ts`: (1) the package's own
declared verify scripts, probed `typecheck`/`check` (first wins) → `lint`
→ `test` → `format:check`, scoped `npm run <script> -w <pkg-path>`; a
**name-based** denylist never runs mutating/interactive scripts
(`format`/`dev`/`build`/`preview`/`smoketest`/`*:watch`/`*:e2e`) — matching
NAMES not bodies, so a legit `test` chaining to `test:watch` still runs;
(2) a stack-default table keyed on a marker file (v1: node + go), into
which flow's built-ins are lifted unchanged;
(3) a flow-drafted `.flow/pre-commit.json` entry committed into the PR diff
(see `/flow-pipeline` Step 6) when 1–2 resolve nothing. That file
(distinct from `~/.flow/config.json`) is also the **escape-hatch** —
a top-level array of `{ name, prefixes, checks }` scopes, merged config >
auto-detect > built-in. These `checks` run as argv (no shell/injection),
widening the fixed allowlist to arbitrary commands the operator trusts.

## Don'ts

- Don't bypass the helper scripts. The supervisor must always call
  `flow-new-worktree` / `flow-remove-worktree` / `flow-state-update`
  rather than reimplementing their behaviour with raw `git` / `gh` calls.
- Don't spawn sub-agents from the supervisor. See above. The eight
  named exceptions are `/pr-review`'s Multi-Agent Review,
  `/product-planning`'s Discovery, `/new-feature`'s Scout,
  `/pr-review`'s Fix-Applier, `/flow-pipeline` step 10's
  Merge-Conflict Resolver, `/coder`'s Edit-Applier, `/pr-review`
  Step 1.5's Gatekeeper, and `/pr-review` Step 3.5's
  Consolidator-Validator subagents — all eight covered by
  "Task-tool exemption" bullets below; no other skill or step may
  call Task.
- Don't add features beyond the task's stated scope.
- Don't propagate unverified factual claims. The trigger categories,
  per-category verification recipes, and anti-patterns live in
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
  final edits landing. On `main`, pause and ask before committing even
  when running a code-editing skill, since direct commits to main
  bypass review. Pushing remains gated by the named exemptions below;
  creating PRs counts as user-visible action — confirm before pushing.
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
    `gh pr merge --squash <PR>` call inside step 10,
    only when the auto-merge gate fires (`flow-gate-decide` returns
    `auto-merge` — the Test Steps section has zero unchecked items) and
    only on a PR opened by `/flow-pipeline` itself. The exemption does
    **not** extend to a `gated` verdict: a `gated` verdict is terminal,
    and a `gated` PR is merged by `/flow-pipeline` only through the
    fresh-confirmation gate-override path (a new, unambiguous,
    in-context user instruction confirmed via `AskUserQuestion`,
    recorded by `flow-merge-guard --record-override`, enforced by the
    `flow-merge-guard` step-10 backstop). The supervisor may never
    substitute its own judgment for a `gated` verdict — see
    `skills/pipeline/flow-pipeline/references/auto-merge-rubric.md` "A
    `gated` verdict is terminal, not advisory". **Anti-patterns this
    exemption explicitly forecloses:** (a) reclassifying an unchecked
    functional Test Steps item as "subjective UX" so the gate verdict
    comes out as `auto-merge`; (b) merging a `gated` PR on the strength of a stale or
    inferred "merge" / "ship it" instruction given before the gate
    verdict was surfaced. Invoking `/flow-pipeline` is itself the user's
    authorisation; opt out per-pipeline with `flow new --no-auto-merge`
    (the supervisor stops at the gated state regardless of the gate
    verdict).
  - **Shared rationale for the eight Task-tool exemptions below.**
    `/flow-pipeline`'s "Hard rules" forbid the supervisor from calling
    the `Task` / `Agent` tool, with eight named exceptions. The same
    rationale covers all eight, so it is stated here once: (a) the
    supervisor is itself a top-level Claude Code session, so the
    one-level sub-agent cap doesn't apply to *its* Task calls; (b) each
    subagent is one-shot (returns an artifact + brief summary, then
    exits), so the context-bloat constraint doesn't apply either; (c)
    every exemption is anchored on its step *heading name*, not its
    number, so it survives renumbering; (d) every exemption is
    documented bidirectionally in
    `skills/pipeline/flow-pipeline/SKILL.md` "Hard rules" and the
    consumed skill's own SKILL.md; (e) the narrow-and-named-contract
    discipline applies — each names exactly one spawn site, and a future
    skill needing the same license must be added here by name rather
    than generalising the rule. Each exemption's unique
    contract — spawn site / triggering step, artifact path, typed
    artifact fields, model override, edge-case prose — lives in
    [references/exemption-contracts.md](references/exemption-contracts.md);
    only the byte-exact opener and a one-line summary remain below.
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` Independent
    Multi-Agent Review.** Step 8's six parallel review agents, each
    writing its own `agent-output-<lens>.json`.
  - **Task-tool exemption: `/flow-pipeline` → `/product-planning`
    Independent Discovery Subagent.** Step 3's one discovery agent,
    writing `.flow-tmp/plan.md` + `.flow-tmp/pr-description-draft.md`.
  - **Task-tool exemption: `/flow-pipeline` → `/new-feature`
    Independent Scout Subagent.** Step 5's one scout agent (wider-scope
    path only — ≤3 affected files skip it), writing `.flow-tmp/scout.md`.
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` Fix-Applier
    Subagent.** Step 8's one fix-applier agent for the per-finding
    address loop + commit/push, writing `.flow-tmp/fix-applier-result.json`.
  - **Task-tool exemption: `/flow-pipeline` → Merge-Conflict Resolver
    Subagent.** Step 10's one resolver agent for the rebase + per-file
    resolution + force-push (per-pipeline branch only), writing
    `.flow-tmp/merge-resolver-result.json`.
  - **Task-tool exemption: `/flow-pipeline` → `/coder` Independent
    Edit-Applier Subagent.** The one edit-applier agent `/coder` spawns
    when `/new-feature` step 5, `/verify` step 3, or `/refactoring`
    step 3 takes its wider-scope path — or the `/flow-pipeline`
    supervisor's interactive code-change redirect path fires — writing
    `.flow-tmp/coder-result.json`; full contract in
    `skills/pipeline/coder/SKILL.md`. These are the **only eight**
    authorised Task-tool fan-out sites from `/flow-pipeline`; no other
    skill or step may call Task.
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` Independent
    Gatekeeper Subagent.** `/pr-review` Step 1.5's one gatekeeper agent
    with a `model: "haiku"` cost-routing override, writing
    `.flow-tmp/gatekeeper-result.json`.
  - **Task-tool exemption: `/flow-pipeline` → `/pr-review` Independent
    Consolidator-Validator Subagent.** `/pr-review` Step 3.5's one
    consolidator-validator agent (default Sonnet, no model override),
    writing `.flow-tmp/consolidator-result.json`.
  - **Task-tool spawn sites must load Task first.** Each of the eight
    sites above must load the Task schema via
    `ToolSearch query="select:Task"` before invoking Task (or its alias
    `Agent`); if neither alias is surfaced top-level, an unguarded
    invocation silently falls through to in-line execution — so on
    missing schema, escalate
    `NEEDS HUMAN: task-tool-unavailable: <exemption-name>` rather than
    falling back inline. `bin/skill-md-lint.test.ts` enforces the
    "Load the Task tool before spawning" paragraph at all eight sites.
    A sibling guard, not a ninth exemption.
  - **AskUserQuestion exemption: `/flow-pipeline` step 4 candidate-
    issues sub-step.** The multi-select form fired during step 4's
    "Candidate follow-up issues sub-step" to pick which orthogonal
    candidates to file post-merge. One of two authorised
    `AskUserQuestion` sites (a synchronous user prompt, not a sub-agent
    fan-out); naming the fire site keeps the user-prompt surface
    auditable.
  - **AskUserQuestion exemption: `/flow-pipeline` step 9 gate-override
    sub-step.** The single confirmation form fired during step 9's
    "Gate override (post-verdict, opt-in)" sub-step, when the user
    instructs the supervisor to merge a `gated` PR anyway — a *fresh*
    confirmation that puts the gate verdict in front of the user rather
    than inferring authorisation from an earlier instruction. An
    affirmative answer is recorded by `flow-merge-guard
    --record-override` and enforced by the step-10 backstop. These two
    — step 4 candidate-issues and step 9 gate-override — are the
    **only** authorised `AskUserQuestion` sites, documented
    bidirectionally with `skills/pipeline/flow-pipeline/SKILL.md`.
  - **Auto-issue-create exemption: `/pr-review` Step 6 deferral path
    and `/flow-pipeline` Step 10 post-merge sweep.** `flow-create-issue`
    may fire only from these two named sites: (a) `/pr-review` deferring
    a finding past the 3-criterion bar
    (`--label flow-agent,deferred-review`), and (b) `/flow-pipeline`
    step 10's post-merge sweep
    (`--label flow-agent,out-of-scope-discovery`, once per `- [x]`
    candidate in plan.md). Indiscriminate auto-creation pollutes
    backlogs and races on `gh` rate limits; both sites have explicit
    user opt-in. Documented bidirectionally in
    `skills/pipeline/flow-pipeline/SKILL.md`,
    `skills/pipeline/pr-review/SKILL.md` Step 6, and
    `bin/flow-create-issue.ts`.
