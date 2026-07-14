# Per-phase model routing (central precedence reference)

Single source of truth for how the supervisor resolves the Claude model for
each fan-out sub-agent. Every named Task-spawn site in the pipeline / epic
SKILLs links here rather than restating the whole chain.

Adding a per-spawn `model:` argument to an **existing** named fan-out creates
**no new Task-tool exemption** and **no tenth spawn site** — the nine exemption
openers, the two `AskUserQuestion` forms, and every "Load the Task tool before
spawning" preamble stay byte-exact (guarded by `bin/skill-md-lint.test.ts`).

## How the supervisor reads a model (jq, never a `bin/lib` import)

The supervisor and its sub-agents run in the **consumer worktree**, where
flow's `bin/lib/*` is absent. So per-phase model resolution goes through `jq`
on the two files the supervisor already reads for `autoMerge` / `copilotReview`
/ `waitForCopilot`:

```bash
SLUG=$(tmux show-options -t "$TMUX_PANE" -v -w @flow-slug)
STATE=~/.flow/state/"$SLUG".json
# Per-phase override the user passed via `flow feature create --model-<phase>`:
STATE_MODEL=$(jq -r '.model<Phase> // empty' "$STATE")
# Global per-phase default from the config models table:
CFG_MODEL=$(jq -r '.models.<phase> // empty' ~/.flow/config.json 2>/dev/null)
# Inherited session model (the `--model` / models.default resolved at launch):
SESSION_MODEL=$(jq -r '.model // empty' "$STATE")
```

Pass the resolved alias as the Task tool's per-spawn `model:` argument. The
Task `model:` enum is identical to flow's `MODEL_ALIASES`
(`opus` / `haiku` / `sonnet` / `fable`), so any alias flow accepts, Task
accepts. When the resolved value is empty, **omit** `model:` from the Task call
so the sub-agent inherits the session model (the default Claude behaviour).

## Precedence table (highest wins)

| Spawn site                                         | state field          | precedence                                                                            |
| -------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| Step 3 Discovery (planning)                        | `modelPlanning`      | `state.modelPlanning // config.models.planning // inherited`                          |
| `/new-feature` Scout (implement)                   | `modelImplement`     | `config.models.scout // state.modelImplement // config.models.implement // inherited` |
| `/coder` Edit-Applier (implement)                  | `modelImplement`     | `config.models.coder // state.modelImplement // config.models.implement // inherited` |
| Step 6 Verify-Retry-Loop (verify)                  | `modelVerify`        | `state.modelVerify // config.models.verify // "sonnet"` **(NOT inherited)**           |
| `/pr-review` Multi-Agent Review (review)           | `modelReview`        | `state.modelReview // config.models.review // inherited`                              |
| `/pr-review` Fix-Applier (fixApplier)              | `modelFixApplier`    | `state.modelFixApplier // config.models.fixApplier // "sonnet"` **(NOT inherited)**   |
| `/pr-review` Consolidator-Validator (consolidator) | `modelConsolidator`  | `state.modelConsolidator // config.models.consolidator // inherited`                  |
| Step 10 Merge-Conflict Resolver (mergeResolver)    | `modelMergeResolver` | `state.modelMergeResolver // config.models.mergeResolver // inherited`                |
| `/epic-create` designer (planning)                 | `modelPlanning`      | `state.modelPlanning // config.models.planning // inherited`                          |

## Three deliberate asymmetries

- **verify defaults to `sonnet`, not inherited.** Verify is a mechanical gate
  that rarely benefits from an expensive model; defaulting it to inherit would
  silently spend Fable on it. So its final fallback is the literal `sonnet`,
  not the session model. Documented at the Step 6 spawn site.
- **fixApplier defaults to `sonnet`, not inherited.** The Fix-Applier loop
  applies already-diagnosed findings — mechanical apply-commit-push work its
  `agents/flow-fix-applier.md` definition already pins to `effort: low` for the
  same reason. Letting the model inherit would silently spend the session model
  (e.g. Opus/Fable) on gate-run-and-commit work, so its final fallback is the
  literal `sonnet`. Documented at the `/pr-review` Fix-Applier spawn site.
- **scout / coder are config-only fine-grain (no flags).** `--model-implement`
  is the one primary grain over implementation; `config.models.scout` /
  `config.models.coder` are optional finer overrides that layer **above**
  `modelImplement` (they win when set) but have no CLI flag.

## The gatekeeper is pinned — no flag, no inherit

The `/pr-review` Step 1.5 gatekeeper stays `model: "haiku"` by design (its
whole point is cheap cost-routing that short-circuits the expensive review
fan-out). A `config.models.gatekeeper` key is **reachable but loudly
discouraged** — overriding it defeats the deliberate cost-routing. Do **not**
wire a `--model-gatekeeper` flag and do **not** let it inherit the session
model.

The pin is now ALSO declarative: `agents/flow-gatekeeper.md` frontmatter
carries `model: haiku` as the durable record of the pin. The spawn site keeps
its identical per-spawn `model: "haiku"` param regardless — per-spawn wins
over frontmatter, the two values are identical so they never conflict, and
the param is what keeps the `general-purpose` fallback path (definition not
installed) on haiku too.
