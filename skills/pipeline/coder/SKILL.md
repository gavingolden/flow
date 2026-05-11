---
name: coder
description: >-
  Apply a structured edit-set to files in an isolated subagent context, running
  pre-commit verification before returning. Invoked by `/new-feature` step 5
  and `/verify` step 3 to keep per-edit Edit/Write tool calls and their
  diff-bearing tool_results out of the supervisor's transcript. Not for
  direct user invocation.
---

# Goal

Apply a caller-provided edit-set to files inside an isolated Task-tool
subagent context, run `flow-pre-commit --json` against the post-edit
worktree, and return a structured artifact at
`<worktree>/.flow-tmp/coder-result.json`. The supervisor never sees the
per-edit `Edit`/`Write` calls or the pre-commit transcript — it only sees
the wrapper's brief return summary and reads the artifact once.

# When to Use

- `/new-feature` step 5 (Implement) on the wider-scope path of its hybrid
  threshold — the caller composes an edit-set from the `it.todo()` list and
  the scout's `## affected_modules`.
- `/verify` step 3 (Fix Failures) per outer attempt — the caller composes
  an edit-set from the `failure` JSON object emitted by `flow-pre-commit
  --json` (one entry per failed check, naming the source file + the issue
  the fix should resolve).

# When NOT to Use

- Trivially scoped edits where the caller's own hybrid threshold says
  inline is cheaper. `/coder` itself does not apply a threshold — its
  callers decide whether to invoke it. The two known callers use
  different bars: `/new-feature` step 5 stays inline at ≤1 file AND ≤30
  LOC AND every file named in the prompt; `/verify` step 3 stays inline
  on single-line type/lint errors in one file. See each caller's
  "Spawn procedure (wider-scope path only)" section for the canonical
  threshold. The Task-tool round trip costs more than the bytes saved
  on a one-line fix; the threshold exists to preserve the inline path
  for those cases.
- Direct user invocation. `/coder` is invoked by other skills, not by
  humans — the spawn prompt expects a structured edit-set the user is not
  going to compose by hand.
- Multi-turn refinement. Each `/coder` invocation is one-shot — applies the
  requested edits, runs verify, returns the artifact, exits. Iterative
  refinement is the caller's job (compose a new edit-set, re-invoke).
- Discovery / scouting / review work. `/product-planning`'s discovery,
  `/new-feature`'s scout, `/pr-review`'s multi-agent review, and
  `/pr-review`'s fix-applier already own those concerns; `/coder` only
  applies edits that have already been decided.

# How it works

This skill is a thin wrapper around a one-shot **Independent Edit-Applier
Subagent**. The wrapper itself does no file reads and no edits — it spawns
one Task-tool subagent (`subagent_type: general-purpose`), passes the
caller's structured edit-set plus the absolute paths to write, and waits
for the subagent to return a brief both-sides summary. The subagent does
the heavy lifting in its own isolated context: opening each cited file,
making the edits, running `flow-pre-commit --json`, and writing the
structured artifact at `<worktree>/.flow-tmp/coder-result.json`.

The supervisor session that loads this skill (typically `/flow-pipeline`
step 5 or step 6 via `/new-feature` or `/verify`) only ever sees:

1. The prose of this SKILL.md (the wrapper).
2. The Task-tool call's prompt and brief result envelope.
3. The one-paragraph summary the subagent returns.
4. The caller's single read of `.flow-tmp/coder-result.json` body when it
   needs `verify_status` or per-edit dispositions.

It never sees the per-edit `Edit`/`Write` tool calls, the diff-bearing
tool_results, the `flow-pre-commit` transcript, or the file reads. Those
stay inside the subagent's context. Same context-cost surgery PR #95
applied to `/product-planning`'s discovery and the fix-applier refactor
applied to `/pr-review`'s address loop — `/coder` is the analogous fix for
the implement phase itself.

The trade-off is intentional: the caller cannot refer back to the
edit-application transcript in later steps. The contract that absorbs the
trade-off is `coder-result.json` itself — its typed fields (`edits`,
`verify_status`, `rejected_alternatives`, `anti_patterns_found`,
`summary`) are what `/new-feature` step 5 and `/verify` step 3 consume.

## Independent Edit-Applier Subagent

