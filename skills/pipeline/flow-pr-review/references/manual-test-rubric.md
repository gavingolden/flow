# Test Steps Rubric

A PR description's "Test Steps" section is the reviewer's verification hook — one
unified section spanning automated checks (the pr-review skill runs deterministic
items and ticks the box, injecting captured output as evidence) and manual smoke
(the human runs these). Legacy PRs may use `Manual validation`, `How to test`,
`Manual smoke`, or other variants — the rubric is heading-tolerant. Automated
tests catch regressions; manual tests catch things the automated suite was never
written to check — integrations, failure-mode UX, config gates, anything that
only surfaces when the feature actually runs.

When AI writes both the code and the test plan, the risk is a plan that looks plausible
but only exercises the happy path. This rubric gives Step 12b a depth-aware definition
of "testable" so shallow plans get flagged.

## Automate first

Manual is the fallback, not the default. Every checkbox in a manual test plan is recurring
human cost — for the author, the reviewer, and every future contributor who runs the smoke
before merging a related change. When a scenario can be expressed as "run command X, assert
condition Y," it should be an automated test, not a manual checklist item.

**Automation is a three-tier pyramid, not a binary.** "Run command X, assert condition Y" spans three layers, and the cheapest one that can still fail honestly wins. A **unit** test exercises a pure function or a request-builder in isolation. An **HTTP / integration** test spins up a local server and issues an authenticated request (real auth token; real or stubbed upstream) to exercise a backend/API contract end to end on the server side — no browser involved. A **browser** check observes what only a real render can: rendered output, console errors, accessibility, visual layout, and how many requests the deployed client actually fires. Push each assertion to the **lowest faithful layer** — the cheapest tier that still fails when the behavior breaks. The recurring-cost argument is why: a unit or integration test runs in CI on every change forever; a browser-manual step bills a human each time. See **Decompose a manual step by layer** below for how to apply this when a candidate step looks browser-shaped.

