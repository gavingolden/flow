# Manual Test Rubric

A PR description's "How to test" section is the reviewer's verification hook. Automated
tests catch regressions; manual tests catch things the automated suite was never written
to check — integrations, failure-mode UX, config gates, anything that only surfaces when
the feature actually runs.

When AI writes both the code and the test plan, the risk is a plan that looks plausible
but only exercises the happy path. This rubric gives Step 12b a depth-aware definition
of "testable" so shallow plans get flagged.

## Automate first

Manual is the fallback, not the default. Every checkbox in a manual test plan is recurring
human cost — for the author, the reviewer, and every future contributor who runs the smoke
before merging a related change. When a scenario can be expressed as "run command X, assert
condition Y," it should be an automated test, not a manual checklist item.

Apply the **automation test** to every entry in the proposed manual section:

> Can I name (a) a fixture / setup, (b) one or more deterministic assertions, and (c) an
> exit condition — all without subjective human judgment? If yes, it's a test, not a
> manual step.

### Safely automatable (move to a test, do not leave manual)

- **Process behavior** — exit codes, stdout/stderr substrings, signal handling
  (`kill -TERM`, `SIGINT`), PID liveness via `process.kill(pid, 0)`, parent-exit
  reparenting (`PPID==1`), wall-clock budgets ("parent exits in < 8s")
- **Filesystem state** — file existence/absence, file contents (regex/JSON/JSONL shape
  via `jq`), permissions, atomic-rename absence of `.tmp` siblings
- **Subprocess + IPC** — spawn → exit lifecycle, PID files written before / unlinked
  after, file-descriptor inheritance, env-var propagation
- **CLI output** — argparse / commander surfaces, help text, exit codes per flag
- **Pure data transforms** — given input X, output is exactly Y
- **Schema / migration shape** — table columns, indexes, constraints (assert via
  `pg_dump --schema-only` or equivalent)
- **Anything reproducible in a tmp-dir fixture** without external services, with a
  bounded wall-clock cost (the project's existing integration-test budget defines the bar)

### Genuinely manual (leave in the checklist)

- **Subjective UX** — "the error message reads naturally", "the toast feels right",
  "the spacing balances", animations, dark-mode aesthetics — anything where the
  assertion is "a human would judge it acceptable"
- **Production-only integrations** — third-party APIs without a sandbox, prod-scoped
  secrets, real billing flows
- **Cross-browser / cross-device rendering** — Safari quirks, mobile viewport, screen
  readers (until the project invests in those harnesses)
- **Performance under realistic load** — when local-fixture timing isn't representative
  of prod
- **Cost-prohibitive infra** — when wiring up the test costs more than the regression
  risk it would catch (rare; default to "automate it" unless you can name the cost)

### Decision shortcut

If you find yourself writing "verify the file appears at...", "check the process is
still running", "confirm the status is `<X>`", or "ensure stdout contains `<Y>`" —
**stop**. That's a test. Write the test instead. The fact that an integration test
already covers the same area (e.g. `*.smoke.test.ts`) means the new scenario almost
always slots in alongside as another `it(...)` — not a parallel manual checklist.

### Caveat: don't trade a working test for a flaky one

Automation precedence does not mean "automate at any cost." If the automated form would
be flaky (real network, real LLM, timing-dependent without a determinism shim), or
require a heavy harness disproportionate to the risk, prefer either:
1. A focused unit test of the logic, with the integration check left as a one-time
   manual smoke documented in the PR; or
2. A `RUN_INTEGRATION=1`-style gated test that doesn't run by default but is callable.

The bar is "safely automatable," not "automatable in principle."

## The scaffold

Manual test plans are built from three scenario categories. Which categories a specific
change needs is decided by the materiality table below — not every material change needs
all three.

1. **Happy path** — one concrete, reproducible scenario where everything works. The
   check names a specific input and a specific expected observable (rendered value,
   HTTP 200 with payload X, toast with text Y). "Verify it works" is a wish, not a test.

2. **Unhappy / failure paths** — at least one scenario where something goes wrong:
   missing input, upstream error, unauthorized access, allowlist rejection, rate-limit
   response. The check is the _user-facing outcome_, not just the status code.
   "Allowlist-blocked request surfaces a friendly error, not a raw 403" beats
   "request returns 403."

3. **Edge cases** — boundary conditions specific to the change: empty results,
   concurrent access, TTL expiry, feature-flag disabled, very large or very small
   inputs. These are the scenarios automated tests often stub past.

## Materiality

Not every change needs every category. Apply proportionally — over-prescribing on trivial
changes is noise:

| Change type                              | Happy | Unhappy |  Edges   |
| ---------------------------------------- | :---: | :-----: | :------: |
| New integration (provider, upstream API) |   ✓   |    ✓    |    ✓     |
| Schema migration                         |   ✓   |    ✓    |    ✓     |
| New user-facing feature                  |   ✓   |    ✓    | If clear |
| Bug fix in error-handling                |   ✓   |    ✓    |    —     |
| Bug fix in pure logic                    |   ✓   |    —    |    —     |
| Internal refactor (no behavior change)   |   —   |    —    |    —     |
| Config / env var                         |   ✓   |    ✓    |    —     |

"Material" = anything reaching a user-observable boundary (UI, HTTP endpoint, CLI,
data output) OR touching error handling OR gated by config. Pure internal refactors
that pass the existing test suite unchanged do not need a manual plan.

## PR-type scenario menus

Use these as a baseline. Not every entry applies to every PR — pick the ones that match
the actual change surface.

### New data provider integration

- Happy: fetch a known symbol, chart renders with expected data
- Missing API key: backend either skips route registration or fails loudly at startup
- Allowlist rejection: request to an unlisted path returns 403 and the UI shows a
  friendly error (not a stack trace)
- Auth missing: request without a token returns 401 and the UI handles it
- Empty result: a valid identifier with no data shows an empty state, not a crash
- Rate-limit response (if plan-relevant): user-facing message, no silent failure
- Upstream shape drift: malformed response is caught by the DTO mapper and surfaces a
  clear error

### Schema migration

- Migration up produces the expected schema (columns, indexes, constraints)
- Existing rows unaffected — spot-check 1-2 rows
- RLS: authorized user reads the new column, unauthorized user is blocked
- Reversibility (if the migration is reversible): `down` actually reverts

### New user-facing feature

- Primary action works end-to-end from the user's entry point
- Loading state visible during async work
- Error state shown on failure (network, validation, server error)
- Empty state shown when there's no data
- Keyboard and ARIA correct for any new interactive widget
- Dark mode rendered correctly

### Backend infra / config

- Default configuration works with no env changes
- Env-var override takes effect (e.g., `FOO_MAX_MB=16` actually caps at 16)
- Missing env var either falls back to a documented default or fails loudly at startup

## Shallow smells

If any of these appear, the test plan probably needs tightening:

- "Verify it works" / "check the UI" — no concrete observable
- Restates automated tests (`npm run test`, `go test` are not manual steps)
- Only happy path on a change that clearly has failure modes
- Implementation language ("the `useFoo` hook returns `bar`") instead of user-observable
  language
- One-liner on a large PR with new external integrations or error-handling changes

## Proportionality

The rubric exists because AI-generated code needs a verification hook that's hard to
fake. It does NOT exist to bureaucratize trivial work. A typo fix, a pure comment edit,
or a three-line internal refactor does not need a manual plan.

When in doubt, ask: "if this PR merges and silently breaks, what's the scenario a human
should have tried to catch it?" If you can name one, that scenario belongs in the plan.
