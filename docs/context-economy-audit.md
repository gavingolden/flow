# Context economy audit — a measured baseline for Phase-5 tightening

Phase 5 of [`target-architecture.md`](target-architecture.md) ("measure,
then tighten") requires the downstream context-diet decisions — the
`/coder` routing edit-size threshold, per-repo skill granularity, and the
standalone-skills-home story — to rest on measured evidence rather than
guesses (decision D4, "measure before tightening"). This report is the
`p5-token-audit` node's exit artifact: the method, and the aggregate-only
findings from running `flow-transcript-audit` against a real completed
pipeline. It changes no pipeline behaviour; the before/after delta for
each diet change belongs to the sibling `p5-context-diet` node.

**Privacy note:** every number below is an aggregate (a count, a sum, a
percentage) derived by the helper. This report contains no quoted prompt
text, file content, or other verbatim transcript excerpts.

## Method

`flow-transcript-audit` (`bin/flow-transcript-audit.ts` +
`bin/lib/transcript-audit.ts`) walks a pipeline's Claude Code session
JSONL under `~/.claude/projects/<encoded-cwd>/` and attributes spend two
ways:

- **Per pipeline phase — exact.** Each record's top-level
  `attributionSkill` field (an undocumented but empirically stable field,
  observed on real transcripts) maps to a phase via a fixed table:
  `flow-pipeline` → supervisor, `product-planning` → plan,
  `new-feature`/`coder` → implement, `verify` → verify, `pr-review` →
  review. Records with a `null` or unrecognized `attributionSkill` land
  in an explicit **`unattributed`** bucket — reported as a first-class
  headline number, never silently folded into the preceding skill. A
  second, clearly-labelled **carry-forward** view is also reported: null
  records inherit the previous attributed record's phase, so a reader can
  see how much of any split depends on that fallback. Both views sum
  `message.usage` (`input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`) exactly — this
  half of the measurement is not a proxy.
- **Per tool-call class — an injected-payload-size proxy.**
  `message.usage` is reported per assistant API turn, not per tool call,
  so exact per-tool-class _token_ attribution isn't available from the
  transcript. The helper instead classifies each tool call
  (`Edit`/`Write` → edit, a `git diff`/`show`/`status`/`log` `Bash` call →
  diff, a `flow-pre-commit`/`vitest`/`npm run test`/`npm run verify` `Bash`
  call → verify-log, a `Skill` invocation's body or a `Read` of
  `*SKILL.md`/`AGENTS.md` → skill-body, an `Agent`/`Task` call → sub-agent
  return) and reports **count + injected-payload character size**, not a
  fabricated per-class token split. Dense text (structural YAML, verify
  logs, stack traces) tokenizes denser than prose, so a char-based number
  under-states — never over-states — that class's true token share; every
  percentage below should be read with that direction in mind.
- **In-process edit-size distribution — exact.** For each `Edit`/`Write`
  call, the helper reads `toolUseResult.structuredPatch`'s hunk lines
  (`+`-prefixed = added, `-`-prefixed = removed) for edits to existing
  files, and falls back to counting `toolUseResult.content`'s line count
  for `type: "create"` results (`structuredPatch` is empty for
  newly-created files, so a naive structuredPatch-only reader would
  register every file creation as a zero-line edit — this fallback avoids
  that undercount). This is exact, not a proxy: `structuredPatch` and
  `content` are the literal diff/file the tool applied.
- **Sub-agent spend — split by completion state.** An `Agent`/`Task`
  call's `toolUseResult` carries a measured `totalTokens`/`usage`
  aggregate only when `status: "completed"` (a synchronous, foreground
  spawn). The now-default backgrounded spawn (`status: "async_launched"`)
  has no spend recorded in the parent transcript at all — the helper
  counts these separately as **pending** rather than silently treating
  them as zero-cost.
- **Frontmatter cost — an estimated floor.** Each installed skill's
  `SKILL.md` YAML frontmatter block is measured in characters and divided
  by a documented constant (4 chars/token) to estimate its token cost.
  Anthropic ships no offline Claude tokenizer, and the sanctioned exact
  counter (`/v1/messages/count_tokens`) is a network call that would make
  the fixture tests non-hermetic — so this stays a char-based estimate.
  Structural YAML tokenizes denser than prose, so this too is a floor,
  not a point estimate.
- **Schema-break handling.** If a transcript's shape no longer matches
  what the helper expects (a renamed/missing `message.usage` field, an
  unexpected `attributionSkill` type), it reports a distinct
  `schema-break` result rather than a silently-wrong number — see
  `bin/flow-transcript-audit.test.ts`'s "graceful schema-break
  degradation" tests.

**Data source for this report.** One real, completed `/flow-pipeline` run
in this repository was selected because its `attributionSkill` values
span `product-planning`, `new-feature`/`coder`, and `pr-review` — i.e. it
covers plan, implement, and review. The transcript is 835 JSONL lines
(~2.1 MB). As a privacy cross-check for the sidechain-attribution claim in
the plan's Architecture Decisions: of the 197 `.jsonl` files currently
under this machine's `~/.claude/projects/<encoded-cwd>/`, zero carry an
`"isSidechain":true` record — sub-agent internal turns are genuinely not
persisted alongside the parent transcript, confirming the parent's
`Agent`-result aggregate is the only available signal for sub-agent
spend.

## Findings

### Per-phase token totals

Strict headline (input + output + cache-creation + cache-read tokens,
summed exactly from `message.usage`, grouped by `attributionSkill`):

| Phase            | Share of total |
| ---------------- | -------------- |
| plan             | 22.0%          |
| implement        | 28.0%          |
| review           | 18.0%          |
| supervisor       | 1.7%           |
| verify           | 0.0%           |
| **unattributed** | **30.3%**      |

The `unattributed` bucket is the largest single slice — roughly 3 in 10
tokens in this transcript carry no `attributionSkill` at all. The
carry-forward secondary view (null records inherit the prior attributed
phase) redistributes nearly all of it: under carry-forward, `unattributed`
drops to 0.1% and `review` absorbs the bulk of the reassigned mass, rising
from 18.0% to 48.2%. That's a large swing on a single fallback choice —
exactly why the plan's Architecture Decisions kept the strict bucket as
the headline rather than silently carrying forward: whatever produced
this pipeline's unattributed tokens (framework overhead, compaction,
error-recovery loops, or something else) fires disproportionately during
or right after the review phase, and a carry-forward-only report would
have billed all of it to review without disclosing the fallback. This
transcript's ~30% strict-unattributed share means per-phase splits from
this method constrain diet decisions less tightly than a fully-attributed
transcript would — a single-pipeline baseline should be read as
indicative, not definitive, on exactly this dimension. `verify` shows
zero tokens because this particular pipeline's local-verify pass ran
inside the `/verify`-attributed skill invocation but produced no
directly-attributed assistant turns in this transcript — a boundary
worth refining under the cross-model review's suggested follow-up
(boundary-delimited phase mapping off `Skill`-invocation events; see
plan.md's candidate follow-ups).

### Per-tool-call-class breakdown

Injected-payload character share (a proxy — see Method; dense classes are
under- not over-represented below):

| Class            | Count | Share of classed payload |
| ---------------- | ----- | ------------------------ |
| skill-body       | 5     | 61.0%                    |
| other            | 95    | 19.5%                    |
| edit             | 36    | 14.4%                    |
| diff             | 9     | 2.3%                     |
| verify-log       | 15    | 1.4%                     |
| sub-agent-return | 13    | 1.4%                     |

Skill-body payload — the full `SKILL.md` text injected each time a skill
is loaded or read — dominates classed payload at 61% of measured
characters from just 5 occurrences, despite `edit` (the actual code
changes this pipeline made) firing 36 times. This is a first, indicative
data point supporting the `target-architecture.md` "skill loading"
residual's concern: full-body skill injection is expensive relative to
the mechanical work a pipeline does, which is the premise
`p5-context-diet`'s lean-body/lazy-reference splits and the
standalone-skills-home story are meant to address.

Sub-agent spend in this transcript: 7 completed `Agent`/`Task` calls
totalling 693,902 tokens (measured, from each call's `toolUseResult`
aggregate), and 6 backgrounded (`async_launched`) calls whose spend is
not observable in the parent transcript at all. Roughly _half_ of this
pipeline's sub-agent calls are therefore invisible to any transcript-based
measurement — a real blind spot for whole-pipeline cost accounting, not
just this report's.

### In-process edit-size distribution (the `/coder` routing-threshold input)

36 `Edit`/`Write` calls, line-delta (added + removed) per call:

| min | p50 (median) | p90 | p99 | max |
| --- | ------------ | --- | --- | --- |
| 0   | 8            | 63  | 100 | 100 |

`target-architecture.md`'s current `/coder` routing threshold is
`≤1 file AND ≤30 LOC AND every file named` (prose-judged, not mechanically
enforced). Against this single transcript: the **median** edit (8 lines)
is well under the 30-LOC threshold, but **p90 (63 lines) and p99/max (100
lines) exceed it by 2–3×**. Read together with the fact that this
threshold is prose-judged rather than mechanically enforced, that gap is
exactly the kind of measured signal `p5-context-diet` needs to decide
whether 30 LOC is the right cutoff, whether it should flex with file
count, or whether a mechanical edit-cap guard (rather than a
model-judged threshold) is warranted — this report doesn't make that call,
only supplies the distribution. A single-transcript sample of 36 edits is
a start, not a settled distribution; `p5-context-diet` should treat this
as a first data point and consider whether the cross-pipeline aggregation
follow-up (see plan.md's candidate follow-ups) is warranted before
committing to a specific new threshold.

### Frontmatter cost (skill granularity / standalone-home input)

Across the 20 skills installed in this repository's `skills/` directory:
**2,268 estimated tokens total**, ~113 tokens/skill on average (min 62,
max 260), at the documented ~4 chars/token floor.

`target-architecture.md`'s "skill loading" residual estimates "~20 skills
× ~100 tokens" as the per-session frontmatter tax every installed skill
imposes on every plain `claude` session on the machine, flow-relevant or
not. This measurement — 20 skills, ~113 tokens/skill average, 2,268
tokens total — lands close to that estimate, on the higher side (since
the char-based proxy is a floor, the true tokenized cost is likely higher
still). This is one supporting data point for the standalone-skills-home
story (`p2-standalone-skills-home`): the per-skill frontmatter tax is real
and roughly the order of magnitude the roadmap assumed, which is relevant
to whether flow's skills belong in every session's global
`~/.claude/skills/` or in a project-scoped, opt-in location.

## Limitations

- **Single-pipeline baseline.** All findings above come from one
  transcript. The plan's own "at least one" floor is satisfied, but
  cross-pipeline variance is unmeasured — the candidate follow-up
  "cross-pipeline trend aggregation" (plan.md) would average attribution
  across N transcripts and is the natural next step before treating any
  number here as load-bearing for a specific threshold change.
- **~30% of this transcript's tokens are strictly unattributed.** See
  "Per-phase token totals" above. The boundary-delimited phase mapping
  candidate follow-up (attributing off `Skill`-invocation framework
  events rather than the per-record field) is recorded as the mitigation
  path, not built here.
- **Per-class figures are a proxy, not exact token counts,** and the
  proxy's error direction is one-sided (under-count on dense classes).
  The `--exact-tokens` candidate follow-up (an opt-in, non-default path
  via Anthropic's `/v1/messages/count_tokens`) would close this gap at
  the cost of a network dependency and non-hermetic fixture tests.
- **Frontmatter cost is a documented floor**, not a point estimate, for
  the same char-proxy reason.