> **Section headings do not exempt items from this rubric.** "Test Steps" is the
> canonical heading and the auto-merge gate signal, not a verdict on automatability.
> Apply the rubric to each checkbox individually — if it passes the automation
> test below, it should either be run by the reviewer right now (per Step 8c of
> the pr-review skill, which auto-runs and injects evidence) **or** converted
> to a real test (per Step 11e's `Fail (automatable)` resolution). The conversion
> is **default-on**: the pr-review skill writes the test, runs it, commits and
> pushes, and prunes the converted bullet without pausing for upfront confirmation.
> The user redirects via reply after the fact (e.g. "this one should have stayed
> manual — revert it") rather than gating each conversion. Items failing the
> `Caveat: don't trade a working test for a flaky one` check below surface as
> `suggestion` findings instead. The heading name (or any sub-section the author
> writes) is not a reason to skip either path.

Apply the **automation test** to every entry in the proposed manual section:

> Can I name (a) a fixture / setup, (b) one or more deterministic assertions, and (c) an
> exit condition — all without subjective human judgment? If yes, it's a test, not a
> manual step.

**Probe-then-attempt before falling back to manual.** When you are unsure whether a local dependency a step needs — Docker, a local Supabase stack, a dev server — is already running, do NOT pre-label the step manual. Probe for it first (a health check, a port check, `docker ps`, `supabase status`), then attempt to start it (`npm run dev`, `supabase start`, `docker compose up -d`) and run the step. Only fall back to leaving the item manual after a genuine attempt to satisfy the precondition fails for a reason outside the agent's control (a credential you cannot mint, a service you cannot reach, a port you cannot bind). A step whose only blocker is "the local stack wasn't up yet" is runnable — bring the stack up and run it.

### Guard-strength check

A complementary axis to (a)–(c) above — ask it after confirming a check is automatable: **(d) could this check fail under a plausible regression other than reverting this exact diff?** A check that only asserts import presence (`grep -q 'NewComponent' App.svelte`) passes whether or not the component is mounted, rendered, or wired to a route — the only scenario that makes it fail is reverting the file to its state before the import was added. A check that renders the component and asserts a visible element fails when mounting breaks, when the component throws, or when a required prop is missing.

If (d) is no — the only failing scenario is reverting this exact diff — the check is a change-detector, not a guard. It may pass (a)–(c) yet still be too shallow to catch a real regression. Flag it and recommend a behavioral assertion instead (see **UI wiring behavioral assertion** in the Shallow smells section).

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

A genuinely-manual step is one the automation test above could not turn into a
runnable item. Within that category every manual step is one of two kinds, and
the distinction is **load-bearing for the auto-merge gate** — an agent must
classify each manual step as functional or subjective, and must never relabel
one as the other to change a merge outcome.

**Reserve this category for genuinely external/irreversible resources or irreducibly-subjective human judgment.** The manual gate is for steps that depend on production credentials, a deploy target, or a real third-party service (Slack, Stripe, a real-LLM call) — resources that are external to the repo and cannot be stood up locally — or on aesthetic taste a person must sign off (the subjective checks below). The canonical rule: a Test Step whose ONLY unmet preconditions are **local and reversible** — start the dev server, bring up / seed the local DB, set a local `.env` var, drive the repo's own headless browser — is RUNNABLE, not manual, and the agent MUST satisfy those preconditions itself (probe-then-attempt per "Automate first" above) before ticking or gating. "Needs the local stack" is never a reason to leave a step manual; it is a setup step the agent performs.

This boundary does NOT loosen any guardrail on external, destructive, or irreversible actions. No production writes, no destructive ops, the `.github/workflows/*` approval gate stays in force, and no real secrets are ever used — bringing up a _local_ stack to run a step is orthogonal to those guardrails, which still apply verbatim. The boundary moves only the local-and-reversible setup from "manual" to "the agent does it"; it grants no new license over external systems.

#### Functional checks

A **functional** manual step asserts a concrete, observable pass/fail outcome:
the feature either does the thing or it does not. There is no human-taste
judgment — a second observer would record the same result. Functional checks
are correctness checks.

- "Hover the legend entry — the popover opens" (the incident check below: a
  binary observation, and the feature was in fact completely broken)
- "Click Export — a CSV file downloads"
- "Open `/portfolio` with the seeded user — the allocation chart renders"
- "Submit the form with a missing field — an inline error appears"
- **Production-only integrations** — a third-party API without a sandbox, a
  prod-scoped secret, a real billing flow actually returns the expected result.
  The _outcome_ is still binary; it just can't be exercised in a fixture.
  (Cross-browser / cross-device rendering used to live here as genuinely-manual.
  It is now **Automatable via the browser-validation capability** — see the next
  subsection — whenever the `chrome-devtools` MCP and a `.flow/ui-validation.json`
  manifest are present.)

#### Automatable via the browser-validation capability

When the `chrome-devtools` MCP and a `.flow/ui-validation.json` manifest are
present, a browser-observable functional check is **no longer genuinely
manual** — the agent runs it via the browser-validation capability and ticks
the box. The gate for these is the **a11y `take_snapshot` text plus an
explicit `wait_for`**, never a raw screenshot pixel comparison.

- **Cross-browser / cross-device rendering** — "the page renders, key
  elements are present, no console errors, no failed network requests" is a
  binary observation the capability asserts against the a11y snapshot. (A
  specific other-browser engine still needs that engine; the in-engine render
  is now automatable.)
- The deterministic half (no console errors, no failed requests, manifest
  `expectSelectors` present) gates at Step 6 (`/flow-verify`); the subjective half
  (see the enumerated visual-appearance category below) runs at Step 8c
  (`/flow-pr-review`).

#### Enumerated visual-appearance assertions

A **visual-appearance** assertion is a concrete, checkable observation about
how the rendered UI looks — distinct from "does it feel premium" taste. Write
each as a single observation the agent runs via the `chrome-devtools` MCP,
judges via the `ui-ux` skill's authorities (Nielsen, WCAG/POUR, Refactoring
UI), and ticks. Concrete examples:

- "The delete button is right-aligned in the card footer."
- "The chart legend does not overlap the y-axis labels."
- "The empty state shows a centered icon above muted helper text."
- "The focus ring is visible on keyboard-tab to the primary action."

Each is a real observation a second observer would record the same way given
the same snapshot — so it is automatable via Step 8c, not left as an unchecked
manual item. Author UI Test Steps as these enumerated assertions rather than
vague "looks right" prose. Truly irreducibly-aesthetic items ("does this feel
premium?") stay genuinely-manual subjective checks below.

**For artifact-referencing PRs, Visual-Spec-derived per-assertion items are
the canonical form of this category.** When the plan carries a `## Visual
Spec` (discovery froze a design artifact into `.flow-tmp/design/spec.json`),
each Test Step item mirrors one spec assertion — tagged with its assertion id,
e.g. `- [ ] [nav-active-weight] .nav a.active renders font-weight: 600` — and
the mechanical tier is ticked (or left unticked) by the `flow-design-spec
diff` envelope rather than by eye; judged-tier items are compared side-by-side
against the frozen reference snapshot. See
`skills/pipeline/flow-pr-review/references/ui-validation-evidence.md`
("Design-fidelity per-assertion walk").

**An unverified functional step blocks merge.** A functional manual step that
is still an unchecked `- [ ]` item is a feature that has _not been shown to
work_. The auto-merge gate counts it like any other unchecked item and the PR
stays `gated` — see
`skills/pipeline/flow-pipeline/references/auto-merge-rubric.md`, "A `gated`
verdict is terminal, not advisory". Reclassifying a functional step as
subjective to wave it through is a **prohibited move**: it is the exact
failure mode the gate exists to catch (a real run merged a broken feature by
relabelling "hover the legend entry, the popover opens" as "subjective UX").
The same prohibition covers Visual Spec assertions: **a Visual Spec assertion
is never `SUBJECTIVE: `-relabelled** — a mechanical assertion passes or fails
by the `flow-design-spec diff` envelope, and a judged one by the side-by-side
reference comparison; relabelling either to dodge an unticked box is the same
move by another name.

#### Subjective checks

A **subjective** manual step asserts something only a human can judge: the
assertion is "a person would find this acceptable", and two observers might
reasonably disagree. Subjective checks are polish checks, not correctness
checks.

- "The error message reads naturally", "the toast feels right", "the spacing
  balances" — anything where the assertion is human taste
- Animations, transitions, dark-mode aesthetics
- **Performance feel** — "feels responsive under realistic load" when the
  judgment is _feel_. A _measured_ budget ("p95 < 200ms") is functional and
  should be automated, not left as a subjective step.
- **Cost-prohibitive infra** — when wiring up the test costs more than the
  regression risk it would catch (rare; default to "automate it" unless you
  can name the cost)

Subjective steps still belong in the checklist and still gate an auto-merge
while unchecked — the gate counts every unchecked `- [ ]` item and does not
read checkbox text — but an unchecked subjective step is not evidence the
feature is broken, only that its finish has not been signed off.

**When in doubt, classify a step as functional.** Over-classifying a
borderline step as functional keeps the safe default — the PR stays gated
until a human verifies it — whereas mislabelling a functional step as
subjective risks shipping a broken feature.

#### A non-trivial UI appearance change must author a subjective approval step

A non-trivial addition or change to UI appearance **REQUIRES** at least one
authored subjective human-approval Test Step — and **one per distinct facet**
(layout, animation, empty state, color/theme). Do not collapse facets into one
representative step. This is the breadth axis applied to subjective checks — the
exact parallel to **Coverage breadth: one check per distinct functional change**
below and to **Decompose a manual step by layer** above: a facet no item asserts
is a facet that ships unseen, because nothing ever required a human to eyeball
it. The gap this closes is structural: the enumerated visual-appearance bucket
above is legitimately auto-tickable at Step 8c, so a UI PR built entirely from
those concrete assertions has zero unchecked subjective item for the gate to
count — and a brand-new page auto-merges with no aesthetic sign-off at all.

**Include-vs-exempt test:** would a reasonable person want to eyeball this before
it ships? If yes, author the subjective step. Trivial tweaks — a copy fix, a
padding nudge, an icon swap — are exempt; do not manufacture a subjective step
where none is warranted.

**Scope: the per-facet rule applies to artifact-less UI changes.** For an
**artifact-referencing** PR — the plan carries a `## Visual Spec` whose
enumerated per-assertion items already cover the facets element by element —
author **exactly one** overall `SUBJECTIVE: ` sign-off for the
artifact-referenced surface instead of one per facet: the per-assertion
enumeration subsumes the facet breakdown, and per-facet `SUBJECTIVE: ` steps
on top of it would double-gate what the spec already asserts. Per-facet
`SUBJECTIVE: ` steps remain the rule for artifact-less non-trivial UI changes.
This scoping loosens nothing: the single overall sign-off still gates the
merge, and the prohibited-move guard below still forbids relabelling any
Visual Spec assertion (or other functional step) as `SUBJECTIVE: `.

**The `SUBJECTIVE: ` marker contract.** Each such step carries a literal
`SUBJECTIVE: ` prefix (uppercase, colon, single space) immediately after the
`- [ ] ` — a human-facing, greppable label. The auto-merge gate still counts it
as a plain unchecked `- [ ]` item (`bin/flow-gate-decide.ts` is prefix-agnostic;
**no gate-count change**): one un-ticked subjective step ⇒ `gated`, exactly like
any other unchecked item. The prefix adds machine meaning only to `/flow-pr-review`,
which never ticks it (Step 8c) and flags its absence on a non-trivial UI PR
(Step 11).

**Taxonomy placement.** A subjective aesthetic sign-off is **NOT** a
local-and-reversible-runnable step (the **Genuinely manual** / local-reversible
rule above): no mechanical assertion exists to run after any amount of setup, so
the agent cannot stand it up and tick it. It is the **lowest faithful layer for
taste — a human** — one notch beyond even the enumerated visual-appearance /
browser tier (which auto-asserts alignment, focus-ring, no-overlap). It therefore
stays a Subjective check, untouched by the local-reversible rule.

**The prohibited-move guard still holds.** This must-exist rule must **not** be
used to relabel a _functional_ step as `SUBJECTIVE: ` to dodge a tick — that is
the prohibited move named above ("hover the legend entry, the popover opens" is
functional, not subjective) — and a **Visual Spec assertion is never
`SUBJECTIVE: `-relabelled** either: its verdict belongs to the
`flow-design-spec diff` envelope (mechanical) or the side-by-side reference
comparison (judged), not to a taste sign-off. Functional-vs-subjective
classification stays primary; `SUBJECTIVE: ` is scoped strictly to
genuinely-aesthetic UI judgment.

##### Worked example: a new /portfolio page with no aesthetic sign-off (modeled on the structural gap)

A PR adds a brand-new `/portfolio` page — a fresh layout, an entrance animation,
and an empty state. It ships with only enumerated visual-appearance assertions:

**Anti-pattern — every check auto-ticks, so the page merges unseen:**

- [ ] The portfolio cards are evenly spaced in a 3-column grid.
- [ ] The focus ring is visible on keyboard-tab to the first card.
- [ ] The empty state shows a centered icon above muted helper text.

Each of those is an observer-agnostic visual-appearance assertion the agent
ticks at Step 8c — so the gate counts zero unchecked items and the new page
auto-merges with no human ever judging whether the whole thing looks right.

**Comprehensive — one `SUBJECTIVE: ` step per facet, plus the auto-tickable assertions:**

- [ ] The portfolio cards are evenly spaced in a 3-column grid.
- [ ] The focus ring is visible on keyboard-tab to the first card.
- [ ] The empty state shows a centered icon above muted helper text.
- [ ] SUBJECTIVE: you approve the overall look and feel of the new /portfolio page
- [ ] SUBJECTIVE: you approve the entrance animation on the /portfolio page
- [ ] SUBJECTIVE: you approve the empty state of the /portfolio page

The enumerated assertions still auto-tick; the three `SUBJECTIVE: ` steps —
layout, animation, empty state — each gate the merge until a human signs off,
and `/flow-pr-review` never ticks them on the user's behalf.

This worked example is the **artifact-less** form (no design artifact was
referenced, so no `## Visual Spec` exists and the per-facet rule applies).
Had the `/portfolio` page been built against a frozen design artifact, the
checklist would instead carry one enumerated item per Visual Spec assertion
(each tagged with its assertion id) plus **exactly one** overall
`SUBJECTIVE: ` sign-off, per the Scope paragraph above.

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

### Caveat: browser-validation flakiness

The browser-validation capability extends the flakiness caveat above to the
live-browser case. A browser check is only safely automatable when it gates on
the **a11y `take_snapshot`** plus an explicit **`wait_for`** (not a raw-pixel
comparison and not a fixed sleep), disables animations / respects
`prefers-reduced-motion` (via the manifest's `disableAnimations` flag), and
depends on **seeded fixture state** for stable data. Screenshots are
**evidence, not the gate**: they are captured for the human and referenced by
path, never diffed pixel-for-pixel to pass/fail a check. A check that can only
be made reliable with raw-pixel matching or animation-timing assertions stays
genuinely manual.

### Durable-test precedence

Prefer a **durable Playwright/vitest spec** over an ephemeral MCP check for any
deterministic assertion worth guarding forever — a permanent spec runs in CI on
every change with no live browser session required. Reserve the
browser-validation MCP pass for the **live exploratory + visual-evidence**
checks not worth a permanent spec (the subjective visual-appearance judgment,
the one-off render smoke). The MCP capability complements the durable suite; it
does not replace it.

### Decompose a manual step by layer

Before authoring any Test Step as browser-manual, run the **layer test**: is the intent a backend/API contract you could exercise by spinning up a local server and issuing an authenticated request (real auth token; real or stubbed upstream)? If yes, it is a deterministic **integration test**, not a manual step — author it at the HTTP tier and let CI run it forever. Reserve the **browser tier** strictly for assertions only a browser can make: rendered output, console errors, accessibility, visual layout, and how many requests the deployed client code actually fires through a live render. Use the `chrome-devtools` MCP for live and visual _evidence_; prefer a durable Playwright/vitest spec for any deterministic browser assertion worth guarding forever (the **Durable-test precedence** note above, applied to the browser tier).

**A single manual step often bundles assertions from more than one tier — split it.** When one step mixes a backend-contract assertion with a genuinely-visual one, separate them and push each to its **lowest faithful layer**: the contract half becomes an integration test, the visual remainder stays a browser check (manual or MCP). The carve-outs are _not_ re-routed by this rule — subjective UX, cross-browser engines, and performance-under-realistic-load remain genuinely manual (see **Genuinely manual** above). The rule only rescues backend-contract assertions that were mis-filed as browser-manual; it never demotes a genuinely-visual or genuinely-manual assertion to a tier that cannot faithfully make it.

This is the **lowest faithful layer** principle from **Automate first**, made operational at authoring time. Both human authors (`/flow-new-feature` Step 4b, `/flow-product-planning` Step 7) and the `/flow-pr-review` Step 8c automation pass apply it when they read a browser-flavored step.

#### Worked example: a watchlist batch-load step (modeled on `gavingolden/econ-data#370`)

An econ-data PR ("feat(watchlist): batch cold-load via Go envelope endpoint") added a cold-load path where one envelope endpoint serves a whole watchlist. It shipped with a single gated manual step:

**Anti-pattern — one step, a backend contract and a visual check conflated:**

- [ ] Open `/watchlist` and, in the network panel, confirm exactly one batch request and zero HTTP 429s, then sort by a return column and confirm the rows reorder correctly.

That one line buries a rich, automatable backend contract under a network-panel glance. Six of its assertions are exercisable over authenticated HTTP against a local server — none need a browser. Expanded, each pushed to its lowest faithful layer:

**Comprehensive — backend contract at the integration tier, thin visual remainder left manual:**

- [ ] Run `npm run test -- watchlist-batch.test.ts -t "single envelope"` — one request to the batch endpoint serves the whole 40-ticker watchlist (one envelope, not 40 calls).
- [ ] Run `npm run test -- watchlist-batch.test.ts -t "no rate limiting"` — the batch path issues zero upstream requests that return HTTP 429.
- [ ] Run `npm run test -- watchlist-batch.test.ts -t "compact strip payload"` — the envelope returns the compact strip shape, not the full per-ticker series.
- [ ] Run `npm run test -- watchlist-batch.test.ts -t "cache reuse"` — a second load reuses each ticker's cached entry rather than re-fetching it.
- [ ] Run `npm run test -- watchlist-batch.test.ts -t "100-symbol cap"` — a watchlist above the 100-symbol cap is rejected or truncated at the documented boundary.
- [ ] Run `npm run test -- watchlist-batch.test.ts -t "per-symbol degrade"` — one failing symbol degrades to its own error state without sinking the whole envelope.
- [ ] Open `/watchlist`, and in the network panel confirm the deployed client fires exactly one batch request, then sort by a return column and confirm the rows reorder correctly (the literal request _count the live client fires_ and the visual sort are the only browser-faithful assertions here).

Six backend-contract assertions move to deterministic integration tests that run in CI forever; only the count _as the deployed client fires it through a live render_ and the visual sort stay a browser step. The original step left the whole bundle manual — and the PR's own test suite already asserted "an N-symbol watchlist issues exactly one batch request" at the store layer, proving the contract half was automatable all along. Note the request _count_ stays in the visual remainder only because it asserts what the live client fires end to end; the same count asserted against the request-builder's logic is a unit test, not a browser check.

### The `<!-- flow:authoring-rubric -->` marker

Test Steps drafted by `/flow-new-feature` Step 4b, `/flow-product-planning` step 7, and the
`.github/PULL_REQUEST_TEMPLATE.md` open the section with this HTML comment between the
heading and the first `- [ ]` item:

```html
<!-- flow:authoring-rubric — for each `- [ ]` item below, the three-question
automation test from manual-test-rubric.md is: (a) named fixture/setup,
(b) deterministic assertion(s), (c) exit condition. If all three are answerable
without subjective human judgment, it must be a runnable item. Source of truth:
skills/pipeline/flow-pr-review/references/manual-test-rubric.md. -->
```

The marker is an inline summary of this rubric's three-question test, embedded in the
PR body so any later editor (an agent re-running pr-review, a human pasting in steps,
a hand-edited squash-merge follow-up) sees the same authoring standard without having
to follow a link. The auto-merge gate (`bin/flow-gate-decide.ts`) strips HTML comments
before counting unchecked `- [ ]` items, so the marker is invisible to the gate count
and never affects auto-merge vs. gated routing.

**This file wins on drift.** The marker text is a one-time inline copy of the (a)–(c) automatability test;
the canonical contract is the "Automate first" section above. If the marker ever
diverges from this rubric, the rubric is authoritative — fix the marker template at
its three authoring sites, not the rubric. The marker covers the three-question automatability axes only; (d) guard-strength is a complementary check documented in the adjacent **Guard-strength check** section.

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

## Coverage breadth: one check per distinct functional change

The scaffold and materiality table above decide _depth_ for a single change — how many of happy / unhappy / edge a given behavior needs. Breadth is the orthogonal axis: when one PR adds or alters **multiple distinct user-facing behaviors** — several search facets, several commands, several states, several flags — the Test Steps section must include **one functional check per distinct user-facing change**, not a single representative step that conflates them. A reviewer reading the checklist should be able to reconstruct the full scope of new behavior from the checklist alone; a facet that no item asserts is a facet that can break silently and still merge, because nothing ever claimed it worked.

This is breadth of _coverage_, not a mandate to add manual prose. Each facet routes through **Automate first** exactly like any other check — automate the facet where the automation test passes, and leave it manual only where the rubric flags it genuinely manual. A feature with four automatable facets gets four runnable items, not four manual lines. The breadth requirement makes the scope visible; "Automate first" keeps the automatable facets off the human's plate.

### Worked example: a multi-facet search DSL (modeled on `gavingolden/pokemon#216`)

A search-DSL PR added four distinct user-facing behaviors at once: name anchoring (`^pika` matches only names starting with `pika`), name wildcard positions (`pika*`, `*chu`, `*ika*`), set-prefix resolution (`set:base` resolves to the base set's card pool), and palette parity (results render in the legacy color palette). It shipped with a single conflated manual step:

**Anti-pattern — one step, four facets conflated:**

- [ ] Run a few `/search` queries and confirm the results look right.

That one line under-states the scope. A reviewer can't tell four behaviors changed, and three of them could be broken while the single query the author happened to try still passes. Expanded to one check per facet, each routed through the automation test first:

**Comprehensive — one check per facet, automated where automatable:**

- [ ] Run `npm run test -- search-dsl.test.ts -t "name anchoring"` — `^pika` matches only names starting with `pika`, not names merely containing it.
- [ ] Run `npm run test -- search-dsl.test.ts -t "wildcard positions"` — `pika*`, `*chu`, and `*ika*` each resolve to their expected match sets (prefix, suffix, infix).
- [ ] Run `npm run test -- search-dsl.test.ts -t "set prefix"` — `set:base` resolves the set prefix to the base set's card pool.
- [ ] Open `/search`, run `^pika set:base`, and confirm results render in the legacy palette (subjective UX, manual).

Three of the four facets are deterministic data transforms (Safely automatable, above) and become runnable items; only palette parity is a genuine visual-judgment check and stays manual. Without the breadth rule the PR shipped one conflated line; with it, the four behaviors are each visible and three are verified by exit code rather than by hope.

### Worked example: local-and-reversible preconditions are runnable, not manual (modeled on `gavingolden/pokemon#296`)

A PR added a seeded-login flow and shipped both its Test Steps pre-labeled manual because each "needs the local stack":

**Anti-pattern — both steps gated on "needs the local stack":**

- [ ] Manual — needs the local stack: run `seed-user.ts` against local Supabase and confirm the demo user exists.
- [ ] Manual — needs the local stack: drive `/login -> /card` in a browser and confirm the card view renders for the seeded user.

Neither blocker is external: a local Supabase stack and the repo's own headless browser are both **local and reversible**, so the agent must stand them up and run the steps rather than gate the PR on a human. Reclassified:

**Comprehensive — both reclassified to RUNNABLE via probe-then-attempt:**

- [ ] Probe local Supabase (`supabase status`); if it is not up, start it (`supabase start`), then run `bun seed-user.ts` and assert the demo row exists (`[ "$(psql ... -tAc "select count(*) from users where email='demo@example.com'")" = "1" ]`).
- [ ] With the dev server up (`npm run dev`) and the repo's own headless browser (e.g. `@playwright/test` if present), drive `/login -> /card` for the seeded user and assert the card view's key elements are present in the a11y snapshot.

The manual gate would apply to this pair ONLY if a step needed a resource the agent genuinely cannot stand up locally — production Supabase credentials, a deploy target, or a real third-party service (Slack, Stripe, a real-LLM call). A local DB the agent can seed and a headless browser it can drive are setup, not a manual gate.

## Precondition concreteness: spell out the exact how

A manual step is only runnable by someone with no prior knowledge of the change when it names the exact action behind every precondition it states. A step that opens "With DEV logging on…" or "Once the feature flag is enabled…" assumes the reader already knows the project's toggles and jargon — but the reader who most needs the checklist is the one who does not, and a bare "turn X on" leaves them stuck with no way to start. **Spell out the concrete how** for each precondition: the exact command to run, the click path to follow, or the setting to change, in copy-pasteable form.

Concretely, every manual or human-verification step must (a) name the exact command, click path, or setting that satisfies each precondition it states; (b) assume no prior knowledge of project-specific toggles, env vars, or jargon — define the term the first time it appears, or replace it with the action; (c) never use bare "turn X on" / "with X enabled" / "once X is configured" phrasing without the concrete steps that get there. This is orthogonal to functional-vs-subjective and to "Automate first" — it governs the prose of the items that legitimately stay manual, so the human running them is never blocked on an undocumented setup step.

### Before / after: an undocumented precondition

A step asserted a precondition without saying how to reach it. The toggle was gated behind `import.meta.env.DEV`, and the relevant lines only appeared once the browser DevTools console was raised to its Verbose level (the logger routes through `console.debug`) — none of which the step said.

**Anti-pattern — bare precondition, no how:**

- [ ] With DEV logging on, add a company to the watchlist and confirm the debug line appears.

The reader has no way to act: nothing says what "DEV logging" is or how to turn it on.

**Comprehensive — every precondition spelled out:**

- [ ] Start the dev server: run `npm run dev` (DEV logging is gated behind `import.meta.env.DEV`, which the dev server sets).
- [ ] In the browser DevTools console, set the level selector to **Verbose** (the debug lines route through `console.debug`, which the default level hides).
- [ ] Add a company to the watchlist and confirm the debug line appears in the console.

The rewrite names the command, the exact setting, and why each is needed, so a reader with no project knowledge can run it top to bottom.

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
- One step bundling several distinct facet behaviors (e.g. a single `/search` line covering
  name anchoring, wildcards, and set-prefix resolution) — split it into one check per facet
  per "Coverage breadth" above
- A change-detector or tautological check: an assertion that can only fail by reverting this exact diff, not by a regression in behavior. The canonical example is a presence-grep (`grep -q 'NewComponent' App.svelte`) on a UI wiring change — it passes whether or not the component actually renders or is reachable. Encouraged strong shapes: a Testing Library render test, a Playwright/vitest spec, or a chrome-devtools MCP snapshot check.

### UI wiring behavioral assertion

A Test Step that verifies a UI wiring change — mounting a new component, wiring a new route, registering a new handler — solely by asserting import presence (`grep -q 'NewComponent' App.svelte`) is under-tested. The grep passes whether or not the component actually renders, mounts, or is reachable by a user. The check must reach behavior: a Testing Library `render` test asserting a visible element, a Playwright spec navigating to the route, or a chrome-devtools MCP snapshot confirming the component mounts without error.

Proportionality carve-out: trivial copy or padding tweaks are exempt — the include-vs-exempt test from **A non-trivial UI appearance change must author a subjective approval step** above applies here too. See **Guard-strength check** in the Automate first section for the formal (d) axis this rule instantiates.

## Proportionality

The rubric exists because AI-generated code needs a verification hook that's hard to
fake. It does NOT exist to bureaucratize trivial work. A typo fix, a pure comment edit,
or a three-line internal refactor does not need a manual plan.

When in doubt, ask: "if this PR merges and silently breaks, what's the scenario a human
should have tried to catch it?" If you can name one, that scenario belongs in the plan.
