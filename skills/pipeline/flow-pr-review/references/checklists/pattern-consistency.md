# Pattern-Consistency Review Checklist

Checks for the **pattern-consistency** lens. Soft cap: ~150 lines — condense, merge
duplicates, automate deterministic entries into lint, or move consumer-specific entries to
`docs/consumer-review-patterns.md` before adding new entries. New entries are captured via `flow-pr-review/SKILL.md` step 5 ("Capture
the gap") — see that step for the two-destination contract; never edit this file at review time — step 5 routes
generic gaps to a filed issue; edits land only via a maintainer PR against the flow repo.

---

## Bundled-work disclosure

For each `Bundled during implementation:` line in the PR body's `## Key decisions`, verify:
(a) the bundled work actually passes the three-exclusion triage in
`skills/pipeline/flow-product-planning/references/discovery-instructions.md`
("Objective-item triage") — including its cumulative bundle-size test — and (b) a matching
`- **Bundled:**` bullet was appended to the relevant task in `.flow-tmp/plan.md`. A violation
is an ordinary review finding (issue or suggestion, per severity) like any other check in
this file.

## Consistency Checks

When code handles multiple cases (switch statements, if-else chains, parallel functions for
different providers/types), verify cross-cutting patterns apply uniformly to every branch,
not just some. If a branch omits one, determine whether the omission is intentional (and
commented) or accidental. **General rule:** if N-1 of N branches use a pattern, the Nth
branch probably should too.

## npm Lifecycle Script Environment Guards

`prepare`/`postinstall`/`preinstall` scripts run automatically during `npm install`/`npm ci`.
If they depend on non-Node tools (`git`, `bun`, `docker`) without a guard, they break installs
in environments lacking those tools. For each lifecycle script, identify external tool
dependencies, verify each is guarded with `command -v`/`which`, and verify failure is
non-fatal (doesn't block `npm install`).

## Stale Comments Referencing Impossible Scenarios

When a phase doc-comment enumerates resume scenarios or branch-reach conditions, a refactor
that narrows reachability (e.g. shrinks a dispatch table's `unfinishedStatuses`) leaves the
comment claiming a scenario the new wiring makes unreachable. Trace whether the
runner/dispatcher can actually produce each enumerated scenario — the dispatch table is the
authority. Prefer deleting the impossible scenario over hedging it; a short accurate comment
beats a long partly-wrong one.

## Branch Staleness vs. Main-Integrated Behaviour

A PR's branch can pass its own CI while cut from a stale `main`, because CI exercises the
branch in isolation, not the post-squash-merge tree. This matters most when the PR adds a
phase/hook/step that _composes_ with modules changed on `main` since the cut — even when the
PR's own diff doesn't touch those files, and especially when the PR's tests mock the
changed-on-main module (suppressing the only signal that would catch drift). Check
`git log <branch>..origin/main` for commits touching integration partners; if the PR's
tests mock those partners, recommend a rebase + full re-run before merge. Bar:
`suggestion (non-blocking)` unless there's a concrete file-level conflict or known
contract change.

## `process.exit` Inside Result-Returning Primitives

A function whose return type encodes success/failure (`{ ok, ... }`, a domain enum) is a
contract that callers can wrap in try/catch — but `process.exit(...)` inside it bypasses that
contract entirely; a try/catch cannot catch an exit. This surfaces only when a CLI primitive
built assuming it only runs from `main()` gets reused from a non-CLI caller (a phase, an
orchestrator, a test harness). For each result-returning primitive used outside a CLI entry
point, grep it (and its helpers) for `process.exit`; enumerate whether the new caller's
argument set can reach it. The fix is not "wrap in try/catch" — refactor the primitive to
throw or return a failure variant, pushing the exit decision back to the CLI entry point.

## Agent Prompt Cites A Confidence Range That Diverges From The Helper's Filter Default

Agent role prompts describing a pre-digest lens's payload sometimes restate the lens's
_internal_ confidence-score range rather than the _filtered_ range the agent actually
receives (the helper applies `confidence >= min_confidence` before emitting). A prompt whose
cited lower bound is below the helper's default lies about what shows up in the agent's
facts block. Grep the matching CLI parser for its `min_confidence` default and compare;
prefer prose that names the filter default by name over a baked-in range, so it stays true
if the default moves.

## Doc Arithmetic Drift From Code Constants

Prose budgets that sum components ("head 200 + marker + tail 100 = 300") derive from code
constants and drift from them, either via a refactor updating the constant but not every doc
site quoting it, or via an author who never checked the sum. For each cited budget, locate
the constant(s) it derives from, sum the parts including marker/separator overhead, and grep
the repo for the exact number — every site must agree with the code and with each other.

## Exact-String Anchor Gating Between Producer and Consumer Docs

A producer doc authors a specific artifact (heading, sentinel literal, field name) and one or
more consumer docs gate behavior on matching that exact string. When the gate is byte-exact
and "tolerant of absence" by design, a one-sided rename on the producer side silently
degrades the whole feature instead of failing loudly. Grep the exact literal across the
producer and every consumer file; confirm it's byte-identical everywhere. Either pin the
anchor with a lint checking all sites in lock-step, or make the consumer match tolerantly
(case-insensitive, any heading level) while pinning only the producer's exact emission.

## Partial Cross-Reference Update After a Multi-Item Move

When a PR moves or renames ≥2 sibling items (escalation variants, config entries, section
headings), every prose cross-reference elsewhere that names those items by enumeration must
be updated to name all of them — not just the ones the author touched first. Find every
location naming the moved/renamed group by enumeration and count how many members each
actually names. "The omission is pre-existing" is not a valid dismissal once the PR changes
what the reference points at — the omission was harmless while all members lived together
and became a real gap the moment the PR moved the group.

## Git-Grep Audit Guards Must Use Deterministic Pathspec Magic

An audit-guard test that shells out to `git grep`/`git ls-files` with a bare `**` glob
pathspec relies on git's default glob interpretation, which differs by pathspec settings and
silently false-passes when the pattern matches nothing. Guards exist to fail loudly; a guard
whose selector can quietly select zero files never detects anything. Flag bare `**` pathspecs
in grep-based invariants: use explicit `:(glob)` pathspec magic, or assert the selector
matches a known-present sentinel file so an empty selection fails.

## Doc Claims Overstating Instrumentation Coverage (PR #477)

When a PR adds instrumentation/telemetry on one code path and ships prose claiming universal
coverage ("every launch", "all requests"), cross-check each claim against the actual call
sites — sibling paths (a duplicated private helper, an alternate backend) may be
uninstrumented by design. Flag the wording, not the missing instrumentation, when the scope
was deliberate.

## Doc Comment Asserting a Stricter Contract Than the Matcher Implements (PR #505)

When a comment or constant doc claims a cross-layer string contract must stay
"byte-identical"/"exact match" but the paired matcher uses a substring/`includes`/prefix
check, flag the contradiction — either the matcher should be strict or the comment should
state the real (looser) contract. Look for doc comments containing "exact"/"byte-identical"
adjacent to `.includes(`, `strings.Contains`, or regex partial matches on the same value.

## Predicate Doc Comment Naming a Narrower Trigger Than the Predicate Matches (PR #461)

When a boolean helper is documented in terms of the _scenario that motivated it_ but its
predicate actually matches a broader set, flag the gap — the narrow wording invites a future
reader to reason about only the motivating case and miss the other states that reach the
branch, which is how an over-broad guard survives review. Distinct from the stricter-doc
pattern above: there the comment is _stricter_ than the code, here it is _narrower in
trigger_ while the code is broader.

## JSDoc/Comment Cross-Reference to an Instance Member Written as `Class.method` (PR #577)

A doc comment citing an instance method with dot notation (`Graph.isInterpolatedAnchorUsable`)
implies a public static API when the member is actually private/instance. The correct
notation is `Class#method`, which is also what JSDoc/TypeDoc resolve as an instance-member
link. Check any cross-file comment naming a method on another class: is it static
(`Class.method`) or instance (`Class#method`), and is it even exported — citing a private
method from another module's comment is itself a smell worth flagging.
