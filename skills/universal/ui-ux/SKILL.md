---
name: ui-ux
description: >-
  Apply portable, stack-agnostic UI/UX judgment — visual hierarchy, spacing
  rhythm, surface/depth, typography, color restraint, interaction states,
  and accessibility — grounded in named authorities (Nielsen heuristics,
  WCAG/POUR, Refactoring UI, Material, Apple HIG, Anthropic). TRIGGER when a
  request is about design or UX judgment regardless of framework: "make this
  feel less cluttered", "is this accessible?", "what's the right hierarchy
  here?", "this looks generic / like AI slop", "fix the spacing", "improve the
  empty/error state". SKIP and defer framework MECHANICS to the stack skills:
  "add a shadcn Dialog", "fix this Tailwind class", "write the Svelte runes" —
  those go to tailwind-shadcn / svelte.
---

# Goal

Produce UI that is intentional, usable, and accessible rather than generic. The job is to counter convergent defaults — the safe, statistically-average choices that make an interface immediately recognizable as machine-made, what Anthropic calls "AI slop" — and to balance aesthetics with usability, which reinforce each other rather than compete (the aesthetic-usability effect). This judgment is portable: it holds on any stack, so it lives in `universal/` and never emits framework code.

# When to Use

- A request is about design or UX *judgment*: "make this feel less cluttered", "what's the right hierarchy?", "is this accessible?", "this looks generic", "fix the spacing rhythm".
- Reviewing or critiquing an interface for visual quality, interaction completeness (loading / empty / error states), or accessibility.
- Deciding *what* a UI should communicate and *why* — before any framework-specific markup is written.

# When NOT to Use

- Writing the framework MECHANICS that render the judgment. Defer Tailwind / shadcn token, class, and component work to `tailwind-shadcn`. Defer Svelte 5 runes, stores, and component logic to `svelte`.
- Writing tests (defer to `testing`) or backend/data changes (defer to the relevant stack skill).

# Context

Load the relevant reference on demand — don't read all of them up front:

- [Curated sources + "why trusted" lines](references/sources.md) — the authorities every principle traces back to.
- [Visual design](references/visual-design.md) — hierarchy, spacing, surface/depth, typography, color, the anti-default stance.
- [Interaction and UX](references/interaction-ux.md) — Nielsen's 10 heuristics applied portably, plus forms and navigation.
- [Accessibility](references/accessibility.md) — WCAG POUR + the WAI-ARIA APG discipline.
- [Pre-submit critique protocol](references/critique-protocol.md) — the quality gate to run before declaring UI work done.

# Instructions

## 1. Establish the shared foundation (only when the work spans more than one screen or component)

Single-component work skips to the next step. When the task spans several pages or components — "apply this across the app", "redesign every page" — decide the shared design system *first* and record it as a durable artifact that the per-component work conforms to, rather than letting each component re-decide it. Extract it where one already exists (the type scale, spacing scale, color roles, surface/elevation model, focus and motion conventions, and the accessibility baseline); define it explicitly where it doesn't. This is the systems-over-screens discipline Refactoring UI and Material build on, and it is what lets Anthropic's coherence signal — typography, color, and layout reading as one intentional whole — hold across a whole surface instead of one screen at a time. Freeze the foundation before any per-component pass: components judged against a fixed contract stay consistent and can safely be worked in parallel, whereas components judged in isolation diverge — each one locally defensible, the set incoherent.

## 2. Clarify Design Intent

Before judging or producing anything, answer four questions (briefly for small tweaks, explicitly for new screens):

- **Who** is the user and what must they accomplish here?
- **Feel** — what should this feel like (dense and precise, calm and spacious, focused and minimal)?
- **Reject** — name at least one default you are consciously avoiding. If you can't name one, you haven't decided anything yet.
- **Reference** — is there an existing screen or product whose treatment sets a precedent to follow or react against?

## 3. Apply judgment, loading references on demand

Work the relevant strand and pull in only the reference you need (progressive disclosure):

- Layout, hierarchy, spacing, surfaces, typography, color → `references/visual-design.md`.
- States, feedback, forms, navigation, error/empty/loading → `references/interaction-ux.md`.
- Keyboard, focus, contrast, semantics, ARIA, reduced motion → `references/accessibility.md`.

Each principle there names its source inline; the framework that renders it stays with the stack skill.

## 4. Pre-submit critique

Before declaring the work done, run the gate in `references/critique-protocol.md`: walk composition/craft, interaction, accessibility, and distinctiveness; apply the one to three highest-impact fixes; and name one non-default choice you made. If you can't name one, return to the design-intent step. When the work spanned more than one component, the critique's composition check extends across the set — confirm each component matches the shared foundation and its siblings, not just that it coheres on its own.

# Anti-Patterns

Lead by rejecting the convergent defaults Anthropic documents — these are the specific moves that read as AI slop:

- **Generic fonts as the only typeface** — Inter / Roboto / Arial everywhere with no intentional choice or pairing.
- **Purple-on-white gradients** and other safe, overused decorative treatments applied by reflex.
- **Cookie-cutter layouts** — the same centered-card, evenly-spaced arrangement every prompt produces.
- **Timid, even color palettes** where every hue gets equal weight and nothing leads.
- **Flat, no-depth backgrounds** — single-fill surfaces with no layering or atmosphere.

Beyond those: one radius / one shadow / one spacing value repeated everywhere; hierarchy asserted by labels instead of size/weight/contrast; missing empty, loading, and error states; color used as the sole carrier of meaning; and icon-only controls with no accessible name. The expanded reasoning lives in `references/visual-design.md` and `references/critique-protocol.md`.

# Verification

- For multi-surface work, a shared foundation was established or extracted before any per-component judgment, and each component conforms to it (cross-component coherence, not just per-screen).
- The four design-intent questions were answered (who / feel / reject-a-default / reference).
- The pre-submit critique ran and at least one non-default choice can be named.
- Interaction states (loading, empty, error) exist where data can be absent or fail.
- Accessibility holds to the WCAG AA spot-check: keyboard-operable, visible focus, AA contrast, semantic structure, meaning not carried by color alone.

# Constraints

- NEVER emit framework-specific content from this skill — no utility classes, tokens, component primitives, or framework runes. The portability is the point; mechanics belong in `tailwind-shadcn` / `svelte`.
- NEVER reproduce a source's copyrighted text. Name the source inline and link the canonical URL once, in `references/sources.md`.
- Judgment is portable: state every principle so it holds on any stack, then let the stack skill render it.
