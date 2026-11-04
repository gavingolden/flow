# Performance Review Checklist

Checks for the **performance** lens. Cap: 200 lines, lint-enforced. Before an addition would cross it: condense, fold instance entries into a class rule, re-home an entry to the lens whose checklist owns its surface, automate deterministic entries into lint, or move consumer-specific entries to `docs/consumer-review-patterns.md`.
New entries are captured via `flow-pr-review/SKILL.md` step 5 ("Capture the gap") —
see that step for the two-destination contract; never edit this file at review time — step 5 routes
generic gaps to a filed issue; edits land only via a maintainer PR against the flow repo.

---

## Performance

Performance issues in hot paths compound quickly. A single N+1 query in a list view can
turn a 50ms page load into a 5-second one.

### What to look for

- Database queries inside loops (N+1 pattern)
- Missing pagination on queries that could return unbounded results
- `addEventListener` / `setInterval` without cleanup (memory leaks)
- Synchronous blocking operations on the main thread or in async contexts
- Unnecessary copies of large data structures (spread on large arrays/objects)
- Sequential awaits that could be parallelized (`Promise.all`)
- Missing or incorrect cache invalidation
- O(n^2) or worse algorithms applied to potentially large datasets

### How to check

1. For each database call in the diff: is it inside a loop? Could it be batched?
2. For list/collection queries: is there a `LIMIT` or pagination mechanism?
3. For event listeners and intervals: is there a corresponding cleanup?
4. For `await` chains: are the operations independent? If so, could they use `Promise.all`?
5. For large data operations: is the algorithm complexity appropriate for the expected data size?

### Confidence guidance

- Query inside a loop with no batching: 90+ (clear N+1)
- Unbounded query on a growing table: 85-90
- Missing cleanup on an interval: 85-90 (leaks over time)
- Sequential awaits on independent operations: 80-85 (perf improvement, not a bug)

**General rule:** Flag concrete, measurable performance issues — not hypothetical slowdowns.
"This loop is O(n^2) over user data that can grow to 10K rows" is actionable. "This could
be slow" is not.

---

## Metrics instrumentation

A runtime change shipped without metrics blinds the owner; a label fed from an unbounded
set multiplies series and the monitoring bill. The repo's `.flow/metrics.md` and the PR's
`## Instrumentation` section are the contract; the `flow-metrics` skill holds the rules.

### What to look for

- A touched trigger surface (request handler, job or queue consumer, outbound API call,
  multi-stage pipeline, connection or worker pool) with no emission matching the PR's
  `## Instrumentation` section; check each surface in the diff against it
- A metric recorded directly against a backend client instead of the repo's metrics helper
  (confidence 80)
- An attribute fed from an unbounded set: a raw error or exception message, a
  user/request/session ID, or a raw URL path instead of a route template; trace each new
  attribute's values to a closed list (confidence 85-90, unbounded series)
- An `error.type` value absent from `.flow/metrics.md` `## error.type values`; grep that file
  and the helper's union for each new value (confidence 80-85)
- A duration recorded in milliseconds under a seconds unit (confidence 80-85)
- Separate success and failure metrics, or summaries, where the backend aggregates histograms
- A hand-written HTTP-edge metric duplicating what auto-instrumentation already emits
  (confidence 75-80)
- A gauge read with a rate (`rate()`, `increase()`): a level is read directly or with `max`
  (confidence 80-85)
- A utilisation ratio emitted as a gauge: a ratio cannot be summed or averaged across
  instances; emit the used and max counts and compute the ratio in the query (confidence 80)

**General rule:** Flag a concrete unbounded label or a missing emission on a named trigger
surface, not a style preference about metric names.

---

## Slurping Append-Only Logs Into Memory

Code that aggregates over append-only log files (jsonl phase logs, ndjson event streams,
audit trails) often grows to hold the full file content in memory at once via
`readFile` + `split("\n")`. Each file is small in isolation, but the aggregator multiplies
the cost: scanning across all tasks (with `--all`, with archive enabled) reads every log
file synchronously into the heap.

### What to look for

- `fs.readFile` + `.split("\n")` over a file whose growth is unbounded by design (logs,
  event streams, audit trails)
- The same call invoked inside a `for…of` over many files (an aggregator, a roster
  builder)
- A function whose input is a path to a file the rest of the system writes incrementally

### How to check

1. For each `readFile` over a log/jsonl/ndjson path, ask: is the producer append-only
   with no upper bound? If yes, this is the pattern.
2. Verify the consumer truly needs the whole file in memory — most aggregators only need
   per-line state (sum, last-seen, count). If so, `readline` over `createReadStream` is
   the streaming alternative.
3. Trace the worst-case fan-out — if the aggregator runs across N files at once
   (`Promise.all`, `--all`), multiply per-file size by N for the peak.

### Example — slurping per-phase jsonl in a roster aggregator (PR #23)

```typescript
// BAD: loads the full jsonl into memory for every phase, every task, every roster build.
const raw = await fsp.readFile(filePath, "utf8");
for (const line of raw.split("\n")) {
  // …sum per-line state…
}

// GOOD: streaming line reader, peak memory bounded to one line.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
const rl = createInterface({
  input: createReadStream(filePath, { encoding: "utf8" }),
  crlfDelay: Infinity,
});
for await (const line of rl) {
  // …sum per-line state…
}
```

**General rule:** If a log file's size is bounded only by how long the producer ran,
read it line-by-line. Slurp + split is fine for config files, not for append-only logs.

---

## Comment Claims a Render-Time Saving That an Import-Time Cost Defeats

A comment (or PR body) justifying an opt-in/default-off flag as avoiding a
dependency's cost, when the dependency is pulled in by an **unconditional
static import** at the top of the same file. Gating the _render_ does not gate
the _module graph_ — the import cost is paid by every consumer regardless.
Either make the import lazy/dynamic, or narrow the claim to behavioural /
rendering equivalence only.

Check any comment that says a default-off flag "keeps X out of" consumers:
confirm whether X is statically imported. Caught by a human/bot reviewer on
PR #473 (`SearchPageHarness.svelte`); the agent lenses flagged a different
inaccuracy in the same comment but missed this one.
