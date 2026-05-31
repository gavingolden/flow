# Polling protocol

How the supervisor waits for CI and the bot reviewer (Copilot) to
finish on an open PR. This is a sleep + poll loop run as Bash tool
calls inside one conversation turn.

## Goals

1. Detect "CI is terminal AND a bot review has posted" so step 8
   (review) can run.
2. Detect "CI is terminal but no bot review will arrive" so the
   pipeline doesn't block forever on a Copilot timeout.
3. Detect "CI failed" so step 7 can loop back to implement(fix)
   without waiting the full cap.
4. Cap total wait time so a hung CI doesn't burn unbounded context.

## Cadence

### Cadence schedule

The supervisor's sleep between polls follows a three-tier ramp,
capped by the 20-min wall-clock budget below:

| Poll number | Sleep before next poll |
|---|---|
| 1–5 | 30s |
| 6–10 | 60s |
| 11+ | 90s |

`gh pr checks` JSON is small and GitHub rate limits are generous
even at the 30s baseline; the ramp's purpose is to bound supervisor-
session token cost as the wait stretches, not to ease load on
GitHub. The ramp was activated in Item 19 (the response to Item 6
cost reporting) — before that, the loop slept 30s on every
iteration regardless of `POLLS`.

**Unconditional on the first iteration** — empty `gh` results never
short-circuit the wait when presence is affirmed; only the presence
checks below can legitimately skip. This is orthogonal to the ramp:
the ramp governs *how long* to wait, the presence checks govern
*whether* to wait at all.

## Hard cap

**20 minutes from the first poll.** If neither CI nor a bot review
has reached a terminal state by then, escalate `NEEDS HUMAN: ci-hang
<url>` and end. The PR + worktree are preserved.

## Per-poll counter

Each iteration prints exactly one summary line on **stderr** so the
user reading scrollback (or attaching mid-wait) can see progress at a
glance — and so the final JSON verdict on stdout stays cleanly
capturable via `RESULT=$(flow-ci-wait "$PR")`:

```
CI poll <N>, elapsed <X>m<Y>s of 20m, cadence <C>s
```

`N` starts at 1 and increments each iteration. `<X>m<Y>s` is
wall-clock elapsed since the first poll began. `<C>` is the current
ramp tier — `30` for polls 1–5, `60` for polls 6–10, `90` from poll
11 onward. The line is rendered before the gh calls fire — if the
calls fail or hang, the user still sees the iteration started.

The line has no fixed `/N` denominator: with the ramp, the
worst-case poll count is ~20 — the 19th poll fires at elapsed ≈
1170s (`5×30 + 5×60 + 8×90`) and the 20th is the iteration whose
start-of-loop cap check (`ELAPSED >= 1200`) finally trips, versus
40 under the pre-ramp 30s-fixed cadence. Printing a hard-coded
`/40` would be misleading. The 20-min budget is still printed as
`elapsed Xm Ys of 20m`.

### Per-poll `requested_reviewers` in-progress signal

When Copilot is configured, each poll also re-reads `requested_reviewers`
(`gh pr view <n> --json reviewRequests`) rather than caching the
loop-entry value — GitHub auto-removes Copilot from the list once it
posts its review, so membership genuinely changes across polls. The read
feeds a `copilotRequestedThisPoll` flag that distinguishes a healthy
in-progress wait from a dead one. When CI is terminal and no Copilot
review has posted yet, the loop emits one of two stderr variants:

- `Copilot queued, still waiting` — the configured login is present in
  this poll's `requested_reviewers` (queued; the review is expected).
- `no Copilot review yet` — the login is absent (none queued this poll).

This is observability only: `copilotRequestedThisPoll` informs the
stderr line, not the pure decision matrix (`decideOnPoll` does not
branch on it). The same per-poll read is reused by the post-POST
verification when a retrigger fires on that iteration (see "Retrigger on
stale review").

## Presence checks

The first poll on a freshly-opened PR may legitimately return empty
results because nothing has been posted yet. To distinguish "not
posted yet" (keep polling) from "not configured" (legitimately skip
the wait), the supervisor runs two one-shot presence checks **once at
loop entry**, before the first poll:

### CI workflows

