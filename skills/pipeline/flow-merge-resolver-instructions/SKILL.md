---
name: flow-merge-resolver-instructions
description: Preloaded instructions for the flow-merge-resolver subagent; not for direct invocation.
---
<!-- flow-instructions-sentinel: flow-merge-resolver-instructions -->
# Merge-conflict resolver instructions

These instructions are read by the merge-conflict resolver subagent that
`/flow-pipeline`'s SKILL.md spawns via the Task tool when step 10's
`gh pr merge --squash` returns a conflict-class failure. The subagent runs
in an isolated context — its file reads, per-file resolution rationale,
merge output, and the push prose stay inside its own session and are
never returned to the supervisor. The only outputs it produces are the
side effects on the worktree (file edits, the merged branch, the
push) and the structured artifact it writes to disk
(`.flow-tmp/merge-resolver-result.json`), plus a brief one-paragraph
summary it returns on completion.

The wrapper passes you these inputs in its spawn prompt:

- The verbatim stderr from the failed `gh pr merge --squash` call (so you
  can confirm the conflict class the wrapper detected).
- The PR number.
- The base branch name (typically `main`, but read from the wrapper's
  prompt — the supervisor resolved it from `gh pr view`).
- The list of conflicting file paths (from `git status --porcelain` on
  the worktree, post-merge-attempt — the supervisor may have already
  initiated `git merge`).
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
  Detection patterns table); your own `git merge` output should match.
  If it does not — e.g. the wrapper saw "Pull Request is not mergeable"
  but your local `git merge origin/<base>` completes cleanly — the
  divergence is itself a signal (likely required-checks rather than
  textual conflict). Record this in `rejected_strategies` and proceed
  to Step 8 with `push_status: skipped`.
- Read `.flow-tmp/plan.md` and the PR description. Skim for the PR's
  intent — what the change is meant to accomplish — so semantic
  conflicts can be resolved against intent rather than textual proximity.
- Read `git log origin/<base>..HEAD --oneline` and
  `git log HEAD..origin/<base> --oneline` to see what each side has
  diverged. Cap each at 50 lines; if either side has more, summarize the
  pattern rather than enumerating.

This is read-only background — these reads stay in your context.

## 2. Verify the merge state and re-attempt if needed

The wrapper may have initiated `git merge origin/<base>` before
spawning you, leaving the worktree in mid-merge state. Run:

```bash
git status --porcelain
git rev-parse --show-toplevel  # confirm you're in the worktree
test -f "$(git rev-parse --git-path MERGE_HEAD)" && echo "merge in progress"
```

The `MERGE_HEAD` probe (not a `.git/rebase-*` directory check) is
required because in a flow worktree `.git` is a FILE pointing at
`.git/worktrees/<name>/`, not a directory. `git rev-parse --git-path
MERGE_HEAD` resolves into that per-worktree gitdir correctly; a
hardcoded `test -d .git/rebase-merge` would never fire in a worktree.

Two cases:

- **Merge in progress** (`MERGE_HEAD` exists): keep going from the
  current state. Do not run `git merge --abort` unless explicitly
  recovering from a broken state — see the Troubleshooting table below.
- **No merge in progress**: run

  ```bash
  git fetch origin "$BASE_BRANCH"
  git merge --no-edit "origin/$BASE_BRANCH"
  ```

  Capture stderr. If the merge completes without conflicts, the
  wrapper's conflict-detection was a false positive — write
  `push_status: skipped`, populate `rejected_strategies` with
  the divergence, and skip to Step 8.

### Detection patterns

The wrapper triggers the resolver when `gh pr merge --squash` stderr
matches any of these fingerprints. If your local merge output also
matches, you're aligned with what the wrapper saw:

- `Pull Request is not mergeable`
- `not mergeable: the merge commit cannot be cleanly created`
- `merge conflict between`
- `CONFLICT (` (from `git merge` output — multiple variants:
  `CONFLICT (content)`, `CONFLICT (modify/delete)`, `CONFLICT (rename/rename)`)

If your local merge produces a stderr that matches NONE of these AND
no `<<<<<<<` markers exist in the worktree, the wrapper's classification
was wrong. Document this in `rejected_strategies` and exit per the
no-conflict path above.

## 3. Resolve each conflicted file

### Conflict-marker orientation (merge, not rebase)

