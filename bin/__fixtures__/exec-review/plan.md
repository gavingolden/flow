# PRD

> [!NOTE]
> Web-grounded research (discovery Step 1.5): skipped — not a researchable question.

# Add a --verbose flag to the example CLI

**Goal:** Let a user of the example tool see what it is doing when something looks wrong.

## Problem Statement

A user who runs the example tool gets no output until it finishes, so a slow run looks identical to a hung one and they cannot tell whether to wait.

Evidence (verified at the fixture commit):

| Claim                                  | Evidence                                                       |
| -------------------------------------- | -------------------------------------------------------------- |
| The tool prints nothing while it works | The entry point only prints at exit [anchor: src/example.ts:3] |

## Request vetting

- **Hypothesis:** a single opt-in `--verbose` flag that prints one progress line per step is enough to tell a slow run from a hung one.
- **Case against:** a flag nobody passes changes nothing for the users who are confused today, because they would have to know it exists before they could use it [anchor: src/example.ts:3]
- **Sources:** no outside source: the change is local to one file and has no external prior art worth citing
- **Verdict:** adopt

## Existing-code assessment

- **src/example.ts:** keep — gains one flag check and progress lines; no restructuring [anchor: src/example.ts:3]

## Scope Boundary

**In scope**

- A `--verbose` flag that prints one line per step.

**Out of scope**

- Log files, colour, or any other output mode.

## Behavioral contrast

### User flow

| Before                                  | After                                                  |
| --------------------------------------- | ------------------------------------------------------ |
| A slow run prints nothing until it ends | With `--verbose`, each step prints a line as it starts |

### System flow

- Progress output
  - Before: none.
  - After: one stderr line per step when the flag is set.

**Lost:** nothing is lost; without the flag the output is unchanged.

## Open Questions

- [x] Q1 — Should progress go to stdout or stderr? stderr, so piping the result still works.
  - **Stakes:** none — resolved without asking

## Recommendation

**Proceed** — a one-flag change with no migration and an obvious home. [confidence: high] [anchor: src/example.ts:3]

**Redundancy:** none found — no existing flag prints progress.

## Plan risks

The weakest assumption is that one line per step is enough detail; if users want timings they will ask for a second flag, which costs one more option and no rework.

## Cut list

- No `--quiet` counterpart — nobody has asked for less output than the default.

# Task breakdown

### Task 1: Add the flag

- **Skill:** `flow-new-feature`
- **Description:** Read `--verbose` from argv in the entry point and print one stderr line before each step.
- **Inputs:** none.
- **Outputs:** the flag.
- **Contract:**
  - **Files:** edit `src/example.ts`.
  - **Interfaces:** none.
  - **Call-site edits:** none.
- **Acceptance criteria:** `npx vitest run src/example.test.ts`

# PR description draft

## TLDR

Passing `--verbose` now prints a line as each step starts; before, a slow run printed nothing until it ended.

## User-facing changes

- New `--verbose` flag prints one progress line per step.

## System changes

none

## Why

A slow run looked identical to a hung one.

## Key decisions

- Progress goes to stderr so piped output is unchanged.

## Test Steps

- [ ] Run `npx vitest run src/example.test.ts` — the flag prints one line per step.

<!-- flow-plan-review-hash: 4c2c61387bdadf51bccde4c0c43b98086e651c6fdc78747ab9df41238c39fe23 -->
