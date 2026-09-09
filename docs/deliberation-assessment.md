# Blind second-opinion judge: what the evidence supports

Companion to `bin/flow-deliberate.ts`, `skills/universal/flow-deliberate/SKILL.md`, and
the Deliberation step in
`skills/pipeline/flow-product-planning/references/discovery-instructions.md`.
This note records why the judge has the shape it has, what the published
evidence does and does not support, and the condition under which the
discovery wire should be removed.

Same purpose as `docs/nested-subagents-assessment.md`: a repo-only assessment
that keeps a design decision auditable after the reasoning that produced it has
scrolled out of anyone's memory. Not shipped by `flow install`.

## Premise

flow sometimes reports that it has no answer, or hands a design fork back to
the user, on a question the repository could settle. The user's own observation
is the starting evidence: pressing with _"consider all options, weigh the pros
and cons of each, identify which are complementary vs exclusive, and give a
final recommendation"_ often produces a sound answer from the same model that
had just declined.

That gap is the top-ranked cost in `.flow/product.md`'s ranked priorities: an
interruption on a question the system could have resolved itself. The question
this note answers is not "would a second opinion be nice" but **"is there
published evidence that an isolated, blind, structured second pass beats the
first pass — and evidence about which designs would waste the money?"**

## Evidence

Each row was verified against the named paper, not a homepage or a secondary
summary. Confidence is about the claim's support in the literature, not about
how much flow relies on it.