The supervisor parses each `.github/workflows/*.{yml,yaml}` file's
top-level `on:` block and only sets `CI_CONFIGURED=1` when at least one
workflow lists `pull_request`, `pull_request_target`, or `merge_group`
among its triggers. Workflows with only `schedule:`, `push:`,
`workflow_dispatch:`, or `workflow_call:` triggers are correctly
ignored — they don't run on the in-flight PR, so waiting for their
checks would be pointless. PR #152 is the historical incident:
`cloudflare-pages-prune.yml` was a schedule-only workflow that caused
`flow-ci-wait` to wait the full 20-minute cap before deciding
`ci-hang` because the old presence check counted any `.yml` file in
the directory.

The check is still filesystem-only — no API call. The answer is
deterministic from disk given the worktree, and short-circuits on the
first qualifying file.

### Copilot reviewer

```bash
gh pr view "$PR" --json reviewRequests \
  --jq '[.reviewRequests[].login] | map(ascii_downcase) | join(",")'
```

If the configured Copilot login (`copilot-pull-request-reviewer` by
default — see "Bot reviewer name" below) appears in the list,
`COPILOT_REQUESTED=1`. Otherwise `COPILOT_REQUESTED=0`; the supervisor
treats `copilot_posted` as vacuously true and never waits the 10-min
bot timeout.

The fetched list is normalized to lowercase via `ascii_downcase`. The
configured login on the local side **must also be lowercased** before
matching (the `case` example in `SKILL.md` uses
`tr '[:upper:]' '[:lower:]'` to do this). Lowercasing both sides is
how the "case-insensitive exact match" promised under "Bot reviewer
name" is mechanically enforced; matching a normalized list against an
un-normalized constant only happens to work when the constant is
already lowercase, and breaks the moment the constant is replaced
with a value pulled from `~/.flow/config.json` that may carry mixed
case.

#### Historical-PR fallback

`reviewRequests` is the right signal when Copilot is explicitly added as
a reviewer, but it misses the most common production configuration:
Copilot enabled at the org / repo level to **auto-review every PR**
without ever populating `reviewRequests`. This is the failure observed
on PR #78 / 2026-05-03 — the supervisor saw `COPILOT_REQUESTED=0`,
proceeded straight through review, and merged before Copilot's review
posted ~30s later. When `reviewRequests` does not include the configured
login, `flow-ci-wait` falls back to scanning the last 5 merged PRs on
the current repo (`gh pr list --state merged --limit 5 --json number`,
then per-PR `gh pr view --json reviews`); a single match by the
configured login on any of those PRs flips `COPILOT_REQUESTED=1` and
the normal 10-min timeout applies. If both signals are negative (no
explicit request and no historical reviews) the `COPILOT_REQUESTED=0`
override above still applies — repos where Copilot has never reviewed
keep the existing single-poll-exit behaviour. Errors and malformed JSON
in the fallback collapse to negative; a transient `gh` hiccup must not
synthesise false confidence that the bot will review this PR.

The fallback is deliberately a heuristic, not a proof of auto-review
configuration. A user who once **manually** requested a Copilot review on a
single past PR will look identical to an org-level auto-review setup, so
subsequent PRs in that repo will wait the 10-min Copilot timeout even
though Copilot is not actually configured to auto-review them. This
asymmetry is intentional: the worst case of a false positive is a 10-min
wait that the existing timeout already caps; the worst case of a false
negative is the PR #78 incident — merging before the bot review posts.
The fallback prefers the cheaper failure mode.

#### Retrigger on stale review (one-shot)

The historical-PR fallback above answers "is Copilot expected on this
PR at all?". A second failure mode lives one layer deeper: Copilot is
expected and has already reviewed the PR once, but a subsequent fix
commit advances `headRefOid` past the SHA Copilot reviewed against,
and the original review is stale. GitHub auto-removes Copilot from
`requested_reviewers` after its first review and Copilot does **not**
auto-re-review on subsequent pushes — so the supervisor sees a posted
Copilot review and short-circuits to step 8 even though the bot has
not looked at the fix.

The staleness predicate is exact-SHA mismatch between the **latest**
Copilot review's `commit.oid` (most recent in submission order, via
the per-poll `gh pr view --json reviews,state,headRefOid` projection
above) and the PR's current `headRefOid` from the same projection. A
review with `commit.oid === headRefOid` is fresh and the existing
"Copilot posted" exit fires unchanged.

