# Pattern-Consistency Review Checklist

Checks for the **pattern-consistency** lens. Soft cap: ~150 lines — condense, merge
duplicates, automate deterministic entries into lint, or move consumer-specific entries to
`docs/consumer-review-patterns.md` before adding new entries. New entries are captured via `flow-pr-review/SKILL.md` step 5 ("Capture
the gap") — see that step for the two-destination contract; never edit this file at review time — step 5 routes
generic gaps to a filed issue; edits land only via a maintainer PR against the flow repo.

---

## Bundled-work disclosure

For each `Bundled during implementation:` line in the PR body's `## Key decisions`, verify:
(a) the bundled work actually passes the four-exclusion triage in
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

A second source of truth for existing state (a new writer, cache, or index) must route
through every invariant the incumbent writer enforces (econ-data #633).

## Prose Claims Must Match the Code They Describe

Applies to a doc, comment, or agent-prompt sentence the diff adds or edits that states what
code does. Open the code it names and check:

- Enumerated scenarios: the dispatch table is the authority (a refactor that narrows
  `unfinishedStatuses` leaves a comment claiming an unreachable scenario). Delete the
  impossible scenario rather than hedge it.
- Cited ranges and defaults: compare against the helper's filter default (e.g.
  `min_confidence`); prefer naming the default over a baked-in range.
- Doc arithmetic ("head 200 + marker + tail 100 = 300"): locate the constants, sum the
  parts including marker/separator overhead, and grep for the exact number at every site.
- Coverage claims ("every launch emits X"): check every sibling call site, such as a
  duplicated private helper or an alternate backend (flow PR #477).
- Strictness claims ("exact", "byte-identical"): confirm the matcher is not `.includes(`,
  `strings.Contains`, a prefix, or a partial regex on the same value (flow PR #505).
- Trigger claims: compare the predicate's real trigger set with the narrower scenario the
  comment names; the narrow wording hides the other states that reach the branch (flow PR #461).

## Claims the Diff Contradicts

Applies to PR-body, runbook, README, evidence, and in-code-rationale sentences the diff adds
or edits:

- Negative claims ("nothing reads X"): grep the PR's own diff for a counterexample
  (flow PR #524).
- Promised visibility: grep the renderer or template for each new field the PR says is
  shown (flow PR #743).
- Recovery and re-run commands: confirm resume merges rather than overwrites, and that
  documented commands pass inputs this PR moved (flow PRs #907, #950).
- Status and evidence claims ("fixed", "already lives in X", "the only variable"):
  cross-check the PR body's out-of-scope list and the diff's other changed inputs
  (flow PR #748, econ-data #840).
- In-code rationale for not doing a promised thing: a constraint the same PR authored is
  self-imposed; flag it (econ-data #690).
- Instrumentation claims: a diff that adds or changes a request handler, job or queue
  consumer, outbound API call, or multi-stage pipeline while the plan or PR
  `## Instrumentation` says `none` or is absent; flag at confidence 80 or above.

## New Rules That Contradict Their Neighbours

For an added or edited rule, carve-out, or gate, read the surrounding sentences, the rest of
the doc, and its consuming SKILL.md. Flag a later floor overriding a named carve-out, or an
output format requiring what the gate exists to avoid (flow PRs #637, #748). Confirm each newly
cited sibling path resolves in the skill it names, not a neighbouring skill (flow PR #637).

## npm Lifecycle Script Environment Guards

`prepare`/`postinstall`/`preinstall` scripts run automatically during `npm install`/`npm ci`.
If they depend on non-Node tools (`git`, `bun`, `docker`) without a guard, they break installs
in environments lacking those tools. For each lifecycle script, identify external tool
dependencies, verify each is guarded with `command -v`/`which`, and verify failure is
non-fatal (doesn't block `npm install`).

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

## JSDoc/Comment Cross-Reference to an Instance Member Written as `Class.method` (PR #577)

A doc comment citing an instance method with dot notation (`Graph.isInterpolatedAnchorUsable`)
implies a public static API when the member is actually private/instance. The correct
notation is `Class#method`, which is also what JSDoc/TypeDoc resolve as an instance-member
link. Check any cross-file comment naming a method on another class: is it static
(`Class.method`) or instance (`Class#method`), and is it even exported — citing a private
method from another module's comment is itself a smell worth flagging.
