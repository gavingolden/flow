---
name: flow-verify
description: >-
  Run pre-commit verification checks, fix failures, and re-run until clean. Use
  when user says "verify", "run checks", "check my changes", "pre-commit", or
  before committing changes.
argument-hint: "[--scope frontend,backend,scripts] [--pr <number>]"
---

# Goal

Run all relevant pre-commit checks, fix any failures, and re-run until every check passes.

# When to Use

- Before committing changes
- User asks to "verify", "run checks", "check my changes"
- After completing a refactor, feature, or bug fix
- As a sub-step of other skills (e.g., pr-review Step 6)

# When NOT to Use

- When the user wants to run a single specific check (e.g., just `npm run test`)
- When the user is only running `npm run format` without checks

# Context

- `flow-pre-commit` (installed globally by `flow install` and on PATH) auto-detects scope,
  runs format + checks, and reports pass/fail. The `--json` flag emits a single bounded
  JSON object — head/tail-capped failure excerpts plus a `firstErrorText` extraction —
  so this skill returns a compact summary to its caller instead of replaying 50–200 KB
  of raw test stack traces.
- If the binary isn't on PATH, fall back to invoking the relevant `npm run` scripts
  directly (e.g., `npm run check`, `npm run lint`, `npm run test`).

# Instructions

## 1. Run the Pre-Commit Checks

```bash
flow-pre-commit --json $ARGUMENTS
```

If `$ARGUMENTS` is empty, the helper auto-detects scope from `git diff HEAD`. The `--json`
flag is required: it bounds each failed check's output to ~200 lines (head 100 + tail 100)
and extracts a `firstErrorText` field so the model summarising results doesn't have to scrape
a wall of raw stderr. If `flow-pre-commit` isn't on PATH, fall back to running the equivalent
npm scripts in sequence and stopping on the first failure — in that fallback path you don't
have the JSON structure, so summarise manually.

For direct human use at a terminal, the human-readable mode without `--json` is still
available (`flow-pre-commit` with no flag) and that path is unchanged.

### Optional UI-smoke pass

When the diff touches a meaningful UI surface AND the `chrome-devtools` MCP is available in this session, run the browser-driven UI-smoke pass alongside `flow-pre-commit` — a hand-authored `.flow/ui-validation.json` manifest is no longer a precondition; when none exists the helper returns a mechanical `action: "bootstrap"` verdict you branch on (infer `launch`/`baseUrl`/`routes`/`loginUrl` + credential NAMES → empirically verify → write the verified NAMES/config back into the manifest, names and non-secret config only — never a secret value, and commit it). Follow the shared procedure in [../flow-pipeline/references/ui-smoke-pass.md](../flow-pipeline/references/ui-smoke-pass.md): probe the MCP (`ToolSearch query="select:mcp__chrome-devtools__navigate_page"`) → on missing schema fall back to `flow-ui-validate --mcp-absent` (a quiet `ran:false` skip that never blocks the run) → otherwise `flow-ui-validate --changed-files <diff>` → on `bootstrap` self-complete the manifest, on `ran:true` (ready) `meta.env`-injected launch on dedicated ports → open a per-pipeline isolated page first (`new_page` with an `isolatedContext` named from the pipeline slug — read `@flow-slug` / `~/.flow/state/<slug>.json` / the worktree basename — so two pipelines sharing one chrome-devtools MCP server do not bleed cookies/storage) → drive the MCP per route → assemble a captures JSON → `flow-ui-validate --captures`. A `ran:true` result with `ok:false` (a console error, a failed request, or a missing `expectSelectors` element) is a verify failure routed through the same fix loop as any `flow-pre-commit` check (see Step 3); headless / MCP-absent runs stay green. **Adaptive noise filter:** when an `ok:false` flags a benign console error or failed request unrelated to the diff (a favicon 404, a third-party beacon/analytics request, browser-extension noise), do **not** fix-loop on it — add the substring to the manifest's `ignoreRequestPatterns` / `ignoreConsolePatterns` in `.flow/ui-validation.json` and commit that manifest change (it lands in the reviewable PR diff), then re-run. **Self-completing + self-maintaining manifest (CRITICAL):** the agent completes and maintains EVERYTHING the smoketest needs, not just the launch — when it adapts the launch on the fly, fixes a 404'd route or failed launch field, or records a verified `loginUrl` + credential NAMES, it persists the launch adaptation back into `.flow/ui-validation.json` (env/launch/baseUrl/routes/loginUrl/credentialEnvVars) and commits it into the reviewable PR diff so the next run starts deterministic; runtime credential VALUES resolve from the local `.env`/shell env and are never persisted. The committed manifest and every artifact reference credential env-var NAMES only — reading the manifest-named VALUES at runtime to drive the login form (see the Login step in ui-smoke-pass.md) is sanctioned only for zero-risk seed/test accounts, not a license to hand-type arbitrary or production passwords. When run directly (interactive `/flow-verify`), a genuinely-unresolvable creds gap may prompt via `AskUserQuestion`; the autonomous pipeline path instead escalates `NEEDS HUMAN: smoketest-needs-creds`. See [../flow-pipeline/references/ui-smoke-pass.md](../flow-pipeline/references/ui-smoke-pass.md) for the full probe → bootstrap → launch → drive → assemble → fix-loop body and the LLM-free / no-`claude -p` / no-Task constraint, and `skills/pipeline/flow-pipeline/SKILL.md` Step 6 for the supervisor-side contract.

