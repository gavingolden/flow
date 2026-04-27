# M2 — plan, worktree, implement

The next milestone. After M2, a `triaged` task can become an open PR with
no human in the loop. The pipeline still stops there — verify, ci, review,
gate, merge land in M3 and M4.

Read first: `architecture.md`, `task-schema.md`, and `phases/triage.md`.

## Goal

Add three phases and a `flow run <task-id>` command that drives them.

```
triaged ──► planning ──► planned ──► creating-worktree ──► worktree-ready
                                                              │
                                                              ▼
                                                        implementing
                                                              │
                                                              ▼
                                                          pr-open  (terminal for M2)
```

`pr-open` is the M2 terminal status. M3 takes over from there.

## New CLI surface

Add to `src/cli.ts`:

```
flow run <task-id>          # required arg in M2; --all and --max land in M5
flow status [<task-id>]     # nice-to-have for M2; falls under M5 if it slips
```

`flow run`:

1. Reads `<target-repo>/.orchestrator/tasks/<task-id>.md`. (`<target-repo>` =
   git root of cwd, same as `flow start`.)
2. Inspects `status`. Dispatches to the right phase based on the state
   machine. Phases that have already completed are skipped.
3. Stops on the first phase that returns `retry` (after exhausting
   retries), `needs-human`, or `failed`. Prints the reason and exits
   non-zero.
4. Otherwise runs phases in sequence until the M2 terminal (`pr-open`)
   or the task has nothing to do.

## Phase 1 — plan

| | |
|---|---|
| **Type** | headless Claude Code subprocess in the *target repo* |
| **Skill invoked** | `/product-planning` |
| **Entry status** | `triaged` |
| **Exit status (ok)** | `planned` |
| **On failure** | retry once with the failure log appended; then `failed` |

The plan phase converts the triage's clarifications into a PRD, a task
breakdown, and a PR description draft. econ-data's `product-planning`
skill already does all of this — flow just invokes it with the right
input.

### Implementation

```ts
// src/pipeline/phases/plan.ts
import { runHeadless } from "../headless.js";

export async function runPlanPhase(task: Task): Promise<PhaseResult> {
  const prompt = buildPlanPrompt(task);
  const result = await runHeadless({
    cwd: task.target_repo,
    prompt,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash(ls *)", "Bash(cat *)"],
    timeoutMs: 10 * 60 * 1000,
  });
  if (!result.ok) return { status: "retry", reason: result.error };
  await appendPlanOutputs(task, result);
  await transitionStatus(task, "planned");
  return { status: "ok" };
}
```

`buildPlanPrompt` constructs an instruction that includes:

- A pointer to the task file (so the skill can read the user prompt and
  clarifications itself rather than receiving them inline).
- An invocation of `/product-planning` with the user's request as
  `$ARGUMENTS`.
- An explicit instruction to write `pr-description-draft.md` and the
  PRD into a path the implement phase can find (suggested:
  `<target-repo>/.orchestrator/tasks/<id>-plan/`).

### Open question 1 — slash commands inside `claude -p`

This is the first thing to verify in M2. Two paths:

- **Best case:** `claude -p "/product-planning <args>"` invokes the
  skill in the target repo's `.claude/skills/product-planning/`.
  Confirmed: skill runs, output JSON parsed, done.
- **Fallback:** read `<target-repo>/.claude/skills/product-planning/SKILL.md`
  and inline its content into the prompt: *"Follow these instructions:
  …<skill body>… for the user request: …"*. Less elegant but
  guaranteed-to-work.

Implement the best case first. If `claude -p "/foo"` doesn't dispatch,
the fallback is mechanical to add. Document which one you ended up
using in `phases/plan.md`.

### Open question 2 — mid-skill confirmations

`/product-planning` asks the user "ready to proceed to task breakdown?"
in some flows. In headless mode that hangs.

Mitigations, in order of preference:

1. Pre-answer in the wrapping prompt: *"You are running in non-
   interactive headless mode. Do not pause for confirmations; proceed
   through the full skill end-to-end and write the deliverables to
   disk."* Often sufficient.