When the predicate is true AND CI has reached terminal AND the
one-shot retrigger budget for this `flow-ci-wait` invocation is
unused, the helper fires the re-request POST:

```bash
gh api -X POST repos/{owner}/{repo}/pulls/{n}/requested_reviewers \
  -f reviewers[]=<configured-copilot-login>
```

The configured login is the same value read from
`~/.flow/config.json` `bots.copilot` (default
`copilot-pull-request-reviewer`) used for detection elsewhere in this
section. The `{owner}/{repo}` template is `gh api`'s documented
substitution, so no manual repo resolution is needed.

The retrigger is **one-shot per `flow-ci-wait` invocation**, on
purpose. The worst-case wait stays bounded at `existing 20-min cap +
one 10-min Copilot timeout` rather than an unbounded retrigger loop
on a fix that keeps landing while we wait. The supervisor's
ci-fix-loop re-invocation grants a fresh retrigger budget per fix
cycle — so a second fix on the same PR still gets exactly one
re-request, just from the next `flow-ci-wait` invocation rather than
the current one.

The retrigger is **gated on CI terminal** (`isCiTerminal(...) ===
true`). Re-requesting Copilot against a commit that may be
force-pushed mid-CI wastes the one-shot budget on a SHA that won't
exist by the time Copilot reviews it. The gate also means a stale
review observed during a pending-CI poll just causes the loop to
continue — the retrigger fires on the first post-terminal poll that
still observes the stale review.

- **Merge-only exclusion.** When every commit between the
  Copilot-reviewed commit and the current `headRefOid` is a merge
  commit (e.g. merging main into the PR branch as a pre-merge
  integration step), the retrigger is skipped — the diff vs base is
  unchanged from Copilot's perspective and another review would be a
  no-op POST burning the one-shot budget. Detected via
  `gh api repos/{owner}/{repo}/compare/<old>...<new> --jq .commits`
  returning commits whose `parents` arrays all have length >= 2; see
  the `allMergeCommitsBetween` helper in `bin/flow-ci-wait.ts`. Fails
  open (any `gh` hiccup falls through to firing the retrigger) — the
  cheaper failure mode is one wasted POST per invocation; the
  expensive failure mode (skipping when a real fix exists) would
  re-introduce PR #161.

- **Small-follow-up exclusion.** When the only commits between the
  Copilot-reviewed commit and the current `headRefOid` are a 'small
  follow-up', the retrigger is skipped — re-requesting Copilot would
  burn a paid credit on a review unlikely to surface findings. A
  follow-up counts as small when EITHER (a) every intervening commit
  is a `/pr-review` fix-applier review-fix commit, detected by the
  `(pr-review #N)` subject marker (`FIX_APPLIER_COMMIT_MARKER`); OR
  (b) total changed LOC (additions + deletions) is `<=
  SMALL_FOLLOWUP_MAX_LOC` (15) AND distinct files touched is `<=
  SMALL_FOLLOWUP_MAX_FILES` (3). Detected via
  `gh api repos/{owner}/{repo}/compare/<old>...<new>` projecting
  `commits[].commit.message` and `files[]` additions/deletions/filename;
  see the `isSmallFollowup` helper in `bin/flow-ci-wait.ts`. It is a
  sibling of the merge-only exclusion in the same retrigger gate.
  Fails open (any `gh` hiccup falls through to firing the retrigger)
  on the same conservative direction — one wasted POST is cheaper than
  skipping a real fix's review and re-introducing PR #161.

