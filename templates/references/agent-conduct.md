## Agent Behavior

- Be extremely concise. Target an experienced developer.
- Preserve existing comments/TODOs unless the related code was removed.
- Ensure no dead/unused code remains after changes.
- After completing work, check if changes affect agent docs (`AGENTS.md`, skills, workflows).
  Update or flag inconsistencies.
- When a workaround is needed for a tool failure, shell issue, or platform quirk, propose
  adding it as a rule to `AGENTS.md` or the relevant skill so future agents avoid the same
  issue.
- **Verify factual claims before emitting them.** Always try to verify
  factual claims proactively via an API request, doc fetch, or
  filesystem check before propagating them into edits, PR bodies, or
  scripts — especially values that have been latent/unvalidated for a
  while. Concrete trigger categories: SHAs, file paths, line numbers,
  URLs, issue/PR numbers, version strings, env-var names, API surface
  shapes (function names, exported symbols, flag names), dates,
  counts of anything you've claimed before, deprecated CLI flags.
  Anti-patterns: paraphrasing project docs from memory in a
  commit-message Why-section, copy-pasting a prior PR body section
  without re-checking its citations, citing line numbers from a stale
  read, hardcoding a SHA from earlier in the session without
  re-running `git rev-parse`. Per-category verification recipes —
  line number: read the file at the exact path before citing; SHA:
  `git rev-parse <ref>`; URL: `curl -sI` or follow the link; PR
  number + state: `gh pr view <n> --json title,state,mergedAt`;
  issue number + state: `gh issue view <n> --json title,state` (the
  PR variant verifies pull requests only — a plain issue lookup
  against `gh pr view` fails or surfaces the wrong record); count
  of anything: `grep -cE '<anchored-pattern>' <file>` (never
  unanchored substring); CLI flag: `<verb> --help`; file/path
  existence: `test -f <path>`; exported symbol or function name:
  `grep -n '<symbol>' <module>`; version string: `<verb> --version`
  or `jq -r .version package.json`; env-var name:
  `grep -n '<NAME>' .env.example` (presence in the example file is
  the canonical source-of-truth check); date:
  `git log --format='%ad' --date=short -1 <ref>` for a commit or
  tag, `gh api repos/{owner}/{repo}/issues/<n> --jq .created_at`
  for an issue or PR creation date. Prefer authoritative sources over
  non-authoritative ones: official vendor documentation (Anthropic,
  Google, etc.) and peer-reviewed research outrank random blogs (e.g.
  Medium.com) when researching — especially AI topics — so weight a
  claim's credibility by its source, and verify anything an official
  source can confirm against that source rather than a secondary
  write-up. The rule is 'always *try*' with
  judgment, not blanket pessimisation — when in doubt, verify.
- **Explain problems impact-first in plain language.** Lead with the
  user-visible impact rather than the internal mechanism, and translate
  internal identifiers (tool names, step numbers, error codes) into
  their effect — an identifier may trail in a parenthetical, never
  stand as the statement itself. When a decision is needed, present
  options as a structured list, recommendation first, with each
  option's consequence — good and bad — named on one line; when no
  clear recommendation exists, say so plainly instead of manufacturing
  a confident answer. Keep logs, diffs, and deep analysis out of the
  summary itself — put them below it, or reference them as an artifact
  path. For example:
  Before: "The CI poller exited with `status=timeout` after 20 minutes."
  After: "CI hasn't finished in 20 minutes — longer than normal, and it may be stuck."
- **Emit instructions as scannable numbered steps.** A reader resuming a
  paused task, following an escalation recipe, or working a checklist
  should not have to segment a paragraph into actions before they can
  start acting. When an instruction or action list carries two or more
  discrete actions — a separate copy-pasteable command, or a separate
  decision the reader must make — render it as a numbered imperative
  list, one action per line: `1. <step>`, `2. <step>`, … . Detail rides
  as an indented sub-bullet under the step it belongs to, never bundled
  onto the step line itself; name the acting party at the start of a
  step when more than one party acts (you run a command, the reader
  decides something, a subagent reports back), so the reader never has
  to infer who does what. A trailing qualifier on one command (e.g.
  "and inspect its output") is detail, not a second action, and stays on
  the step line. Three carve-outs: (1) a single discrete action stays
  inline — never padded into a one-item numbered list just to look
  consistent with the multi-step cases; (2) a checklist using `- [ ]`
  checkbox items (e.g. manual test steps a human ticks off) keeps its
  checkbox form and is never renumbered to ordinals, since downstream
  tooling frequently counts unchecked boxes as a gate signal — checklist
  items take the one-action-per-box rule, not the numbering; (3) a fact
  recap (a status summary of what already happened) stays
  one-fact-per-line and is out of scope, because numbering a recap of
  the past implies an execution order that never existed. For example:
  Before: "Attach to the session, inspect the log for the failure, then
  redirect the skill with a fix hint."
  After:
  ```
  1. Attach to the session.
  2. Inspect the log for the failure.
  3. Redirect the skill with a fix hint.
  ```
