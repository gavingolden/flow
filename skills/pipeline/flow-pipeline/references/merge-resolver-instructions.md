# Merge-conflict resolver instructions

These instructions are read by the merge-conflict resolver subagent that
`/flow-pipeline`'s SKILL.md spawns via the Task tool when step 10's
`gh pr merge --squash` returns a conflict-class failure. The subagent runs
in an isolated context — its file reads, per-file resolution rationale,
rebase output, and force-push prose stay inside its own session and are
never returned to the supervisor. The only outputs it produces are the
side effects on the worktree (file edits, the rebased branch, the
force-push) and the structured artifact it writes to disk
(`.flow-tmp/merge-resolver-result.json`), plus a brief one-paragraph
summary it returns on completion.

The wrapper passes you these inputs in its spawn prompt:

- The verbatim stderr from the failed `gh pr merge --squash` call (so you
  can confirm the conflict class the wrapper detected).
- The PR number.
- The base branch name (typically `main`, but read from the wrapper's
  prompt — the supervisor resolved it from `gh pr view`).
- The list of conflicting file paths (from `git status --porcelain` on
  the worktree, post-rebase-attempt — the supervisor may have already
  initiated `git rebase`).
- The absolute worktree path (your working directory).
- The absolute path to `.flow-tmp/plan.md` (so you understand the PR's
  intent when judging conflict semantics).
- The PR description (so you understand the user-facing scope and key
  decisions).
- The absolute path to write the artifact (`ARTIFACT_PATH` —
  `.flow-tmp/merge-resolver-result.json` under the worktree).

Follow the steps below in order.

## 1. Load context

Before touching any conflict, load the inputs:

- Read the wrapper's spawn prompt for the `gh` stderr, PR number, base
  branch, conflicting file list. The stderr fingerprint matters: the
  wrapper detected one of the conflict-class patterns (see step 2's
  Detection patterns table); your own `git rebase` output should match.
  If it does not — e.g. the wrapper saw "Pull Request is not mergeable"
  but your local `git rebase origin/<base>` completes cleanly — the
  divergence is itself a signal (likely required-checks rather than
  textual conflict). Record this in `rejected_strategies` and proceed
  to Step 8 with `force_push_status: skipped`.
- Read `.flow-tmp/plan.md` and the PR description. Skim for the PR's
  intent — what the change is meant to accomplish — so semantic
  conflicts can be resolved against intent rather than textual proximity.
- Read `git log origin/<base>..HEAD --oneline` and
  `git log HEAD..origin/<base> --oneline` to see what each side has
  diverged. Cap each at 50 lines; if either side has more, summarize the
  pattern rather than enumerating.

This is read-only background — these reads stay in your context.

## 2. Verify the rebase state and re-attempt if needed

The wrapper may have initiated `git rebase origin/<base>` before
spawning you, leaving the worktree in mid-rebase state. Run:

```bash
git status --porcelain
git rev-parse --show-toplevel  # confirm you're in the worktree
test -d .git/rebase-merge -o -d .git/rebase-apply && echo "rebase in progress"
```

Two cases:

- **Rebase in progress** (the `.git/rebase-*` dir exists): keep going
  from the current state. Do not run `git rebase --abort` unless
  explicitly recovering from a broken state in step 7.
- **No rebase in progress**: run

  ```bash
  git fetch origin "$BASE_BRANCH"
  git rebase "origin/$BASE_BRANCH"
  ```

  Capture stderr. If the rebase completes without conflicts, the
  wrapper's conflict-detection was a false positive — write
  `force_push_status: skipped`, populate `rejected_strategies` with
  the divergence, and skip to Step 8.

### Detection patterns

The wrapper triggers the resolver when `gh pr merge --squash` stderr
matches any of these fingerprints. If your local rebase output also
matches, you're aligned with what the wrapper saw:

- `Pull Request is not mergeable`
- `not mergeable: the merge commit cannot be cleanly created`
- `merge conflict between`
- `CONFLICT (` (from `git rebase` output — multiple variants:
  `CONFLICT (content)`, `CONFLICT (modify/delete)`, `CONFLICT (rename/rename)`)

If your local rebase produces a stderr that matches NONE of these AND
no `<<<<<<<` markers exist in the worktree, the wrapper's classification
was wrong. Document this in `rejected_strategies` and exit per the
no-conflict path above.

## 3. Resolve each conflicted file

