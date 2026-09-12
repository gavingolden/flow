# flow-eval — maintainer guide

`flow-eval` is a maintainer-only, locally-runnable headless eval harness
running five committed suites, split by what each measures:

- Four **supervisor context-isolation scaffolds** (`verify-loop`,
  `haiku-gatekeeper`, `checkpoint-pending-clear`, `ui-smoke-isolation`) —
  cost/context/turn footprint, so a future scaffold-removal PR (epic
  `modernize-flow-s-supervisor-architecture`, feature
  `f2-scaffold-stress-test`) carries a recorded before/after delta
  instead of a prose argument.
- One **correctness suite** (`phase-write-fidelity`, issue #679) —
  whether the supervisor's end-state `state.phase` lands where the step
  it ran says it should, at Step 5's PR-open tail (issue #694) and Steps
  7-10. It measures whether the supervisor _calls_ the value-returning
  helper that writes the phase; the helper _writing_ correctly is proved
  separately, by `bin/lib/phase-advance.test.ts` and each helper's own
  unit spec.
- One **explanation-quality suite** (`pm-explanation-quality`, epic
  `make-flow-reason-from-explain` f2) — whether the PR-body site's `## Why`
  and `## User-facing changes` sections read as consequence-first, PM-facing
  writing rather than mechanism-first, code-centric writing, via the
  advisory `flow-explain-judge` check.

Alongside the suites, `docs/eval/review-cost-baseline.md` records the
measured **review-phase cost before-state** — the supervisor's own turn
count, per-turn context and API-equivalent spend inside `/flow-pr-review`,
plus the phase-boundary context floors that decide whether any
auto-compact window is safe. It is committed because the audit script
reads a rolling 30-day window, so the "before" arm stops being
reproducible once a cost change lands.

`bin/flow-eval.ts` is never installed onto a user's PATH (see
`bin/lib/sources.ts`'s `MAINTAINER_ONLY` set) — run it from a flow
checkout.

## Security note: the child runs with your real account

Every scenario's `claude -p` child is intentionally NOT sandboxed by a
fake `HOME` or a throwaway account: the child runs with your real
account, your real home directory, and (under `--permission-mode
dontAsk`) auto-approved shell access, so it can exercise a session the
way a real launched pipeline would. `buildChildArgv` bounds the highest-
harm actions with a fixed `--disallowedTools` deny-list (no `git push`,
no `gh pr merge/create/close`, no `gh release`, no `rm -rf
node_modules*`), but that is a floor, not a sandbox — only run scenarios
you trust, the same as you would `claude -p` directly.

## Headless safety flags

Every headless `claude` child this repo spawns picks its own subset of
`--restricted`/`--permission-prompts none` — the right subset depends on
what that child is FOR, not a single blanket policy. Three rows, plus a
fourth that's `n/a` because it spawns no `claude` child at all:

> [!IMPORTANT]
> **This section raises the harness's minimum `claude` version.** Both
> flags below were verified present against `claude --version`
> `2.1.259 (Claude Code)`; `--restricted` additionally documents its own
> floor ("Requires Claude Code v2.1.248 or later",
> https://code.claude.com/docs/en/cli-reference). `probeClaude` enforces
> no version floor, so an older `claude` fails every run with an
> unknown-flag error rather than one of the three named skip reasons.

| Spawn site                                                                                     | `--permission-prompts none`    | `--restricted`      | Why                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flow-eval` child (`bin/lib/eval-runner.ts`'s `buildChildArgv`)                                | YES                            | NO                  | `--restricted` "removes the built-in tools that run commands or code ... unless `--tools` names them, and ignores ... project ... settings files" (`claude --help`) — it would strip the Bash access the scenarios exist to drive and null the deliberate `--setting-sources project` this file already passes. `--permission-prompts none` alone closes the unattended-child gap without touching either. |
| `flow-plugin-probe` Task-spawn probe (`bin/flow-plugin-probe.ts`'s `probeAgentInvocationName`) | YES                            | YES, `--tools Task` | This probe needs the Task tool and nothing else — `--restricted --tools Task` is the tightest legal grant, and the probe already runs against an isolated fixture `HOME`.                                                                                                                                                                                                                                  |
| `flow-plugin-probe` / `flow-plugin-contract-lint`'s `plugin list\|validate\|details` calls     | NO                             | NO                  | Not headless prompt sessions (no `-p`) — these subcommands take neither flag.                                                                                                                                                                                                                                                                                                                              |
| `flow-model-bench`                                                                             | n/a — spawns no `claude` child | n/a                 | `flow-model-bench` dispatches its manifest through `flow-delegate-fanout`, whose default runner spawns the `flow-delegate` BINARY (`bin/flow-delegate-fanout.ts:472`), which in turn calls agy (Google AI Ultra), never `claude -p`.                                                                                                                                                                       |

Five headless `claude -p` children exist repo-wide today: the `flow-eval`
scenario child, `flow-plugin-probe`'s Task-spawn probe
(`probeAgentInvocationName`), and three live-only probes the ablation-arm
PR (#755) added — `probeAgentMemoryScope`, `probeSkillsPreloadName`, and
`probeMaxTurnsPartial`/`probeCacheTtl1h` — each gated behind `--live` and
run against the real, already-logged-in `HOME` rather than an isolated
fixture. Those three live probes do not yet carry
`--permission-prompts none` / `--restricted`: they drive Bash tool calls
and Task-tool subagent spawns the flags would suppress, so extending the
contract to them needs a probe-by-probe safety check, not a blanket flag
add — tracked separately rather than guessed here.
`bin/flow-plugin-contract-lint.ts:125` is a further real `claude` spawn
site, but it's a `plugin validate`/`plugin list` call, not a headless
prompt session, so it carries neither flag.

## Precondition: `flow install`

`flow-eval` spawns a real `claude -p` child against a plugin root it
materializes itself from the checkout you invoke `bun bin/flow-eval.ts`
from (`bin/lib/eval-fixture.ts`'s `ownCheckoutRoot()`) — it does not read
the global `~/.flow/claude-home/` install at run time. The global install
is only an existence precondition: `flow-eval` checks that
`~/.flow/claude-home/.claude/skills/flow-module-core/agents/` exists
before running, and a missing install surfaces as the named
`flow-not-installed` skip, not a crash. Run `flow install` once to
satisfy that precondition.

## The ui-smoke-isolation suite

Unlike the other three isolation scaffolds, `ui-smoke-isolation` drives a
real browser (`chrome-devtools` MCP) through the `flow-ui-driver`
sub-agent, so it carries extra host preconditions on top of `flow
install`:

- Chrome must be installed and the `chrome-devtools` MCP server must
  already be registered, launched with `--isolated` — the same
  shared-profile-lock precondition
  [`ui-smoke-pass.md`](../../skills/pipeline/flow-pipeline/references/ui-smoke-pass.md)
  documents for a live pipeline run.
- No other pipeline (and no other concurrent `flow-eval` run of this
  suite) may be driving a browser against the same MCP server at the
  same time — the isolated page the driver opens is keyed on the eval
  slug, but the underlying MCP server process is shared.

A suite or scenario declares which MCP servers its child needs via the
`mcpServers` field (`ScenarioSpec`/`SuiteSpec.defaults`, same
scenario-over-suite-defaults precedence as `allowedTools`) —
`ui-smoke-isolation`'s `suite.json` sets `"mcpServers": ["chrome-devtools"]`.
At fixture materialization time, `eval-fixture.ts` copies only the named
servers out of the maintainer's `~/.claude.json` `mcpServers` map into a
per-run `mcp-config.json`, which `eval-runner.ts` passes to the child as
`--mcp-config <path> --strict-mcp-config`. This exists because
`--setting-sources project` (load-bearing for settings hermeticity — see
above) does not reach MCP servers registered at user scope, and a bare
project-scoped `.mcp.json` requires interactive approval the unattended
eval child can never give; `--mcp-config`/`--strict-mcp-config` is the
only channel that reaches a user-scope server. Naming a server the host
has not registered (e.g. via `claude mcp add`) fails the run loudly at
setup — a paid suite must not silently produce a grader whose tools were
never actually reachable.

Run it with `--runs 1` (the suite's own `defaults.runs`): a browser drive
is materially more expensive per run than the other three suites'
Bash-only fixtures, so `--runs 2`'s default variance-smoothing is not
worth the doubled cost here.

`transcript.finalContextTokens` and `transcript.topLevelToolCalls` are
**top-level-only** — they describe the supervisor's own context and tool
calls, excluding everything the spawned `flow-ui-driver` sub-agent does
inside its own isolated context (that is the entire point of the
isolation measurement: the sub-agent's `mcp__chrome-devtools__*` calls and
context growth never reach the supervisor). `result.total_cost_usd`, by
contrast, **includes** the driver — Claude Code bills a spawned sub-agent
against the same top-level `result` envelope, so the cost delta the
scaffold is meant to justify is only visible there, not in the top-level
tool-call/context metrics.

`transcript.mcpToolCalls` and `transcript.topLevelMcpToolCalls` (both
`bin/lib/eval-transcript.ts`) are ALWAYS-PRESENT aggregate counters of
every tool call whose name starts with `mcp__` — the former across the
whole transcript (top-level + every sub-agent), the latter top-level
only, same scoping as `topLevelToolCalls` above. They exist because a
per-tool-name key (`transcript.toolCalls.<name>` /
`transcript.topLevelToolCalls.<name>`) is only present once that exact
tool name has actually been called; `metricSource` resolves an absent
path to `undefined`, and a `metric` grader scores `undefined` as a
FAIL ("metric source unresolved"), never as `0`. **A `max: 0` isolation
gate must therefore be written against an always-present aggregate, not
a per-tool-name key** — a per-tool `max: 0` gate fails exactly when the
behaviour under test is perfect (zero top-level calls of that name),
because the zero-call case is the one case where the key never gets
created at all.

Worked example this repo hit for real: `ui-smoke-isolation`'s
`drive-not-inline` gate originally read
`transcript.topLevelToolCalls.mcp__chrome-devtools__navigate_page` with
`max: 0`, and its sibling `mcp-drive-happened` gate read
`transcript.toolCalls.mcp__chrome-devtools__navigate_page` with `min: 1`
— both keyed on one hand-picked tool name. The first real before-arm run
against `main`'s tree made 7 `chrome-devtools` calls
(`take_snapshot` x2, `new_page`, `list_network_requests`,
`list_console_messages`, `evaluate_script`, `close_page`) and **none**
were `navigate_page`: `mcp-drive-happened` could never fire on the
observed drive shape, and `drive-not-inline` was inverted against its
own success condition (a perfectly-isolated run resolves the absent key
to `undefined`, which FAILs, rather than to `0`, which would PASS). Both
graders were repointed at `transcript.mcpToolCalls` /
`transcript.topLevelMcpToolCalls`; thresholds, ids, kinds, and gate flags
were left unchanged.

## Running a suite

```sh
bun bin/flow-eval.ts run --suite verify-loop-isolation --out .flow-tmp/eval
bun bin/flow-eval.ts run --all --out .flow-tmp/eval
```

Useful flags: `--dry-run` (materializes fixtures and renders prompts
without spawning `claude`), `--runs <n>` (override every scenario's
per-run count), `--concurrency <n>` (bounded worker pool across every
`(scenario, run[, arm])` job in the suite — `--ablation with-without`
doubles each `(scenario, run)` into a with/without pair, and the pool is
sized against the flattened job list, not the scenario count; default 1),
`--threshold <0..1>` (exit 1 when a suite's score misses it),
`--claude-bin <path>`, `--ablation <none|with-without>` (default `none`),
`--autocompact <auto|100k..1M>` (sets the child session's auto-compact
window — use it to measure whether a supervisor still behaves correctly
after its own instructions get summarised). An arm run with
`--autocompact` carries a different `childArgvDigest` from a no-flag arm,
so `compare` will warn that the two reports came from differently-shaped
children — that warning is correct and expected for an arm comparison,
not a defect to suppress.

Named skip reasons (exit 0, one-line stderr notice, a `skipped` report
still written): `claude-not-on-path`, `claude-not-authenticated`,
`flow-not-installed`. `--dry-run` writes a `skipped: {reason: "dry-run"}`
report for the same reason — vitest (`bin/evals-suites.test.ts`,
`bin/flow-eval.test.ts`) stays the CI gate; no vitest spec ever spawns
`claude`.

### `--ablation with-without`: a no-plugin baseline arm

```sh
bun bin/flow-eval.ts run --suite verify-loop-isolation --out .flow-tmp/eval \
  --ablation with-without
```

Runs every scenario TWICE per configured run — once with the real
`flow-module-core` plugin loaded (`"with"`, today's only arm), once with
no plugin loaded at all (`"without"`: no `--plugin-dir`, and `--add-dir`
points at a plugin-free sibling home instead of the fixture's real one)
— and reports the score/metric delta between the two, so a scaffold-
removal PR can cite a measured "the plugin changed X by Y%" instead of a
prose argument. Doubling the arm count doubles `claude` spend for that
invocation; the CLI prints a one-line cost notice (never a prompt) before
running when this flag is set.

A gate grader that can never pass without the plugin loaded (the
`plugin-loaded` gate every committed scenario carries, which asserts the
transcript mentions `flow-module-core`) is marked `withOnly: true` in its
`case.json` entry — excluded entirely from the `"without"` arm's score
(both numerator and denominator), so it reads as a plugin-fired
indicator rather than dragging every suite's `scoreDelta` down to the
same fixed, information-free constant. This mirrors the native harness's
own vocabulary verbatim: `claude plugin eval --help` on 2.1.259 describes
`--ablation`'s `with-without` mode as making "graders marked with-only,
incl. `tool_used: Skill`, ... a plugin-fired indicator rather than part
of the score."

Excluding `plugin-loaded` from the bare arm removes the only signal that
would have caught an ablation _leak_ at run time, so that arm gets an
inverted replacement: a synthetic `ablation-leak-free` gate asserting its
transcript does **not** mention `flow-module-core`. It fires on the
`"without"` arm only, and a failure means the no-plugin child still
loaded a flow plugin root — the delta from that run is meaningless, not
merely small. This is the runtime counterpart to the composition-time
anti-leak assertions in `bin/lib/eval-runner.test.ts`: those prove the
argv and env are clean, this proves the child behaved as though they
were. The ablation removes flow's scaffold from **three** surfaces, not
one — `--plugin-dir`, the `--add-dir` claude-home (the plugin root is
materialized _inside_ it), and the plugin `bin/` on `PATH`. Dropping only
the first leaves every skill and helper reachable and yields a near-zero
delta that reads as "the scaffold adds nothing".

`--ablation with-without` COMPLEMENTS the baseline-vs-candidate `compare`
workflow below, it does not replace it: `compare` measures drift between
two committed trees (e.g. before/after a scaffold-removal PR), while
`--ablation` measures the plugin's own effect within a SINGLE run. Use
both together to answer "did this PR's change move the metric, and how
much of the metric was the plugin's doing in the first place."

## Report schema (v1) and `compare`

`bin/lib/eval-report.ts`'s `EvalReport` (`schemaVersion: 1`) is the
deliberate stable seam — additive fields only once a baseline is
committed; bump `schemaVersion` for anything else. Two additive fields
this feature added, both optional so every committed `docs/eval/baseline/
*.report.json` still validates unchanged: `runner.childArgvDigest` (a
hash of the composed child argv's SHAPE — flag names, plus the fixed
values of the permission/setting-sources/tools flags, and a
`--plugin-dir` count; never the prompt, session id, or a fixture path,
which differ on every run) and, per scenario, an `ablation` object
(`{with, without, scoreDelta, metricDeltas}`) present only when
`--ablation with-without` ran. `bun bin/flow-eval.ts report --in
<report.json>` renders the markdown summary;

```sh
bun bin/flow-eval.ts compare --base docs/eval/baseline/verify-loop-isolation.report.json \
  --candidate .flow-tmp/eval/verify-loop-isolation/report.json \
  --tolerance 0.10 --fail-on-regression
```

diffs two reports scenario-by-scenario and metric-by-metric: `worse` /
`better` / `same` / `noisy` (base-spread-exceeds-tolerance) verdicts,
direction-aware (`lower`/`higher`-is-better), plus an
`environmentMismatch` warning when `runner.childArgvDigest` (when BOTH
reports carry one) differs between the two reports — a shape drift means
the two children were composed differently (e.g. one predates a
`--permission-prompts` addition), not just a different tree — or when
`runner.model`/`runner.effort`/
`runner.claudeVersion` differ between the two reports. `--fail-on-regression`
exits 1 on any regression; `--json` prints the raw `Comparison` object
instead of the markdown table.

## Recording a baseline

One command, from a **plain shell** — never inside a flow session window
(a pipeline may spawn `claude -p` only through `flow-claude-headless`;
baseline recording is a maintainer-initiated action, not a pipeline step):

Before recording, confirm
`~/.flow/claude-home/.claude/skills/flow-module-core/agents/` carries
every agent definition the suites you're about to run spawn (notably
`flow-verify.md`) — `probeFlowInstall` only stats the agents
**directory**, never individual definitions, so a partial install still
passes the precondition check and silently degrades to `general-purpose`
at run time (losing the agent's tool allowlist). This is worse than a
red, not better: the `no-agent-fallback` grader reads `notMatches` over
`$ASSISTANT_TEXT`, which excludes tool-result output, so the `echo`'d
`NOTICE — agent-fallback:` line only turns it red if the supervisor
happens to restate it in assistant-role prose — not guaranteed. Treat
this as a manual pre-flight check, not a grader-enforced one.

```sh
bun bin/flow-eval.ts run --all --out .flow-tmp/eval --record-baseline
git add docs/eval/baseline
git commit -m "chore: record flow-eval baseline"
git push
```

To re-record only a subset, repeat `--suite` (accepts multiple) instead
of `--all`:

```sh
bun bin/flow-eval.ts run --suite checkpoint-pending-clear \
  --suite verify-loop-isolation --runs 5 \
  --out .flow-tmp/eval --record-baseline
```

`bin/lib/eval-baseline.ts`'s README-table writer merges each unlisted
suite's existing row from `docs/eval/baseline/` alongside the freshly
recorded ones, so a subset run never drops another suite's baseline
from the table.

`--record-baseline` refuses (exit 2) on a dirty tree unless
`--allow-dirty` is also passed — a baseline is a measurement of a
specific committed tree, and an uncommitted diff makes that
correspondence a lie. It writes `<suite>.report.json` +
`<suite>.summary.md` per suite into `docs/eval/baseline/` and refreshes
the recorded-at table in `docs/eval/baseline/README.md` between the
`<!-- flow-eval-baseline:start -->` / `<!-- flow-eval-baseline:end -->`
markers.

**Measuring an unmerged branch.** The eval child materializes its plugin
root from the checkout you invoke `bun bin/flow-eval.ts` from
(`bin/lib/eval-fixture.ts`'s `ownCheckoutRoot()`), not from the global
`~/.flow/claude-home/` install — so measuring a branch under test is just
running `flow-eval` from that branch's checkout or worktree. No
repointing the global install and no restore step:

```sh
cd <branch-checkout-or-worktree>
bun bin/flow-eval.ts run --all --out .flow-tmp/eval
```

## The `claude plugin eval` forward check

Live on 2.1.259 (superseding this doc's earlier "2.1.239 at this
writing" note, which was already stale): `claude plugin eval --help`
renders full usage and exits 0 — `--json`/`--runs`/`--threshold` and now
also a native `--ablation <none|with-without>` flag with the SAME
with/without-baseline shape this feature independently arrived at — but
a real (non-`--help`) invocation is still org-gated early access. Verified
directly against both `init --bare <name>` and a real target:

```console
$ claude plugin eval init --bare demo
`plugin eval` is currently in early access
$ echo $?
1
```

(stderr, not stdout — never merged with `2>&1`, so a downstream JSON
parse of the same invocation's stdout is never corrupted by this
message). `bin/flow-plugin-probe.ts`'s `plugin-eval-availability` probe
machine-detects this gate the same way — `--help` alone is NOT
sufficient evidence (it renders and exits 0 even while gated), so the
probe additionally attempts the harmless, network-free `init --bare`
invocation and classifies `refuted` on the early-access stderr,
`confirmed` once the gate lifts. Run it directly:

```sh
bun bin/flow-plugin-probe.ts --json --probe plugin-eval-availability
```

`.github/workflows/ci.yml` installs Node and Bun only — no `claude`
binary — so the native command can never be flow's CI gate regardless of
enablement. `EvalReport.runner.name` stays the seam that would let a
future `claude-plugin-eval` runner backend emit the same report shape
(an adapter, not a rewrite, enforced at `bin/lib/eval-report.ts`'s
`runner.name` literal type) — revisit when the command is GA for flow's
org **and** CI installs `claude`. Not built now; tracked as a candidate
follow-up, not a task in this feature.

## Concurrency

`--concurrency <n>` bounds how many `(scenario, run)` pairs execute in
parallel across the WHOLE suite (not per-scenario) — each in-flight run
materializes its own hermetic fixture and spawns its own `claude`
child, so cost and local-machine load scale roughly linearly with `n`.
Default 1 (serial) is the safe default for a maintainer's laptop; raise
it deliberately when running the full `--all` suite set.

## `flow ls` during a run

`flow-eval` seeds real pipeline state under an `eval-<suite>-<scenario>-r<n>`
slug in the real `~/.flow/state/` — not an isolated test directory,
because the child session's own helpers (`flow-state-update`,
`flow-checkpoint`, `flow-resume-decide`) only ever read the real state
dir. Each seeded state record's `repo` field points at that run's
hermetic fixture repo, not the flow checkout (`bin/lib/eval-fixture.ts`
writes `repo: repoDir`) — so a bare `flow ls` run from the flow checkout
no longer shows `eval-*` rows once `flow ls` scopes to the current repo
by default; run `flow ls --all-repos` to see them while a suite is
running. Teardown removes the seeded state (state, checkpoints, turn
tracking, proc registry) whether the run passed, failed, or was
interrupted (a `SIGINT` handler in `bin/flow-eval.ts` sweeps every
in-flight fixture before exiting).
See `evals/README.md` for the suite/scenario file format.