**Shared-profile lock (parallel pipelines).** chrome-devtools-mcp backs every browser with a single default on-disk Chrome profile (`~/.cache/chrome-devtools-mcp/chrome-profile`), so two flow pipelines that both reach this pass under one un-isolated MCP registration contend for it — the second to launch errors with `The browser is already running for ~/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances`. Recovery: register the chrome-devtools MCP with `--isolated` in `~/.claude.json` (each server process gets its own auto-cleaned throwaway profile), or wait for/close the other pipeline browser. The per-call `isolatedContext` above is same-server defense-in-depth — it isolates pages within one MCP server but does NOT resolve this cross-process on-disk-profile lock; `--isolated` is the actual cross-pipeline remedy. On detecting the lock, drive `flow-ui-validate --browser-busy`, which emits a loud-but-clean `ran:false` / `skipped_reason: browser-profile-busy` skip — a busy browser degrades exactly like an absent one (never a hard failure) and verify proceeds green on the rest of the diff.

## 2. Interpret Results

The helper exits 0 if all checks pass, 1 if any fail. Stdout is a single JSON object with
this shape (failed checks only — passing checks omit the `failure` field):

```json
{
  "scopes": ["src", "scripts"],
  "results": [
    {
      "name": "npm run test",
      "scope": "src",
      "passed": false,
      "durationMs": 4321,
      "failure": {
        "firstErrorLine": 42,
        "firstErrorText": "FAIL  src/foo.test.ts > should bar",
        "headExcerpt": "first 100 lines …",
        "tailExcerpt": "last 100 lines …",
        "totalLines": 5000
      }
    }
  ],
  "allPassed": false,
  "changedFiles": ["src/foo.ts"]
}
```

Parse the JSON — `failure.firstErrorText` and `failure.headExcerpt` are the canonical
source of failure context. Do not paste the full raw stderr back into chat; the bounded
excerpt is intentional. If the supervisor needs more than the excerpt for a non-obvious
failure, the user can re-run `flow-pre-commit` (without `--json`) to see the full output
in the terminal — but that detail does not need to flow back through the supervisor's
context.

## 3. Fix Failures

A `ran:true` UI-validate result with `ok:false` (from the optional UI-smoke pass in Step 1) is a verify failure: route it through this same fix loop, treating each failing route's `consoleErrors` / `failedRequests` / `missingSelectors` as the failure context the inline-or-`/flow-coder` decision keys off.

Decide whether to delegate the fix to `/flow-coder` based on the **hybrid
threshold**:

- **Trivially scoped fix** (single-line type/lint error in one file —
  judged from `failure.firstErrorText` plus the top-level `changedFiles`
  field of the `--json` report) edits inline. Log a one-line reason
  ("trivial scope: single-line fix in one file — editing inline").
- **Wider scope** (multi-file failures, fixes that need ≥3 LOC in a
  single file, or any failure where the fix requires reading multiple
  files for context) delegates to `/flow-coder` per outer attempt. Log a
  one-line reason ("wider scope: spawning /flow-coder").

### Inline fix (trivial path)

For each failed check (`results[].passed === false`), use
`failure.firstErrorText` to locate the failing file/test, then read the
relevant source file directly. Fix the issue in the source file.

- **Type errors** (`npm run check`): Resolve type mismatches, missing
  imports, or incorrect generics.
- **Lint errors** (`npm run lint`): Run `npm run format` first, then
  fix remaining issues manually.
- **Test failures** (`npm run test`): Read the failing test, understand
  the assertion, fix the code (not the test) unless the test itself is
  wrong.
- **Go errors** (`go vet`, `go test`): Fix in the relevant `backend/`
  file.

### Spawn procedure (wider-scope path only)