For each path in `git diff --name-only --diff-filter=U`:

1. Open the file. Read enough surrounding context (typically ±20 lines
   around each conflict marker) to understand both sides.
2. Classify the conflict:
   - **Textual** — both sides edit the same lines; the resolution is
     mechanical (interleave, prefer-incoming, prefer-current). No
     semantic judgment needed.
   - **Semantic** — both sides edit logically related code (e.g. one
     side renames a function, the other adds a call site). Resolution
     requires understanding the PR's intent vs `main`'s intent.
   - **Structural** — one side deletes/renames a file the other edits,
     or both sides add the same import / new file. Resolution needs
     reconciliation, not just merge of text.
3. Choose a resolution strategy. Record it. The strategy must be one of:
   - `prefer-incoming` — take `main`'s version verbatim.
   - `prefer-current` — keep this PR's version verbatim.
   - `interleave` — both sides retained, manually combined.
   - `rewrite` — neither side preserved; new code reconciles intent.
   - `delete` — file removed (only valid for `modify/delete` conflicts).
4. Make the `Edit` tool calls to remove conflict markers and apply the
   resolution. Verify no `<<<<<<<`, `=======`, or `>>>>>>>` markers
   remain in the file.
5. Run `git add <path>`.
6. Record an entry in `resolved_files`:
   - `path` — repo-relative.
   - `strategy` — one of the values above.
   - `semantic_decision` — one line: what the conflict was, what
     intent each side carried, why this strategy was chosen.

### When resolution is ambiguous

If choosing between strategies requires user judgment — e.g. both sides
made independently valid semantic decisions, neither obviously dominates,
and the PR's intent doesn't clearly favour one — pick the **safer**
default and record the call in `ambiguous_resolutions`:

- `prefer-incoming` (taking `main`) is generally safer than
  `prefer-current` because it minimizes this PR's deviation from the
  base, leaving any coherence cost for a follow-up PR rather than
  shipping a maybe-wrong reconciliation.
- For `interleave` vs `rewrite`, prefer `interleave` — preserves both
  authors' intent without inventing a third reading.

Record:

- `path` + `line_range` (e.g. `src/foo.ts:42-58`).
- `judgment_call` — one line describing the call you made.
- `alternatives_considered` — one or more alternative strategies you
  evaluated, each with a one-line "why rejected".

These entries surface back to the supervisor through the `summary`
return value: step 8's both-sides return contract requires you to name
the top `ambiguous_resolutions` (or `rejected_strategies`) entry in the
summary's negative half, and the wrapper appends the summary's first
sentence to the `NEEDS HUMAN: merge-failed` escalation reason on retry
failure. The artifact's `ambiguous_resolutions` array itself is durable
on disk for human inspection but is **not** read by the supervisor on a
successful retry; populate it for the on-disk audit trail and let the
summary carry the escalation signal.

### When resolution is impossible

If a file genuinely cannot be resolved (the conflict requires a design
decision no defensible default exists for, e.g. two incompatible
schemas), do **not** invent a fix:

- Do not `git add` the file.
- Record it in `ambiguous_resolutions` with `judgment_call: "no
  defensible default — escalation required"` and the strategies you
  considered + why each was rejected in `alternatives_considered`.
- Skip the rebase-continue in step 4. Set `force_push_status: skipped`
  in step 6. Write the artifact in step 7.
- Return a summary that names the blocker. The supervisor will retry
  `gh pr merge`, it will fail again, and `NEEDS HUMAN: merge-failed`
  fires with your blocker text.

## 4. Continue the rebase

After every conflicted file is either `git add`'d or recorded as
unresolvable, run:

```bash
git rebase --continue
```

If `git rebase` advances to another commit with conflicts, return to
Step 3 and resolve those. Loop until either `git rebase --continue`
completes (rebase done) or `git status` shows further conflicts to
address.

If the rebase produces a commit-message editor prompt, you are running
a non-`-i` rebase that hit a `git commit --amend`-equivalent pause —
keep the commit message unchanged (close the editor without edits).
Standard `--continue` flow.

## 5. Verify the resolution

Before pushing, confirm the resolution is structurally sound:

```bash
git status --porcelain                       # expect empty
git log origin/$BASE_BRANCH..HEAD --oneline  # expect this PR's commits, rebased
test -z "$(git diff --check)"                # no leftover conflict markers anywhere
```

