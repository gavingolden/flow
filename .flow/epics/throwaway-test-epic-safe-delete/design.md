# Epic: throwaway test epic (safe to delete) — `--quiet` flag for `flow ls`

## 1. Problem & intent

**Goal:** Let scripts and quick eyeballing consume `flow ls` output without the header row noise.

The verbatim epic prompt is: "throwaway test epic (safe to delete): add a
`--quiet` flag to `flow ls` that suppresses the header row." `flow ls`
(`bin/lib/ls.ts`, `printTable`) always prints a `NAME  REPO  PHASE  PR  LAST
ACTIVITY` header line before the data rows (`bin/lib/ls.ts:280`). There is no
existing way to get just the rows — e.g. for `flow ls --quiet | wc -l` or
piping into `awk`/`grep` without a `tail -n +2`. This is explicitly flagged
by the user as a throwaway test epic (safe to delete), so scope is kept
literal to the one-line description — no additional `ls` behavior is
in-bounds.

## 2. Clarified requirements

```
WHEN a user runs `flow ls --quiet` with at least one row to print
THE SYSTEM SHALL print the data rows only, omitting the `NAME  REPO  PHASE  PR  LAST ACTIVITY` header line

WHEN a user runs `flow ls --quiet` with zero active pipelines
THE SYSTEM SHALL still print the existing `flow ls: no active pipelines` message (unaffected by `--quiet`, since that line is not the header row)

WHEN a user runs `flow ls --quiet --cost`
THE SYSTEM SHALL omit the header row (including the `$ COST` column header) while still printing the `$ COST` data column

WHEN a user runs `flow ls --quiet` combined with an already-invalid flag combination (e.g. `--detail` without `--cost`)
THE SYSTEM SHALL still exit 2 with the existing usage error, unaffected by `--quiet`

WHEN a user runs `flow ls --help`
THE SYSTEM SHALL list `--quiet` in the verb help text
```

Before → after:

| | Before | After |
|---|---|---|
| `flow ls` | prints header + rows | unchanged (default remains header + rows) |
| `flow ls --quiet` | flag does not exist (`unknown option '--quiet'`, exit 2) | prints rows only, no header |
| `flow ls --quiet --cost` | flag does not exist | prints rows only (with `$ COST` column), no header |

**Lost:** none — `--quiet` is strictly additive; the default (header shown) is unchanged, and no existing flag or output is removed.

## 3. High-level design

**Decision: add `--quiet` as a third parsed option alongside `--cost`/`--detail` in `runLsCli`, threaded through `LsOptions`, and read only at the `printTable` header-line call site.**

- Context: `runLsCli` (`bin/lib/ls.ts:67-87`) already parses a small
  allowlisted option set (`--cost`, `--detail`) into an `LsOptions` object
  passed to `runLs`. `printTable` (`bin/lib/ls.ts:258-282`) is the single
  place that emits the header line (`console.log(line(cols.map((c) =>
  c.header)))`, line 280).
- Decision: extend the `allowed` set with `--quiet`, add `quiet?: boolean` to
  `LsOptions`, thread it into `runLs`'s `opts` (already the case, since
  `runLs` takes the full `LsOptions`), and guard the single header-emitting
  line in `printTable` with `if (!opts.quiet)`. No other function needs the
  flag — the row-printing loop, `printOrphanRecovery`, `printDetail`, and
  `warnUnknownModels` are all unaffected because they never touch the header.
- Consequences: one bounded, low-risk change (single new boolean threaded
  through one existing option-parsing path and one existing print function);
  no interaction with `--cost`/`--detail` beyond both being optional
  modifiers of the same table; the "no active pipelines" early-return message
  is untouched because it is not the header row.

This is a single volatile decision (where the flag is read), which is also
the epic's only feature boundary — see §4.

## 4. Feature decomposition

- **F1 — `flow ls --quiet` suppresses the header row.** `dependsOn: []`.
  Adds `--quiet` to `runLsCli`'s allowlist, adds `LsOptions.quiet`, guards
  the header-line `console.log` in `printTable` with `if (!opts.quiet)`,
  updates the `flow ls` verb help text in `bin/lib/help.ts`, and adds/updates
  tests in `bin/lib/ls.test.ts` covering: `--quiet` alone (no header, rows
  present), `--quiet --cost` (no header, `$ COST` data present), and the
  zero-rows path unaffected. `mvp: true` (it is also the entire epic).
  Rationale: hides the "where is the header read" decision behind the
  existing `LsOptions` interface — the only volatile decision in this epic.

```mermaid
graph TD
  F1["F1: flow ls --quiet"]
```

## 5. (n/a — see §4 mermaid)

This epic decomposes into exactly one feature; the DAG is a single node with
no edges, rendered above.

## 6. Open Questions

- **Flag semantics: does `--quiet` suppress ONLY the header, or also
  suppress `stderr` notices (update-notice, unknown-model warning) and the
  post-table orphan-recovery footnote?** **Recommended:** suppress only the
  header row, exactly as the prompt states ("suppresses the header row") —
  the orphan-recovery footnote and stderr notices are separate, useful
  signals a script consumer can still redirect away (`2>/dev/null`) without
  losing them from interactive use. Widening `--quiet` to swallow those too
  would silently drop actionable warnings (e.g. unknown-model cost
  undercount) for no signal in the prompt that this was wanted.
- **Should `--quiet` compose with a future machine-readable output mode
  (e.g. `--json`)?** **Recommended:** out of scope — no such flag exists
  today, and inventing one would violate the "keep scope small and literal"
  instruction for this throwaway test epic.
- **Is this epic-worthy at all, or should it just be a single `flow feature
  create` run?** **Recommended:** treat as a single-feature "epic" exactly
  as scoped — the prompt is genuinely one PR's worth of work (one flag, one
  file's header line, one help-text line, a few test cases). The epic
  wrapper here exists only because the harness invoked epic-mode discovery;
  the manifest reflects the true size (one feature, `mvp: true`) rather than
  manufacturing artificial splits.

## Recommendation

Proceed — the change is small, additive, low-risk, and the manifest is sized 1:1 to the epic prompt's actual scope (one feature).

## Plan risks

The single weakest assumption is that `--quiet` should suppress only the header row and nothing else (stderr notices, orphan-recovery footnote); if a downstream consumer actually wanted a fully machine-clean `flow ls` output (e.g. for piping to `jq` or `awk` with zero incidental lines), this narrower reading would under-deliver and need a follow-up feature — see the first Open Question.
