# Test-Coverage Review Checklist

Checks for the **test-coverage** lens. Soft cap: ~150 lines — condense, merge duplicates, automate deterministic entries into lint, or
move consumer-specific entries to `docs/consumer-review-patterns.md` before adding new
entries. New entries are captured via `flow-pr-review/SKILL.md` step 5 ("Capture the gap") —
see that step for the two-destination contract; never edit this file at review time — step 5 routes
generic gaps to a filed issue; edits land only via a maintainer PR against the flow repo.

---

## Real-Time Waits in Specs Where a Fake-Timers Idiom Exists

A spec that waits on real wall-clock time (`waitFor` with a seconds-scale timeout around a
`setTimeout`-driven behavior) is slower and CI-flaky when the repo already uses
`vi.useFakeTimers()` for timer-driven behavior elsewhere. Agents tend to suppress this as
"style"; reviewers flag it because it compounds across suites.

### What to look for

- New specs asserting on state that a production `setTimeout`/interval mutates, using
  real-time `waitFor`/sleeps rather than advancing fake timers
- Imports (`waitFor`) that become unused once the spec switches to fake timers

### How to check

1. In changed test files, find `waitFor(..., { timeout:` with timeout ≥ 1000ms.
2. Check whether the awaited behavior is a deterministic in-process timer (not network/IO).
3. If yes and the repo uses `vi.useFakeTimers()` elsewhere, flag `suggestion (non-blocking)`
   at ≥80 confidence — this is determinism, not style.

**General rule:** when production behavior is a deterministic in-process timer, the spec
advances fake timers; real-time waits are reserved for genuinely async boundaries.

## Exact-Count Assertion Against an Additive Contract (PR #453)

When a test asserts an exact count of rendered items/sections (`expect(x).toHaveLength(6)`)
over a surface whose contract is explicitly additive ("later producers may add sections"),
flag it as brittle — prefer asserting presence of each required item or a minimum count.
Look for: hard-coded totals in tests adjacent to superset-stable/additive contract doc
comments.

## Vacuous Guards

A guard that passes when the protected thing vanishes or is mangled protects nothing (flow
#915, #866, #864). For each guard, ask: would this fail if the protected thing were removed or
corrupted? Flag:

- An expected set derived from the artifact under test (`Object.keys(actual)`,
  `for x in observed`), which can never disagree with it.
- A "keep verbatim" assertion that checks only a prefix or label rather than comparing the
  full fixture value.
- A numeric bound on a JSON value not first asserted to be a finite number (`NaN` and
  `Infinity` serialize to `null`, which coerces to 0 in comparisons; `undefined` fails or passes
  silently).
