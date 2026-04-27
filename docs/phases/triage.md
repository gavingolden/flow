# Phase 0 — triage

The first phase. Owned by an interactive Claude Code session, not a
script. Its job is to classify the user's request and either answer it
in place or write a `task.md` for the rest of the pipeline.

**Status: shipped (M1).**

## Inputs

- `<prompt>` from the CLI, joined with spaces — the verbatim user
  request.
- `cwd` — must be inside a git repository. The CLI errors out
  otherwise.

## Outputs

One of:

- **No-change:** Claude answers in-line, the session exits, no file is
  written. The user can ask follow-ups in the same session.
- **Change:** Claude writes `.orchestrator/tasks/<id>.md` conforming to
  `docs/task-schema.md` and exits. The next step is `flow run`.

## Why a real Claude session, not a headless call

Triage is the one phase that needs back-and-forth conversation. The
agent must:

- Probe scope (new page or modification? new table or extend existing?).
- Surface unknowns the user hasn't articulated.
- Challenge questionable assumptions.
- Propose alternatives when a simpler approach exists.

A headless `claude -p` invocation can't do that — it would either
fabricate a `task.md` from one prompt or get stuck waiting on stdin.
So triage runs interactively. Every later phase, by contrast, has a
sufficiently structured contract to run scripted.

## How the system prompt gets in

```sh
claude "<prompt>" \
  --append-system-prompt "$(cat templates/triage-system-prompt.md)" \
  --permission-mode acceptEdits \
  --disallowed-tools "Edit,MultiEdit,NotebookEdit"
```

The CLI does the equivalent in `src/commands/start.ts` via `execa`.

- `--append-system-prompt` is the documented way to add instructions
  without modifying the user's working directory or installing a skill
  into the target repo. The triage rules travel with the flow CLI; the
  target repo stays untouched.
- `--permission-mode acceptEdits` skips plan-mode approval for the
  single Write tool call that produces task.md. Without it, users
  whose Claude Code defaults to plan mode have to ExitPlanMode every
  invocation. Plan mode is also where triage breaks down most badly
  (see "Past failures" below).
- `--disallowed-tools "Edit,MultiEdit,NotebookEdit"` is the structural
  guardrail. Even if Claude misreads the system prompt and tries to
  implement the feature itself, it cannot — the modify-existing-file
  tools are unavailable. The Write tool stays available so it can
  create the task.md. Bash is unrestricted; the system prompt asks
  Claude not to use it for in-place edits, but if reliability problems
  surface later, scope Bash to read-only patterns (`Bash(git log)`,
  `Bash(ls *)`, etc.).

If a future phase wants to reuse this pattern (e.g., to inject phase-
specific guardrails on top of an existing skill), the same flags
apply.

## Past failures (for the next agent's context)

These already happened in M1 verification — they're documented so
future tweaks to the system prompt don't regress.

- **Plan mode hijacked triage entirely.** The user invoked
  `flow start "add a small read-only badge…"`, Claude entered plan
  mode (the user's default), drafted an *implementation* plan,
  the user approved, and Claude proceeded to modify `AppHeader.svelte`
  directly. No task.md was written. Root cause: the original system
  prompt buried "do not modify code" in a "What NOT to do" section
  near the bottom, easy for plan mode's flow to override. Fixed by
  (a) `--permission-mode acceptEdits` to sidestep plan mode, (b)
  `--disallowed-tools` to make code edits structurally impossible,
  (c) moving the load-bearing instruction to the very top of the
  system prompt with explicit "if you find yourself drafting an
  implementation plan, stop" language.

If new failures emerge during M2 verification, append them here.

## Classification heuristics

Summary of `templates/triage-system-prompt.md`:

| Pattern | Class |
|---|---|
| "how does X work?", "explain Y", "what's the difference …", "why does …" | no-change |
| "add", "implement", "build", "fix", "refactor", "change", "remove", "wire up" | change |
| Ambiguous ("I'm thinking about …", "what would it take to …") | ASK before classifying |

If the user starts in no-change mode and later says "OK let's actually
do it", the agent escalates to the change flow.

## What triage does NOT do

- It does not modify code in the target repo. Read-only.
- It does not create branches, worktrees, or commits.
- It does not run the implementation pipeline. That's `flow run`.
- It does not write multiple task files in one session. If the user
  describes several unrelated changes, the agent asks which one to
  scope first; the others are handled in subsequent `flow start`
  invocations.

## Contract for downstream phases

Phase 1 (plan) reads:

- `## User prompt` — the original request.
- `## Triage` — type / intent / summary.
- `## Clarifications` — what was settled in the conversation.
- `## Constraints / out of scope` — what's explicitly excluded.
- `## Open questions` — what's still unresolved.

Anything plan needs that's missing from these sections is a triage
bug — the system prompt should be tightened to elicit it, not
worked around in plan.

## Files

| Path | Role |
|---|---|
| `src/cli.ts` | Commander entry, wires the `start` command. |
| `src/commands/start.ts` | Finds git root, ensures `.orchestrator/tasks/`, spawns `claude` with `--append-system-prompt`. |
| `templates/triage-system-prompt.md` | The full triage rules: classification, conversation rules, task.md format, what NOT to do. |

## Known gaps to address in M2 and beyond

- The system prompt currently uses `${REPO_ROOT}` substitution before
  being passed to Claude. If we add more substitutions (target's
  primary language, available skills, …) consider a tiny templating
  helper rather than `replaceAll` chains.
- There's no `flow status <id>` command yet. M5 adds queue / status
  visibility; until then, `cat .orchestrator/tasks/*.md` is the UI.
