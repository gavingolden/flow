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

| Spawn site                                              | state field          | precedence                                                                                                                                    | effort default |
| ------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Step 3 Discovery (planning)                             | `modelPlanning`      | `state.modelPlanning // config.models.planning // inherited`                                                                                  | `session`      |
| `/flow-new-feature` Scout (implement)                   | `modelImplement`     | `config.models.scout // state.modelImplement // config.models.implement // inherited`                                                         | `session`      |
| `/flow-coder` Edit-Applier (implement)                  | `modelImplement`     | `config.models.coder // state.modelImplement // config.models.implement // inherited`                                                         | `session`      |
| `/flow-pr-review` Multi-Agent Review (review)           | `modelReview`        | `state.modelReview // config.models.review // inherited`                                                                                      | `session`      |
| `/flow-pr-review` Bug-Detection Lens (review)           | `modelReview`        | `config.models.reviewLenses.bug-detection // state.modelReview // config.models.review // inherited` **(uncapped — Fable on Fable sessions)** | `session`      |
| `/flow-pr-review` Security Lens (review)                | `modelReview`        | `config.models.reviewLenses.security // state.modelReview // config.models.review // session model capped at opus`                            | `session`      |
| `/flow-pr-review` Pattern-Consistency Lens (review)     | `modelReview`        | `config.models.reviewLenses.pattern-consistency // state.modelReview // config.models.review // session model capped at opus`                 | `session`      |
| `/flow-pr-review` Performance Lens (review)             | `modelReview`        | `config.models.reviewLenses.performance // state.modelReview // config.models.review // session model capped at opus`                         | `session`      |
| `/flow-pr-review` Supply-Chain Lens (review)            | `modelReview`        | `config.models.reviewLenses.supply-chain // state.modelReview // config.models.review // session model capped at opus`                        | `session`      |
| `/flow-pr-review` Test-Coverage Lens (review)           | `modelReview`        | `config.models.reviewLenses.test-coverage // state.modelReview // config.models.review // session model capped at opus`                       | `session`      |
| `/flow-pr-review` Product Lens (review)                 | `modelReview`        | `config.models.reviewLenses.product // state.modelReview // config.models.review // "opus"` **(pinned; NOT inherited)**                       | `medium`       |
| `/flow-pr-review` Intent-Guess Lens (review)            | `modelReview`        | `config.models.reviewLenses.intent-guess // state.modelReview // config.models.review // session model capped at opus`                        | `session`      |
| `/flow-pr-review` Fix-Applier (fixApplier)              | `modelFixApplier`    | `state.modelFixApplier // config.models.fixApplier // "sonnet"` **(NOT inherited)**                                                           | `≤ medium`     |
| `/flow-verify` UI-driver (uiDriver)                     | —                    | `config.models.uiDriver // "sonnet"` **(NOT inherited; config-only, no CLI flag)**                                                            | `≤ medium`     |
| `/flow-pr-review` Consolidator-Validator (consolidator) | `modelConsolidator`  | `state.modelConsolidator // config.models.consolidator // session model capped at opus`                                                       | `session`      |
| Step 10 Merge-Conflict Resolver (mergeResolver)         | `modelMergeResolver` | `state.modelMergeResolver // config.models.mergeResolver // inherited`                                                                        | `session`      |
| `/flow-epic-create` designer (planning)                 | `modelPlanning`      | `state.modelPlanning // config.models.planning // inherited`                                                                                  | `session`      |

## Five deliberate asymmetries

- **fixApplier defaults to `sonnet`, not inherited.** The Fix-Applier loop
  applies already-diagnosed findings — mechanical apply-commit-push work.
  Letting the model inherit would silently spend the session model
  (e.g. Opus/Fable) on gate-run-and-commit work, so its final fallback is the
  literal `sonnet`. Its effort follows the same logic: a built-in `medium`
  capped at the session's effort, overridable with `efforts.fixApplier` (see
  "Per-spawn effort" below). Documented at the `/flow-pr-review` Fix-Applier
  spawn site.
- **scout / coder are config-only fine-grain (no flags).** `--model-implement`
  is the one primary grain over implementation; `config.models.scout` /
  `config.models.coder` are optional finer overrides that layer **above**
  `modelImplement` (they win when set) but have no CLI flag.
- **A review lens (and the consolidator) inherits the session model, capped
  at opus.** A lens inherits the session model unchanged when that model is
  priced at or below opus (`MODEL_PRICE_RANK` in `bin/lib/state.ts`); an
  alias priced above opus — today only `fable` — falls back to opus instead,
  so an accidentally-expensive session can never fan out seven expensive review spawns
  at once. This is a rank-ordering rule keyed on `MODEL_PRICE_RANK`, not a
  named-model special case. Bug-detection is the exception: it inherits the
  session model uncapped (Fable on Fable sessions) because the pre-registered
  recall check found Fable materially better (8.7% vs 3.9%, p = 0.0065) at
  $2.50 vs $0.71 a review measured at medium effort; set
  `config.models.reviewLenses.bug-detection` to opt back.