Under `git merge origin/<base>` run FROM the pipeline branch,
`<<<<<<< HEAD` / `ours` is **THIS PR's version** and
`>>>>>>> origin/<base>` / `theirs` is **THE BASE's version** — the exact
INVERSE of a rebase, where the replayed commit is `theirs`. So
`prefer-current` takes the `HEAD` side and `prefer-incoming` takes the
`origin/<base>` side; `git checkout --ours` / `--theirs` mean the
OPPOSITE of what rebase habits suggest. The five strategy names below
are intent-named and unchanged by this — and under a merge,
`prefer-incoming` becomes literally accurate, since the base really is
the incoming branch.

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
   resolution.
5. **LAYER 1.** Before `git add`, run
   `git diff --check -- <path> | grep -q 'leftover conflict marker'` and
   branch on THAT pipeline's exit status — never the raw exit code
   directly, since a whitespace-only edit (common after an `interleave`
   resolution) also exits non-zero via a `trailing whitespace.` line and
   would spuriously loop step 4. Exit 0 means a leftover marker was
   found: re-open the file and repeat step 4. Exit 1 means no marker:
   proceed to `git add`. This is the only layer that catches a partial
   edit (e.g. a lone `=======` left mid-file) — it runs before the
   resolution is committed, unlike Step 5's Layer 2 below.
6. Run `git add <path>`.
7. Record an entry in `resolved_files`:
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
- Skip the merge-commit step in step 4. Set `push_status: skipped`
  in step 6. Write the artifact in step 7.
- Return a summary that names the blocker. The supervisor will retry
  `gh pr merge`, it will fail again, and `NEEDS HUMAN: merge-failed`
  fires with your blocker text.

## 4. Complete the merge

After every conflicted file is either `git add`'d or recorded as
unresolvable, run:

```bash
git commit --no-verify -m "chore: merge origin/<base> into <branch> to resolve conflicts"
```

