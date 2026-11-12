# Decision rules

Contents: Decision table · Executive review · Writing and sending a ruling · Proposals · Never

## Decision table

Match the event's pipeline phase (from its brief), then act. "Log" means
`flow-manager-ctl log --kind manager-decision …`.

| Event / phase                                                                                                          | Do                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan-pending-review` (transition, new)                                                                                | "Executive review" below. A ruling only on an `approve`; otherwise a needs-you line with the executive's recommendation                                                                                                                                      |
| `checkpoint-pending-clear` → `checkpoint-idle` (10 min with no owner action)                                           | `SendMessage` the peer `continue` to the slug. The 10 minutes keep you from racing the owner's own `/clear`. Tell the owner the trade-off: `continue` keeps the planning context through implementation instead of starting a fresh session                  |
| `plan-pending-interview`, `triage-pending-interview`, `triage-pending-clarification`, `approval-pending-clarification` | Never answer. Draft the answers into a proposal (`proposal add --kind interview-draft --slug <s> --text "<Q → draft answer>" --recommendation "<one line>"`); the owner answers, then an owner ruling carries it                                             |
| `triaged-no-change`                                                                                                    | Needs-you line: triage found nothing to change; confirm or redirect                                                                                                                                                                                          |
| `gated`                                                                                                                | Never tick a Test Step and never merge. Summarise the open Test Steps from the brief's `prSections` and the f4 evidence the PR body links; for a UI pipeline add one line on whether the change looks consistent with the repo's existing UI. Needs-you line |
| `needs-human`                                                                                                          | Needs-you line naming the window: `flow attach <slug>`                                                                                                                                                                                                       |
| `browser-retry-pending`                                                                                                | Needs-you line naming the window                                                                                                                                                                                                                             |
| `merged` for a pipeline in an epic                                                                                     | One wave review (below); reorders only, everything else as proposals                                                                                                                                                                                         |
| `merged-out-of-band`, `gone`                                                                                           | One line to the owner; log it                                                                                                                                                                                                                                |
| `stale`                                                                                                                | Point at the open `stale-cancel` proposal; never cancel                                                                                                                                                                                                      |
| `ruling-unpicked`                                                                                                      | The pipeline did not take the ruling in 15 minutes: tell the owner to answer in `flow attach <slug>` (the status line already says so); write no second ruling                                                                                               |
| `new-candidate`                                                                                                        | A name only: ask the owner whether to add it to the scope                                                                                                                                                                                                    |
| `idle` (only under `flow manage --stop-when-idle`)                                                                     | Run `flow manage --stop`; say what finished                                                                                                                                                                                                                  |

## Executive review

Only for a pipeline whose `flow-exec-review status --slug <s>` prints
`granted: true` with the `plan` class. A `relay`-only grant never runs a review.

1. Write cross-pipeline facts the in-pipeline review lacked to
   `context-<slug>.md` in your working directory: sibling pipelines' phases from
   `status.md`, live notes from `flow-manager-note list --about <slug>`, a
   merged sibling that changed what this plan builds on. Facts only, under
   8,000 characters.
2. Run `flow-exec-review review --kind plan --slug <s> --context-file context-<slug>.md`
   with `timeout: 600000`. Add `--epic <e>` for an epic feature.
3. Branch on the JSON, never the exit code:
   - `ran: false`, `skipReason: no-new-evidence` → nothing new since the last
     look; add the needs-you line and wait for a note or a sibling to change.
   - `action: approve` → write a manager `approve` ruling citing
     `.decisionId`; the pipeline stamps its own PR body when it accepts it.
   - `action: challenge` → write a manager `redirect` ruling whose `--text`
     carries `.memoPath` and `.decisionId`, so the memo is never stranded.
   - `action: defer` or any other skip → needs-you line with `.recommendation`
     (or `.skipText`); write no ruling.
4. A wave review: `flow-exec-review review --kind wave --epic <e> --repo-root <repo>`
   (the repo path is in the brief). It applies reorders only; relay anything it
   proposes as a proposal.

## Writing and sending a ruling

1. `flow-manager-ctl ruling write --slug <s> --reply approve|redirect|answer --source manager|owner --reason "<why>" [--text "<text>"] [--decision <id>]`.
   - `--source manager` needs `--decision <id>`: an executive decision logged
     after the pipeline entered this pause (`approve` for approve; a challenge or
     a redirect recommendation for redirect). A redirect or answer needs `--text`.
   - `--source owner` needs the owner to have typed words naming the pipeline
     (its slug, an open proposal id, or the `#N` handle) after the pause began;
     the writer finds that prompt itself. Never pass an id.
2. On `ok:true` it prints `{"id","message":"RULING <id>"}`. `SendMessage` with
   `to` = the slug and `message` = the `message` text, nothing else.
3. On `ok:false` read `reason`: `out-of-scope`, `no-grant` (a manager ruling
   needs the `plan` class; an owner ruling needs `plan` or `relay`),
   `source-not-allowed` (the owner answers interviews and clarifications),
   `no-exec-approval`, `no-owner-words`, `one-way-door` (the plan names an
   action that cannot be undone: the owner decides in the window),
   `budget-reached` (today's executive limit). Tell the owner in one line; do
   not retry with different words to get past it.
4. Before every send re-read the target's phase (`flow-manager-ctl scope show`
   lists each pipeline's phase) and skip the send when it already left the pause.

## Proposals

A proposal is a question for the owner, never an action: `proposal add --kind
epic-change|stale-cancel|interview-draft --text … [--slug|--epic|--repo]
[--recommendation …]`. List open ones with `proposal list`; record the owner's
reply with `proposal answer <id> --answer "<text>"`, then act only through a
ruling or an owner command. Epic changes go through `flow epic manage` or `flow
epic launch`, never an edit of the manifest.

## Never

Never `send-keys`, read a diff, read a state file directly, answer for the
owner, or send anything but `RULING <id>` or `continue` to a pipeline.
