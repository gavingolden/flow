# Per-phase model routing (central precedence reference)

Single source of truth for how the supervisor resolves the Claude model for
each fan-out sub-agent. Every named Task-spawn site in the pipeline / epic
SKILLs links here rather than restating the whole chain.

Adding a per-spawn `model:` argument to an **existing** named fan-out creates
**no new Task-tool exemption** and **no ninth spawn site** — the eight exemption
openers, the one `AskUserQuestion` form, and every "Load the Task tool before
spawning" preamble stay byte-exact (guarded by `bin/skill-md-lint.test.ts`).

## How the supervisor reads a model (jq, never a `bin/lib` import)

The supervisor and its sub-agents run in the **consumer worktree**, where
flow's `bin/lib/*` is absent. So per-phase model resolution goes through `jq`
on the two files the supervisor already reads for `autoMerge` / `copilotReview`
/ `waitForCopilot`:

```bash
SLUG="$FLOW_SLUG"
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

| Spawn site                                              | state field          | precedence                                                                            |
| ------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| Step 3 Discovery (planning)                             | `modelPlanning`      | `state.modelPlanning // config.models.planning // inherited`                          |
| `/flow-new-feature` Scout (implement)                   | `modelImplement`     | `config.models.scout // state.modelImplement // config.models.implement // inherited` |
| `/flow-coder` Edit-Applier (implement)                  | `modelImplement`     | `config.models.coder // state.modelImplement // config.models.implement // inherited` |
| `/flow-pr-review` Multi-Agent Review (review)           | `modelReview`        | `state.modelReview // config.models.review // inherited`                              |
| `/flow-pr-review` Fix-Applier (fixApplier)              | `modelFixApplier`    | `state.modelFixApplier // config.models.fixApplier // "sonnet"` **(NOT inherited)**   |
| `/flow-pr-review` Consolidator-Validator (consolidator) | `modelConsolidator`  | `state.modelConsolidator // config.models.consolidator // inherited`                  |
| Step 10 Merge-Conflict Resolver (mergeResolver)         | `modelMergeResolver` | `state.modelMergeResolver // config.models.mergeResolver // inherited`                |
| `/flow-epic-create` designer (planning)                 | `modelPlanning`      | `state.modelPlanning // config.models.planning // inherited`                          |

## Two deliberate asymmetries

- **fixApplier defaults to `sonnet`, not inherited.** The Fix-Applier loop
  applies already-diagnosed findings — mechanical apply-commit-push work its
  `agents/flow-fix-applier.md` definition already pins to `effort: low` for the
  same reason. Letting the model inherit would silently spend the session model
  (e.g. Opus/Fable) on gate-run-and-commit work, so its final fallback is the
  literal `sonnet`. Documented at the `/flow-pr-review` Fix-Applier spawn site.
- **scout / coder are config-only fine-grain (no flags).** `--model-implement`
  is the one primary grain over implementation; `config.models.scout` /
  `config.models.coder` are optional finer overrides that layer **above**
  `modelImplement` (they win when set) but have no CLI flag.

## In-process skills pin effort, not model

The precedence table above governs Task-SPAWN sites only, and it
structurally cannot cover an in-process skill: an in-process `SKILL.md`
runs on the supervisor's own turn, never in a spawned subagent, so there
is no Task call for a `model:` argument to attach to.

A `SKILL.md` may still carry `effort:` in its frontmatter to bound that
turn's reasoning depth — the same lever the low-effort agent definitions
use, just declared on the skill instead of on a spawned agent. It should
**NOT** carry `model:`. Prompt caches are model-scoped, so a mid-turn
model switch discards the supervisor's warm cache and forces a full
re-read of the transcript at full input rate — the opposite of the
saving the pin is meant to buy, for a same- or adjacent-tier switch:
staying put costs the re-read at the session model's cache-read rate,
switching costs it at the target's uncached base rate, and that
inequality holds when the two tiers' rates are close. It is not a law
across a large tier gap — a top-tier model's cache-read rate can exceed
a cheap tier's uncached base rate, which would flip the comparison. The
decision not to pin `model:` here also rests on an independent
judgment-quality argument, not the cache-cost argument alone: this
skill's calls are exactly the kind of local, bounded judgment the
supervisor's own session model is already carrying context for.

`skills/universal/flow-checkpoint/SKILL.md` is the one instance of this
pattern today: it pins `effort: medium` and deliberately omits `model:`.
