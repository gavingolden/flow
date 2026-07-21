# Nested sub-agents assessment

## Premise (verified)

As of Claude Code v2.1.172 (June 2026), nested sub-agent spawning is
platform-possible: a sub-agent may itself spawn a sub-agent, up to a
fixed depth of 5, enforced by tool-stripping at depth 5 (a depth-5
sub-agent's tool list omits `Task`/`Agent`, so it cannot spawn further).
This is documented at code.claude.com/docs/en/sub-agents. The premise
was verified via a web-grounded gather pass (Gemini 3.1 Pro) followed by
an adversarial refute pass (Claude Opus 4.6) explicitly tasked with
finding evidence against it; the refute pass found none, so the premise
verdict is **SUPPORTED**.

This assessment revisits flow's flat, one-shot sub-agent fan-out policy
(nine named top-level exemptions, no nesting) against that platform
change, using flow's actual pipeline sites as the evaluation set.

## What the one-level cap was actually carrying

AGENTS.md's supervisor rationale historically cited two justifications
for never nesting: (1) a platform-enforced "one-level cap", and (2)
context bloat from a long-running supervisor accumulating sub-agent
output. The platform premise above shows justification (1) was never a
hard platform limit at any depth flow actually uses (the deepest chain
any site could plausibly want is depth 3: supervisor → verify-loop →
edit-applier). Justification (2) — context economy — was always the
load-bearing one. `docs/context-economy-audit.md` establishes review as
the heaviest phase per pipeline run; Anthropic's own multi-agent
guidance recommends flat orchestrator-worker topologies over deep
nesting, citing roughly 15x the token cost of a single agent for
exploratory multi-agent fan-out. Beyond raw token cost, flow's nine
existing exemptions all lean on properties that erode with nesting depth:
loud-failure artifact contracts (one flat write per subagent, no
grandchild artifact to reconcile), single-site debuggability (a human or
the supervisor can inspect one subagent's transcript, not a tree), and
the supervisor's own resume anchors (current phase, PR number, worktree
path — all read from the top-level transcript, not a buried grandchild's).
These properties were always the actual reason flow stayed flat at eight
of the nine sites; the platform cap was, at most, a second, weaker
argument that happened to point the same direction.

## Per-site assessment

| Site                             | Depth if nested | Win                                                                                                                                                         | Cost                                                                                                                                                                                                                         | Verdict            |
| -------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| supervisor → pr-review wholesale | 2               | Fewer top-level Task calls in the supervisor's own transcript                                                                                               | AskUserQuestion unavailable inside a subagent (pr-review's gate-override and candidate-issues forms would break); auto-push moves two levels from the user's own instruction; resume anchors leave the supervisor transcript | Rejected           |
| verify-loop → coder              | 3               | Verify-loop's wider-scope fix path gets edit-applier's mechanical pre-check + rejected-alternatives/anti-patterns discipline instead of ad-hoc inline edits | One extra artifact hop (`verify-coder-result.json`), one extra spawn-failure mode to record                                                                                                                                  | **Adopted**        |
| fix-applier → coder              | 3               | Same edit-applier discipline for pr-review's per-finding fix loop                                                                                           | fix-applier already owns per-finding commit/push sequencing; splitting that into a grandchild spawn muddies which layer commits                                                                                              | Rejected (for now) |
| discovery → parallel scouts      | 2               | Faster wall-clock for multi-file discovery                                                                                                                  | Discovery is a single one-shot Task already; sub-fanning it multiplies the ~15x token cost for a phase that isn't the audited hot spot                                                                                       | Rejected           |
| consolidator sub-spawn           | 2               | Could parallelize validation of multiple agent-output files                                                                                                 | Consolidator-validator already runs as one Sonnet pass over pre-computed agent outputs; no measured bottleneck to justify the spend                                                                                          | Rejected           |
| epic-run fan-out                 | 2               | Could parallelize manifest reconciliation across features                                                                                                   | epic-run is a playbook session, explicitly zero named fan-out by design (no Task, no AskUserQuestion); nesting here would be a new top-level policy change, not a mechanical adoption                                        | Rejected           |

## Cross-cutting costs

Independent of any single site, nesting anywhere carries these costs:

- **Token fan-out.** Roughly 15x the token cost of a single agent for
  exploratory multi-agent work, per Anthropic's own multi-agent
  guidance — the dominant cost at every site above.
- **Debuggability.** A human (or the supervisor) inspecting one
  subagent's transcript is tractable; inspecting a tree of nested
  transcripts to find which layer failed is not, absent tooling flow
  doesn't have.
- **Artifact-contract complexity.** Every additional nesting layer needs
  its own distinct artifact path (to avoid a stale parent artifact
  masking a child miss) and its own failure enum — more surface for the
  loud-failure contract to get wrong.
- **AskUserQuestion unavailability inside subagents.** Any site whose
  parent-level behaviour depends on a mid-task form (gate-override,
  candidate-issues) cannot be nested without redesigning that form's
  trigger point.
- **Resume anchors move off the supervisor transcript.** The
  supervisor's own compact-survival anchors (phase, PR number, worktree
  path) live on its own transcript; nesting a site that owns one of
  those anchors would require threading it back up an extra hop.
