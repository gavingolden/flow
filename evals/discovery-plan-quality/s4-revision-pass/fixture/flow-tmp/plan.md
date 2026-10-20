# PRD

# Report a corrupt todo file instead of showing an empty list

**Goal:** A corrupt todo file produces a visible warning and a non-zero exit, so a user never mistakes lost data for an empty list.

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question; force with `flow feature create --research`.

## Problem Statement

- **Corruption looks like emptiness.** `loadTodos` in `src/store.ts` swallows every JSON parse error and returns `[]`, so `todo list` prints nothing for a damaged file.
- **The next write destroys the evidence.** `todo add` after a swallowed parse error saves a fresh one-item list over the corrupt file.

## Request vetting

- **Hypothesis:** surfacing the parse error at load time, and refusing to overwrite a file that failed to parse, removes the silent-data-loss path without changing the happy path.
- **Case against:** a hard failure on load makes every command unusable until the user repairs the file by hand, which is worse than an empty list for someone who only wanted `todo add` [anchor: src/commands/add.ts:5].
- **Sources:** no outside source: grounded on `src/store.ts` and `src/commands/add.ts`.
- **Verdict:** adopt-with-conditions: warn and exit non-zero from read commands, and keep `add` blocked only until the file is moved aside, with the path printed.

## Scope Boundary

**In scope**

- `loadTodos` reports a corrupt file instead of returning `[]`.
- `list`, `summary` and `add` surface the failure with the file path.

**Out of scope**

- Automatic repair or backup of a corrupt file.

## Behavioral contrast

### User flow

- **Before:** a corrupt file prints an empty list and exits 0; the next `add` overwrites it.
- **After:** a corrupt file prints `todo file is corrupt: <path>` to stderr and exits 1; `add` refuses to overwrite it.

### System flow

- **Before:** `loadTodos` catches the parse error and returns `[]`.
- **After:** `loadTodos` throws a `CorruptTodoFileError` naming the path; the entry point catches it once.
- **Lost:** nothing: a missing file still loads as an empty list.

## User Stories / Acceptance Criteria

### Story 1: A corrupt file is reported

As a user, when `~/.todo-cli.json` holds invalid JSON, `todo list` tells me so instead of printing nothing.

- [ ] `todo list` on a corrupt file exits 1 and prints the path to stderr.
- [ ] A missing file still lists as empty with exit 0.

## Architecture Decisions

- **One typed error, caught at the entry point.** `loadTodos` throws `CorruptTodoFileError`; `src/index.ts` catches it once, so command modules stay free of error plumbing.

## Technical Constraints

- Bun runtime; no new dependencies.
- The file format is unchanged.

## Open Questions

- [ ] Should `add` offer to move the corrupt file aside? (Changes whether `add` can recover without manual repair.)
  - **Recommended:** no, print the path and the one-line `mv` command instead; automatic moves are out of scope [confidence: medium] [anchor: weighing: risk — an automatic move is a data-handling decision the request does not make]
  - **Stakes:** system — a silent move could hide the corruption cause.

### Product critique (blind)

- P1 [accepted] — the fix must not make `add` impossible; the plan prints the repair command with the path.

## Decision analysis

### D1 — Where the corruption error is surfaced

| Option | Where | Friction |
| --- | --- | --- |
| (a) Throw in `loadTodos`, catch once in `index.ts` | one place | 0 extra steps |
| (b) Return a `{ todos, error }` result from `loadTodos` | every caller | 3 call sites change |

- **Exclusivity:** exclusive.
- **Ranked:** (a) > (b).
- **Verdict:** (a) [confidence: medium] [anchor: weighing: footprint — one catch site against three call-site edits]

### Cross-model review (AGY)

Depth `light`; one reviewer ran, so every point is single-reviewer input.

- **Overwrite protection is the real fix** [accepted] — the plan's `add` refusal covers it.

<!-- flow-plan-review-hash: 0000000000000000000000000000000000000000000000000000000000000000 -->

## Alternatives considered

- **Return a result object instead of throwing** — rejected: it touches every caller for the same user-visible outcome.

## Recommendation

**Proceed** — throw a typed error from `loadTodos`, catch it once at the entry point, and refuse to overwrite a corrupt file [confidence: high] [anchor: src/store.ts:11]

**Redundancy:** none found — nothing in `src/` already reports a corrupt file.

## Plan risks

The weakest assumption is that a hard failure on load is acceptable to a user who only wanted to add a todo; the printed repair command is the mitigation.

## Cut list

- No automatic backup or repair of the corrupt file: out of scope and a separate data-handling decision.

## Prompt interpretation

- **Reading of prescribed methods:** not applicable
- **Plausibility estimate:** the request prescribes no method and no quantitative target.
- **Recommended path:** not applicable

# Task breakdown

### Task 1: Throw a typed error for a corrupt todo file

- **Skill:** `flow-testing`
- **Description:** `loadTodos` throws `CorruptTodoFileError` (with the path) on a parse failure; a missing file still returns `[]`; the entry point catches the error, prints the path to stderr and exits 1.
- **Inputs:** none.
- **Outputs:** a typed error and a single catch site.
- **Contract:**
  - **Files:** edit `src/store.ts`; edit `src/index.ts`; edit `tests/todo.test.ts`.
  - **Interfaces:**
    - `export class CorruptTodoFileError extends Error { constructor(readonly path: string) }`
    - `export function loadTodos(): Todo[]` — throws `CorruptTodoFileError` on a JSON parse failure.
  - **Call-site edits:** `src/index.ts` wraps command dispatch in one try/catch for `CorruptTodoFileError`.
- **Acceptance criteria:** `bun test`

### Skills Summary

| Skill | Tasks |
| --- | --- |
| `flow-testing` | 1 |

# PR description draft

## TLDR

A corrupt todo file is now reported instead of shown as an empty list.