using the actual base and branch names in place of the placeholders.
`--no-verify` matters here: unlike `git rebase --continue` (which
bypasses `pre-commit`/`commit-msg` hooks entirely), a plain `git commit`
runs them, so a consumer repo's husky/lefthook `pre-commit` hook could
abort this resolution commit for a reason wholly unrelated to the
conflict and route the resolver into `git merge --abort`, discarding
all resolution work. The session-id `prepare-commit-msg` hook still
fires under `--no-verify` (only `pre-commit` and `commit-msg` are
skipped). This is consistent with the Constraints section's ban on
running `flow-pre-commit` from inside the resolver — verification of
the merged branch is the supervisor's job, not this commit's. A
conventional-commit subject here matters downstream: GitHub's default
squash body concatenates commit subjects, so keeping this subject
conventional-commit shaped keeps the shipped squash body
conventional-commit shaped too. Whether this specific `chore: merge
...` subject actually surfaces as a bullet in a LATER PR's squash body
is UNDETERMINED — see `references/git-workflow.md`'s "Why no authored
squash body (issue #486)" for the recorded decision and its re-open
trigger.

A merge is a single conflict pass — there is no "advances to another
commit with conflicts" loop and no `-i`-rebase commit-message editor to
navigate. Once `git commit` succeeds, move on to Step 5.

## 5. Verify the resolution

Before pushing, confirm the resolution is structurally sound:

```bash
git status --porcelain                       # expect empty
git log origin/$BASE_BRANCH..HEAD --oneline  # expect this PR's commits plus the merge commit
MARKER_RC=0
$MARKER_CHECK_CMD --committed || MARKER_RC=$?  # LAYER 2 — see below. Wrapper-supplied; see next paragraph.
```

**Why this reads the committed tree.** After Step 4's `git commit`, the
worktree, the index, and `HEAD` are identical — a worktree-vs-index
check (`git status --porcelain`, or the same per-file check Step 3 ran,
with no `HEAD` argument) is INERT here: it has nothing left to diff and
reports clean regardless of what the committed content actually
contains (see AGENTS.md "Don't gate a post-commit verification on a
worktree-vs-index diff"). `$MARKER_CHECK_CMD --committed` instead
inspects the committed tree directly (`HEAD`, plus the merge's touched
files), so it actually reflects what was just committed. This is
**LAYER 2** — Step 3's per-file check is Layer 1, the only layer that
catches a partial edit (a lone `=======` left mid-file) before it's
committed. Layer 2 deliberately narrows to `<<<<<<<`/`>>>>>>>` only —
`=======` is legitimate content elsewhere (e.g. markdown setext
headings), and Layer 1 already covers the leftover-`=======` case
pre-commit.

**Act on `$MARKER_RC`.**

| `$MARKER_RC`  | Meaning                                                           | Action                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`           | clean — no blocking markers in the committed tree                 | Proceed to Step 6. Record any `PRE-EXISTING` lines from the command's output in `rejected_strategies` — they predate this merge and are not yours to fix. |
| `1`           | a leftover marker in a file this merge touched                    | Return to Step 3 for the flagged file(s).                                                                                                                 |
| `2`           | the helper itself errored (missing flow checkout, bad invocation) | Set `push_status: skipped`; record the verbatim error in `summary`.                                                                                       |
| anything else | never read as clean                                               | Treat identically to `2` — set `push_status: skipped` and escalate.                                                                                       |

**Why the wrapper passes the command, and why there is no PATH
fallback.** `$MARKER_CHECK_CMD` is resolved once in the wrapper's
spawn prompt as `bun $FLOW_ROOT/bin/flow-conflict-marker-check.ts` —
against flow's own SOURCE TREE, not a `~/.local/bin` PATH symlink. A
PATH symlink can lag behind source by an entire `flow install` cycle, and
flow's directory-vs-per-file install modes make that skew
unpredictable — invoking from source removes the window entirely. If
`$MARKER_CHECK_CMD` fails to resolve at all (an ENOENT, or the derived
`$FLOW_ROOT` doesn't contain a flow checkout), that is BROKEN, not
stale: do not retry, do not hand-roll an inline reimplementation of the
scan, and do not substitute a bare PATH name or add a PATH-existence
probe — treat it as the `2` row above and escalate. The helper also
strips the `HEAD:` rev-prefix from its own scan output internally
before matching paths against the touched-file list; a prose
reimplementation of that parse was tried and rejected during planning
(`HEAD:<path>:<line>:<text>` does not string-match bare `<path>`
output, so a prose intersection dismisses every real hit as
pre-existing) — the partition must stay code, inside the helper.

If `git status` shows uncommitted changes, or `$MARKER_RC` is anything
other than `0` (see the table above — no value other than `0` is ever
read as clean), you missed something. Return to Step 3 for the flagged
file. Do not push with leftover markers.

## 6. Push

The resolver is authorised to push the per-pipeline branch via
the `Auto-push exemption` umbrella that `/flow-pipeline` invocation
already establishes. **The push is scoped to the per-pipeline branch
only — never to `main`, `master`, or the base branch.** The
per-pipeline branch was set when `flow-new-worktree` ran in step 2
and is the current branch in your worktree.

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
test "$CURRENT_BRANCH" != "$BASE_BRANCH" || {
  echo "REFUSING: current branch is the base branch"
  exit 1
}
git push origin "$CURRENT_BRANCH"
```

A plain push is refused non-fast-forward if the remote advanced,
giving the same parallel-supervisor race protection as a leased,
forced push would, without delegating an irreversible operation to a
subagent spawn.

Record the outcome in `push_status`:

- `succeeded` — push exited 0.
- `failed` — push returned non-zero. Capture the verbatim stderr in
  `summary`. Do not retry; the wrapper decides escalation.
- `skipped` — you did not push (no-conflict false positive,
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
      "sha": "<7-char hex of the merge commit (and any commit created during resolution)>",
      "message": "<the commit's subject line>"
    }
  ],
  "push_status": "succeeded" | "failed" | "skipped",
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
  strategy, the push outcome.
- At least one negative: the top entry from `ambiguous_resolutions` or
  `rejected_strategies` — what call required judgment, what strategy
  was tried and rolled back. A summary that names only successes fails
  the contract.

Do not paste the artifact JSON, file diffs, or merge output back —
the wrapper only forwards your summary, and the artifact on disk is
the durable record. Keeping the return value short is the whole point
of the subagent fan-out.

# Troubleshooting

| Problem                           | Symptom                                                                                                              | Fix                                                                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Merge produces no conflicts       | `git merge origin/<base>` exits 0 with no conflicts; wrapper's classification was a false positive                   | Skip to Step 8. Record the divergence in `rejected_strategies` (one entry: `path: "(none)"`, `strategy: "(no-op)"`, `why_rejected: "wrapper saw <X> stderr but local merge clean"`). Set `push_status: skipped`.                                                   |
| Merge aborts mid-flight           | Committing the resolution errors out for a non-conflict reason (e.g. invalid commit)                                 | Run `git merge --abort` to return to pre-merge state. Record the failure in `summary`; set `push_status: skipped`. The supervisor's retry will fail and escalate.                                                                                                  |
| Conflict marker survives the Edit | `git diff --check` flags `<<<<<<<` after your edit (valid here — this fires during Step 3, BEFORE the Step 4 commit) | Re-open the file, expand the `Edit` `old_string` to include the full marker triple, retry. The Edit tool requires unique `old_string`; conflict markers within similar files can collide.                                                                          |
| Push rejected (non-fast-forward)  | `git push` exits non-zero with `! [rejected] ... (fetch first)`                                                      | The remote advanced — another process pushed. Record `push_status: failed` with the verbatim stderr in `summary`. Do not retry blindly. NEVER escalate to `--force`; let the wrapper decide.                                                                       |
| `modify/delete` conflict          | One side deleted the file, the other modified it                                                                     | Choose `delete` (accept the deletion) or `prefer-current` (keep the modified file, undo the deletion). Record the call in `ambiguous_resolutions` if the PR's intent doesn't clearly favour one.                                                                   |
| Both sides rename the same file   | `rename/rename` conflict                                                                                             | Choose one of the two new names by reading both sides' usages. Record in `ambiguous_resolutions` with the alternative name in `alternatives_considered`.                                                                                                           |
| Lockfile conflict                 | `package-lock.json` / `bun.lock` / `yarn.lock` conflicts                                                             | Use `prefer-incoming` (take `main`'s lockfile), then re-run the dependency installer (`npm install` / `bun install`) and `git add` the regenerated lockfile. Record `strategy: prefer-incoming` and note "regenerated via package manager" in `semantic_decision`. |
| Marker check will not run         | `$MARKER_CHECK_CMD --committed` exits 2, or the command itself is missing/ENOENT                                     | Treat as the `2` row in the Act-on-`$MARKER_RC` table above — set `push_status: skipped`, record the verbatim error in `summary`. Do NOT substitute a bare PATH name, add a `command -v` probe, or hand-roll an inline `git grep` fallback.                        |

# Verification

Before writing the artifact and returning, self-check:

- Every entry in `git diff --name-only --diff-filter=U` (at the start
  of step 3) is accounted for in `resolved_files` (resolved) or
  `ambiguous_resolutions` (left unresolved). No file is silently
  dropped.
- Every `resolved_files` entry has a non-empty `path`, `strategy`
  (one of the five enum values), and `semantic_decision`.
- Every `commits` entry has a 7-character SHA and a message.
- `push_status` is exactly one of `succeeded` / `failed` /
  `skipped`.
- `ambiguous_resolutions` and `rejected_strategies` reflect what you
  actually weighed; empty arrays only when you genuinely had no
  ambiguity / no rolled-back attempts.
- The artifact JSON parses (no trailing commas, no unescaped strings).
- The return summary is 3–5 sentences and surfaces both positive and
  negative findings.
- No `<<<<<<<`, `=======`, or `>>>>>>>` markers remain in any tracked
  file (`$MARKER_CHECK_CMD --committed` exited 0).

# Constraints

- NEVER push to the base branch (`main`, `master`, or whatever the
  PR targets); the branch-name guard in Step 6 is mandatory.
- NEVER use `git push --force` or `--force-with-lease` — a rejected
  push is recorded as `push_status: failed`, never forced.
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
- NEVER `git merge --abort` once you've started resolving — partial
  resolutions are still useful state. Abort only on the explicit
  troubleshooting case above.
- NEVER run `/flow-verify` or `flow-pre-commit` from inside the resolver.
  Verification of the merged branch is the supervisor's job — the
  retried `gh pr merge --squash` is the verification, and CI re-runs
  on the pushed head. Re-running `/flow-verify` here would defeat
  the context-cost win the fan-out exists for. This is also why Step
  4's resolution commit uses `--no-verify` — see the rationale there.
  A narrow, named exception carves out `$MARKER_CHECK_CMD --committed`
  (Step 5's Layer 2 check) from this ban: it is not `flow-pre-commit`
  and not `/flow-verify`, so running it is permitted — and Step 5 in
  fact REQUIRES it, gating the push on its result, not merely allowing
  it.
- NEVER rewrite history on the branch — the merge preserves every
  original commit SHA and appends one merge commit; do not rebase,
  amend, or squash.
- NEVER leave the artifact unwritten. On any failure path — including
  unresolvable conflicts, a rejected push, or an unrecoverable
  merge state — write the artifact with whatever partial state you
  have. The wrapper's missing-artifact escalation is reserved for
  catastrophic crashes; controlled failures must record themselves.