2. Add a `--non-interactive` flag to the target skill that auto-yeses
   confirmations. Requires changing the skill in econ-data — a separate
   PR there.
3. Split the skill into approve/execute halves invoked separately.
   Heavyweight; only if 1 and 2 are insufficient.

Try #1 first. The triage system prompt is already structured this way
and works.

## Phase 2 — worktree

| | |
|---|---|
| **Type** | script, no LLM |
| **Action** | invoke the target repo's `scripts/new-agent-worktree.ts <branch>` |
| **Entry status** | `planned` |
| **Exit status (ok)** | `worktree-ready` |
| **On failure** | abort (`failed`) — no retry; manual investigation needed |

Branch name derivation:

```
<author-prefix>/<id-slug>
```

Where `<author-prefix>` defaults to `agent` (configurable in
`.orchestrator/config.toml` later) and `<id-slug>` is the task id minus
the date (so `2026-04-27-add-portfolio-chart` → `add-portfolio-chart`).
Final branch: `agent/add-portfolio-chart`.

### Implementation

```ts
// src/pipeline/phases/worktree.ts
import { execa } from "execa";
import { existsSync } from "node:fs";

export async function runWorktreePhase(task: Task): Promise<PhaseResult> {
  const branch = deriveBranchName(task);
  const scriptPath = path.join(task.target_repo, "scripts", "new-agent-worktree.ts");

  if (!existsSync(scriptPath)) {
    return { status: "failed", reason: `target repo missing ${scriptPath}` };
  }

  // Idempotent: if a worktree path is already recorded and exists, skip.
  if (task.worktree && existsSync(task.worktree)) {
    return { status: "ok" };
  }

  const { stdout, exitCode } = await execa(
    "npx", ["tsx", scriptPath, branch],
    { cwd: task.target_repo, reject: false },
  );
  if (exitCode !== 0) {
    return { status: "failed", reason: `worktree script exit ${exitCode}: ${stdout}` };
  }

  const worktreePath = parseWorktreePathFromOutput(stdout);
  await updateTaskFrontmatter(task, { worktree: worktreePath, branch });
  await transitionStatus(task, "worktree-ready");
  return { status: "ok" };
}
```

`parseWorktreePathFromOutput` reads the worktree path from the script's
output (the script prints it as the last line, per econ-data's
`new-agent-worktree.ts`). Verify this contract — if the output format
varies, parse the worktree path with `git worktree list --porcelain`
after the script returns instead.

### Falling back when the target lacks the script

For M2, error cleanly with a message naming the missing path. Do not
attempt a generic `git worktree add` fallback — that skips the
project-specific symlinks (`.env`, `.claude/settings.local.json`) which
the next phase needs. Configurable worktree commands land later (M5+).

## Phase 3 — implement

| | |
|---|---|
| **Type** | headless Claude Code subprocess in the *worktree* |
| **Skill invoked** | `/new-feature` |
| **Entry status** | `worktree-ready` |
| **Exit status (ok)** | `pr-open` |
| **On failure** | retry once with failure log appended; then `failed` |

The implement phase opens a PR. Three things must happen inside the
spawned Claude session:

1. The skill writes code, tests, commits, pushes a branch.
2. It opens a GitHub PR using `gh pr create`.
3. The PR description includes the **Manual validation** section with
   either populated steps (UI / DB / external API / behaviour change)
   or empty (refactor / docs).

(3) is new — `/new-feature` doesn't know about flow's auto-merge rule.
Two options for wiring it in:

- **A) Wrapping prompt instructs the skill** to include the section
  with the right contents based on the diff. Preferred — no skill
  changes needed.
- **B) Update `/new-feature` upstream** to always emit the section.
  Cleaner long-term but requires a PR to econ-data.

Use (A) for M2; revisit (B) when M4 lands and we see how reliable the
heuristic is.

### Implementation

