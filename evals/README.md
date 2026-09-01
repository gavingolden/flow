# evals/ — flow-eval suite format

This directory holds the fixed scenario suites `bin/flow-eval.ts` runs.
`flow-eval` is maintainer-only (see `bin/lib/sources.ts`'s `MAINTAINER_ONLY`
set) — it is never installed onto a user's PATH, and no pipeline skill
invokes it. Read `docs/eval/README.md` for how a maintainer actually runs
it and records a baseline; this file is the format reference for authoring
a new suite or scenario.

## Layout

```
evals/
  _shims/            # shared hermetic CLI shims (currently: gh)
  <suite-id>/
    suite.json
    <scenario-id>/
      case.json
      prompt.md
      result-schema.json   # optional
      preload/...           # optional, referenced by case.json's `preload`
      fixture/               # optional, becomes the materialized repo
        flow-tmp/            # non-dot name — see "flow-tmp/ vs .flow-tmp/" below
      overlay/                # optional, a second commit applied on top of fixture/
      state.json               # optional, seeds the pipeline state
      checkpoint.md             # optional, the checkpoint body when fixture.checkpoint is set
```

**`_shims/gh`'s supported subcommands.** `pr view <n|branch> --json a,b,c`
answers from `$FLOW_EVAL_FIXTURE/pr.json` (an array of PR objects, or an
object keyed by PR number); an absent field on the matched record reads
as `null`, never a crash. `pr checks <n> --json a,b,c` answers from an
OPTIONAL sibling `checks.json` (an array of check records) — when that
file is absent it exits 1 with a short stderr rather than a silent `[]`,
so a scenario that meant to seed CI state and forgot the file fails
loudly instead of passing vacuously. `gh api repos/{owner}/{repo}/pulls/<n>`
(plus its `/reviews` and `/comments` suffixes, `--paginate` optional) and
`pr diff <n> --name-only` answer `bin/flow-fetch-pr-review.ts`'s four
fetch calls from the same `pr.json` record's `title`/`html_url`/`body`/
`additions`/`deletions`/`changed_files`/`head.ref` fields plus two
shim-specific arrays, `apiReviews` and `apiComments` (deliberately
separate from the `pr view --json reviews` shape — the REST reviews/
comments endpoints and the GraphQL `reviewRequests`/`reviews` projection
are different shapes off the same PR). Every other subcommand is
unsupported and loud (`flow-eval gh shim: unsupported: [...]` on stderr,
exit 1), never a silent success — a fixture-authoring gap must read as a
red run, not a green one that proved nothing.

## suite.json

```json
{
  "schemaVersion": 1,
  "id": "my-suite",
  "candidate": "the-thing-being-measured",
  "description": "one line",
  "scenarios": ["s1-first", "s2-second"],
  "defaults": { "runs": 2, "maxBudgetUsd": 4, "timeoutSec": 900 }
}
```

`defaults` may set any of `runs`, `maxBudgetUsd`, `timeoutSec`,
`allowedTools`, `model`, `effort`. Resolution order for each scenario field is
scenario value, then `suite.defaults`, then the built-in
`SCENARIO_DEFAULTS` in `bin/lib/eval-suite.ts` (there is no built-in default
for `model`/`effort` — an unset value stays `undefined` and the child
inherits whatever `claude -p` resolves on its own).

Pin `effort` per suite alongside `model` when a suite's cost/behaviour
sensitivity warrants it: the harness passes it through as `claude -p
--effort <level>`, records it in the report's `runner.effort`, and
`flow-eval compare` warns on drift between a base and candidate report's
`runner.effort` the same way it already does for `runner.model`.

## case.json (one per scenario directory)

```json
{
  "id": "s1-first",
  "title": "Human title",
  "provenance": "where this scenario's inputs came from",
  "prompt": "prompt.md",
  "preload": ["preload/plan-digest.md"],
  "promptSeed": "resume",
  "fixture": {
    "repo": "fixture",
    "overlay": "overlay",
    "state": "state.json",
    "checkpoint": {
      "body": "checkpoint.md",
      "site": "plan-approval",
      "armed": true
    },
    "shims": ["../../_shims/gh"],
    "linkNodeModules": false
  },
  "env": { "flowSlug": true },
  "allowedTools": ["Bash", "Read"],
  "model": "haiku",
  "effort": "medium",
  "maxBudgetUsd": 4,
  "timeoutSec": 900,
  "runs": 2,
  "resultSchema": "result-schema.json",
  "graders": [
    /* see below */
  ]
}
```

`id` must equal the scenario's directory name. Every referenced path
(`prompt`, `preload[]`, `resultSchema`, `fixture.repo`, `fixture.overlay`,
`fixture.state`, `fixture.checkpoint.body`, `fixture.shims[]`) is resolved
relative to the scenario directory and must exist on disk — `loadSuite`
(`bin/lib/eval-suite.ts`) rejects a suite where any of them is missing.
Shim paths may climb out of the scenario directory (`../../_shims/gh`) to
reach the shared shim.

