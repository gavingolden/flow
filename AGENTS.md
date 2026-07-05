# flow — agent guide

`flow` has two responsibilities in one repo:

1. A **tmux-driven multi-phase pipeline supervisor**. Each `flow feature create
   "<description>"` opens a tmux window running Claude Code, and the
   `/flow-pipeline` supervisor skill drives the full pipeline (triage →
   plan → worktree → implement → verify → CI → review → gate → merge)
   inside that one chat session. Sub-skills load in-process; helper
   scripts under `bin/` are Bash tool calls.
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

The redesign from a Node orchestrator to a tmux-driven supervisor is
complete: `src/`, the per-repo `flow install`, and the orchestrator-
only skills (`flow-add`, `flow-approve`, `flow-revise`, `flow-watch`,
`flow-status`) are deleted. The wrapper at `bin/flow` is Bun and
dispatches verbs natively with no passthrough fallback.

## Code conventions

- **Runtime:** Bun for everything under `bin/`. `package.json` declares `engines.node >= 20` so `npm install` and `npm run test` (vitest) still work, but no shipped code is Node-specific.
- **Style:** small, single-purpose modules. Target < 200 lines/file.
- **Comments:** default to none. Add one only when the *why* is non-obvious (a constraint, a workaround, a subtle invariant). Don't restate what the code does.
- **Errors:** validate at boundaries (CLI args, subprocess output, parsed YAML). Trust internal callers. No defensive checks for things that can't happen.
- **No premature abstractions.** A phase is just a function. Don't introduce a `Phase` class hierarchy until two phases share enough behaviour to justify it.
- **No backwards-compat shims.** flow has no users yet. Refactor freely.

## Output style

Response guidelines for any agent working in this repo. The first entry is an accuracy rule (a precondition for every other rule that emits prose, citations, or recipes); the rest are ordered by token-savings impact, highest first.

