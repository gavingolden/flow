# flow documentation

Every doc outside the root [README](../README.md), grouped by what you are trying to do.

## Using flow

- [Getting started](getting-started.md) — your first pipeline, from install to merged PR.
- [Run pipelines in parallel with tmux](tmux.md) — the tmux launcher, plus a tree view of every pipeline and its phase.
- [Configuration](configuration.md) — modules, install flags, upgrades, and every `~/.flow/config.json` key.
- [Per-phase models](configuration.md#per-phase-models) — route expensive models to planning and cheap ones to verify.
- [Consumer-repo contract](../references/consumer-repo-contract.md) — what `flow-pre-commit` expects from a repo you point flow at.
- [Migrating an existing AGENTS.md](migrating-an-existing-agents-md.md) — move a repo that copied the old monolithic template onto the three-file split.
- [Blind second-opinion judge](deliberation-assessment.md) — why `/flow-deliberate` has its shape and what the evidence supports.
- [Consumer review patterns](consumer-review-patterns.md) — a seed checklist to copy into your repo's `.flow/review-checklist.md`.

## Working on flow

- [CONTRIBUTING.md](../CONTRIBUTING.md) — dev setup, conventions, and releasing.
- [AGENTS.md](../AGENTS.md) — the rules every agent working on flow follows.
- [The supervisor skill](../skills/pipeline/flow-pipeline/SKILL.md) — how `/flow-pipeline` drives a run.
- [Test-quality methodology](test-quality-methodology.md) — which tests earn their cost, and why.
- [Target architecture](target-architecture.md) — the redesign target and what flow is not.

## Design notes and evaluations

- [Context-economy audit](context-economy-audit.md) — a measured baseline for tightening what loads into context.
- [Launch reliability](launch-reliability.md) — findings from the intermittent `flow feature create` launch-failure investigation.
- [Nested sub-agents assessment](nested-subagents-assessment.md) — why flow keeps its sub-agent fan-out flat.
- [Skill description convention](skill-description-convention.md) — the retention rule that keeps skill descriptions small.
- [Subagent features probe](subagent-features-probe.md) — live results that settled assumptions about Claude Code sub-agent features.
- [Test Steps audit](test-steps-audit.md) — what PR checklists contain and how to tell whether they worked.
- [Token-spend analysis](token-spend-analysis.md) — where the Claude quota goes and which savings are worth pursuing.
- [Demo GIFs](demo/README.md) — how the README demos are rendered.
- [Epic designer dossier](epic-designer/README.md) — the design for flow's epic design phase.
- [Eval harness](eval/README.md) — the maintainer guide to `flow-eval` and its suites.
- [Model bench](model-bench/README.md) — how to evaluate a new model for an agy-delegated step.
- [Workflow-runtime spike](workflow-spike/README.md) — the throwaway spike on the Claude Code workflow runtime.