- **Consider the middle ground when a request is framed as a binary choice.**
  When a prompt poses an either/or — "should it work like A or B?",
  "store it in the URL or the database?", "fast or simple?" — the two
  named poles are evidence of how the user is currently thinking, not a
  constraint on the solution space. The better answer is frequently an
  intermediate option: a subset of A's capability with B's simplicity, a
  phased rollout, a config-gated default, a hybrid that takes the cheap
  80% of each. Name at least one such middle-ground option alongside the
  two poles rather than silently picking a pole, and surface the
  trade-off where the user will see it (the plan, the PR description, a
  design note) so they can redirect. The genuinely-binary case still
  exists (a boolean flag, a yes/no migration); the rule is to *check*
  for a middle ground, not to manufacture one where none exists.
- **Understand the ultimate goal behind the request, not just the literal ask.**
  Before assuming the literal request is the whole job, understand what the user
  ultimately wants to fix, unblock, or speed up — the problem behind the proposed
  solution (the XY problem; the user-story "so that `<goal>`" clause). This is
  conditional, not unconditional: run already-goal-aligned requests — expert,
  trivial, or time-critical — as the literal ask directly, and ladder up only on
  ambiguous or high-blast-radius ones. By default infer the goal in one line and
  proceed, surfacing the alternative where the user will see it (the plan, the PR
  description, a design note) rather than asking; ask one focused goal-framing
  question only when the goal is genuinely unclear AND guessing wrong is costly or
  hard to reverse. No ceremony — infer in one line, don't perform a root-cause
  framework — and never interrogate the user with a chain of "why"; the laddering
  is internal reasoning. The same discipline covers the broader **framing-lens
  family** (Jobs-to-be-Done, first-principles, inversion, pre-mortem, second-order
  effects, and internal-only Five Whys) — each a bounded internal heuristic you
  reason with, never a performed/emitted section. Same family as
  **Consider the middle ground when a
  request is framed as a binary choice.** above — this one governs *altitude*: up
  from the proposed solution to the goal it serves.

## Anti-Overengineering

Make only changes that are directly requested or clearly necessary. Keep solutions minimal:

- Don't add features, refactors, or "improvements" beyond what was asked.
- Don't add error handling or validation for scenarios that can't happen.
- Don't create abstractions for one-time operations or hypothetical future needs.

Minimal scope targets *unrequested feature creep* — new features, speculative
refactors, hypothetical-future abstractions — **not** trivial robustness fixes.
"Review only changed files" likewise does **not** forbid a minimal edit to an
adjacent production file when that edit is what makes the PR's own change robust.
Anti-Overengineering is a guard against doing *more* than the task; it is never a
license to knowingly ship a *worse* artifact. See the fix-now bar below.

### Fix-now bar — when ALL three hold, fix it in-PR (don't defer, don't rationalize)

A finding MUST be fixed in this PR — not deferred to a tracker issue, and not
filed away as an "accepted trade-off" in a review artifact — when all three are
true:

1. **Small** — roughly a handful of lines.
2. **Low-risk / mechanical** — no meaningful design decision and no research; the
   change is obvious once seen.
3. **In-scope** — directly related to code this PR already touches, OR to a
   brittleness / regression this PR itself introduced.

This holds *even when the clean fix needs a minimal touch to an adjacent
production file the diff didn't originally include*. Example: when a test would
otherwise have to assert against a brittle implementation detail (a literal CSS
utility class, a generated id), add a stable hook to the adjacent component (a
`data-` attribute) and assert on that — rather than coupling the test to the
brittle detail and recording the brittleness as a trade-off. That one-line
adjacent edit is in scope, not scope creep.

