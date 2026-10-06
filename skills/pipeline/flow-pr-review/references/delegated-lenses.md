# Delegated review lenses (Step 3)

Some Claude review lenses can run on the user's idle Google AI Ultra quota
(agy, Claude Opus) instead of as Claude Task agents. `flow-agy-lenses`
decides which, runs them, and reports a `delegated` / `fallback` split
that covers exactly the lenses it was asked to run — a lens is never silently
dropped: any lens it cannot deliver is a `fallback` lens, and you Task-spawn
it as you always did. Which lenses move is config:
`delegate.models.claudeLenses` (`null` = delegation off) and `delegate.lenses`;
the helper owns the routing (delegation off, not in the delegated set, a Fable
session keeps bug-detection on Claude, a live cooldown after a quota failure —
until the reset agy names, else 60 minutes).

This reference is a Bash fan-out, not a new Task-tool exemption: the Task
spawns below are the existing Multi-Agent Review exemption.

## When it applies

Only when `command -v flow-agy-lenses` succeeds. Step 3's `resolve_lens` Bash
block already ran `flow-agy-lenses ... --plan-only` (instant, no agy call, so
a delegation-off review pays no extra turn); it printed
`{routes: [{lens, route: "agy"} | {lens, route: "task", reason}]}`. When the
helper is absent, or no route is `agy`, run Step 3's Task fan-out exactly as
written for every lens — nothing in this file changes it.

## Procedure

Let `AGY_LENSES` be the lenses the plan routed to `agy`, comma-joined, and
`TASK_LENSES` the lenses it routed to `task`.

1. **Start the agy wave and the never-moved lenses together.** In ONE
   message: a Bash call with `run_in_background: true` and an explicit
   `timeout: 600000` running

   ```bash
   flow-agy-lenses --worktree "$WORKTREE" --skill-dir "$SKILL_DIR" \
     --lenses "$AGY_LENSES"
   ```

   (the `--plan-only` flag dropped, and ONLY the agy-routed lenses passed),
   AND the Task spawns for every `TASK_LENSES` lens plus intent-guess. Lenses
   that do not move therefore start no later than they do today.

2. **Collect the fallback.** When the background Bash call's completion
   notification arrives, read its stdout: one JSON envelope
   `{model, routes, delegated, fallback, cooldownArmed}`. Every lens in
   `AGY_LENSES` is in exactly one of `delegated` or `fallback` — a lens the
   helper's second plan re-routed to Claude (a cooldown armed by a concurrent
   review in between) is a `fallback` lens with its route reason.
   - `delegated` lenses already have a schema-valid
     `$WORKTREE/.flow-tmp/agent-output-<lens>.json` — do not spawn them.
   - Task-spawn exactly the `fallback` lenses, in one parallel message, with
     the same spawn mechanics as Step 3. Each carries a `reason`
     (and `skipClass`). They start only after the WHOLE agy wave returns, so
     a lens whose own agy attempt failed at once still waits for its slowest
     sibling (about 2-3 minutes when a sibling succeeds, up to 8 minutes when
     one hangs to the per-lens timeout).
   - No parseable envelope (helper killed or crashed): treat every lens in
     `AGY_LENSES` as a fallback lens, reason "the Google-plan run produced no
     result".

3. **Widen re-fan.** A consolidator widen re-spawns the ungated lenses; route
   that wave through the helper again: one Bash call running the Step 3 plan
   command with `--lenses "$WIDENED_LENSES"` (the widened set, comma-joined),
   then steps 1-2. The helper merges its result record per lens, so the first
   wave's engine data is kept.

Step 3.5's consolidator inputs are unchanged: one
`agent-output-<lens>.json` per lens that ran, whichever engine produced it.

## Limits a delegated lens works under

A delegated lens cannot run shell commands (headless agy auto-denies them),
so the Security and Supply-Chain shell recipes become file reads. It gets the
base-branch `.flow/review-checklist.md` inlined (read via
`git show origin/<base>`), never the working-tree copy, and never sees
reviewer comments. It reads only inside the worktree.

## What the Step 12 report says

For each lens, the report names where it ran (Google plan or Claude) and,
for every lens that ran on Claude although delegation was on, a plain-language
reason (see [report-template.md](report-template.md)). Translate the helper's
reason strings; never print them raw:

| Helper reason                                                     | Say                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `agy-output-unparseable`, `agy-empty-artifact`                    | the Google-plan result came back empty or unusable                   |
| `agy-tools-denied`                                                | the Google-plan reviewer tried to run a command it is not allowed to |
| `agy-token-exhausted`                                             | the Google-plan reviewer ran out of output budget                    |
| `agy-timeout`                                                     | the Google-plan run timed out                                        |
| `agy-quota-exhausted`                                             | the Google plan hit its usage limit                                  |
| `agy-not-found`, `agy-not-authenticated`, `agy-model-unavailable` | the Google plan is not available on this machine                     |
| `agy-prep-failed`, `agy-fanout-failed`, `agy-finalize-failed`     | the Google-plan run could not be prepared                            |
| any other `agy-*`                                                 | the Google-plan run failed                                           |
| route `fable-session-keeps-task`                                  | bug-detection stays on Claude when the session runs Fable            |
| route `agy-cooldown`                                              | the Google plan is cooling down after a quota failure                |

Examples: "security ran on Claude: Google-plan result came back empty";
"all lenses on Claude: Google plan cooling down after a quota failure".
Route reasons `delegation-off` and `not-in-delegated-set` are the default
state, not a fallback — do not report them.
