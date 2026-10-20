# Sub-agent design research — post-f6 retrospective (2026-09-07)

Recorded by the `f6-workflow-port` supervisor after PR #789 merged, in
response to the maintainer's concern that the stage-workflow design (steps
5–10 as cold-context `agent()` chains) loses root-agent visibility and may
be on the wrong side of the single-vs-multi-agent evidence. Consumed by
epic features **f7-workflow-observability-floor** and
**f8-write-path-inline** (`.flow/epics/modernize-flow-s-supervisor-architecture/`).

## Measured on flow itself (primary evidence, reproducible)

| Measurement                                                                                  | Value                                                                                                                                                   | Source                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Stage-B run for PR #789: 5 `general-purpose` agents, 2 turns each, for 5 `gh`/`git` commands | ~48k cache-write + ~46k cache-read input tokens **per agent**, 40–540 output tokens; 241k subagent tokens, 137 s total                                  | `~/.claude/projects/-Users-gavingolden-code-me-flow/a4e24141-*/subagents/workflows/wf_63cdbb24-090/agent-*.jsonl` (`message.usage` fields) |
| Same commands as supervisor Bash calls would cost                                            | ~5 cache-read turns against the supervisor's existing prefix (≈0.1× input price each); roughly an order of magnitude less                               | pricing arithmetic, not a measured arm — verify in f8's eval gate                                                                          |
| f5 spike: trivial helper agents                                                              | ~30k subagent tokens and 5–15 s per trivial call (six-agent run: 179k tokens)                                                                           | `docs/workflow-spike/adr.md` row (1) and constraint 1                                                                                      |
| Eval after-arm vs before-arm, stage-A scenarios                                              | `s1-step7-ci-wait` $0.56 → $2.83 (+405%); `verify-loop-isolation/s1` $0.83 → $1.98 (+138%) — runs were cut short at turn-end, so these are lower bounds | `docs/eval/f6/README.md`                                                                                                                   |
| Eval before-arm scores (prose supervisor, n=2)                                               | 0.98 / 0.96 / 1.00 / 0.875 — the "prose skips steps" problem was real but small                                                                         | `docs/eval/f6/before/*/report.json`                                                                                                        |
| Supervisor context at the gated-feedback resume scenario                                     | 108k → 92k final context tokens (post-port smaller)                                                                                                     | `docs/eval/f6/after/checkpoint-pending-clear/report.json`                                                                                  |
| Live run defect class                                                                        | 3 review agents killed by the safety classifier → runtime returned `null` → script `TypeError`, no result file; diagnosable only from `journal.jsonl`   | `docs/eval/f6/live-run.md`                                                                                                                 |

## External evidence (AGY web-grounded pass, 2026-09-07; verify before citing further)

Prompt and raw output: this file's companion `subagent-design-research.agy.md`.
Sources the supervisor independently recognises as real and on-point:

- Cognition, "Don't Build Multi-Agents" — sequential write handoffs across
  agents fragment the codebase mental model; keep one writer, share state
  on disk. https://cognition.ai/blog/dont-build-multi-agents
- Cemri et al., "Why Do Multi-Agent LLM Systems Fail?" (MAST, arXiv
  2503.13657) — 1,600+ traces, 14 failure modes; "silent wrong result"
  (worker reports success on broken output) is a dominant class.
- Xia et al., "Agentless" (arXiv 2407.01489) — a plain procedure matched
  multi-agent systems on SWE-bench Lite at roughly $0.34/issue vs $2–10+.
- Anthropic, "How we built our multi-agent research system" — multi-agent
  wins on parallel read-heavy research; ~15× the tokens of a single chat;
  single-writer and structured handoffs are required.

Two AGY bullets over-reach and should NOT be cited: METR's time-horizon
work does not study multi-agent handoffs, and "Building Effective Agents"
does not quantify a cache penalty.

## Verdict the epic adopts

Parallel **read-only** fan-out (review lenses, discovery, blind survey) is
supported. Sequential **write** handoffs across cold workers (implement →
verify → fix; guard → merge → sweep) are not: they cost more, lose the
orchestrator's history, and fail silently. The f5 go/no-go rubric tested
only platform capability (can a workflow call helpers, resume, stop) and
never asked whether the substrate should carry the write path at all; that
gap is filed as a skill-vetting follow-up, not re-litigated here.

## What is NOT settled (feature agents should verify)

- The exact cost delta of the hybrid vs both arms — f8's eval gate measures it.
- Whether the review fan-out inside a workflow script is cheaper or dearer
  than the same fan-out spawned from the supervisor prose (it was already a
  Task fan-out pre-port); f8 should record both.
- Whether Haiku-pinned mechanical agents close enough of the 10× gap to keep
  any helper agents in scripts at all.
