### Manual Verification

<TODO: Replace with your project's actual verification commands.>

Use the pre-commit checks script for manual scope detection and structured reporting:

```bash
./scripts/pre-commit-checks.ts
```

Or run manually — `npm run format` first, then the relevant checks. Fix errors before
committing.

- **<scope-1>** (`<path>`): `<commands>`
- **<scope-2>** (`<path>`): `<commands>`

**Monorepo auto-detect + config escape hatch.** Single-package repos need
no setup. For a monorepo, `flow-pre-commit` auto-detects conventional
layouts — `apps/<pkg>/` and `packages/<pkg>/` directories that own their
own `package.json` — with **zero config**, and runs that package's own
declared verify scripts (probe order `typecheck`/`check` → `lint` →
`test` → `format:check`, scoped via `npm run <script> -w <pkg-path>`; a
name-based safety denylist never runs `format`/`dev`/`build`/`preview`/
`*:watch`/`*:e2e`/`smoketest`). When nothing is declared it falls back to
a stack-default table (node via `package.json`, go via `go.mod` →
`go vet`/`go test`). For a layout auto-detect can't recognize or a non-
default command set, add a repo-relative `.flow/pre-commit.json` — a
top-level array of `{ name, prefixes, checks }` scope entries (read
tolerantly; malformation degrades to defaults with no error). A
genuinely-uncovered file (no `package.json` owner, no stack marker, no
config) still fails the gate loudly with `reason: "unmatched-files"`.

**Satisfy local, reversible Test-Step preconditions yourself — don't gate them
as manual.** A Test Step whose only unmet preconditions are
**local and reversible** is runnable, not manual: start the dev server, bring up
/ seed the local DB, set a local `.env`, drive the repo's own headless browser
(if present), and run it. When you are unsure whether a local dependency (Docker, a local DB, a
dev server) is already up, probe-then-attempt — probe for it, try to start it,
then run the step — and leave it manual only after a genuine attempt fails for a
reason outside your control. Reserve the manual gate for genuinely external or
irreversible resources (production credentials, deploy targets, third-party
services like Slack/Stripe/real-LLM) or subjective human judgment.

This boundary does **not** loosen the `### Requires Approval` or
`### Forbidden (No Exceptions)` guardrails above: the `.github/workflows/*`
approval gate, the destructive-git approval rules, and the credential
prohibitions all stay in force verbatim. Standing up a *local* stack to run a
step is orthogonal to those guardrails — it grants no new license over external
systems, prod writes, or secrets.

**A non-trivial UI appearance change must author a subjective approval step the
agent can never tick.** A net-new or materially-changed UI surface REQUIRES at
least one authored subjective human-approval Test Step — and, for **artifact-less**
UI changes, **one per distinct facet** (layout, animation, empty state,
color/theme); do not collapse facets into one representative step. An
**artifact-referencing** PR whose plan carries a `## Visual Spec` authors
**exactly one** overall sign-off instead — the mechanical Visual Spec
assertions already gate each facet, so per-facet human sign-offs would
double-gate what the diff envelope asserts. See
`skills/pipeline/flow-pr-review/references/manual-test-rubric.md`'s "Subjective
checks" scoping for the canonical contract. The include-vs-exempt test is "would a reasonable
person want to eyeball this before it ships?" — trivial tweaks (copy fix, padding
nudge, icon swap) are exempt, so no subjective step is manufactured where none is
warranted. Each such step carries a literal `SUBJECTIVE: ` prefix (uppercase,
colon, single space) after the `- [ ] ` — a human-facing, greppable label. The
auto-merge gate counts it as a plain unchecked `- [ ]` item (no gate-count
change), but `/flow-pr-review` never ticks, prose-promotes, or browser-validates a
`SUBJECTIVE: ` item into a tick, and flags a non-trivial UI PR that has none.
This closes a structural gap: a UI PR built entirely from auto-tickable
enumerated visual-appearance assertions (alignment, focus-ring) would otherwise
merge with zero human aesthetic sign-off. Defer to
`skills/pipeline/flow-pr-review/references/manual-test-rubric.md` ("Subjective checks")
for the canonical contract and a worked example.

### Clean up spawned resources

**Tear down every resource you spawn before you finish — never leave one
running on the user's machine.** This covers dev servers / launch
subprocesses, chrome-devtools MCP pages/contexts, headless browsers
(Playwright et al.), and any background process. Browser teardown is
**symmetric with server teardown**: a UI-validation pass that brings up a
dev server and opens a per-pipeline isolated browser page (`new_page` +
`isolatedContext`) must tear **both** down — `close_page` on the page it
opened, disposing the `isolatedContext`, in the same breath as stopping the
server — on the completion path **and on every error / early-exit path**.
Registering the `chrome-devtools` MCP with `--isolated` (above) gives each
session its own auto-cleaned throwaway Chrome profile, and the agent still
explicitly closes the page/context it opened — but closing the page never
closes the browser process itself: chrome-devtools-mcp exposes no
browser-close tool, so `close_page` disposes only the `isolatedContext`.
The browser process must be reaped separately, by SIGTERMing the session's
own chrome-devtools-mcp server so its `shutdown()` handler runs (never a
harder signal — that would skip `shutdown()` and orphan the browser
instead of closing it). flow ships `flow-browser-teardown --reap --record`
for this, fired once at the pipeline's terminal state — registry-driven
first, falling back to this session's own server by process ancestry only
for what the registry didn't cover.
Scope the teardown strictly to what you spawned — never close a page or
profile belonging to a concurrent agent run or to the user's own browser.
The motivating incident: an automated visual pass left the chrome-devtools
MCP Chrome running, holding its profile lock and orphaning a browser window,
which blocked the MCP for the rest of the run.
