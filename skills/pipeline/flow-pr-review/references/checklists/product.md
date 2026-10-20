# Product Review Checklist

Checks for the **product** lens — the seventh, brief-gated lens. It runs only when
`flow-product-brief` resolves a brief (repo `.flow/product.md` or the user-level
`~/.flow/product.md` fallback); absent a brief it does not run at all, and its
artifact (`agent-output-product.json`) is tolerated-absent downstream. Soft cap:
~120 lines — condense before adding new entries.

## Scope: what counts as "user-read"

The product lens argues only from the brief about surfaces a human actually reads,
never from code quality, performance, security, supply chain, or test coverage —
those belong to the lenses that own them. In scope:

- Terminal/CLI output strings (error messages, status lines, help text)
- Docs, README files, and templates shipped to consumers
- Prompt and pause-block prose the user reads (pause-output-contract slots, agent
  spawn summaries surfaced to the user)
- The PR body's `## Why`, `## User-facing changes`, and `## Test Steps` sections

Out of scope: internal comments, variable/function names, log lines never surfaced
to a human, and anything another lens already owns (see above).

---

## Mechanism-first user-facing text

A user-facing string (CLI output, error message, doc line) that explains _how_ the
system did something rather than _what changed for the reader_ fails the brief's
"lead with consequence" vocabulary when the brief specifies one. Flag the mismatch
as `suggestion (non-blocking)`, quoting the offending string and the brief clause it
violates.

### How to check

1. Extract new/changed user-facing strings from the diff.
2. Compare each against the brief's "what good looks like" section and vocabulary
   table, when the brief states one.
3. Flag only strings the brief actually gives a rule for — an unstated preference is
   not a finding.

## Test Step assumes the reader opened the code

A `## Test Steps` item that names an internal identifier (a function, a file path,
an internal flag) instead of an observable action or output cannot be executed by a
reader who has not read the diff. Anchor the finding on the diff file/line the step
exercises, quote the step verbatim in `body`, and prefix `subject` with `[test-steps]`
so the fix-applier routes the fix to the PR body rather than to source. Always
`label: suggestion`, `decoration: non-blocking`.

### How to check

1. Read `{{PR_DESCRIPTION}}`'s `## Test Steps` section.
2. For each step, ask: could someone who has not opened the code perform it as
   written (click X, run Y, observe Z)?
3. If a step requires code knowledge to execute, flag it.

## Cost added without saying what it buys

A change that adds user-visible friction (a new required flag, an extra
confirmation, a slower default) without the PR body's `## Why` or
`## User-facing changes` stating the benefit the brief would recognize as a
ranked priority. Flag as `issue (non-blocking)` when the brief names a
competing priority the added cost trades against; `question` when the brief
is silent on the trade-off.

### How to check

1. Diff the user-visible behavior before/after.
2. Check whether `## Why` / `## User-facing changes` states the benefit.
3. Cross-reference the brief's ranked priorities (`P<n>`) for a stated conflict.

## Lower-ranked priority wins a stated conflict

When the diff's stated rationale explicitly trades one brief priority for another
and picks the lower-ranked one, flag it — the brief's ranking is the tie-breaker.
Label `issue (non-blocking)` and cite both priority numbers in `body`.

### How to check

1. Identify the priorities the PR's own rationale invokes (explicit only — never
   infer a priority the PR text doesn't name).
2. Compare their ranks in the brief.
3. Flag only when the diff's own stated rationale — not your inference — names the
   trade-off.

---

## Exclusions (always)

- Code-only hunks with no user-read surface in the diff.
- Identifiers inside code comments or commit bodies (not user-facing).
- Anything another lens already owns (bug-detection, pattern-consistency,
  performance, security, supply-chain, test-coverage).
- Any section the brief's own truncation/parse leaves unstated — do not infer past
  what the brief actually says.

Findings need a structured `file` + `line` on a PR-touched line; `[test-steps]`
findings anchor on the diff line the step exercises, even though the fix lands in
the PR body, not in that file.