| Claim                                                                          | Confidence              | Source                                                                                                                                          | What it changed in the design                                                                                  |
| ------------------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Models sycophantically follow a stated user lean                               | high                    | Sharma et al. 2023, [arXiv:2310.13548](https://arxiv.org/abs/2310.13548) (ICLR 2024)                                                            | `--blind-to-file` and the mechanical `question-not-blind` refusal — blindness is enforced, not requested       |
| Information in the middle of a long context is used poorly                     | high                    | Liu et al. 2023, [arXiv:2307.03172](https://arxiv.org/abs/2307.03172) (TACL)                                                                    | an isolated subprocess with only the question, not a "think harder" re-prompt inside the existing transcript   |
| Intrinsic self-correction without external feedback does not reliably help     | high                    | Huang et al. 2023, [arXiv:2310.01798](https://arxiv.org/abs/2310.01798) (ICLR 2024)                                                             | the judge verifies claims against the repository; there is deliberately no "now review your own answer" step   |
| Structured reasoning / sampling is a strong single-model baseline              | high                    | Wang et al. 2022, [arXiv:2203.11171](https://arxiv.org/abs/2203.11171); Wei et al. 2022, [arXiv:2201.11903](https://arxiv.org/abs/2201.11903)   | the four-step protocol in one call, rather than an ensemble                                                    |
| Rewriting the input to strip opinionated content reduces sycophancy            | medium                  | Weston & Sukhbaatar 2023, [arXiv:2311.11829](https://arxiv.org/abs/2311.11829)                                                                  | step 1 of the protocol: restate the question stripped of its framing                                           |
| Larger models are reasonably calibrated _in the right format_, not universally | medium                  | Kadavath et al. 2022, [arXiv:2207.05221](https://arxiv.org/abs/2207.05221)                                                                      | confidence is derived from the anchor class and mechanically demoted, never taken as asserted                  |
| Multi-agent debate can improve factuality on some tasks                        | medium (task-dependent) | Du et al. 2023, [arXiv:2305.14325](https://arxiv.org/abs/2305.14325); Liang et al. 2023, [arXiv:2305.19118](https://arxiv.org/abs/2305.19118)   | considered and **not adopted** — see Counter-evidence                                                          |
| Multi-persona single-call prompting and step-back prompting help on some tasks | medium                  | Wang et al. 2023, [arXiv:2307.05300](https://arxiv.org/abs/2307.05300); Zheng et al. 2023, [arXiv:2310.06117](https://arxiv.org/abs/2310.06117) | step-back restatement kept; personas cut                                                                       |
| Structured analytic techniques reduce premature closure                        | **unverified**          | Heuer & Pherson, _Structured Analytic Techniques for Intelligence Analysis_                                                                     | cited by a blind-survey judge during planning; **not verified against the source** and load-bearing on nothing |

## Counter-evidence

The rows that killed the more elaborate designs. These were the decisive
evidence, so they get their own section rather than a line in the table above.

| Finding                                                                                                                                      | Confidence                                            | Source                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Multi-agent debate does not reliably beat self-consistency or plain CoT at equal budget, and reported gains are sensitive to hyperparameters | high                                                  | Smit et al. 2024, [arXiv:2311.17371](https://arxiv.org/abs/2311.17371) (ICML 2024) |
| Persona/role-assignment variants are inconsistent and do not reliably improve reasoning                                                      | high                                                  | Zhang et al. 2025, [arXiv:2502.08788](https://arxiv.org/abs/2502.08788)            |
| Multi-agent systems consume on the order of 15× a chat's tokens                                                                              | medium (vendor engineering report, not peer-reviewed) | Anthropic engineering, "Building a multi-agent research system"                    |

Read together: the expensive designs — debate rounds, simulated personas,
several judges — are the ones with the weakest evidence per dollar. A single
structured pass is the evidence-backed default, and it is also the cheapest
thing that could work. That is an unusually comfortable alignment, and it is
the reason this feature is small.

## What this does not prove

Honest limits, because the tripwire below exists precisely because these hold:

- **The benchmarks are not this task.** Every cited result is on math, QA, or
  factuality benchmarks with a checkable ground truth. flow's judge answers
  open design questions — "should this live in `bin/` or `scripts/`" — where
  there is no ground truth and no benchmark. Calibration measured on GSM8K
  says little about calibration on a repo-layout fork.
- **Claude judging Claude is a weaker independence guarantee than it looks.**
  The judge is blind to the caller's lean, which is what the sycophancy
  evidence is about. It is _not_ independent of the model family's shared
  priors: both sides may be wrong in the same direction, and no amount of
  blindness fixes that. A cross-model judge would be genuinely independent;
  that was deliberately deferred (the `research` module is optional, and the
  ad-hoc surface must work on a bare install).
- **No measurement of flow's own adoption quality exists yet.** Nothing here
  establishes that adopted `medium`/`high` recommendations are _right_. The
  telemetry below is the instrument for finding out; until it has data, the
  honest statement is that this is a well-motivated bet, not a proven win.
- **The counter-evidence is against debate, not for this.** Smit et al. and
  Zhang et al. justify _not_ building the expensive thing. They do not
  establish that a blind second pass beats no second pass at all.

## Design consequences

Each is traceable to a row above, so a future edit can see what it is
overturning:

1. **One bounded call, no debate, no personas** — Smit et al. 2024; Zhang et
   al. 2025. Also the cheapest option, which is priority 2 in the product
   brief.
2. **An isolated subprocess, not a re-prompt in the transcript** — Liu et al.
   2023 (lost in the middle) plus Sharma et al. 2023 (the transcript carries
   the lean). This is also why the in-process "tier 1" re-prompt was cut during
   plan review: self-prompting inside the anchored context pre-empts the blind
   call while inheriting exactly the anchoring the call exists to escape.
3. **Blindness is mechanically enforced** — Sharma et al. 2023.
   `briefLeaksCorpus` refuses a question that contains an 8-word run of the
   caller's own lean, _before_ spending anything. A rule the caller could
   forget is not a guarantee.
4. **Verify against the repo; no self-review step** — Huang et al. 2023. The
   protocol's step 3 is external checking, which helps; "review your answer",
   which does not, is absent.
5. **Confidence is anchor-derived and demoted mechanically** — Kadavath et al. 2022. A judge claiming `high` on an unverifiable anchor is demoted to `low`
   by `bin/flow-deliberate.ts`, which routes it to the caller's existing escape.
   This is the single most important safety property: it is what stops a
   confident-sounding guess from being laundered into a settled fact.
6. **One wired site, not a global rule** — not an evidence consequence but a
   context-proximity one, and the user's own stated concern: a rule in
   `AGENTS.md` sits furthest from the decision point and is the first thing
   skipped under load. `AGENTS.md` is also within a few characters of its
   26,000-char lint budget. The wire is site-local and pinned by a lint.

## Kill criterion

**Remove the discovery wire if more than 20% of adopted `medium`/`high`
recommendations are redirected by the user at plan review, over the first 20
consults.**

The judge's job at that site is to shrink the answer sheet without changing
what ships. An override rate above one in five means it is not resolving
questions but pre-answering them wrongly, which is worse than the escape it
replaced — the user now has to notice and undo a decision instead of simply
making one.

Removing the wire leaves `/flow-deliberate` and the helper in place: the ad-hoc
surface has a human in the loop by construction and is not what this criterion
measures.

The 20% threshold is a judgment call, not a derived number — there is no prior
to derive it from. It is set where an override stops feeling like normal
disagreement and starts feeling like noise. Revise it once there is data, and
say so here when you do.

## Measuring the override rate

`bin/flow-deliberate.ts` emits one `deliberate.call` event per consult —
including skips, so judge silence is as visible as judge spend — to
`~/.flow/telemetry/events.jsonl` (`bin/lib/telemetry.ts`).

Consults that produced an adopted-eligible answer:

```sh
jq -r 'select(.event == "deliberate.call" and .attrs.ran == true
       and (.attrs.confidence == "medium" or .attrs.confidence == "high"))
       | [.slug, .attrs.task, .attrs.confidence] | @tsv' \
  ~/.flow/telemetry/events.jsonl
```

Total judge spend, and spend per outcome:

```sh
jq -s 'map(select(.event == "deliberate.call"))
       | {calls: length,
          ran: (map(select(.attrs.ran == true)) | length),
          demoted: (map(select(.attrs.anchor_demoted == true)) | length),
          usd: (map(.attrs.total_cost_usd // 0) | add)}' \
  ~/.flow/telemetry/events.jsonl
```

Slugs where a judge answered and the plan was then redirected — the numerator
of the override rate. `phase.transition` records a re-entry to `planning` after
`plan-pending-review`, which is what a redirect looks like on disk:

```sh
jq -r 'select(.event == "deliberate.call" and .attrs.ran == true
       and (.attrs.confidence == "medium" or .attrs.confidence == "high"))
       | .slug' ~/.flow/telemetry/events.jsonl | sort -u > /tmp/judged.txt

jq -r 'select(.event == "phase.transition" and .attrs.phase == "planning")
       | .slug' ~/.flow/telemetry/events.jsonl | sort | uniq -d > /tmp/redirected.txt

comm -12 /tmp/judged.txt /tmp/redirected.txt | wc -l   # numerator
wc -l < /tmp/judged.txt                                # denominator
```

**Caveat worth stating before anyone acts on the number:** this is a
slug-grained proxy, not a per-question one. A pipeline that consulted the judge
about Q3 and was redirected about Q7 counts as an override here. Treat a rate
near the threshold as a prompt to read the `deliberated (` lines in those
plans, not as a verdict. Tightening this into a per-question measurement needs
the eval suite tracked as a candidate follow-up.