**Task-tool fan-out is intentional.** This step ("Independent Edit-Applier
Subagent") spawns one edit-applier agent via the Task tool. When `/coder`
is loaded by `/new-feature` step 5 or `/verify` step 3 (themselves loaded
in-process by `/flow-pipeline` steps 5 and 6), this fan-out is permitted by
the named Task-tool exception #5 in
`skills/pipeline/flow-pipeline/SKILL.md`'s "Hard rules" section (itself
anchored on this step's heading name, not its number, so it survives
future renumbering). Outside the supervisor context, the Task tool is
unrestricted, so the spawn runs identically. Either path: one subagent,
returns artifact on disk + a brief summary.

**Verify re-run inside the subagent — load-bearing.** The subagent re-runs
`flow-pre-commit --json` *after* applying every edit, before returning.
Type/lint/test failures caused by the edit surface in-context where the
edit rationale is still live, not after the subagent exits and the parent
caller sees a verify failure with no rationale context. Skipping this
re-run returns the refactor to its pre-`/coder` shape.

**Negative-findings slots are required.** The artifact's
`rejected_alternatives` and `anti_patterns_found` arrays are not optional
decorations — they are the slots where the subagent records what it
learned should NOT be done. The spawn prompt below tells the subagent to
populate them proactively; the schema makes them required keys (empty
arrays are permitted only when the subagent genuinely encountered no
alternatives or anti-patterns).

## Spawn procedure

**Load the Task tool before spawning.** In Claude Code sessions where neither `Task` nor its alias `Agent` is surfaced top-level by the harness (both are aliases of the same one-shot subagent-spawn primitive: identical `subagent_type` / `prompt` / `description` schema), the spawn will silently fall through to in-line execution unless the schema is loaded first. Before the Task call below, run `ToolSearch query="select:Task"` and confirm the response contains either a `<function>{"name": "Task", ...}</function>` or a `<function>{"name": "Agent", ...}</function>` line. If it does not, **do not fall back to in-line execution** — escalate `NEEDS HUMAN: task-tool-unavailable: coder-edit-applier` and exit. The fan-out's value is its context isolation; an in-line fallback breaks the contract that this exemption is justified by.

The wrapper spawns the subagent once per `/coder` invocation. Before the
spawn:

1. Resolve the working directory absolutely into a single shell variable
   `$WORKTREE`. If the caller passed a `WORKTREE` value (typical when
   invoked from `/new-feature` or `/verify` running inside `/flow-pipeline`),
   use it as-is. Otherwise, set `WORKTREE="$(pwd)"` explicitly. Then derive
   the artifact path from it:

   ```bash
   WORKTREE="${WORKTREE:-$(pwd)}"
   ARTIFACT_PATH="$WORKTREE/.flow-tmp/coder-result.json"
   ```

   `ARTIFACT_PATH` is the canonical handle for the artifact location;
   the caller's existence check and body read both use it so the path
   lives in exactly one place.

2. Resolve the skill base directory absolutely. The Skill tool prints
   "Base directory for this skill" at the top of this SKILL.md when
   loaded — capture it as `SKILL_DIR`. Then derive:
   - `INSTRUCTIONS_PATH = <SKILL_DIR>/references/coder-instructions.md`

   The subagent reads its instructions via this absolute path. Pass
   `SKILL_DIR` so the subagent never has to resolve sibling references
   relative to its `cd`'d worktree, where they don't exist. Also create
   the consumer-side `.flow-tmp/` directory now (single side-effect
   attribution site for the parent dir; the subagent only writes the
   file):

   ```bash
   mkdir -p "$WORKTREE/.flow-tmp"
   ```

3. Make exactly **one** Task-tool call:

   ```
   subagent_type: general-purpose
   description:   Edit-applier for /coder
   prompt:        <the prompt template below, with variables filled in>
   ```

4. When the subagent returns, treat its 3–5 sentence summary as the chat
   output. Do **not** read the artifact body in the wrapper — the caller
   (`/new-feature` or `/verify`) reads it once when it needs
   `verify_status` or per-edit dispositions, and reading it twice in the
   same context erodes the context-cost win. The wrapper's only post-spawn
   job is a cheap existence check (`test -s "$ARTIFACT_PATH"`); on missing
   or empty artifact, surface the failure to the caller — the wrapper
   itself never retries.

## Spawn prompt template

Fill in the five `{{...}}` placeholders before passing to the Task tool:
`INSTRUCTIONS_PATH`, `EDIT_SET`, `WORKTREE`, `SKILL_DIR`, `ARTIFACT_PATH`.

