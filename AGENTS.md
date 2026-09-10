# flow — agent guide

`flow` has two responsibilities in one repo:

1. A **multi-phase pipeline supervisor**: `/flow-pipeline` drives
   triage → plan → worktree → implement → verify → CI → review → gate →
   merge inside one chat session, launched by `flow feature create
   "<description>"`. Sub-skills load in-process; `bin/` scripts are Bash
   tool calls.
2. A **curated skill library** at `skills/` plus the helper binaries at
   `bin/` they shell out to, both distributed by `flow install`.

This file is the entry point for any agent working on flow. Read it once
per session — surface-specific rules under `.claude/rules/` load only
when you touch a matching path, so they are not duplicated here.

## Where to look

| You want | Read |
|---|---|
| Supervisor behaviour and contracts | `skills/pipeline/flow-pipeline/SKILL.md` |
| Skill library structure | `skills/` (`pipeline/`, `universal/`, `stacks/`) |
| Task-tool exemptions, sub-agent Don'ts | `.claude/rules/flow-supervisor-contracts.md` (loads on `skills/`, `agents/`, `references/`, `templates/`) |
| `bin/` conventions, telemetry, tmux-pane rules, CI | `.claude/rules/flow-bin-conventions.md` (loads on `bin/`, `.github/`, `package.json`) |
| Git-workflow mechanics | `references/git-workflow.md` |
| Response-hygiene conventions | `references/output-style.md` |
| Consumer-repo `flow-pre-commit` contract | `references/consumer-repo-contract.md` |
| Redesign target, current state, what flow is not | `docs/target-architecture.md` |
| Generic engineering rules for a new repo | `templates/AGENTS.md.template` |
| Measure a scaffold removal | `docs/eval/README.md` |
| Which tests earn their cost | `docs/test-quality-methodology.md` |

## Code conventions

- **Runtime:** Bun for everything under `bin/`. `package.json`'s `engines.node >= 20` keeps `npm install`/`npm run test` (vitest) working; no shipped code is Node-specific.
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