- **Background-by-default semantics (v2.1.198+).** Newer Claude Code
  versions run sub-agent Task calls in the background by default,
  which changes polling/completion semantics for any nested spawn and
  was not present when the current nine exemptions were designed.
- **SendMessage-resume and Agent Teams not adopted.** Both are
  newer platform primitives for coordinating multi-agent work; this
  assessment does not adopt either — the nine-exemption model already
  covers flow's fan-out surface without them.

## Verdict

The current flat, one-shot, nine-named-exemption design stands, **except**
at the one site where the platform-possible win — the edit-applier's
mechanical contract-adherence and negative-findings discipline — clearly
outweighs the added nesting cost: **verify-loop → edit-applier**, adopted
in this same PR. The exactly-nine top-level-exemption rule is unchanged;
the nested site is bookkept _inside_ the existing Verify-Retry-Loop
exemption, not as a tenth top-level exemption.

The adoption is deliberately conservative given the depth-3 swallowed-
failure pre-mortem (a grandchild subagent's failure silently disappearing
into a stale or missing artifact, with no one layer noticing): the
answer is a distinct `verify-coder-result.json` artifact (never
confusable with the supervisor-path `coder-result.json`), a recorded
`coder_spawn` enum (`ok`|`not-attempted`|`task-tool-unavailable`|
`artifact-missing`|`invalid`) that the verify-loop subagent writes into
its own `verify-loop-result.json`, and a hard behavioural rule: on any
spawn or artifact miss, apply that one fix inline and stay inline for
the remainder of the run — never retry the spawn. This is the same
loud-failure discipline that makes flow's existing artifact contracts
debuggable, applied one layer deeper rather than invented from scratch.

Rejected alternatives, recorded here so they are not silently
re-proposed:

- **Wholesale pr-review nesting** (supervisor → pr-review as a single
  nested subagent) — rejected: `AskUserQuestion` unavailable inside a
  subagent breaks the gate-override and candidate-issues forms; the
  auto-push exemption would fire two levels away from the user's own
  instruction; resume anchors would leave the supervisor's own
  transcript.
- **fix-applier → coder** — rejected for now: fix-applier already owns
  per-finding commit/push sequencing, and splitting edit application
  into a grandchild spawn would blur which layer is responsible for the
  commit.
- **discovery → parallel scouts** — rejected: discovery is already a
  single one-shot Task; fanning it out further multiplies the ~15x
  token cost for a phase `docs/context-economy-audit.md` doesn't flag
  as a hot spot.
- **epic-run fan-out** — rejected: `epic-run` is explicitly a
  zero-fan-out playbook session by design; nesting there would be a new
  top-level policy decision, not a mechanical adoption of an existing
  pattern.
- **Option D — relax the exactly-nine rule to a generic depth-≤3
  license** — rejected: the narrow-and-named exemption pattern keeps
  flow's fan-out surface auditable and lint-anchorable (`bin/skill-md-
lint.test.ts` can enumerate and check each named site); a generic
  depth budget trades that away for no current consumer beyond the one
  site this PR adopts.

## Adopted site: verify-loop → edit-applier

On its wider-scope fix path (the same non-trivial bar `/flow-verify`
step 3 already uses), the Verify-Retry-Loop subagent spawns exactly one
`flow-edit-applier` subagent per outer attempt — depth 3
(supervisor → verify-loop → edit-applier) — rather than applying the
fix inline. The spawn passes a JSON edit-set shaped per
`skills/pipeline/flow-coder/references/coder-instructions.md`, and a
caller-passed absolute artifact path,
`<worktree>/.flow-tmp/verify-coder-result.json` — deliberately distinct
from the supervisor-path `coder-result.json` so a stale parent artifact
can never mask a child miss.

Failure handling is recorded, not escalated: a `coder_spawn` enum
(`ok`|`not-attempted`|`task-tool-unavailable`|`artifact-missing`|
`invalid`) lands in the verify-loop's own `verify-loop-result.json`. On
any miss the loop applies that one fix inline and stays inline for the
remainder of the run — no retry, no hang. The Task-load guard mirrors
the existing nine-site convention: `ToolSearch query="select:Task"`
before spawning; on a missing schema, record
`task-tool-unavailable: verify-loop-edit-applier` rather than
escalating (this site degrades-and-records, because inline application
is already a known-good fallback — unlike the nine top-level exemptions,
which escalate `NEEDS HUMAN: task-tool-unavailable: <exemption-name>`
because they have no inline fallback).

The normative source for the full spawn contract is
`skills/pipeline/flow-pipeline/references/verify-loop-instructions.md`;
this document records the _rationale_ for adopting nesting there, not
the mechanics.
