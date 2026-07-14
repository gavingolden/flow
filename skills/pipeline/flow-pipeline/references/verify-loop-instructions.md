# Verify-retry-loop subagent instructions

These instructions are read by the verify-retry-loop subagent that
`/flow-pipeline`'s SKILL.md spawns via the Task tool at step 6 (`Local
verify`). The subagent runs in an isolated context — its `/flow-verify`
transcript, the re-pasted `flow-pre-commit --json` failure JSON, the
per-fix rationale, and the UI-smoke output stay inside its own session
and are never returned to the supervisor. Isolating that loop is the
whole point: across the 3 outer attempts the re-pasted failure JSON
would otherwise accumulate unbounded in the supervisor's own transcript
(the one measured unbounded supervisor-context offender). The only
outputs it produces are the side effects on the worktree (fix commits,
any Layer-3 `.flow/pre-commit.json` commit, any UI-smoke manifest
commit) and the structured artifact it writes to disk
(`.flow-tmp/verify-loop-result.json`), plus a brief one-paragraph
both-sides summary it returns on completion.

The wrapper passes you these inputs in its spawn prompt:

- The PR number.
- The absolute worktree path (your working directory).
- The absolute path to `.flow-tmp/plan.md` (so you understand the PR's
  intent when fixing failures).
- The absolute path to write the artifact (`ARTIFACT_PATH` —
  `.flow-tmp/verify-loop-result.json` under the worktree).

Follow the steps below in order.

## 1. Load context

Before running anything:

- `cd` into the worktree (your working directory).
- Read `.flow-tmp/plan.md` for the PR's intent — what the change is meant
  to accomplish — so a verify failure is fixed against intent rather than
  papered over. This is read-only background; it stays in your context.

## 2. Run the 3-outer-attempt `/flow-verify` loop

Invoke `/flow-verify` in-process inside the worktree. `/flow-verify` self-loops
internally; the **outer cap is 3 attempts** and fires only when
`/flow-verify` exits without a clean pass.

Each retry re-invokes `/flow-verify` and pastes the prior attempt's
`flow-pre-commit --json` `failure` object verbatim. The cap on
retry-prompt size is enforced _structurally_ by `flow-pre-commit --json`
(`bin/flow-pre-commit.ts` — `buildFailureExcerpt` head/tail-caps each
failed check at 100+100 lines), so you can paste it verbatim — no
hand-truncation:

```
/flow-verify