```
You are the Independent Edit-Applier Subagent for `/coder`. You run in an
isolated context and return an artifact on disk plus a brief summary.

Read the full instructions at:
  {{INSTRUCTIONS_PATH}}

Edit-set (verbatim, JSON-shaped):
  {{EDIT_SET}}

Working directory (cd here before reading any project files):
  {{WORKTREE}}

Skill base directory (resolve sibling references against this absolute
path — they do not exist relative to {{WORKTREE}}):
  {{SKILL_DIR}}

Write the structured artifact to (absolute path):
  {{ARTIFACT_PATH}}

Follow the coder-instructions.md steps in order. You are one-shot — do not
ask the user clarifying questions. When the edit-set leaves something
unspecified, make a defensible assumption based on the surrounding code
and project conventions, and surface every assumption you made in the
artifact's `rejected_alternatives` or `anti_patterns_found` slots.

Populate `rejected_alternatives` for every edit-shape you considered and
rolled back, and `anti_patterns_found` for every off-pattern observation
the next session should know about. An empty array is permitted only when
you genuinely encountered none — silence is not the default. Do not call
`gh issue create`, `flow-create-issue`, or any tracker integration; surface
deferred-worthy observations as `anti_patterns_found` and let the parent
caller file the issue if appropriate.

Return a one-paragraph summary (3–5 sentences) that surfaces BOTH sides
of what you learned: at least one positive (top edit's intent, the verify
verdict, edit count applied) AND at least one negative (top entry from
`rejected_alternatives` or `anti_patterns_found`). A summary that names
only positive findings fails the contract. Do not paste the artifact JSON
back; the artifact on disk is the record.
```

The artifact's JSON schema is documented verbatim in
`references/coder-instructions.md` step 4. Both files declare the same
five top-level keys (`edits`, `verify_status`, `rejected_alternatives`,
`anti_patterns_found`, `summary`); a structural lint at
`bin/skill-md-lint.test.ts` enforces the schema-drift symmetry, and a
runtime validator at `bin/lib/coder-schema.ts` lets callers assert shape
before consuming the artifact.

The fifth named Task-tool exemption is documented bidirectionally in
`AGENTS.md` `## Don'ts` and `skills/pipeline/flow-pipeline/SKILL.md`
"Hard rules" — both files name "Independent Edit-Applier Subagent" as
the heading anchor.

# Verification

- Exactly one Task-tool call to the Edit-Applier Subagent per `/coder`
  invocation; the wrapper did not retry on missing artifact (the caller
  decides whether to re-invoke).
- `.flow-tmp/coder-result.json` exists at the resolved absolute path with
  all five top-level keys (`edits`, `verify_status`,
  `rejected_alternatives`, `anti_patterns_found`, `summary`).
- The wrapper's transcript contains no per-edit `Edit`/`Write` prose, no
  `flow-pre-commit` output, and no file-read prose — those stayed inside
  the Edit-Applier Subagent.
- The wrapper's chat output is the subagent's 3–5 sentence both-sides
  summary plus a one-line existence-check confirmation; never the full
  artifact JSON.
- `verify_status` is the literal `"pass"` or a head/tail-capped failure
  excerpt — never a free-form prose summary of the verify outcome.

# Constraints

- NEVER do edit-application work in the wrapper's context. The
  Edit-Applier Subagent owns the per-file `Edit`/`Write` calls, the
  pre-commit run, and the artifact write. Loading reference docs, opening
  cited files, or drafting edits inline defeats the entire point of the
  subagent fan-out.
- NEVER make more than one Task-tool call per `/coder` invocation. The
  single fan-out is the named exemption; multi-call fan-out is not
  authorised. If the artifact is missing after the spawn, surface the
  failure to the caller — the wrapper itself never retries. Re-invocation
  is the caller's decision; a second call inside this run would violate
  the one-Task-call invariant.
- NEVER read `.flow-tmp/coder-result.json` body in the wrapper. The
  cheap existence check (`test -s`) is the only allowed artifact access
  between spawn and return. The caller's first read of the body is the
  single read; reading earlier would duplicate that read in the same
  context.
- NEVER let the subagent own the `mkdir -p .flow-tmp/`. Single
  side-effect attribution site: the wrapper alone creates the directory.
  The subagent only writes the file.
- NEVER pass a free-form prose edit description to the subagent. The
  edit-set must be a JSON-shaped list of `{file, intent, expected_outcome}`
  entries — the subagent's contract depends on the structure to know
  when an edit landed and what each entry was meant to achieve.
- NEVER spawn a nested Task call from inside the subagent. The one-level
  sub-agent cap forbids it. If the subagent needs context the edit-set
  doesn't carry, it records an `anti_patterns_found` entry and the
  parent caller decides how to proceed.