If `git status` shows uncommitted changes or `git diff --check` flags
leftover markers, you missed something. Return to Step 3 for the
flagged file. Do not force-push with leftover markers.

## 6. Force-push

The resolver is authorised to force-push the per-pipeline branch via
the `Auto-push exemption` umbrella that `/flow-pipeline` invocation
already establishes. **Force-push is scoped to the per-pipeline branch
only — never to `main`, `master`, or the base branch.** The
per-pipeline branch was set when `flow-new-worktree` ran in step 2
and is the current branch in your worktree.

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
test "$CURRENT_BRANCH" != "$BASE_BRANCH" || {
  echo "REFUSING: current branch is the base branch"
  exit 1
}
git push --force-with-lease origin "$CURRENT_BRANCH"
```

`--force-with-lease` (not `--force`) is required: it refuses the push
if the remote has advanced beyond your local view, preventing the
"another supervisor pushed in parallel" race.

Record the outcome in `force_push_status`:

- `succeeded` — push exited 0.
- `failed` — push returned non-zero. Capture the verbatim stderr in
  `summary`. Do not retry; the wrapper decides escalation.
- `skipped` — you did not force-push (no-conflict false positive,
  unresolvable conflict, etc.).

## 7. Write the structured artifact

Write the artifact at the absolute path the wrapper passed you (the
parent directory `.flow-tmp/` already exists — the wrapper created it).
Overwrite any prior artifact; do not append.

The artifact MUST conform to this JSON schema:

```json
{
  "resolved_files": [
    {
      "path": "<repo-relative path>",
      "strategy": "prefer-incoming" | "prefer-current" | "interleave" | "rewrite" | "delete",
      "semantic_decision": "<one line: what the conflict was, what each side intended, why this strategy was chosen>"
    }
  ],
  "ambiguous_resolutions": [
    {
      "path": "<repo-relative path>",
      "line_range": "<file:start-end, or empty string when the ambiguity is whole-file>",
      "judgment_call": "<one line: what call was made and why>",
      "alternatives_considered": [
        {
          "strategy": "<one of the strategy values, or a free-text alternative>",
          "why_rejected": "<one line>"
        }
      ]
    }
  ],
  "rejected_strategies": [
    {
      "path": "<repo-relative path>",
      "strategy": "<the strategy that was tried and rolled back>",
      "why_rejected": "<one line>"
    }
  ],
  "commits": [
    {
      "sha": "<7-char hex of the rebased commit>",
      "message": "<the commit's subject line>"
    }
  ],
  "force_push_status": "succeeded" | "failed" | "skipped",
  "summary": "<3–5 sentence both-sides return summary; see step 8>"
}
```

**Negative-findings slots are required.** `ambiguous_resolutions` and
`rejected_strategies` are not optional decorations — they are where you
record what was uncertain and what was tried and rolled back. Populate
them proactively as you work, and surface their entries in the return
summary.

An empty array is permitted only when you genuinely encountered no
ambiguity (every conflict had a clearly dominant strategy) or no
rejected attempts (you got each resolution right on first attempt).
**Silence is not the default.** If you weighed two strategies for any
single file, populate `ambiguous_resolutions` with the call. If you
tried a strategy and rolled it back, populate `rejected_strategies`.

If the artifact is missing keys or fails to parse, the wrapper surfaces
the failure to the supervisor (`NEEDS HUMAN: merge-resolver-missing-artifact`).
Validate your JSON before exiting.

## 8. Return a brief summary

Your final message back to the wrapper should be one short paragraph
(3–5 sentences max) that surfaces **both sides** of what you resolved:

- At least one positive: how many files were resolved, the dominant
  strategy, the force-push outcome.
- At least one negative: the top entry from `ambiguous_resolutions` or
  `rejected_strategies` — what call required judgment, what strategy
  was tried and rolled back. A summary that names only successes fails
  the contract.

Do not paste the artifact JSON, file diffs, or rebase output back —
the wrapper only forwards your summary, and the artifact on disk is
the durable record. Keeping the return value short is the whole point
of the subagent fan-out.

# Troubleshooting

| Problem | Symptom | Fix |
|---|---|---|
| Rebase produces no conflicts | `git rebase origin/<base>` exits 0 with no conflicts; wrapper's classification was a false positive | Skip to Step 8. Record the divergence in `rejected_strategies` (one entry: `path: "(none)"`, `strategy: "(no-op)"`, `why_rejected: "wrapper saw <X> stderr but local rebase clean"`). Set `force_push_status: skipped`. |
| Rebase aborts mid-flight | `git rebase --continue` errors out for non-conflict reason (e.g. invalid commit) | Run `git rebase --abort` to return to pre-rebase state. Record the failure in `summary`; set `force_push_status: skipped`. The supervisor's retry will fail and escalate. |
| Conflict marker survives the Edit | `git diff --check` flags `<<<<<<<` after your edit | Re-open the file, expand the `Edit` `old_string` to include the full marker triple, retry. The Edit tool requires unique `old_string`; conflict markers within similar files can collide. |
| Force-push refused (lease) | `git push --force-with-lease` exits non-zero with "stale info" | The remote advanced — another process pushed. Do not retry blindly. Record the verbatim error in `summary`; set `force_push_status: failed`. Let the wrapper decide. |
| `modify/delete` conflict | One side deleted the file, the other modified it | Choose `delete` (accept the deletion) or `prefer-current` (keep the modified file, undo the deletion). Record the call in `ambiguous_resolutions` if the PR's intent doesn't clearly favour one. |
| Both sides rename the same file | `rename/rename` conflict | Choose one of the two new names by reading both sides' usages. Record in `ambiguous_resolutions` with the alternative name in `alternatives_considered`. |
| Lockfile conflict | `package-lock.json` / `bun.lock` / `yarn.lock` conflicts | Use `prefer-incoming` (take `main`'s lockfile), then re-run the dependency installer (`npm install` / `bun install`) and `git add` the regenerated lockfile. Record `strategy: prefer-incoming` and note "regenerated via package manager" in `semantic_decision`. |

# Verification

Before writing the artifact and returning, self-check:

- Every entry in `git diff --name-only --diff-filter=U` (at the start
  of step 3) is accounted for in `resolved_files` (resolved) or
  `ambiguous_resolutions` (left unresolved). No file is silently
  dropped.
- Every `resolved_files` entry has a non-empty `path`, `strategy`
  (one of the five enum values), and `semantic_decision`.
- Every `commits` entry has a 7-character SHA and a message.
- `force_push_status` is exactly one of `succeeded` / `failed` /
  `skipped`.
- `ambiguous_resolutions` and `rejected_strategies` reflect what you
  actually weighed; empty arrays only when you genuinely had no
  ambiguity / no rolled-back attempts.
- The artifact JSON parses (no trailing commas, no unescaped strings).
- The return summary is 3–5 sentences and surfaces both positive and
  negative findings.
- No `<<<<<<<`, `=======`, or `>>>>>>>` markers remain in any tracked
  file (`git diff --check` exits 0).

# Constraints

- NEVER force-push the base branch (`main`, `master`, or whatever the
  PR targets). The branch-name guard in Step 6 is mandatory.
- NEVER call `gh pr merge` yourself. The wrapper retries the merge
  after you return.
- NEVER spawn another resolver via the Task tool. Exactly one resolver
  per `/flow-pipeline` run.
- NEVER ask the user clarifying questions — the Task tool is one-shot.
  When ambiguity blocks a resolution, record it in
  `ambiguous_resolutions` and let the supervisor decide.
- NEVER write to `/tmp/` or to the worktree root for scratch — every
  transient file lives under `<worktree>/.flow-tmp/<name>`. Same
  isolation rule as the other subagent contracts.
- NEVER `git rebase --abort` once you've started resolving — partial
  resolutions are still useful state. Abort only on the explicit
  troubleshooting case above.
- NEVER run `/verify` or `flow-pre-commit` from inside the resolver.
  Verification of the rebased branch is the supervisor's job — the
  retried `gh pr merge --squash` is the verification, and CI re-runs
  on the force-pushed head. Re-running `/verify` here would defeat
  the context-cost win the fan-out exists for.
- NEVER amend a commit on the rebased branch. The rebase produces new
  commits (different SHAs from the original); that's the expected
  behavior. Don't try to preserve original SHAs.
- NEVER leave the artifact unwritten. On any failure path — including
  unresolvable conflicts, a refused force-push, or an unrecoverable
  rebase state — write the artifact with whatever partial state you
  have. The wrapper's missing-artifact escalation is reserved for
  catastrophic crashes; controlled failures must record themselves.
