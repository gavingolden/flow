# Skill description convention

Issue #844 named a real cost: every installed skill's frontmatter
`description:` is always-loaded (it is what Claude Code scans to decide
whether to offer the Skill tool), so a bloated description is paid on
every session regardless of whether the skill ever fires. This document
states the retention rule that keeps a description small without
degrading trigger recall, the argument behind it, and the detector that
catches a regression before it ships.

## The retention rule

A skill description must retain:

- **(a) The object it acts on, in the user's own vocabulary.** The noun
  phrase a user would use to describe the thing the skill touches —
  not flow's internal name for it.
- **(b) At least one verbatim phrase a user would actually type.** A
  trigger example lifted from how a real request is worded, not a
  paraphrase or a category label.
- **(c) Every SKIP clause that names a sibling skill.** Any "use X
  instead when ..." disambiguation against another installed skill —
  dropping this is a routing regression, not a length saving.

Everything else — restated triggers that don't add a new phrase, worked
examples, and file-extension lists already implied by (a) — is cuttable.

## Why this split

(a) and (b) are the **routing signal**: they are what lets the model
match an unseen user request against this skill without having seen the
exact wording before. (c) is the **disambiguation signal**: it is the
only clause class with a mechanical, observable failure mode — cut it
and two sibling skills collide on the same trigger, and the model has no
textual basis left to pick between them. A phrase that is neither (a),
(b), nor (c) is decoration: it costs tokens on every session and buys no
measurable improvement in either routing or disambiguation.

## The detector: a committed trigger set replayed through the eval loop

Retention is not enough on its own — a rule that "should" preserve
recall still needs a way to catch the case where it doesn't. The
detector is a **committed per-skill trigger set**: a fixture listing the
phrases a description claims to fire on, plus a set of near-miss phrases
it must explicitly NOT claim (the sibling-collision cases (c) exists to
prevent). That fixture is replayed through the existing trigger-rate
loop at `skills/universal/flow-skill-creator/scripts/run_loop.ts`
(verified present in this repo at the time of writing), with the
**pre-trim rate recorded as the baseline in the same commit** that trims
the description. A trimmed description that scores below its own
recorded baseline fails — the commit that shrank the description is the
commit responsible for proving it didn't also shrink recall.

## Honest caveat

No measured evidence was found that cutting a SKIP clause naming a
sibling skill actually degrades recall in practice — the eval loop above
has not yet been run against a real before/after pair for this specific
clause class. The rule is deliberately conservative anyway, but only on
the one clause class with a _mechanical_ failure mode (two skills
claiming the same trigger with no disambiguating text left): dropping a
sibling-SKIP clause is the one cut that content-inspection alone can
show breaks something, independent of any eval run. The other cuts
((a)/(b) retention, everything-else removal) are argued from the
routing-signal reasoning above, not from a measured regression.