- **The product lens falls back to a literal opus, on every session.** Unlike
  the other lenses it is NOT session-capped: a Sonnet session is raised to opus
  rather than passed through, and a Fable session gets opus too. Any explicit
  `config.models.reviewLenses.product`, `--model-review`, or `config.models.review`
  still wins. It is also the one routed site whose `agents/*.md` definition
  carries a built-in `medium` effort that is not session-capped (see
  "Per-spawn effort" below). The Opus move was not quality-benchmarked; see
  `docs/configuration.md` for the trade-off.
- **uiDriver falls back to a literal sonnet AND is the only routed site with
  no CLI flag at all.** `config.models.uiDriver` is the sole knob — no
  `--model-ui-driver` flag, no `state.json` field. A manifest-driven browser
  drive is template execution that must not silently inherit Opus/Fable, the
  same reasoning as fixApplier, but uiDriver goes further: unlike fixApplier
  (which still has a `--model-fix-applier` flag and a `state.modelFixApplier`
  field above its config grain), uiDriver has neither —
  `config.models.uiDriver // "sonnet"` is the entire chain. Like fixApplier,
  its effort defaults to `medium` capped at the session's effort and is
  overridable with `efforts.uiDriver`.

## Per-spawn effort

Effort resolves at each spawn, like the model, through the `flow-spawn-effort`
PATH helper (`bin/flow-spawn-effort.ts`; the same `resolveSpawnEffort` the
audit table renders). The chain, highest wins:

1. `CLAUDE_CODE_EFFORT_LEVEL` — Claude Code's own override. When set it wins
   over every per-spawn value and the agent-file fallback; flow only reports it
   (`flow config models` banner) and never sets it.
2. `config.efforts.<key>` — per-role keys named like `models.*`
   (`planning`, `scout`, `coder`, `fixApplier`, `uiDriver`, `consolidator`,
   `mergeResolver`, and `reviewLenses.<lens>`). There are no group keys:
   `efforts.review` and `efforts.implement` are not read. Not capped by the
   session.
3. The built-in default (the table's `effort default` column): fix-applier and
   UI driver `medium` **capped at the session's effort** (a `low` session stays
   `low`; `max` becomes `medium`; an unknown session keeps `medium`), product
   lens `medium`.
4. Otherwise the helper prints nothing and the spawn follows the session.

The helper owns the build gate: the per-spawn `effort` argument needs Claude
Code 2.1.292+, so on an older or undetectable build it prints nothing and the
site omits the argument — no spawn site carries version prose. On those
builds, or if a site forgets the argument, the `effort: medium` fallback in the
fix-applier, UI-driver and product-reviewer agent files still applies (fixed,
so it can exceed a `low` session); every other role follows the session.

The canonical recipe at a spawn site — non-empty ⇒ pass `effort:` on the Task
call, empty ⇒ omit it, no further condition at the site:

```bash
X_EFFORT=$(command -v flow-spawn-effort >/dev/null 2>&1 && flow-spawn-effort <phase>)
```

`<phase>` is the table's spawn-site slug (`planning`, `scout`, `coder`,
`fix-applier`, `ui-driver`, `consolidator`, `merge-resolver`,
`review-lens:<lens>`). The model-default axis and the effort axis are
independent. `bin/lib/model-routing-table.test.ts` pins the table's
`effort default` column to the `SPAWN_SITES` `effortDefault` fields, and each
default's level to its agent file's `effort:` line.

`flow config models` renders this directly: a line above the table shows the
resolved session effort and its source, and each sub-agent row's EFFORT cell
reads `= session`, or the resolved level with its source (`· built-in`,
`· config`, `· env`).

## In-process skills pin effort, not model

The precedence table above governs Task-SPAWN sites only, and it
structurally cannot cover an in-process skill: an in-process `SKILL.md`
runs on the supervisor's own turn, never in a spawned subagent, so there
is no Task call for a `model:` argument to attach to.

A `SKILL.md` may still carry `effort:` in its frontmatter to bound that
turn's reasoning depth — unlike Task-spawn `agents/*.md` definitions (where
frontmatter `effort: medium` on the fix-applier, UI-driver and product-lens
agents is only a fallback beneath `flow-spawn-effort`'s per-spawn `effort:`
argument; see "Per-spawn effort" above), an in-process skill runs on the
supervisor's own turn rather than through the Task tool, so there is no
per-spawn argument for the pin to interact with. It should
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
