# Delegated review lenses (Step 3)

Some Claude review lenses can run on the user's idle Google AI Ultra quota
(agy, Claude Opus) instead of as Claude Task agents. `flow-agy-lenses`
decides which, runs them, and reports a `delegated` / `fallback` split
that covers exactly the lenses it routed to agy — a lens is never silently
dropped: any lens it cannot deliver is a `fallback` lens, and you Task-spawn
it as you always did. Which lenses move is config: `delegate.models.claudeLenses`
(`null` = delegation off) and `delegate.lenses`; the helper owns the routing
(delegation off, not in the delegated set, a Fable session keeps
bug-detection on Claude, a live 60-minute cooldown after a quota failure).

This reference is a Bash fan-out, not a new Task-tool exemption: the Task
spawns below are the existing Multi-Agent Review exemption.

## When it applies

Only when `command -v flow-agy-lenses` succeeds. When the helper is absent,
or every route below comes back `task`, run Step 3's Task fan-out exactly as
written — nothing in this file changes it.

## Procedure

Let `RUN_LENSES` be the ungated lenses Step 3 would spawn (the seven real
lenses only — intent-guess is never delegated), comma-joined.

1. **Plan (instant, no agy call).** One Bash call:

   ```bash
   flow-agy-lenses --worktree "$WORKTREE" --skill-dir "$SKILL_DIR" \
     --lenses "$RUN_LENSES" --plan-only
   ```

   It prints `{routes: [{lens, route: "agy"} | {lens, route: "task", reason}]}`.
   If no route is `agy`, skip to the normal Task fan-out for every lens.

2. **Start the agy wave and the never-moved lenses together.** In ONE
   message: a Bash call with `run_in_background: true` and an explicit
   `timeout: 600000` running the same command WITHOUT `--plan-only`, AND the
   Task spawns for every `task`-routed lens plus intent-guess. Lenses that do
   not move therefore start no later than they do today.

3. **Collect the fallback.** When the background Bash call's completion
   notification arrives, read its stdout: one JSON envelope
   `{model, routes, delegated, fallback, cooldownArmed}`.
   - `delegated` lenses already have a schema-valid
     `$WORKTREE/.flow-tmp/agent-output-<lens>.json` — do not spawn them.
   - Task-spawn exactly the `fallback` lenses, in one parallel message, with
     the same spawn mechanics as Step 3. Each carries a `reason`
     (and `skipClass`).
   - No parseable envelope (helper killed or crashed): treat every
     `agy`-routed lens from step 1 as a fallback lens, reason "the Google-plan
     run produced no result".

4. **Widen re-fan.** A consolidator widen re-spawns the ungated lenses; route
   that wave through the helper again (steps 1-3 with the widened lens set).
   The helper merges its result record per lens, so the first wave's engine
   data is kept.

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
| `agy-not-found`, `agy-not-authenticated`, `agy-model-unavailable` | the Google plan is not available on this machine                     |
| `agy-prep-failed`, `agy-fanout-failed`, `agy-finalize-failed`     | the Google-plan run could not be prepared                            |
| any other `agy-*`                                                 | the Google-plan run failed                                           |
| route `fable-session-keeps-task`                                  | bug-detection stays on Claude when the session runs Fable            |
| route `agy-cooldown`                                              | the Google plan is cooling down after a quota failure                |

Examples: "security ran on Claude: Google-plan result came back empty";
"all lenses on Claude: Google plan cooling down after a quota failure".
Route reasons `delegation-off` and `not-in-delegated-set` are the default
state, not a fallback — do not report them.