- **Verify factual claims before emitting them.** Verify SHAs, paths, line numbers, URLs, PR/issue numbers, versions, env-var names, API surfaces, dates, counts, and CLI flags against their source before citing them — never from memory or a stale `Read`.
- **Treat user prompts as evidence of intent, not exhaustive specifications.** When a prompt names both a method and a target, surface the tension in the artifact and proceed toward the goal, not the literal reading that fails it (precedent: PR #170).
- **Consider the middle ground when a request is framed as a binary choice.** Name a middle-ground option, surface the trade-off in the artifact, then proceed with the best guess.
- **Understand the ultimate goal behind the request, not just the literal ask.** Infer the goal in one line and proceed for ambiguous/high-blast-radius requests; run expert/trivial/time-critical requests literally.
- **Fix cheap, in-scope robustness issues now rather than deferring them.** A small, low-risk/mechanical, in-scope fix belongs in the PR, not in `anti_patterns_found` as a deferred trade-off.
- **Treat every request as production-bound, not a hobby project.** Include cohesive work in-task (don't dodge it via a follow-up issue) and hold a production bar on the surface you touch.
- **Satisfy local, reversible preconditions before gating a Test Step as manual.** Reserve manual gates for genuinely external/irreversible/subjective items.
- **Non-trivial UI appearance changes need an authored SUBJECTIVE: approval step the agent can't tick.**
- **Structure every pause-point message.** A turn ending on user input or a stop uses the six labeled slots of `skills/pipeline/flow-pipeline/references/pause-output-contract.md` — `**TLDR:**` first, `**Unsolved:**` / `**Needs attention:**` / `**Manual action:**` / `**Untracked:**` omit-when-empty, `**Next action:**` last — within its ~12-line ceiling, never open prose.
- **Explain problems impact-first in plain language.** Problem reports lead with the user-visible impact, translate internal identifiers into their effect, and present options with each one's consequences, recommendation first.
- **Frame every explanation impact-first for a product-lens reader.** Lead with the user-visible consequence, naming the concrete command/flag/artifact; mechanism only on "give me the technical version"; exclusions per `references/output-style.md`.
- **Emit instructions as scannable numbered steps.** Two or more discrete actions render as `1.`/`2.` imperative steps, sub-bullets for detail, actor named when interleaved; a single action stays inline.
- **Route every emitted path/PR/issue URL through `bin/lib/link.ts` or a raw-target-labelled markdown link.** Never a bare target at a new site.

See the reference for the remaining response-hygiene conventions (no
preambles, no sycophantic openers, no emoji unless invited, calibrate
length to task, fenced blocks only for runnable code, etc.).

## Supervisor and sub-skills: in-process only

The supervisor is one Claude Code chat session; sub-skills load in-process
via `Skill`; `bin/` scripts are Bash calls. It never spawns `Task`/`Agent`
and never invokes a raw `claude -p` subprocess (headless Claude only via
`flow-claude-headless`), **with seven narrowly-named exceptions** —
enumerated as named bullets in
`.claude/rules/flow-supervisor-contracts.md` `## Don'ts`. Logic needing a
separate LLM session belongs in an in-process sub-skill or a non-LLM
helper, not here — except a fixed-model, fixed-effort leaf review or
judgment call, which goes through `flow-claude-headless`.

## Compact Instructions

Claude Code reads this section to decide what survives a compaction
(flow's `CLAUDE.md` is `@AGENTS.md`). Lose an anchor below and the
supervisor cannot tell what it has already done.

- **KEEP**: phase, PR number, worktree path, current step, any
  `NEEDS HUMAN:`, `state.interview` while an interview phase is live, the
  pause-output contract, the `.flow-tmp/` artifact paths (`plan.md`,
  `scout.md`, `*-result.json`, `review-scope.json`, `agent-output-*.json`),
  and **the active sub-skill and step within it**.
- **RULE**: after a compaction, re-invoke the active sub-skill via the
  `Skill` tool first — the compaction summarised away its body, and
  running the gate and merge rules from a paraphrase is the failure
  `phase-write-fidelity` exists to catch.
- **DROP**: verify excerpts, raw tool output, CI poll progress, the PR
  fetch dump, `.flow-tmp/diff.txt` — all reconstructable.
- Anchor detail: [references/compact-anchors.md](references/compact-anchors.md).

## Git workflow

- **Branches:** short, descriptive. `flow-new-worktree` creates per-pipeline branches from the slug; humans use `<type>/<topic>`.
- **Commits:** conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). Imperative summary ≤ 50 chars; body explains *why*.
- **PRs:** TLDR / User-facing changes / System changes / Why / Key decisions / Deviations from plan / Test Steps — zero unchecked `- [ ]` Test Steps ⇒ auto-merge, one or more ⇒ gated. Fix PRs add `**Failing:**`/`**Root cause:**`/`**Fix mechanism:**`; `## User-facing changes` and `## System changes` are mandatory (`none` when empty).
- **Never amend pushed commits or force-push** without explicit request.
- Full mechanics at [references/git-workflow.md](references/git-workflow.md).

## Development

```sh
npm install                # one-time
npm run typecheck:scripts  # tsc -p tsconfig.scripts.json (bin/)
npm run test               # vitest run (bin/)
npm run verify             # typecheck:scripts + test + lint
bun bin/flow install        # global install
```

No `npm run build` — flow ships `bin/flow` via Bun, no compile step.

## Don'ts

- Don't bypass the helper scripts. The supervisor must always call
  `flow-new-worktree` / `flow-remove-worktree` / `flow-state-update`
  rather than reimplementing their behaviour with raw `git` / `gh` calls.
- Don't spawn sub-agents from the supervisor. The seven named exceptions are enumerated in `.claude/rules/flow-supervisor-contracts.md` — the **only seven** authorised Task-tool fan-out sites; no other skill or step may call Task.
- Don't add features beyond the task's stated scope.
- Don't treat an absent optional-module skill as a hard failure — check
  `flow-module-status --check-skill <name>` and degrade to a named skip.
- Don't propagate unverified factual claims. See `## Output style`
  'Verify factual claims before emitting them.' — latent values rot
  (line numbers shift, SHAs advance, flags get renamed).
- Don't introduce a database. Markdown plan files plus
  `~/.flow/state/<slug>.json` are the state store; if the queue ever
  outgrows that, swap in Beads via an adapter rather than building
  bespoke storage.
- Don't leave spawned resources running: (1) point-of-use teardown first;
  (2) `flow-browser-teardown --reap --record` as the guaranteed
  registry-driven backstop, never `|| true`-swallowed; (3) `flow reap` as
  the crash-path net, never primary. See `skills/pipeline/flow-pipeline/SKILL.md` "Resource cleanup".
- Don't auto-commit/push outside explicit instruction on `main`; on a
  feature/PR branch, invoking a code-editing skill IS the instruction to
  commit that branch's edits. Named exemptions are enumerated in
  `.claude/rules/flow-supervisor-contracts.md` `## Don'ts`.
