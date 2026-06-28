# Component interaction

Portable component-level interaction judgment — the states a control must express and how it behaves under latency. Where `interaction-ux.md` covers Nielsen's heuristics as screen-level principles, this file operationalizes the two most relevant ones (heuristic 1, visibility of system status; heuristic 5, error prevention) into a per-control contract. Every principle is stated stack-neutrally; the framework that renders a spinner, a toast, or a disabled control is the stack skill's job. Canonical URLs live in `sources.md`.

## The interactive state model

Every interactive control must be able to express the states its situation demands, not just a default and a click. The canonical set (Material Design 3 interaction states; WAI-ARIA APG; Apple HIG):

- **Default / enabled** — the resting state.
- **Hover** — pointer is over the control; a pointer-only signal, never the sole affordance, since touch has no hover.
- **Focus** — the control holds keyboard focus; non-negotiable for keyboard operability and must be clearly visible (see `accessibility.md` — focus visibility).
- **Active / pressed** — the instant of actuation.
- **Loading** — an action is in flight (see below).
- **Disabled** — the control is non-interactive; use sparingly (see disabled-state semantics below).
- **Selected / checked** — for toggles, tabs, and options that hold a persistent chosen state.

A control that renders only default and pressed is incomplete: a missing hover or focus state fails pointer and keyboard affordance, and a missing loading or selected state leaves the user guessing whether anything happened. Material 3 models these as systematic state layers rather than bespoke per-state colors — the portable lesson is consistency across controls, not a specific overlay mechanic.

## Loading and double-submit prevention

When an action takes more than an instant, show that it is happening and stop it from firing twice. On submit of a form or any consequential action, **disable the triggering control and show an inline loading indicator** for the duration of the in-flight request — this is the canonical double-submit (double-click) prevention pattern, and it is the right, narrow use of a disabled state: a button cannot be re-fired while it is visibly working. Choose the indicator by wait length (Nielsen Norman Group):

- **Spinner** — short, indeterminate waits (under ~3s) where no progress estimate is available.
- **Determinate progress bar** — longer operations (over ~3s) where a percentage or step count can be shown; an open-ended spinner on a long wait reads as a hang.
- **Skeleton screens** — initial page or section loads; a layout-shaped placeholder bridges the "gulf of evaluation" by showing the structure the user is waiting for, which a blank screen with a centered spinner does not.

**Optimistic UI** is the complementary move for actions very likely to succeed: reflect the result immediately and reconcile (or roll back with a clear message) when the server confirms. Appropriate for low-stakes, high-success operations — not for irreversible ones.

## Response-time and feedback-latency thresholds

Three perceptual thresholds govern how a delay _feels_, independent of any specific technology:

- **0.1 second** — feels instantaneous; the limit for the user to feel they are directly manipulating the interface.
- **1.0 second** — keeps the user's flow of thought unbroken, though the delay is noticeable; no special feedback is needed below this, but acknowledge waits beyond it.
- **10 seconds** — the limit of held attention; past this the mind wanders and the task is at risk of abandonment, so a determinate progress indicator becomes mandatory.

Attribute these correctly: they originate with **Robert B. Miller (1968)**, were reinforced by Card, Robertson, and Mackinlay (1991), and were codified for the web by **Jakob Nielsen (1993)** — attribute to Miller, not Nielsen alone. Encode them as enduring **perception** thresholds about human cognition, explicitly **distinct from modern web-performance metrics** (Core Web Vitals — LCP, INP, CLS), which measure delivery speed, not perceived responsiveness. **Medium confidence** attaches only to framing them as "the current web standard": the thresholds themselves are durable, but treat them as perceptual budgets that sit alongside, not in place of, the current performance-metric set.

## Disabled-state semantics

The deliberate inversion that catches most generators: **do not disable a submit button until the form is valid.** GOV.UK and Nielsen Norman Group are explicit that disabled buttons fail contrast requirements, are undiscoverable by keyboard, and give the user no reason _why_ they cannot proceed — leaving them stuck with no path forward. Instead keep the primary action **always enabled** and validate **on submit**, surfacing specific, actionable errors that name exactly what to fix.

The two patterns are easy to conflate, so state them sharply:

- **Disable ON submit = GOOD.** After a valid click, disable and show a loading state for the in-flight request (the double-submit prevention above). This is the right, narrow use of a disabled state.
- **Disable UNTIL valid = DISCOURAGED.** A submit button greyed out until every field passes hides both the path forward and the reason for it. Prefer always-enabled plus validate-on-submit.

## Inline-validation timing

For per-field inline validation, the practitioner consensus is "reward early, punish late": surface an error only **on blur** (once the user has left the field), but clear a resolved error **on keyup** (the moment the input becomes valid). Flagging an error while the user is still typing scolds them mid-thought and raises abandonment. **Medium confidence** — this is blog-grade industry consensus (Smashing Magazine and general practice), not a formal standard; adopt it as a sensible default rather than a law, and align it with the form guidance in `interaction-ux.md`.

## Destructive-action patterns

For reversible destructive actions, a salient, persistent **Undo** beats a confirmation dialog. Users develop dialog fatigue and reflexively confirm without reading, so a confirm step often fails to prevent the very error it exists for, whereas Undo actually forgives the mistake (Nielsen Norman Group). Reserve confirmation dialogs for **catastrophic or genuinely irreversible** actions (permanent deletion with no recovery, destructive bulk operations) — and when you do confirm, make the dialog name the specific consequence rather than asking a generic "Are you sure?". This is the component-level expression of Nielsen's heuristic 3 (user control and freedom) and heuristic 5 (error prevention); see `interaction-ux.md`.

## Toast and snackbar conventions

Auto-dismissing toasts and snackbars should dwell **4–10 seconds** before disappearing (Material Design 3). Two hard constraints: a toast must **never be the sole carrier of critical information** (a user who looks away misses it for good), and it must **never hold interactive-only content** that vanishes on a timer — a disappearing action is an accessibility trap and violates **WCAG 2.2.1 Timing Adjustable**, which requires that users be able to turn off, adjust, or extend time limits. Use toasts for transient, non-essential confirmations; route anything critical or actionable to a persistent surface.

## Cross-references

- `interaction-ux.md` — the screen-level Nielsen heuristics these component contracts operationalize (visibility of system status, error prevention, user control and freedom).
- `accessibility.md` — focus management and visible focus, accessible names on controls, and why disabled controls fail contrast and keyboard discovery.

The mechanics that render these states — spinner components, toast libraries, the disabled attribute, ARIA state — live in the stack skill (`tailwind-shadcn` / `svelte`). Name the principle and its authority here; let the stack skill emit the mechanics.