```ts
// src/pipeline/phases/implement.ts
export async function runImplementPhase(task: Task): Promise<PhaseResult> {
  if (task.pr != null) return { status: "ok" }; // idempotent — already opened

  const prompt = buildImplementPrompt(task);
  const result = await runHeadless({
    cwd: task.worktree!,
    prompt,
    allowedTools: [
      "Read", "Write", "Edit", "Glob", "Grep", "MultiEdit",
      "Bash(npm *)", "Bash(git *)", "Bash(gh *)", "Bash(npx *)",
    ],
    timeoutMs: 30 * 60 * 1000,
  });
  if (!result.ok) return { status: "retry", reason: result.error };

  const prNumber = await detectOpenedPr(task);
  if (prNumber == null) {
    return { status: "retry", reason: "implement returned ok but no PR was opened" };
  }
  await updateTaskFrontmatter(task, { pr: prNumber });
  await transitionStatus(task, "pr-open");
  return { status: "ok" };
}
```

`detectOpenedPr` runs `gh pr list --head <branch> --json number,headRefName`
in the worktree and returns the first match.

### Wrapping prompt — the Manual validation rule

Append something like this to the `/new-feature` invocation:

> When you write the PR description, include a `## Manual validation`
> section. Populate it with concrete steps if any of these apply: a
> database migration, a new external API integration, a UI change
> (`.svelte` files in `src/lib/`), or a behaviour change to a critical
> path. Otherwise leave the section empty (just the heading and an
> HTML comment explaining the convention). The orchestrator's gate
> phase reads this section to decide whether to auto-merge.

## New source files

```
src/
├── cli.ts                   # extend: register `run` command
├── commands/
│   ├── start.ts             # exists
│   └── run.ts               # new — entry to runPipeline()
├── pipeline/
│   ├── runner.ts            # new — phase scheduler, status dispatch
│   ├── headless.ts          # new — runHeadless({ cwd, prompt, allowedTools, timeoutMs })
│   ├── retry.ts             # new — small helper, kept for M3+
│   └── phases/
│       ├── plan.ts          # new
│       ├── worktree.ts      # new
│       └── implement.ts     # new
├── state/
│   ├── task-file.ts         # new — readTask, writeTask, transitionStatus, updateTaskFrontmatter (gray-matter)
│   └── ids.ts               # new — deriveBranchName, slug helpers
└── util/
    └── git.ts               # new — findGitRoot (extracted from start.ts)
```

The `findGitRoot` extraction lets `flow run` use the same logic as
`flow start`. Move it out of `commands/start.ts` into `util/git.ts`
and import from both.

## State helpers

```ts
// src/state/task-file.ts
import matter from "gray-matter";

export interface TaskFrontmatter {
  id: string;
  status: TaskStatus;
  created: string;
  updated: string;
  target_repo: string;
  worktree: string | null;
  branch: string | null;
  pr: number | null;
  manual_validation: boolean | null;
}

export interface Task {
  path: string;
  frontmatter: TaskFrontmatter;
  body: string;
}

export async function readTask(filePath: string): Promise<Task> { ... }
export async function writeTask(task: Task): Promise<void> { ... }
export async function transitionStatus(task: Task, next: TaskStatus): Promise<void> { ... }
export async function updateTaskFrontmatter(task: Task, patch: Partial<TaskFrontmatter>): Promise<void> { ... }
export async function appendPhaseOutput(task: Task, phase: string, content: string): Promise<void> { ... }
```

`writeTask` always sets `frontmatter.updated` to `new Date().toISOString()`
and regenerates the `## Progress` section from `frontmatter.status`
plus the canonical phase order (see `docs/task-schema.md`). Phase
implementations don't touch `## Progress` directly — they update
`status` and `writeTask` keeps the visual mirror in sync.

Define the canonical phase order in one place — e.g.:

```ts
// src/state/phases.ts
export const PHASE_ORDER = [
  "triage", "plan", "worktree", "implement",
  "verify", "ci", "review", "gate", "merge",
] as const;
export type PhaseName = (typeof PHASE_ORDER)[number];

// Map status → "checked through which phase".
// e.g. "planned" → triage + plan checked; "pr-open" → through implement.
export function checkedThrough(status: TaskStatus): PhaseName { ... }
```