1. Compose the **edit-set** from each failed `results[]` entry of the
   `flow-pre-commit --json` report. One entry per failed check
   (`results[i].passed === false`), each a JSON-shaped object with three
   fields:
   - `file` — repo-relative path of the failing source (resolved from
     `results[i].failure.firstErrorText`).
   - `intent` — 1–2 lines naming the issue (typically
     `results[i].failure.firstErrorText` plus `results[i].name` for the
     check name).
   - `expected_outcome` — 1–2 lines naming the post-fix state
     (typically "the failing check passes" plus `results[i].name`).

2. Invoke `/flow-coder` in-process via the Skill tool, passing the edit-set
   and the worktree path:

   ```
   /flow-coder
   EDIT_SET: [{...}, {...}]
   WORKTREE: <absolute path>
   ```

   `/flow-coder` is itself a thin wrapper that spawns one **Independent
   Edit-Applier Subagent** via the Task tool (the sixth named Task-tool
   exemption — see `skills/pipeline/flow-pipeline/SKILL.md` "Hard
   rules"). The subagent opens each cited file, makes the fix, runs
   `flow-pre-commit --json` against the post-edit worktree, and writes
   the structured artifact at
   `<worktree>/.flow-tmp/coder-result.json`.

3. After `/flow-coder` returns, do a cheap existence check:

   ```bash
   test -s "$WORKTREE/.flow-tmp/coder-result.json" \
     || { echo "NEEDS HUMAN: coder-failed" >&2; exit 1; }
   ```

4. Read the artifact body once and parse `verify_status` — the string
   "did the post-fix verify pass?" signal. The value is the literal
   `"pass"` on success or a head/tail-capped failure excerpt of the
   first failed check on failure (see `bin/lib/coder-schema.ts` for the
   typed contract). If `verify_status === "pass"`, loop back to Step 1
   (re-run pre-commit) to confirm and exit clean. If the value is any
   non-`"pass"` string, treat it as the failure excerpt and re-enter
   Step 3 with the new failure JSON until the outer cap exhausts.

   **Do not retry inside `/flow-verify`'s own wrapper.** Each outer attempt
   spawns at most one `/flow-coder` invocation; multi-call fan-out at a
   single attempt is not authorised. The supervisor's outer cap (3
   attempts) is the only retry mechanism.

## 4. Re-Run Until Clean

- After fixing, re-run the same checks with the same arguments.
- Repeat until all checks pass.
- Do not give up after one round — some fixes reveal new errors.

## 5. Report

Return a compact summary to the caller — at most ≈30 lines per failed check. For each
failed check include: a one-line PASS/FAIL header (`FAIL  npm run test (4.3s) — src`),
the `firstErrorText`, and a short head/tail excerpt. When the helper actually truncated
the output (i.e. `tailExcerpt` is non-empty, which means `totalLines > 200` — the
HEAD_LINES + TAIL_LINES budget set in `bin/flow-pre-commit.ts`), include an explicit
`... [N more lines truncated; total M lines] ...` separator between your head and tail
slices. Do **not** re-emit the raw `failure.headExcerpt` and `tailExcerpt` byte-for-byte —
pick the most informative ~10–15 lines from each.

If changes were made to fix failures, briefly list what was fixed (one bullet per fix,
not a diff).

## 6. Register Local Follow-ups (when applicable)

If a fix added a new helper to `bin/`, a new dependency, or any other change the
user must replicate locally post-merge, register a follow-up:

```bash
flow-followups add \
  --command "flow install --upgrade" \
  --reason "<why this matters post-merge>" \
  --auto    # only when command is in the helper's allowlist
```

`/flow-pipeline` step 11 consumes the JSONL log on terminal end-states. Verify
itself never runs the follow-up — it just registers it. Skip when no local-machine
side-effect is produced.

# Verification

- The pre-commit checks command exits 0
- All scopes relevant to the changes are covered
- The summary returned to the caller does not contain raw uncapped stderr from any
  failed check
- For wider-scope fixes at Step 3: `/flow-coder` was invoked at most once per
  outer attempt; `.flow-tmp/coder-result.json` exists with all five
  top-level keys; the wrapper's transcript contains no per-edit
  `Edit`/`Write` prose for the wider-scope path.
- For trivially scoped fixes at Step 3: no `/flow-coder` invocation; the
  wrapper logged a one-line trivial-scope reason and edited inline.

# Constraints

- NEVER skip a failing check — investigate and fix it.
- NEVER chain checks with `&&` when running manually — the script handles this correctly.
- NEVER modify tests to make them pass unless the test itself is incorrect.
- NEVER paste the full `failure.headExcerpt` + `failure.tailExcerpt` back into chat
  verbatim — pick a representative slice. The cap exists to bound context, not to be a
  ceremonial truncation that still bloats the supervisor.
- NEVER do per-edit `Edit`/`Write` work in the wrapper's context on
  the wider-scope Step 3 path. The `/flow-coder` subagent owns those edits;
  inlining them defeats the migration's whole point.