The fix-now bar is the mirror of the deferral bar: the same three properties
that send a finding to fix-now, when inverted, are what let a *genuinely
standalone or complex* finding be deferred instead. When a finding clears the
fix-now bar, "I don't want to expand the PR" and "that file wasn't in my diff"
are not reasons to defer or rationalize. Deferral-to-issue stays reserved for
work that *fails* the fix-now bar — a fix needing meaningful design or research,
or a cross-cutting change touching several files.

## Scope: bundle cohesive work, defer only separate features

Treat every request as production-bound — work real users will depend on, not a
hobby-project MVP. This is the lens for two decisions the fix-now bar above does
not cover, because it governs *features*, where the fix-now bar governs
*robustness*.

**Include cohesive work; key on cohesion, not size.** When deciding whether an
addition belongs in the current task or a separate issue, the question is "is
this a *completely separate feature*?" — not "is this small or large?". An
addition is part of the current task when it serves the same user goal, touches
the same surface, or its absence would leave the feature partial or awkward to
use; build it in-task even if the request did not enumerate it. Suggest a
separate issue only when the addition is genuinely independent — its own user
goal and surface, valuable and shippable on its own. Never use a "candidate
follow-up issue" or a backlog ticket as a hedge to avoid doing in-scope work.
Calibrate with four named exclusions: split to a separate issue only for a
genuinely novel non-trivial feature, something that needs its own
design/decision session, a large refactor that is not a prerequisite for
the current work, or a user-foreclosed constraint — and apply the size test
for the large-refactor exclusion to the whole set of bundled work
cumulatively, not to any one item in isolation.

**Hold a production bar on what you build.** Error handling, edge cases,
accessibility, and tests for the surface you touch are part of the feature, not
deferrable polish. Shipping the happy path and filing the rest is the
hobby-project pattern this rule forecloses.

This raises *completeness and quality*, not *feature count*, and it does not
loosen Anti-Overengineering above: the standard is minimal scope executed to a
production standard — not gold-plating, not speculative features, and "challenge
the request / do nothing" stays a valid recommendation. Effort is a secondary
guardrail: a cohesive enhancement that would *materially* expand the work (a
multi-file rewrite, new infrastructure, an unresolved design decision) is
surfaced for the user to weigh rather than silently bundled.

## Skill Consultation

Before modifying code, **read the relevant skill** from its `SKILL.md`. Skills encode
project conventions that cannot be inferred from pattern-matching.

<TODO: Customize this table for your repo's installed skills.>

| When you touch…                             | Read skill        |
| ------------------------------------------- | ----------------- |
| Test files                                  | `flow-testing`    |
| Refactoring / cleanup tasks                 | `flow-refactoring` |
| <stack-specific files, e.g. `.svelte`>      | `<stack-skill>`   |
| <database migrations>                       | `<database-skill>` |

Read each skill **once per conversation**. Skip only for trivially mechanical changes (typo fixes).

## Tooling: Prefer Bun

Prefer `bun` for executing scripts and running package.json commands — it's faster than
`node`/`npx`/`npm run` and runs TypeScript natively.

| Use this           | Instead of                         |
| ------------------ | ---------------------------------- |
| `bun file.ts`      | `npx tsx file.ts` / `node file.ts` |
| `bun run <script>` | `npm run <script>`                 |

**Keep `npm install` for dependencies** unless you've migrated the project fully off npm.
`package-lock.json` and `bun.lock` should not coexist — mixing creates drift. Migrating
fully off npm is a deliberate change, not something to do incidentally.

**Workspace flags differ** — bun uses `--cwd <pkg>` or `--filter <pkg>`, not npm's
`-w <pkg>`. Translate carefully when swapping.

## Code Quality

- Review all code as a senior developer: scrutinize design, naming, edge cases, error handling.
- Prioritize readable, reusable functions. Keep functions short and single-responsibility.
- Avoid deep nesting — use intermediate variables and guard clauses.
- No magic strings — use constants or enums. Use explicit types; no inline/anonymous types.
- Colocate related files. Target <300 lines per file.

## Comments

Explain **why**, not what. Add concise comments for non-obvious code only. Update docs when
functionality changes.

## Testing

New features and bug fixes should include tests. Don't leave coverage gaps for follow-up.
Extract business logic into pure functions testable without UI rendering. For conventions,
stubs, and component isolation — refer to the `flow-testing-svelte` skill (generic
test-writing/coverage guidance lives in `flow-testing`).
