# Review scope, lens gates, and the bounded widen

Full detail for Step 3's scope/gate resolution and the Step-3.5 widen
sub-step `SKILL.md` points at — kept out of `SKILL.md` itself to stay
under the file's line-budget lint ceiling.

Why: every step-8 review entry that clears the Gatekeeper today spawns
all six lenses over the whole PR diff, even on a one-file fix-loop
re-entry or a docs-only PR. `flow-review-scope` resolves `full | delta`
scope and content-gates lenses with nothing in their domain, so cost
scales with what actually changed. Config opt-outs: `review.lensGates`
and `review.deltaScope` in `~/.flow/config.json` (both default `true`;
strict `false` disables — `--no-gates` / `--force-full` are the
equivalent CLI overrides).

## Resolve scope and gates (Step 3 preparation)

Run AFTER item 4's static-analysis pre-digest (the gate rules read its
`dependencies`/`security` signals for the never-skip-on-signal
overrides). The supply-chain lens stays on for any of three triggers: a
changed manifest/lockfile, a static-analysis npm-audit `dependencies`
signal, or a new bare-specifier import added in the reviewed diff.

```bash
flow-review-scope --pr "$PR_NUMBER" --worktree "$WORKTREE" \
  --static-analysis "$WORKTREE/.flow-tmp/static-analysis.json" \
  ${FORCE_FULL:+--force-full}
SCOPE_KIND=$(jq -r .scope "$WORKTREE/.flow-tmp/review-scope.json")
GATED_LENSES=$(jq -r '.gates | to_entries[] | select(.value.run==false) | .key' "$WORKTREE/.flow-tmp/review-scope.json")
DELTA_FILES=$(jq -r '.delta_files[]' "$WORKTREE/.flow-tmp/review-scope.json")
```

Echo every `NOTICE — review-scope:` / `NOTICE — lens-gated:` line the
helper printed to stdout — these are the user-visible cost signals.

`DIFF_PATH="$WORKTREE/.flow-tmp/diff.txt"` is now the file
`flow-review-scope` wrote (full or delta, capped). Step 3.5 and the
Gemini lens must NOT regenerate it — both fallbacks are guarded by "if
the file doesn't already exist", so the invariant is ordering:
`flow-review-scope` runs before either. A future unconditional
`flow-pr-diff "$PR_NUMBER" > "$DIFF_PATH"` re-generate would silently
clobber the delta scoping.

## Spawn only the ungated lenses

Loop only over lenses where `gates.<lens>.run == true` (from
`review-scope.json`). Each Task carries `description: "review lens:
<lens>"` — the telemetry collector attributes subagent-transcript usage
by this description string when a lens falls back to `general-purpose`
(whose `agentType` carries no lens suffix).

Skip the intent-guess spawn when `SCOPE_KIND == delta` AND
`$WORKTREE/.flow-tmp/intent-resolution.json` already exists from a prior
run — a delta diff cannot support a fresh purpose guess. Step 3.6 then
reuses the prior resolution, noted as `intent-guess-skipped: delta
re-entry, prior resolution reused`.

Each lens prompt's `## Review scope` section (`{{REVIEW_SCOPE}}` in
`agent-prompts.md`) substitutes:

- **Full scope:** `Full PR diff.`
- **Delta scope:** `Delta re-entry: the diff below covers only
  <base>..<head> (<n> files). Read every listed file in full; findings
  must still cite PR-touched lines. If a delta hunk changes a contract
  used by unchanged PR files, report it as a finding — do not assume the
  earlier review covered it.` followed by the `$DELTA_FILES` list.

## Record lens tokens

As each lens's Task completion notification arrives, read its
`<usage><subagent_tokens>` value and record it:

```bash
LENS_TOKENS+=("<lens>=<n>")
```

On a widen re-pass (below), ADD the second figure to the same lens's
running total rather than replacing it — the widen's true cost is the
delta pass plus the full pass. A lens whose notification carries no
`subagent_tokens` is simply omitted from `LENS_TOKENS`; the Step-12
collector falls back to the subagent transcript for that lens.

At Step 12, build the `--lens-tokens` flags as a proper array before
calling `flow-review-telemetry collect` — quoted
`"${LENS_TOKENS[@]/#/--lens-tokens }"` glues each `--lens-tokens
<lens>=<n>` pair into ONE argv word, which `parseArgs` rejects with
exit 2:

```bash
LENS_TOKEN_ARGS=()
for t in "${LENS_TOKENS[@]}"; do LENS_TOKEN_ARGS+=(--lens-tokens "$t"); done
flow-review-telemetry collect --worktree "$WORKTREE" --pr "$PR_NUMBER" \
  --session-id "$CLAUDE_CODE_SESSION_ID" "${LENS_TOKEN_ARGS[@]}" --append \
  ${WIDEN_REASON:+--widened "$WIDEN_REASON"}
```

## Widen (consolidator authority, once)

After Step 3.5's artifact read:

```bash
WIDEN=$(jq -r '.scope_verdict.widen // false' "$WORKTREE/.flow-tmp/consolidator-result.json")
```

- If `true` and `WIDENED != 1`: set `WIDENED=1`,
  `WIDEN_REASON=$(jq -r .scope_verdict.reason "$WORKTREE/.flow-tmp/consolidator-result.json")`,
  re-run `flow-review-scope … --force-full`, re-spawn the ungated lenses
  (same exemption, same "Load the Task tool before spawning" preamble —
  not a new site), and re-run Step 3.5.
- If `true` and `WIDENED == 1`: print `NOTICE — widen-cap: consolidator
asked to widen again; already widened once this invocation` and
  proceed without re-spawning.