PRIOR ATTEMPT FAILED — failure JSON (one entry per failed check):
{
  "name": "npm run test",
  "scope": "src",
  "failure": {
    "firstErrorLine": 42,
    "firstErrorText": "FAIL  src/foo.test.ts > should bar",
    "headExcerpt": "<≤100 lines>",
    "tailExcerpt": "<≤100 lines>",
    "totalLines": 5000
  }
}
```

`firstErrorText` is the first line matching the error/fail regex;
`headExcerpt` + `tailExcerpt` are bounded slices of the un-ANSI'd output.

**Apply fixes INLINE — never spawn `/flow-coder`.** You are already a
one-shot Task subagent, so the one-level sub-agent cap forbids you from
spawning a nested Task call; `/flow-verify`'s wider-scope `/flow-coder` delegation
is therefore unavailable to you. Apply every fix inline with `Edit` /
`Write` regardless of scope — your own isolated context _is_ the
isolation `/flow-coder` would otherwise provide, so nothing is lost. Record
this as the design invariant it is, not a degradation.

**Retries are prompt-side only.** The Skill tool has no per-invocation
model/effort override today, so the only escalation between attempts is
the narrowed search space the prior failure log provides — the model and
reasoning effort are the same on attempt 3 as on attempt 1.

After **three failed outer attempts**, stop: set `verify_status:
"exhausted"`, capture the final attempt's failure log into
`final_failure_excerpt` (the head/tail-capped excerpt — do not re-expand
it), and proceed to write the artifact. Do **not** open or edit the PR
body yourself; the supervisor owns the `verify-exhausted` escalation and
the `> [!CAUTION]` PR-body block, which it builds from
`final_failure_excerpt`.

## 3. Layer-3 proactive config-authoring branch

When `flow-pre-commit --json` returns `reason: "unmatched-files"`, the
orphaned files may belong to a recognizable-but-uncovered layout. Before
treating it as a `/flow-verify` failure, call the pure
`draftConfigEntryForOrphans` helper (exported from
`bin/lib/monorepo-scopes.ts`) over the report's `unmatchedFiles`:

- **If it returns an entry** (a recognizable layout whose owning
  `package.json` declares verify-class scripts), write/merge it into the
  repo-relative `.flow/pre-commit.json` (top-level array of
  `{ name, prefixes, checks }` entries — append, do not clobber existing
  entries), commit it to the feature branch so it lands in the reviewable
  PR diff, and **re-run verify** — this does NOT consume an outer
  attempt. Set `config_authored: true` in the artifact.
- **If it returns `null`** (a genuine orphan: no `package.json` owner, no
  stack marker, no config), fall through to the loud `unmatched-files`
  failure, which counts toward the 3-attempt cap.

The helper is LLM-free and pure (no `claude -p` / Task sub-call). This is
the **third** of `flow-pre-commit`'s command-resolution layers; the
Layer-3 commit is the only config write — zero-config auto-detect
(layers 1–2) writes nothing.

## 4. UI-smoke pass

When the diff touches a meaningful UI surface (not only when a
`.flow/ui-validation.json` manifest already exists), run the browser-driven
UI-smoke pass as part of this step, following the shared procedure in
[ui-smoke-pass.md](ui-smoke-pass.md): probe the `chrome-devtools` MCP →
on missing schema run `flow-ui-validate --mcp-absent` (a quiet
`ran:false` skip, never a failure) → otherwise run
`flow-ui-validate --changed-files <diff>` and **branch on the helper
verdict**. On `action: "bootstrap"` (no manifest yet, MCP present), the
helper has inferred `launch`/`baseUrl` (with a `{{PORT}}` placeholder) /
`routes` / `loginUrl` / credential env-var NAMES plus a `needs[]`: allocate
a free port, resolve the placeholder, **empirically verify** the inference
(launch starts, routes render, login succeeds using VALUES resolved from
the local `.env`/shell env at run time), then write the verified
NAMES/config back into `.flow/ui-validation.json` and commit it — storing
names and non-secret config only — never a secret value. On `ran:true`
(ready), a manifest already exists — launch on dedicated ports, open a
per-pipeline isolated page, drive the MCP per route, assemble a captures
JSON, and run `flow-ui-validate --captures`. A shared-profile lock is a
loud-but-clean skip via `flow-ui-validate --browser-busy`, never a hard
failure. A `ran:true` result with `ok:false` is a verify failure that feeds
the **same 3-attempt loop** above; headless / MCP-absent runs stay green.
**Adaptive noise filter:** when an `ok:false` flags benign noise unrelated
to the diff (a favicon 404, a third-party beacon), add the substring to the
manifest's `ignoreRequestPatterns` / `ignoreConsolePatterns` and **commit
that manifest change** rather than consuming a fix-loop attempt.
**Self-completing + self-maintaining manifest:** complete and maintain
EVERYTHING the smoketest needs — when you adapt the launch on the fly, fix a
404'd route or a failed launch field, or record a verified `loginUrl` +
credential NAMES, persist the launch adaptation back into
`.flow/ui-validation.json` and commit it, so the next run starts
deterministic. When the bootstrap `needs` includes `credentials` (a login
wall exists but no NAMES could be mined and none resolve from the local
env), write everything else you verified into the manifest, commit it, and
escalate `NEEDS HUMAN: smoketest-needs-creds` rather than guessing a login
flow. Record the outcome in `ui_smoke` (`passed` / `skipped` /
`not-applicable`); on `skipped` with a UI-touching diff, also set
`ui_smoke_reason` to a one-line reason so the supervisor can surface the
user-visible "UI changed; browser validation did not run — <reason>" line.

## 5. Write the structured artifact

Write the artifact at the absolute path the wrapper passed you (the
parent directory `.flow-tmp/` already exists — the wrapper created it).
Overwrite any prior artifact; do not append.

The artifact MUST conform to this JSON schema:

```json
{
  "verify_status": "pass" | "exhausted",
  "attempts": 1,
  "config_authored": false,
  "ui_smoke": "passed" | "skipped" | "not-applicable",
  "ui_smoke_reason": "<present only when ui_smoke is 'skipped' AND the diff touched UI: a one-line reason (mcp-absent / no-creds / launch-failed / not-meaningful) the supervisor renders into the user-visible 'UI changed; browser validation did not run — <reason>' line>",
  "final_failure_excerpt": "<present only when verify_status is 'exhausted': the head/tail-capped final failure log the supervisor renders into the PR-body `> [!CAUTION]` block>",
  "rejected_alternatives": [
    "<each fix-shape or strategy you considered and rolled back, one line each>"
  ],
  "anti_patterns_found": [
    "<each off-pattern observation the next session should know about, one line each>"
  ],
  "summary": "<3–5 sentence both-sides return summary; see step 6>"
}
```

- `verify_status` is `"pass"` when an outer attempt (1, 2, or 3) exits
  clean, `"exhausted"` after three failed attempts.
- `attempts` is the number of outer attempts consumed (1–3); a Layer-3
  config-authoring re-run does NOT increment it.
- `final_failure_excerpt` is present **only** when `verify_status` is
  `"exhausted"`. Omit it (or leave it empty) on `"pass"`.

**Negative-findings slots are required.** `rejected_alternatives` and
`anti_patterns_found` are not optional decorations — populate them
proactively. An empty array is permitted only when you genuinely
encountered none; silence is not the default.

If the artifact is missing or empty, the wrapper's `test -s` existence
check fails and it surfaces `NEEDS HUMAN: verify-loop-missing-artifact` to
the supervisor (the wrapper checks existence/non-emptiness, not schema, so
a malformed-but-non-empty artifact is your responsibility) — validate your
JSON before exiting.

## 6. Return a brief summary

Your final message back to the wrapper should be one short paragraph
(3–5 sentences max) that surfaces **both sides**:

- At least one positive: the verdict (`pass` / `exhausted`), how many
  outer attempts were used, whether a Layer-3 config entry was authored or
  the UI-smoke pass ran.
- At least one negative: the top entry from `rejected_alternatives` or
  `anti_patterns_found`, or — on `exhausted` — the failing check that
  could not be fixed. A summary that names only successes fails the
  contract.

Do not paste the artifact JSON, file diffs, or the `/flow-verify` transcript
back — the wrapper only forwards your summary, and the artifact on disk
is the durable record. Keeping the return value short is the whole point
of the subagent fan-out.

# Verification

Before writing the artifact and returning, self-check:

- `verify_status` is exactly one of `pass` / `exhausted`.
- `attempts` is 1–3 and reflects outer attempts only (Layer-3 re-runs
  excluded).
- `final_failure_excerpt` is present iff `verify_status` is `exhausted`.
- No nested Task call was made (no `/flow-coder` spawn) — fixes were applied
  inline.
- `ui_smoke` is one of `passed` / `skipped` / `not-applicable`; when it is
  `skipped` on a UI-touching diff, `ui_smoke_reason` carries the one-line
  reason for the user-visible unverified-UI line.
- `rejected_alternatives` and `anti_patterns_found` reflect what you
  actually weighed; empty arrays only when you genuinely had none.
- The artifact JSON parses (no trailing commas, no unescaped strings).
- The return summary is 3–5 sentences and surfaces both positive and
  negative findings.

# Constraints

- ALWAYS run `/flow-verify` — running it is your entire purpose. (This is the
  deliberate inversion of the Merge-Conflict Resolver's "never run
  `/flow-verify`" constraint; do not copy that rule here.)
- NEVER spawn `/flow-coder` or any other Task subagent. The one-level
  sub-agent cap forbids a nested Task call; apply all fixes inline. Your
  isolated context is the isolation `/flow-coder` would otherwise provide.
- NEVER exceed 3 outer `/flow-verify` attempts. After the third failed
  attempt, write `verify_status: "exhausted"` and return — do not loop
  forever.
- The Layer-3 `.flow/pre-commit.json` commit and the UI-smoke manifest
  commit are the ONLY commits you make. You do not commit unrelated work,
  and a Layer-3 re-run does not consume an outer attempt.
- NEVER open, edit, or merge the PR, and NEVER write the
  `verify-exhausted` `> [!CAUTION]` PR-body block — the supervisor owns
  that from `final_failure_excerpt`.
- NEVER touch the base branch (`main`, `master`, or whatever the PR
  targets). All commits land on the per-pipeline feature branch.
- NEVER ask the user clarifying questions — the Task tool is one-shot.
  When something blocks a clean pass, exhaust the 3 attempts, record the
  blocker in `anti_patterns_found` / `final_failure_excerpt`, and let the
  supervisor escalate.
- NEVER write to `/tmp/` or to the worktree root for scratch — every
  transient file lives under `<worktree>/.flow-tmp/<name>`.
- NEVER leave the artifact unwritten. On any failure path, write the
  artifact with whatever partial state you have; the wrapper's
  missing-artifact escalation is reserved for catastrophic crashes.
