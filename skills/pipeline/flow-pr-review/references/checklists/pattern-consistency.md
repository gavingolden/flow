# Pattern-Consistency Review Checklist

Checks for the **pattern-consistency** lens. Cap: 200 lines, lint-enforced. Before an addition would cross it: condense, fold instance entries into a class rule, re-home an entry to the lens whose checklist owns its surface, automate deterministic entries into lint, or move consumer-specific entries to `docs/consumer-review-patterns.md`.
New entries are captured via `flow-pr-review/SKILL.md` step 5 ("Capture
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

- Metrics vocabulary: a new attribute key absent from `.flow/metrics.md` `## Attributes`; a
  registered concept under another word (`upstream` vs `server.address`); a key ignoring a
  fitting OpenTelemetry semantic-convention name; a tenant or customer ID as a label on a
  series-billed backend or Google Cloud Monitoring; an alert action of ticket or with no channel. Confidence 80 or above.

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

- Member notation: a comment citing an instance or private member as `Class.method` implies
  a public static API; write `Class#method`, and flag a cross-module citation of a private
  member (econ-data PR #577).

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
  consumer, outbound API call, multi-stage pipeline, or a connection or worker pool while the plan or PR
  `## Instrumentation` says `none` or is absent; flag at confidence 80 or above.
- Runtime design claims: a diff that adds a runtime surface (handler, job, queue consumer,
  scheduler, outbound call) while the plan's `### Runtime design` says `none` or is absent;
  flag at confidence 80.

## New Rules That Contradict Their Neighbours

For an added or edited rule, carve-out, or gate, read the surrounding sentences, the rest of
the doc, and its consuming SKILL.md. Flag a later floor overriding a named carve-out, or an
output format requiring what the gate exists to avoid (flow PRs #637, #748). Confirm each newly
cited sibling path resolves in the skill it names, not a neighbouring skill (flow PR #637).

## Branch Staleness vs. Main-Integrated Behaviour

CI's merge-ref run reflects `main` only as of the last push, so a PR cut from a stale `main` can pass while a phase/hook/step it adds composes badly with modules changed on `main` since. Highest risk when the PR's tests mock those integration partners. Check `git log <branch>..origin/main` for commits touching them; if mocked, recommend a rebase + full re-run. Bar: `suggestion (non-blocking)` unless a concrete conflict or known contract change.

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