- **Verify factual claims before emitting them.** Always try to verify factual claims proactively via an API request, doc fetch, or filesystem check before propagating them into edits, PR bodies, or scripts — especially values that have been latent/unvalidated for a while. Concrete trigger categories: SHAs, file paths, line numbers, URLs, issue/PR numbers, version strings, env-var names, API surface shapes (function names, exported symbols, flag names), dates, exemption counts, deprecated CLI flags. Anti-patterns to call out explicitly: paraphrasing `AGENTS.md` from memory in a commit Why-section, copy-pasting a prior PR body section without re-checking its citations, citing line numbers from a stale `Read`, claiming an exemption count that has since changed, hardcoding a SHA from earlier in the session without re-running `git rev-parse`, quoting a CLI flag from memory after the `--help` shape may have changed. Per-category verification recipes — line number: `Read` the file at the exact path before citing; SHA: `git rev-parse <ref>`; URL: `curl -sI` or follow the link; PR number + state: `gh pr view <n> --json title,state,mergedAt`; issue number + state: `gh issue view <n> --json title,state` (the PR variant verifies PRs only — a plain issue lookup against `gh pr view` fails or surfaces the wrong record); count: `grep -cE '<anchored-pattern>' <file>` (never unanchored substring); CLI flag: `<verb> --help`; file existence: `test -f <path>`; exported symbol: `grep -n '<symbol>' <module>`; version: `<verb> --version` or `jq -r .version package.json`; env-var name: `grep -n '<NAME>' .env.example` (the example file is the canonical source-of-truth check); date: `git log --format='%ad' --date=short -1 <ref>` for a commit or tag, `gh api repos/{owner}/{repo}/issues/<n> --jq .created_at` for an issue or PR creation date. Prefer authoritative sources: official vendor docs (Anthropic, Google) and peer-reviewed research outrank random blogs (Medium.com) — especially on AI topics — so weight credibility by source and confirm against the official source. When unsure, verify.
- **Treat user prompts as evidence of intent, not exhaustive specifications.** User prompts may contain mistakes, incompleteness, unintended scope restriction, and misweighted goals. When a prompt names prescribed methods (a numbered list, an explicit enumeration of moves) AND a stated quantitative target (`<800 lines`, `30% faster`, `≤ 100ms`), your job is to (a) identify tensions — prescribed-methods-vs-stated-target, under-specification, conflicting constraints — and surface them in the artifacts downstream consumers read (the PRD's `## Prompt interpretation` section; the `/new-feature` Critical Analysis row; `/flow-pipeline` Step 3 routes non-feature tensions to the approval checkpoint), and (b) proceed with the most-likely-correct interpretation toward the stated goal, not the literal interpretation that fails it. The nine Task-tool exemptions and other narrow-and-named contracts cap the scope you can take on without authorisation; this rule governs *interpretation* inside an authorised scope, not scope expansion past it. PR #170 is the canonical precedent: the user named four prescribed trims AND a `<800 lines` target; the agent landed all four (`-71 lines`, finishing at 1337 — 537 above target) and reported success because the methods landed, never surfacing that they couldn't reach the target. Anti-patterns: (a) reading prescribed moves as exhaustive when the target needs more — surface the gap and name additional safe steps in the plan; (b) treating an aspirational target as wishful when methods fall short — it is evidence the user wants the methods to reach it; (c) asking for clarification when work-without-stopping is in effect — instead surface the tension in artifacts (the PRD's Open Questions, the Critical Analysis row) so the user can redirect at the next checkpoint. The structural lint for this rule lives at `bin/skill-md-lint.test.ts` and anchors on the exact phrase **Treat user prompts as evidence of intent, not exhaustive specifications.** — renames must update the lint in the same commit.
- **Consider the middle ground when a request is framed as a binary choice.**
  When a prompt poses an either/or — "should it work like A or B?",
  "store it in the URL or the database?", "fast or simple?" — the two
  named poles are evidence of how the user is currently thinking, not a
  constraint on the solution space. The better answer is often an
  intermediate option: a subset of A's capability with B's simplicity, a
  phased rollout, a config-gated default, a hybrid taking the cheap 80% of
  each. Your job is to (a) name at least one such middle-ground option
  alongside the two poles rather than silently picking a pole, and
  (b) surface the A / middle / B trade-off in the artifacts downstream
  consumers read (the PRD's Architecture Decisions / Open Questions, the
  `/new-feature` Critical Analysis "Consider alternatives" bullet) so the
  user can redirect at the next checkpoint. Same family as **Treat user prompts as
  evidence of intent, not exhaustive specifications.** above — a binary
  framing is one more way a prompt under-specifies — and the same
  discipline applies: proceed with the most-likely-correct option and
  surface alternatives in artifacts when work-without-stopping is in effect.
  The genuinely-binary case still exists (a boolean flag, a yes/no migration);
  the rule is to *check* for a middle ground, not manufacture one where none
  exists. The structural lint for this rule
  lives at `bin/skill-md-lint.test.ts` and anchors on the exact phrase
  **Consider the middle ground when a request is framed as a binary choice.** — renames must update the lint in the same commit.
- **Understand the ultimate goal behind the request, not just the literal ask.**
  Find what the user ultimately wants to fix, unblock, or speed up (the XY
  problem; "so that `<goal>`"). **Conditional:** run expert / trivial /
  time-critical requests literally; ladder up only on ambiguous /
  high-blast-radius ones. Default: infer the goal in one line and proceed,
  surfacing the alternative in the PRD / PR `## Why`; ask one goal-framing
  question at kickoff (never mid-run) only when genuinely unclear AND guessing
  wrong is costly/irreversible. Anti-patterns: no "always ladder up"; no
  ceremonial root-cause section; never interrogate (the framing lenses stay
  internal — Five Whys especially). Technique:
  `skills/pipeline/product-planning/references/discovery-playbook.md` (Ladder Up + framing lenses);
  don't re-author it. Same family as the two rules above; governs *altitude*. The
  lint anchors on the exact phrase **Understand the ultimate goal behind the
  request, not just the literal ask.** in `bin/skill-md-lint.test.ts`.
- **Fix cheap, in-scope robustness issues now rather than deferring them.**
  When a fix is small (a handful of lines), low-risk/mechanical, AND
  directly related to code the PR touches or to a brittleness the PR
  itself introduced, fix it in-PR — don't defer it to an issue or park
  it in `anti_patterns_found` as an "accepted trade-off" — even when the
  clean fix needs a minimal touch to an adjacent production file.
  "Don't add features beyond the task's stated scope" targets unrequested
  feature creep, not a trivial edit that makes the PR's own change robust;
  deferral stays reserved for standalone or complex work. The full bar and
  its motivating incident live in `templates/AGENTS.md.template` and
  `/pr-review`'s `references/fix-applier-instructions.md`; the lint anchors
  on the exact phrase **Fix cheap, in-scope robustness issues now rather
  than deferring them.** in `bin/skill-md-lint.test.ts`.
- **Treat every request as production-bound, not a hobby project.** Judge
  scope and quality through a public-release lens. *Scope:* the
  include-vs-defer test is cohesion, not size — build the cohesive parts
  of the feature in-task (it shares the feature's user goal or surface, or
  its absence leaves the feature partial) and suggest a separate issue only
  for a genuinely separate feature; never use a follow-up to dodge in-scope
  work. *Quality:* hold a production bar — error handling, edge cases,
  accessibility, tests — on the surface you touch. This raises completeness,
  not feature count: the **Fix cheap, in-scope robustness issues now…** rule
  and Anti-Overengineering still govern, so the standard is minimal scope at
  a production standard, not gold-plating. The full bar lives
  in `templates/AGENTS.md.template`; the lint anchors on the exact phrase
  **Treat every request as production-bound, not a hobby project.** in
  `bin/skill-md-lint.test.ts`.
- **Satisfy local, reversible preconditions before gating a Test Step as manual.**
  A Test Step whose only unmet preconditions are `local and reversible` is runnable,
  not manual — satisfy them yourself (start the dev server, seed the local DB, set a
  local `.env`, drive the repo's headless browser, probe-then-attempt when unsure a
  dependency is up) before ticking or gating. Reserve the manual gate for genuinely
  external/irreversible resources or subjective judgment; this loosens no guardrail
  on external/destructive/irreversible actions. Full contract
  `skills/pipeline/pr-review/references/manual-test-rubric.md`.
- **Non-trivial UI appearance changes need an authored SUBJECTIVE: approval step the agent can't tick.**
  Full contract `skills/pipeline/pr-review/references/manual-test-rubric.md`.
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
- **No sycophantic openers.** "Great question", "You're absolutely
  right", "Successfully implemented…" add nothing.
- **No emojis unless the user uses them first.** Match the user's
  register; don't introduce decoration they didn't invite.
- **Don't apologize for errors — just correct.** "Sorry, you're right,
  let me fix that" is filler. Make the correction.
- **Don't narrate internal deliberation.** Think between tool calls,
  not in chat. The user does not need to read your reasoning loop;
  they need the conclusion and the next action.
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
`flow-notify`, `flow-stop-guard`, `flow-ui-validate`, `flow-delegate`, `flow-delegate-fanout`, `flow-plan-review`, `flow-research-cache` — live there with `.ts`
extensions, Bun shebangs, and tests next door (`<name>.test.ts`). `flow install` symlinks each into `~/.local/bin/<name>` (extensionless on PATH). `flow-ui-validate`'s `bin/lib/ui-validation-schema.ts` is an internal import, NOT in the allowlist below. `flow-delegate-fanout` powers `flow-research`.

The three schema validators `flow-pr-review-result-schema`, `flow-agent-finding-schema`, and `flow-fix-applier-schema` are ALSO symlinked onto PATH by `flow install` — but sourced from `bin/lib/*-schema.ts` via an explicit-allowlist `discoverValidators` (distinct from `discoverHelpers`' auto-pickup of every `bin/*.ts`), so pipeline skills invoke them by bare name regardless of cwd.

The `flow` wrapper itself is also Bun, at `bin/flow`. It dispatches every
verb natively — there is no passthrough or legacy entry point.

Static agent-type definitions live in **`agents/`** (`*.md` frontmatter), discovered by `discoverAgents` and symlinked to `~/.claude/agents/`; `flow-verify` and `flow-fix-applier` pin the two mechanical fan-outs to `effort: low` (per-spawn `model:` still wins).

Conventions for any script under `bin/`:

- `#!/usr/bin/env bun` shebang and `chmod +x`.
- Use `import.meta.main` (Bun's symlink-aware "is this the entry point?" check) to gate the `main()` call. Do **not** compare `import.meta.url` to `process.argv[1]` — that comparison breaks when the script is invoked through a symlink.
- Tests live next door as `<name>.test.ts` and run via vitest (`npm run test`). They're flow-internal: `flow install` skips `*.test.ts` files when symlinking, since consumers don't need them on PATH.
- Source ≠ install target by design (`bin/` in flow's repo vs `~/.local/bin/` on the user's machine). Don't move scripts back to the install directory.

When adding a new script, default to Bun. To deviate (e.g. a Node-only dependency), confirm with the user first and document the exception inline.

## Supervisor and sub-skills: in-process only

The load-bearing constraint for `/flow-pipeline`: the supervisor is one
Claude Code chat session, sub-skills (`/product-planning`,
`/new-feature`, `/verify`, `/pr-review`) load in-process via the `Skill`
tool, and helper scripts under `bin/` are Bash tool calls. The
supervisor never spawns the `Task` / `Agent` tool and never invokes
`claude -p ...` subprocesses, **with nine narrowly-named exceptions** —
the `**Task-tool exemption: ...**` bullets under `## Don'ts` below, with
a shared-rationale preamble. This binds the supervisor and its
sub-agents; a standalone leaf skill (`/flow-research` run directly)
firing `claude -p` is a context it never governed, and `flow-research`'s
`FLOW_PIPELINE` guard gates it off when nested (see SKILL.md). This
sidesteps two limits: the one-level sub-agent cap, and context bloat from
a long-running supervisor with sub-agents.

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
  These are high-volume and reconstructable (`state.json`, the PR, and a fresh
  `gh` / `flow-pre-commit` re-derive them).

## Git workflow

- **Branches:** short, descriptive. The supervisor uses `flow-new-worktree` to create per-pipeline branches deterministically from the slug; humans can use `<type>/<topic>` for non-supervisor work.
- **Commits:** conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). Imperative summary ≤ 50 chars. Body explains *why* — motivation, non-obvious choices, what was tried and didn't work. Trivial changes (typo, dep bump) may omit the body.
- **PRs:** Why / What / Key decisions / User-facing changes / Test Steps, in that order. The Why must read as a problem statement, not a feature spec. The Test Steps section is also the auto-merge gate signal — zero unchecked `- [ ]` items ⇒ auto-merge, one or more unchecked items ⇒ gated. See `skills/pipeline/flow-pipeline/references/auto-merge-rubric.md` for the contract.
- **Never amend pushed commits.** Make a new commit instead.
- **Never force-push** without explicit user request.
- **Inline intent annotations:** review-time-scoped per-hunk rationale authored by `/new-feature` Step 5b as inline review comments on the PR diff (`**why:** <1-2 sentences>` + `<!-- flow-intent-v1 -->` integrity suffix, prefix disjoint from `/pr-review`'s Conventional Comments vocabulary). They don't appear in `git log` / `git blame` after merge — durable rationale still belongs in commit-body Why-sections and the PR body's `## Why`. See `skills/pipeline/new-feature/SKILL.md` Step 5b for the trigger contract (rules a/b/c, per-file dedup, ≤8/PR cap, overflow bullet) and `skills/pipeline/pr-review/SKILL.md` Step 3 for how `/pr-review` consumes them as `{{EXISTING_INTENT_COMMENTS}}` context.
- **Session marker + trailer:** every PR `flow-open-pr` freshly creates inside a Claude Code harness ends with a single-line, self-describing HTML-comment marker — `<!-- flow: this PR was created by Claude Code session <id> - transcript at ~/.claude/projects/<encoded-cwd>/<id>.jsonl on the originating machine -->` — sourced from the `CLAUDE_CODE_SESSION_ID` env var. It is best-effort and same-machine-only; absent the env var the PR opens with no marker. Because the marker is an HTML comment it is invisible in GitHub's rendered view and stripped by the auto-merge gate before it counts unchecked `- [ ]` items. The marker is lost from `git history` on squash-merge, so the same session ID also reaches `git log` / `git blame` as a `Claude-Code-Session-Id:` trailer — but via a per-commit git hook, not step 10. `flow-new-worktree` installs a worktree-scoped `prepare-commit-msg` hook (scoped via `extensions.worktreeConfig` + a worktree-scoped `core.hooksPath` so it never fires for the user's primary repo) that appends `Claude-Code-Session-Id: <id>` to **every individual commit** made in the worktree when `CLAUDE_CODE_SESSION_ID` is set. gh's default squash concatenation of the branch's commit messages then carries the trailer into the squash-merge commit — `/flow-pipeline` step 10 runs a bare `gh pr merge --squash` with zero `--body` manipulation. The optional `sessionId` field in `~/.flow/state/<slug>.json` is still written by `flow-open-pr` for the HTML-comment marker path, but step 10 no longer reads it.

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
for the local-only `flow-pre-commit` gate (which a human pushing outside
`/flow-pipeline` never invokes, and an in-pipeline run can pass falsely
against stale PATH-symlinked code). The runner installs Node and Bun
(vitest spawns `bun`). **Make the `verify` job a required status check**
via a branch ruleset (or classic branch protection) on `main` so a red
PR can't merge — select job name `verify` (shown `CI / verify` in the
checks tab). A repo-admin setting, not workflow-enforceable.

## What flow is *not*

- The supervisor does not re-implement Claude Code skills in its own
  process. It hosts a skill library at `skills/` distributed via
  `flow install`; `bin/flow` only routes verbs to helper scripts and tmux.
  Pipeline behaviour lives in the `/flow-pipeline` supervisor skill, run
  by Claude Code in a tmux window.
- It is not a full SDLC tool. It hosts no web UI, Slack posts, Jira
  tickets, or permission management.
- It is not a long-running daemon. Each `flow` invocation does one thing
  and exits. Per-pipeline state persists in `~/.flow/state/<slug>.json`
  and the tmux window's scrollback.

## Consumer-repo notes

`flow-pre-commit` is the verify gate `/flow-pipeline`, `/verify`, and
`/coder` rely on, so consumer repos wiring it in as their sole gate need its
surface area. Scope detection is prefix-/extension-based against the diff:
`src/` trips `src`; `scripts/`, `templates/scripts/`, and `bin/` all trip
`scripts`; any `.md` or `.template` file trips
`docs`, which runs `flow-md-validate .` (link + frontmatter, `.md`-only),
`npm run test` (structural-anchor lints), and `npm run lint`
(`prettier --check .`); the `backend/` prefix trips `backend`
(prefix-only): `go vet -C backend ./...` and `go test -C backend ./...`.
Workflow YAML under `.github/workflows/`
(`.yml`/`.yaml`) ALSO trips `actions` (`actionlint .github/workflows/` +
`npm run lint`) on top of `scripts`. `actionlint` and `go` are OPTIONAL:
off `PATH`, the affected check emits a `skipReason` and counts as passed. The
`root-fallback` pseudo-scope (`npm run typecheck` + `npm run test` +
`npm run lint` at root) fires **additively** — appended alongside matched
scopes for any unclaimed file (never when the diff is fully claimed), so
`reason: "unmatched-files"` no longer fires. (`filterDefinedChecks` drops
undefined-script checks; a zero-check non-empty diff signals
`reason: "no-checks-defined"`.)

**Host-wide test-concurrency cap.** `flow-pre-commit` caps concurrent local test runs host-wide at `K = max(1, ceil(os.availableParallelism()/9))` (2 on 18 cores) via a counting semaphore in `~/.flow/test-sem/`, so parallel pipelines stop oversubscribing cores. Only the test check is throttled (others run unthrottled). Override `K` via `FLOW_TEST_CONCURRENCY` (integer ≥ 1); on acquire timeout the test runs anyway.

**Host-wide research cache.** `flow-research-cache` caches synthesis at `~/.flow/research-cache/`, SHA-256-keyed on the normalized question; F2 discovery is bare-keyed, direct `/flow-research` namespaced-prefix-keyed, so the two stay isolated. 48h TTL (`--ttl-hours`/`FLOW_RESEARCH_CACHE_TTL_HOURS`, dir `FLOW_RESEARCH_CACHE_DIR`); miss/stale/corrupt → exit 3, never errors. Opt-in `prune` sweep (age/count + orphan-tmp), separate from the TTL miss. Contract in `discovery-instructions.md`.

**Zero-config monorepo auto-detect + three-layer command resolution.**
Before root-fallback claims orphans, a SEPARATE pass maps each unclaimed
`apps/<pkg>/` or `packages/<pkg>/` dir that **owns a `package.json`** to an
auto-detected path-named scope (`apps/web`, via `--scope apps/web`); a
no-owner file falls to root-fallback. Every scope resolves through one
shared table in `bin/lib/stack-table.ts`: (1) the package's own declared
verify scripts, probed `typecheck`/`check` → `lint` → `test` →
`format:check`, scoped `npm run <script> -w <pkg-path>`, with a
**name-based** denylist (NAMES not bodies) that never runs
mutating/interactive scripts
(`format`/`dev`/`build`/`preview`/`smoketest`/`*:watch`/`*:e2e`); (2) a
stack-default table keyed on a marker file (v1: node + go), into which
flow's built-ins are lifted unchanged; (3) a flow-drafted
`.flow/pre-commit.json` entry in the PR diff (see `/flow-pipeline` Step 6)
when 1–2 resolve nothing — that file (distinct from `~/.flow/config.json`)
is the **escape-hatch**: a top-level array of `{ name, prefixes, checks }`
scopes (merged config > auto-detect > built-in); `checks` run as argv (no
shell).

**Optional UI-validation manifest.** A consumer may declare `.flow/ui-validation.json` (a single OBJECT, not an array) to opt into browser-driven UI validation; `flow-ui-validate` parses it tolerantly and skips gracefully (exit 0, loud only on a broken precondition). Optional `ignoreConsolePatterns`/`ignoreRequestPatterns` lists suppress noise (favicon 404). Fields + onboarding in `templates/AGENTS.md.template`.

## Don'ts

- Don't bypass the helper scripts. The supervisor must always call
  `flow-new-worktree` / `flow-remove-worktree` / `flow-state-update`
  rather than reimplementing their behaviour with raw `git` / `gh` calls.
- Don't spawn sub-agents from the supervisor. See above. The nine
  named exceptions are `/pr-review`'s Multi-Agent Review,
  `/product-planning`'s Discovery, `/new-feature`'s Scout,
  `/pr-review`'s Fix-Applier, `/flow-pipeline` step 10's
  Merge-Conflict Resolver, `/coder`'s Edit-Applier, `/pr-review`
  Step 1.5's Gatekeeper, `/pr-review` Step 3.5's
  Consolidator-Validator, and `/flow-pipeline` step 6's
  Verify-Retry-Loop subagents — all nine covered by
  "Task-tool exemption" bullets below; no other skill or step may
  call Task.
- Don't add features beyond the task's stated scope.
- Don't propagate unverified factual claims. The trigger categories,
  per-category verification recipes, and anti-patterns live in
  `## Output style` under 'Verify factual claims before emitting
  them.' Latent values rot (line numbers shift, SHAs advance, CLI
  flags get renamed), eroding the textual evidence the rest of the
  pipeline (auto-merge gate, multi-agent review, fix-applier) relies on.
- Don't introduce a database. Markdown plan files plus
  `~/.flow/state/<slug>.json` are the state store; if the queue ever
  outgrows that, swap in Beads via an adapter rather than building
  bespoke storage.
- Don't leave spawned resources running. See
  `skills/pipeline/flow-pipeline/SKILL.md` "Resource cleanup".
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
    authorisation; opt out per-pipeline with `flow feature create --no-auto-merge`
    (the supervisor stops at the gated state regardless of the gate
    verdict).
  - **Shared rationale for the nine Task-tool exemptions below.**
    `/flow-pipeline`'s "Hard rules" forbid the supervisor from calling
    the `Task` / `Agent` tool, with nine named exceptions. The same
    rationale covers all nine, so it is stated here once: (a) the
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
    `skills/pipeline/coder/SKILL.md`. These are the **only nine**
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
  - **Task-tool exemption: `/flow-pipeline` → Verify-Retry-Loop
    Subagent.** Step 6's one verify-retry-loop agent owning the
    3-outer-attempt `/verify` loop (the `flow-pre-commit` failure-JSON
    re-paste, the Layer-3 `.flow/pre-commit.json` config-authoring branch,
    the UI-smoke pass) so the re-pasted failure JSON never accumulates in
    the supervisor's own context across the three attempts; writing
    `.flow-tmp/verify-loop-result.json`.
  - **Task-tool spawn sites must load Task first.** Each of the nine
    sites above must load the Task schema via
    `ToolSearch query="select:Task"` before invoking Task (or its alias
    `Agent`); if neither alias is surfaced top-level, escalate
    `NEEDS HUMAN: task-tool-unavailable: <exemption-name>` rather than
    falling back inline. `bin/skill-md-lint.test.ts` enforces the
    "Load the Task tool before spawning" paragraph at all nine sites.
    A sibling guard, not a tenth exemption.
  - **The `/pr-review` Gemini lens is a Bash fan-out, not a tenth
    exemption** — it spawns no Task, so the nine count is unchanged.
  - **The `/flow-pipeline` Step-3 cross-model plan review is a
    Bash fan-out, not a tenth exemption** — same `review.gemini` gate,
    one AGY reviewer (`flow-plan-review`) of the PRD's `## Decision
    analysis`, no Task (nine count unchanged), graceful skip sans agy.
  - **AskUserQuestion exemption: `/flow-pipeline` candidate-issues
    form (two firing locations).** The multi-select form that picks
    which orthogonal candidates to file post-merge. It is ONE named
    form fired from TWO locations: (a) step 4's "Candidate follow-up
    issues sub-step" on the Affirmative branch, and (b) step 3's
    "Candidate follow-up issues sub-step (non-feature intents)" on the
    `advance-to-step-5` branch (so bug/refactor/docs/infra/chore
    pipelines, which skip step 4, still get offered their discovered
    follow-ups). The five-branch decision is owned by the LLM-free
    `flow-candidate-issues` helper; the `AskUserQuestion` primitive and
    the decision to fire it stay in the supervisor sub-steps. One of
    two authorised `AskUserQuestion` forms (a synchronous user prompt,
    not a sub-agent fan-out) — the candidate-issues form and the step-9
    gate-override form; the count of distinct named forms stays at two,
    no third site. Naming the fire sites keeps the user-prompt surface
    auditable.
  - **AskUserQuestion exemption: `/flow-pipeline` step 9 gate-override
    sub-step.** The single confirmation form fired during step 9's
    "Gate override (post-verdict, opt-in)" sub-step, when the user
    instructs the supervisor to merge a `gated` PR anyway — a *fresh*
    confirmation that puts the gate verdict in front of the user rather
    than inferring authorisation from an earlier instruction. An
    affirmative answer is recorded by `flow-merge-guard
    --record-override` and enforced by the step-10 backstop. These two
    named forms — the candidate-issues form (which fires from two
    locations: step 4's affirmative branch + step 3's
    `advance-to-step-5` non-feature sub-step) and the step 9
    gate-override form — are the **only** authorised `AskUserQuestion`
    sites, documented bidirectionally with
    `skills/pipeline/flow-pipeline/SKILL.md`.
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
  - **`/epic-create` is a separate sanctioned supervisor session.**
    `flow epic create` spawns a fresh top-level `/epic-create` session, so
    `/flow-pipeline`'s exactly-9 and two-form rules are unaffected by its two
    named surfaces (distinct openers, in `skills/pipeline/epic-create/SKILL.md`):
    **Task-tool fan-out: `/epic-create` → /product-planning MODE: epic designer.**
    and **AskUserQuestion form: `/epic-create` clarification round.**
  - **`/epic-run` is a separate sanctioned supervisor session.**
    `flow epic run <slug>` spawns a fresh top-level `/epic-run` session, so
    `/flow-pipeline`'s nine-Task-exemption / two-AskUserQuestion invariants are
    unaffected. Its ONE named surface (in the SKILL) —
    **Task-tool fan-out: /epic-run → judgment sub-agent (per halt/deadlock event).**
    — runs judgment in a one-shot sub-agent isolating CI-log context, and
    fires no `AskUserQuestion` form. It judges only on a halt
    (retry / redirect / escalate) or deadlock; `gated ⇒ escalate-only` and it
    never merges a feature PR. Invariant set + config gates + opt-outs
    live in the SKILL.