- **Post-POST verification (silent-rejection short-circuit).** A
  zero-exit POST does **not** prove Copilot was actually queued: GitHub
  can accept the request (exit 0) yet silently decline to add the login
  to `requested_reviewers` — e.g. a wrong/non-reviewer login, a
  permissions gap, or a plan-tier gate. Trusting the bare exit code there
  hangs the loop for the full 10-minute Copilot timeout on a review that
  will never post. So after a **POST-ok** the loop re-reads
  `requested_reviewers` (`gh pr view <n> --json reviewRequests`, the same
  lowercased-membership read used elsewhere) and branches:
  - **Login present (queued confirmed):** today's behavior —
    `copilotRetriggered := true`, reset the Copilot-timeout window
    (`ciTerminalAt := elapsedSec`), and keep polling for the fresh
    review.
  - **Login absent (silent rejection):** write a `NOTICE` line to stderr
    naming the silent rejection, leave `copilotRetriggered := false`, do
    **not** reset `ciTerminalAt`, and immediately
    `emitResult({ decision: "proceed-to-review-no-bot", copilotRetriggered: false })`
    and return — in the same poll, elapsed well below the 600s timeout
    (no 10-minute wait). This is an early emit at the retrigger call
    site, not a new decision-matrix row; the pure decision matrix is
    unchanged. The re-read only runs on the POST-ok path and is shared
    with the per-poll `requested_reviewers` read (see "Per-poll
    counter").

The **10-min Copilot timeout** branch in the decision matrix reuses
the existing `copilotTimeout` constant; on retrigger, `ciTerminalAt`
is reset to the current `elapsedSec` so the timeout window is
measured from re-request, not from the original CI-terminal moment.
A fresh review with `commit.oid === headRefOid` lands → exit
`proceed-to-review` with `copilotRetriggered: true`. No fresh review
within 10 min → exit `proceed-to-review-no-bot` with
`copilotRetriggered: true`.

**Failure mode — two distinct cases.**

- **POST non-zero (422 / 403 / network).** A non-zero exit from the
  retrigger POST is logged but does NOT free the one-shot budget; it
  sets `copilotRetriggered := true` and (unlike the silent-rejection
  case) does **not** trigger a post-POST re-read — the loop falls
  through to the existing decision matrix and exits
  `proceed-to-review-no-bot` only at the 10-minute Copilot timeout. The
  emitted JSON carries `copilotRetriggered: true` so the supervisor can
  observe the attempt happened; the ci-fix-loop re-invocation is the
  recovery path, not an in-loop retry.
- **POST ok but Copilot not queued (silent rejection).** Caught by the
  post-POST `requested_reviewers` re-read above. Unlike the non-zero
  case, this short-circuits **immediately** (no 10-minute wait) with
  `copilotRetriggered: false` and `decision: proceed-to-review-no-bot`;
  `ciTerminalAt` is not reset.

PR #161 is the historical incident: Copilot reviewed once at commit
`1c59a70` at `2026-05-19T01:18:59Z`, the fix commit `91e18e8` was
pushed at `~01:29Z` advancing `headRefOid`, and `flow-ci-wait`
short-circuited at poll 1 / elapsed 0s because `copilotConfigured=true`
and a Copilot review existed against the stale commit. The PR's
`requested_reviewers` was `[]` at the time of the short-circuit,
confirming GitHub's auto-removal after the first review — there was
no way for the helper to know Copilot would re-review without an
explicit re-request POST.

#### Claim-deadline auto-detect

Copilot reviews typically appear within the first minute of CI going
terminal. When Copilot is configured (`copilotConfigured=true`) but
has not "claimed" the review within a short post-CI-terminal window,
the helper short-circuits the full 10-min copilot timeout with
`decision: 'proceed-to-review-no-bot'` and
`copilotSkipReason: 'unclaimed-after-deadline'`. The exit attribution
is recorded in the JSON output for downstream visibility.

The claim deadline is `DEFAULT_CLAIM_DEADLINE_SEC` (60 seconds) by
default; override via `--claim-deadline-sec <n>` on the helper
invocation. "Claimed" means **any** of:

- The per-poll `gh pr view --json reviewRequests` projection includes
  the configured Copilot login (the bot is still in
  `requested_reviewers`).
- A PENDING Copilot review exists on the current `headRefOid` (the
  bot is drafting its review).
- A non-DISMISSED Copilot review of any state exists on the current
  `headRefOid` (the bot has POSTED, even informally).

The precondition list lives at `deriveCopilotSkipReason` in
`bin/flow-ci-wait.ts`; future drift between this doc and the code
should be detected by the function-name anchor.

Suppress entirely with `--wait-for-copilot` (per-pipeline via
`flow new --wait-for-copilot "<desc>"`, or per-invocation directly on
the helper). Suppressed → the existing 10-min copilot-timeout branch
fires unchanged.

#### Self-dismissal short-circuit

When Copilot dismisses its own review on the current `headRefOid`
(state `DISMISSED`, `commit.oid === headRefOid`) and no
non-dismissed Copilot review exists on the same SHA, the helper
short-circuits with `decision: 'proceed-to-review-no-bot'` and
`copilotSkipReason: 'self-dismissed'`. The signal is strong: the bot
explicitly indicated it has no findings on the current commit, so
waiting the 10-min copilot timeout (or attempting a stale-review
retrigger) burns budget for no gain.

The detection lives at `deriveCopilotSkipReason` in
`bin/flow-ci-wait.ts`. Same anchor as the claim-deadline subsection
above. Same `--wait-for-copilot` suppression rule.

**Critical ordering.** The self-dismissal short-circuit runs **before**
the stale-review retrigger gate ("Retrigger on stale review" above) so
a self-dismissed signal does not trigger a doomed re-request POST.

#### Conflict short-circuit

When a PR branch conflicts with base, GitHub cannot build the
`pull_request` merge ref, so CI never starts — the loop would otherwise
wait out the full 20-min cap and decide `ci-hang`. The helper instead
reads the mergeability projection (`gh pr view <pr> --json
mergeable,mergeStateStatus`) on every OPEN-state poll and emits
`decision: 'pr-conflicted'` immediately when `mergeStateStatus` is
`CONFLICTING` or `DIRTY`.

The gate is **exact membership** on `mergeStateStatus` in
`{CONFLICTING, DIRTY}` — `mergeStateStatus === UNKNOWN` (GitHub still
computing mergeability) never fires it, and `BEHIND` / `BLOCKED` /
`UNSTABLE` / `CLEAN` / `HAS_HOOKS` are not conflicts. The classifier
lives at `deriveConflictState` in `bin/flow-ci-wait.ts`; future drift
between this doc and the code should be detected by the function-name
anchor.

The check runs **per poll** because a conflict can appear at loop entry
(poll 1) or mid-wait (a later poll once base advances), and it runs
**before** the per-poll `requested_reviewers` / `gh pr checks` reads so a
conflicted PR never pays for those calls. The OPEN-state guard preserves
MERGED/CLOSED precedence: a PR that is MERGED or CLOSED falls through to
the decision matrix and routes to `merged-externally` / `pr-closed`.

The mergeability read **fails open**: a non-zero gh exit or malformed
JSON (`observeMergeState` returns `null`) keeps the loop polling rather
than misfiring `pr-conflicted`. This is the opposite conservative
direction from the retrigger-gate readers — here a false `conflicting`
(routing a non-conflicted PR to the merge path) is the expensive error.

### Why per-PR `reviewRequests` and not `gh api .../installations`

The intuitive alternative — `gh api repos/<owner>/<repo>/installations`
— requires a GitHub App JWT to authenticate. User tokens (which `gh`
issues by default) get `401: A JSON web token could not be decoded`
from that endpoint. Per-PR requested-reviewers is the right
substitute: it answers a strictly more useful question ("is Copilot
expected on **this** PR?") with no auth ceremony, and `scripts/ci-wait.ts`
already uses the same approach via `prRequestedReviewers`.

### Override semantics

Once both presence flags are resolved, the per-poll derivations of
`ci_passed` / `ci_failed` / `copilot_posted` are **overridden** as
follows on every iteration:

- `CI_CONFIGURED == 0` → `ci_passed := true`, `ci_failed := false`,
  `ci_terminal := true` (vacuous; the `gh pr checks` call is also
  skipped for the iteration).
- `COPILOT_REQUESTED == 0` → `copilot_posted := true` (vacuous; the
  10-minute bot-timeout branch in the decision matrix is unreachable).

When both flags are 0 the loop exits on its first iteration without
waiting, which is the correct behaviour for a repo with no CI and no
bot reviewer configured.

The Copilot auto-detect short-circuits ('Claim-deadline auto-detect'
and 'Self-dismissal short-circuit' above) are suppressed by two flags:

- `--wait-for-copilot` (boolean) suppresses **both** auto-detect rows
  and restores the full 10-min copilot timeout as the only Copilot
  exit branch. Per-pipeline via `flow new --wait-for-copilot
  "<desc>"` (the supervisor reads `waitForCopilot` from state.json
  and appends the flag), or per-invocation directly on `flow-ci-wait`.
- `--claim-deadline-sec <n>` (positive integer) overrides the
  `DEFAULT_CLAIM_DEADLINE_SEC` (60s) post-CI-terminal claim deadline.
  Direct-invocation only — there is no state.json plumbing.

## Per-poll commands

Both are read-only and idempotent. The reviews call runs every
iteration; the checks call is **skipped when `CI_CONFIGURED=0`** per
the override rule above (no workflows on disk → nothing to poll for).

```bash
# CI check status — terminal states are SUCCESS, FAILURE, CANCELLED,
# TIMED_OUT, SKIPPED, STARTUP_FAILURE, STALE. Pending states are
# PENDING, QUEUED, IN_PROGRESS. `gh pr checks` does not expose a
# `conclusion` JSON field — `state` already encodes the verdict, and
# requesting `conclusion` triggers an `Unknown JSON field` error from
# `gh` (see `scripts/ci-wait.ts` for the same hard-won lesson).
# Run only when CI_CONFIGURED=1.
gh pr checks <pr> --json name,state

# Reviews from any source (Copilot, humans, other bots). Run every
# iteration regardless of presence flags — review state is also where
# `pr_state` (OPEN/MERGED/CLOSED) is sourced from, which the decision
# matrix needs even for repos with no CI configured. `headRefOid` is
# the PR's current HEAD SHA, needed by the stale-Copilot-review
# retrigger branch under "## Copilot reviewer" below. `reviewRequests`
# is the per-poll requested-reviewers projection (lowercased before
# matching), consumed by the Copilot auto-detect short-circuits
# ('Claim-deadline auto-detect' and 'Self-dismissal short-circuit')
# under "## Copilot reviewer". Re-projected per poll because GitHub
# auto-removes Copilot after its first review.
gh pr view <pr> --json reviews,state,headRefOid,reviewRequests

# Mergeability projection. Read every iteration on an OPEN PR to detect a
# branch conflict with base — `mergeStateStatus` is the primary signal (it is
# UNKNOWN while GitHub is still computing). Consumed by the conflict
# short-circuit ('Conflict short-circuit' under "## Copilot reviewer"). Fails
# open: a transient gh error keeps polling rather than misfiring pr-conflicted.
gh pr view <pr> --json mergeable,mergeStateStatus
```

Combine the two JSON payloads in shell (jq) to derive a single state
per poll:

```
ci_terminal     := every check has state ∉ {PENDING, QUEUED, IN_PROGRESS}
ci_passed       := ci_terminal AND every state ∈ {SUCCESS, SKIPPED}
ci_failed       := ci_terminal AND any state ∈ {FAILURE, CANCELLED, TIMED_OUT, STARTUP_FAILURE, STALE}
copilot_posted  := some review where author.login matches the configured
                   bot login (default `copilot-pull-request-reviewer`,
                   case-insensitive exact match) AND
                   review.state ∈ {APPROVED, CHANGES_REQUESTED, COMMENTED}
pr_state        := <`OPEN`, `MERGED`, `CLOSED`>
```

## Decision matrix

Re-evaluate after each poll. The `ci_passed` / `ci_failed` /
`copilot_posted` columns are the **post-override** values — see
"Presence checks" above for how `CI_CONFIGURED=0` and
`COPILOT_REQUESTED=0` short-circuit the corresponding waits.

| `ci_passed` | `ci_failed` | `copilot_posted` | Elapsed | Decision |
|---|---|---|---|---|
| true | — | true | — | **proceed to step 8 (review)**. |
| — | — | — | DISMISSED Copilot review on current `headRefOid` (no fresher non-dismissed review) | **proceed to step 8 without bot review** with `copilotSkipReason: 'self-dismissed'`. Runs BEFORE the retrigger gate so no doomed re-request POST fires. Suppressed by `--wait-for-copilot`. See "Self-dismissal short-circuit" above. |
| true | — | false | `claim-deadline-sec` (default 60s) after `ci_terminal` AND no Copilot review of any state on current `headRefOid` AND Copilot not in `requested_reviewers` | **proceed to step 8 without bot review** with `copilotSkipReason: 'unclaimed-after-deadline'`. Suppressed by `--wait-for-copilot`. See "Claim-deadline auto-detect" above. |
| true | — | false | stale-review + budget unused, post-`ci_terminal` | **fire retrigger POST**, reset Copilot timeout, keep polling. See "Retrigger on stale review" above. |
| true | — | false | < 10 min after `ci_terminal` | **keep polling** (waiting on Copilot). |
| true | — | false | ≥ 10 min after `ci_terminal` | **proceed to step 8 without bot review** (Copilot timed out; `copilotSkipReason: null`). |
| — | — | — | `mergeStateStatus` ∈ {CONFLICTING, DIRTY} on an OPEN PR | **emit `pr-conflicted`** — branch conflicts with base so CI can never start; route to the step-10 merge path. `mergeStateStatus === UNKNOWN` (still computing) never fires it; BEHIND/BLOCKED/UNSTABLE/CLEAN/HAS_HOOKS do not fire it. Fails open on a transient gh error. See "Conflict short-circuit" above. |
| — | true | — | — | **loop back to step 5 in fix mode** (cap: 3 fix-loops total before escalation). Pass the failing-check log into the implement-fix prompt. |
| false | false | — | < 20 min from first poll | **keep polling** (CI still in progress). |
| false | false | — | ≥ 20 min from first poll | **escalate `NEEDS HUMAN: ci-hang`**. End. |
| — | — | — | `pr_state == CLOSED` mid-poll | **escalate `NEEDS HUMAN: pr-closed-mid-flight`**. End. |
| — | — | — | `pr_state == MERGED` mid-poll | the user merged manually; **skip review and gate, render the MERGED block via `flow-gate-summary --status merged ...` (BEFORE the terminal state transition), run `flow-remove-worktree --delete-branch`, end**. |

## The fix-loop cap

When CI fails, the supervisor loops back to step 5 (implement) in
`fix` mode with the failing-check log appended to the prompt. The
cap is **3 fix-loops** across the whole pipeline — after the third
red CI, escalate `NEEDS HUMAN: ci-fix-exhausted` and end. Each
fix-loop counts regardless of whether CI was failing for the same
reason (a different test failing on attempt 2 still counts).

## Bot reviewer name

Default reviewer login: `copilot-pull-request-reviewer`. The supervisor
treats a bot review as posted only when `reviews[].author.login`
matches the configured login by exact (case-insensitive) string
equality. Substring matching (`contains "Copilot"`) is wrong — the
real GitHub Copilot reviewer's login is `copilot-pull-request-reviewer`,
not `Copilot`, and a substring rule risks colliding with unrelated
reviewer names.

If the repo uses a different bot reviewer (e.g. `coderabbitai`), the
supervisor reads the reviewer login from `~/.flow/config.json` (the
per-machine config introduced in PR 1). If the file is absent or
doesn't define one, fall back to `copilot-pull-request-reviewer`.

`scripts/ci-wait.ts` makes the same choice for the same reason — see
its `DEFAULT_CONFIG.bots` and the rationale comment above it.

## What "in one conversation turn" means for this loop

The supervisor's polling loop is a Bash tool call followed by a
`sleep`, looped inside the supervisor's *own* turn — there is no
separate "agent invocation" per poll. Every poll's tool result
appends to the conversation, but the payloads are small (CI JSON +
reviews JSON ≈ 1-2 KB each). Under the active ramp (30s × 5, 60s ×
5, 90s thereafter, 20-min cap), the worst-case poll count is ~20,
giving ~20 polls × 2-4 KB = ~40-80 KB of conversation growth in the
worst case — roughly half what the pre-ramp 30s-fixed cadence
(~40 polls, ~80-160 KB) produced. The ramp is the cost lever Item 19
activated in response to Item 6 cost reporting; it bounds wait-phase
token cost without sacrificing CI-failure detection latency
(failures still surface within the first 30s tier).

The legacy `ci-wait.ts` script ran in a separate process to keep the
orchestrator stateless. The new design keeps state in the supervisor
session; the trade-off is conversation growth, which the ramp now
controls.

## When to revisit this protocol

- If post-Item-19 cost data shows the wait phase is still a
  meaningful fraction of pipeline spend, raise the baseline tier
  (e.g. 60s × 5 instead of 30s × 5) or shorten the 20-min cap.
- If GitHub starts rate-limiting `gh pr checks` at 30s cadence
  (currently fine), drop the first tier and start at 60s.
- If Copilot routinely takes > 10 min after CI terminal, raise the
  Copilot timeout. (Today it's well under 5 min on most repos.)