`writeTask` reads `checkedThrough(status)` and emits the checkbox
list. Reuse the same constant from the runner's pipeline scheduler.

## Headless wrapper

```ts
// src/pipeline/headless.ts
import { execa } from "execa";

export interface HeadlessOptions {
  cwd: string;
  prompt: string;
  allowedTools?: string[];
  timeoutMs?: number;
}

export interface HeadlessResult {
  ok: boolean;
  output: string;        // raw stdout
  error?: string;        // stderr or parsed error
  exitCode: number;
}

export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const args = ["-p", opts.prompt];
  if (opts.allowedTools?.length) {
    args.push("--allowed-tools", opts.allowedTools.join(","));
  }
  // Consider --output-format json once we need structured results.

  const result = await execa("claude", args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 15 * 60 * 1000,
    reject: false,
  });

  return {
    ok: result.exitCode === 0,
    output: result.stdout,
    error: result.exitCode !== 0 ? result.stderr || result.stdout : undefined,
    exitCode: result.exitCode ?? -1,
  };
}
```

Start without `--output-format json`. Add it when a phase actually
needs to consume structured output (probably review in M3).

## Phase scheduler

```ts
// src/pipeline/runner.ts
const M2_PIPELINE: Array<{ entry: TaskStatus; phase: PhaseFn; name: string }> = [
  { entry: "triaged",         phase: runPlanPhase,      name: "plan" },
  { entry: "planned",         phase: runWorktreePhase,  name: "worktree" },
  { entry: "worktree-ready",  phase: runImplementPhase, name: "implement" },
];

export async function runPipeline(task: Task): Promise<PhaseResult> {
  for (const { entry, phase, name } of M2_PIPELINE) {
    if (compareStatus(task.frontmatter.status, entry) < 0) continue; // already past
    if (compareStatus(task.frontmatter.status, entry) > 0) continue; // already past
    if (task.frontmatter.status !== entry) continue;

    const result = await phase(task);
    if (result.status !== "ok") return result;

    // reload from disk — phase wrote to it
    Object.assign(task, await readTask(task.path));
  }
  return { status: "ok" };
}
```

Status comparison via a lookup table or array index. Simple. Extend the
pipeline list in M3 (verify, ci, review).

## Acceptance criteria

- `flow run <id>` on a `triaged` task produces a PR on GitHub.
- The task's frontmatter ends with: `status: pr-open`, `worktree`,
  `branch`, `pr` populated. `manual_validation` still null (M4 sets
  that).
- The PR body has a `## Manual validation` section, populated or empty
  per heuristics.
- Re-running `flow run <id>` on a `pr-open` task is a no-op (returns
  ok, exits cleanly, updates nothing).
- Re-running on a partially-completed task (e.g., `worktree-ready`)
  resumes from the correct phase without redoing earlier work.

## Verification

Use econ-data as the target repo. Pick a small, low-risk feature.

```sh
cd /Users/gavingolden/code/me/econ-data
flow start "add a small read-only badge to the dashboard header"
# Triage runs, writes .orchestrator/tasks/<id>.md, exits.

flow run <id>
# Plan phase runs (~5–10 min). Worktree created. Implement phase runs.
# PR opens. Pipeline exits with ok.

# Verify on disk:
cat .orchestrator/tasks/<id>.md  # status: pr-open, pr: 184 (or similar)
git -C ../econ-data-add-badge log -1  # commit on the feature branch

# Verify on GitHub:
gh pr view 184  # has Manual validation section
```

For each open question, capture the resolution in `phases/plan.md`,
`phases/worktree.md`, and `phases/implement.md` as those phases land.

## Scope guardrails (don't do these in M2)

- No `flow run --all` or queue. M5.
- No verify, CI watch, review. M3.
- No gate or auto-merge. M4.
- No notifications beyond stdout + task.md updates.
- No retry-with-LLM-context. Retries re-invoke `claude -p` with the
  failure log appended to the prompt — they don't carry the previous
  attempt's conversation. (See architecture.md for why.)