`promptSeed` prefixes the rendered prompt with the byte-exact resume or
terminal-orientation seed a real launched session would receive:
`"resume"` uses `resumeSeedFor`, `"terminal"` uses `terminalCarryOver` +
`terminalContinueSeed` (both from `bin/flow-session-start-hook.ts`).

## Grader kinds

Every grader carries `id`, `kind`, and an optional `gate` (default `true`;
`gate: false` marks it informational — excluded from `scoreRun`'s
denominator, still recorded and rendered).

| kind         | required fields                                                 | what it checks                                                           |
| ------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `structured` | `path` + one matcher                                            | a dotted path into the run's `result.structured_output`                  |
| `json-file`  | `file`, `path` + one matcher                                    | reads `file`, parses JSON, checks a dotted path                          |
| `file`       | `file` + one matcher                                            | reads `file` as text (or checks existence)                               |
| `command`    | `argv`, optional `cwd`/`expectExit` (default 0)                 | runs `argv` in `cwd`, compares exit code                                 |
| `git-clean`  | optional `cwd`/`allow`                                          | `git status --porcelain` in `cwd`, ignoring paths matching `allow` globs |
| `metric`     | `source`, `direction` (`lower`\|`higher`), optional `max`/`min` | records a numeric metric; only GATES when `max` or `min` is set          |

A gate-only `metric` spec (`max`/`min` set) is excluded from the recorded
`metrics` map — its pass/fail already lives in `grades`. Compare it via a
separate, unbounded (`gate: false`) sibling spec with the same `source`
(see `bash-calls-floor` + `transcript.toolCalls.Bash` in
`evals/verify-loop-isolation/s1-single-fix/case.json`) when you also want
it to show up as a compared metric.

Matchers (exactly one required for `structured`/`json-file`/`file`):
`equals` (deep-equal), `oneOf` (deep-equal against any member), `contains`
(substring match — against the whole string for a string `actual`, or
against any string element for an array `actual`), `matches`/`notMatches`
(regex over `String(actual)`), `exists` (boolean presence check — for
`file`, this is a real filesystem existence check, not a "field is
defined" check). `matches`/`notMatches` stringify an array `actual` via
`String(actual)` (comma-joined), so a pattern can span element
boundaries — prefer `contains` when you mean "one element has this
substring".

## Placeholders

`file`/`cwd` fields may use `$REPO`, `$FIXTURE`, `$STATE`, `$CHECKPOINTS`,
`$STREAM`, `$ASSISTANT_TEXT` — expanded by `bin/lib/eval-graders.ts`'s
`expandPlaceholders` against the materialized fixture (repo dir, the
scenario's own source directory, the real per-slug `state.json` path, the
checkpoint directory, and the captured `stream.jsonl` path). `$ASSISTANT_TEXT`
points at `assistant-text.txt` — assistant-emitted text only — use for
`notMatches` patterns that also appear in skill/reference prose (which
lands in user-role stream events).

## fixture/ layout rules

- No `node_modules/` — use `fixture.linkNodeModules: true` to symlink the
  flow checkout's own `node_modules/` in at materialization time instead.
  `materializeFixture` throws (not a silent no-op) if the checkout has no
  `node_modules/` to link — run `npm install` in the canonical checkout
  first; a silently-missing symlink otherwise reads as a model regression
  in the eval report, not a missing install.
- `flow-tmp/` vs `.flow-tmp/`: a committed fixture uses the **non-dot**
  name `flow-tmp/`, because `.flow-tmp/` is git-ignored repo-wide (`flow
new-worktree` registers it in `.git/info/exclude`) and `git add` would
  silently drop a dotted directory. `bin/lib/eval-fixture.ts`'s
  `materializeFixture` renames it to `.flow-tmp/` at materialization time
  and registers the exclude, mirroring a real worktree.
- `materializeFixture` also creates `refs/remotes/origin/main` (no
  network) after the base commit, so `flow-pre-commit`'s
  `git merge-base origin/main HEAD` scope detection resolves inside the
  hermetic fixture instead of silently seeing a clean tree.

## promptSeed and run/compare

`bun bin/flow-eval.ts run --suite <id> --out <dir>` materializes each
scenario's fixture, spawns `claude -p` with the rendered prompt (unless
`--dry-run`), grades the transcript, and writes
`<out>/<suite>/report.json` + `summary.md` plus a
`<out>/<suite>/<scenario>/run-<n>/` directory holding `stream.jsonl`,
`grades.json`, and `prompt.txt`. `bun bin/flow-eval.ts compare --base
<report.json> --candidate <report.json>` diffs two reports (median per
metric, direction-aware verdicts, a tolerance band) — this is how a
supervisor-scaffold removal proves it didn't regress cost/context/turns
against the recorded baseline.

## flow ls and eval- state

`flow-eval` seeds real pipeline state under an `eval-<suite>-<scenario>-r<n>`
slug in the real `~/.flow/state/` (not a test-only directory) — the child
session's own helpers (`flow-state-update`, `flow-checkpoint`,
`flow-resume-decide`) only ever read the real state dir. This means
`flow ls` shows `eval-*` rows while a suite is running; teardown removes
them (state, checkpoints, turn tracking, proc registry) whether the run
passed, failed, or was interrupted.
