# Discovery prompt-interpretation procedure (read only when the prompt prescribes methods and names a quantitative target)

### Prompt interpretation (conditional)

This is the upstream artifact half of the `## Output style` rule **Treat user prompts as
evidence of intent, not exhaustive specifications.** in `AGENTS.md`. The rule body covers
the _why_ (PR #170 is the canonical precedent — four prescribed trims landed at -71 lines
vs a <800-line target, with no tension surfaced). This sub-section covers the _how_ —
what the discovery subagent must emit so downstream consumers (`/flow-new-feature` Step 2,
`/flow-pipeline` Step 3 routing, `/flow-pr-review` Step 1.5 Gatekeeper) can act on it.

**Trigger.** When the user prompt names BOTH (a) **prescribed methods** — typically a
numbered list, "do X then Y then Z" phrasing, an explicit enumeration of moves to make —
AND (b) a **quantitative target** — a number with units (`<800 lines`, `30% faster`,
`≤ 100ms`, `-N lines`), a coverage percentage, a latency budget — your PRD MUST include
a top-level `## Prompt interpretation` section.

Apply prose judgment for detection (NOT a regex catalogue). Signals worth weighting:
numbered lists (`1. Do X. 2. Do Y. 3. Do Z.`) or explicit enumeration ("the three changes
are…"); a number with units in the same prompt; "make X reach Y" / "reduce X to Y" /
"increase X to Y" framing pairs a method (the verb) with a target (Y). Two signals does
not guarantee tension — sometimes the methods clearly reach the target. The Recommended
path captures that.

**Omit-when-no-tension.** When discovery surfaces neither signal — or only one — omit the
`## Prompt interpretation` section entirely. Same omit-when-empty rule as the
`# Candidate follow-up issues` section above: an empty heading adds noise and risks
downstream consumers treating absent-tension prompts as tension-flagged (the
`/flow-pipeline` Step 3 routing helper exact-matches against the four-value enum below
and a missing heading is treated as "no tension", but an empty heading would be ambiguous
to a human reading the file).

**Section shape.** Three subsections, in this order:

All three are bullets of the form `- **Label:** value` — the label, a colon, and the
value on the **same line**. Emit them exactly that way; the colon-same-line shape is what
the consumer parses (see the Recommended-path bullet below).

- **Reading of prescribed methods:** one of `exhaustive` (the user intends the named
  methods as the complete set) or `starting points` (the user is signalling these are
  minimum moves; you may extend). Anchor on the user's framing — verbs like
  "specifically" / "exactly these" / "only" lean exhaustive; verbs like "for example" /
  "such as" / "to start with" lean starting points; ambiguous framing defaults to
  `starting points` since literal-spec failures (PR #170) are more costly than
  over-eager extensions.

- **Plausibility estimate:** your honest read on whether the named methods can plausibly
  reach the named target. Cite evidence (file sizes, current measurements, existing
  patterns) rather than speculation. When you do not have evidence and cannot easily get
  it, say so — "uncertain — would need to run X to verify".

- **Recommended path:** one of these four strings, copied verbatim — emitted on the SAME
  line as the `**Recommended path:**` label, in the literal one-line form
  `- **Recommended path:** <enum value>`. The `/flow-pipeline` Step 3 routing helper at
  `bin/flow-step3-route.ts` machine-parses this one-line colon form and exact-matches
  against the first string; drift here (a label on its own line, a missing colon, a
  paraphrased value) silently routes runs the wrong way, so emit the value **bare** — no
  surrounding backticks, no bold, no trailing punctuation, on the same line as the colon —
  so the producer here and the consumer (`bin/flow-step3-route.ts`) agree on an exact
  string:
  - `methods plausibly reach target` — the prescribed methods fully cover the stated
    target without extension. No tension; downstream consumers treat the run as if no
    `## Prompt interpretation` section existed (same routing outcome).
  - `extend scope with named additional safe steps` — the prescribed methods leave a
    gap and you can name specific additional steps that close it. Surface those steps
    in the `# Task breakdown` as additional tasks marked as the extension (e.g.
    Task N: "scope extension — covers the gap between prescribed methods and target").
  - `relax target` — the prescribed methods are correct but the target is unreachable
    without scope blow-up (e.g. "<800 lines" requires deleting load-bearing prose).
    Name what you'd cut and why; the user can choose to accept the looser target or
    redirect.
  - `split into multiple pipelines` — the prescribed methods and target together require
    effort that exceeds a single PR (multiple migrations, breaking changes to a public
    API). Name the natural seams; the user can decide whether to file the rest as
    candidate follow-up issues.

**Open-Questions emission rule.** When the Recommended path is NOT
`methods plausibly reach target`, the PRD's `## Open Questions` section MUST include one
user-facing question naming the choice. Example: "Extend scope to add X and Y, or relax
the target to a looser bound?". The question gives the user a single redirect to resolve
the tension at the next `plan-pending-review` checkpoint without re-running discovery.
When the Recommended path IS `methods plausibly reach target`, no Open-Questions entry
is needed (the prompt and the methods are in agreement).

**Single source of truth.** The four enum values and the Open-Questions emission rule
above live in this file ONLY. Downstream consumers — the helper at
`bin/flow-step3-route.ts`, `/flow-new-feature` Step 2 (Critical Analysis), `/flow-pr-review`
Step 1.5 Gatekeeper — reference this file by path rather than duplicating the contract
inline. Drift between this file and a duplicated copy is exactly the silent-failure
mode PR #170 demonstrates; do not inline the enum or anti-pattern list in
`templates/prd-template.md` or in the consumers' SKILL.md files.
