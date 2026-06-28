# Layout

Portable layout and composition judgment — grids, spacing rhythm, grouping, alignment, reading patterns, responsive strategy, and layout archetypes. This is the spatial-composition spine: how a screen is _structured_ before it is styled. Every principle here is stated stack-neutrally; the framework that renders it (grid and flex primitives, container queries, spacing scales) is the stack skill's job. Canonical URLs and "why trusted" lines live in `sources.md`.

## Grid and column systems

Compose on a shared grid rather than placing elements at arbitrary pixel offsets. A column grid — most commonly a 12-column grid, because 12 divides cleanly into halves, thirds, quarters, and sixths — gives every element a small set of legal positions, so components align to a common spine and the layout reads as deliberate rather than improvised. Material Design 3 and IBM Carbon's 2x Grid both express the responsive grid as columns plus gutters plus margins that adapt at defined breakpoints; the GOV.UK Design System builds page structure on the same idea. The portable rule is not "always 12 columns" but "decide the grid first, then place content on it" — a grid is what makes alignment systematic instead of per-element, and what gives a multi-region screen a shared rhythm.

## The 8-point spacing system (a convention, not a standard)

Size spacing — margins, padding, gaps — from a single scale built on a base unit, conventionally 8px, with a 4px sub-unit reserved for tight component-level spacing (icon-to-label gaps, control padding). Working in multiples of one base unit removes per-value decision-making and produces a visible, repeating rhythm. Treat this explicitly as a **de facto industry convention, not a formal standard**: it is popularized by practitioner systems (Material Design uses an 8px base as its spacing foundation; _Refactoring UI_ argues for a constrained spacing scale) rather than codified by any specification, and "8-point" is partly branding for what is really a 4-point system underneath. The medium-confidence framing matters — adopt a consistent base-unit scale because the rhythm and the removed decision-fatigue are real, not because 8 is a law.

## Gestalt grouping

The eye groups elements before the mind reads them, so spatial arrangement carries meaning on its own. The Gestalt principles — **proximity** (near things read as related), **similarity** (shared color, shape, or size reads as a set), **common region** (a shared container or card binds its contents), **continuity** (elements on a line or curve read as a sequence), **closure** (the eye completes implied shapes), and **figure/ground** (the focal element separates from its background) — originate in early-twentieth-century perceptual psychology (Max Wertheimer, Kurt Koffka, Wolfgang Köhler) and are applied to interfaces by the Interaction Design Foundation. Proximity is the load-bearing one for layout: it is the same idea as spacing-mirrors-relationship (see `visual-design.md` — Spacing and rhythm) seen from the grouping side. Treat Gestalt as descriptive of how perception works (high confidence that it operates) rather than a rigid template — group with proximity and common region first, and reach for a border only when grouping alone is insufficient.

## Alignment, rhythm, and active whitespace

Give every element a deliberate horizontal and vertical alignment relationship with others; a shared edge or baseline creates an "invisible order" that makes a screen scannable (Apple HIG — Layout). Whitespace is a structural material, not leftover space: deliberate negative space sets the visual rhythm that paces the eye through the hierarchy, and _active_ whitespace (placed to group and separate) does more work than uniform padding sprinkled everywhere. Alignment and the grid reinforce each other — the grid supplies the legal positions, and alignment is the discipline of actually snapping to them rather than nudging elements by eye.

## Reading and scanning patterns (with a caveat)

Users scan; they do not read interfaces word-for-word. Nielsen Norman Group's eye-tracking work names recurring shapes — the **F-pattern** (heavy attention along the top and down the left edge, tapering as it descends), the **Z-pattern** (a corner-to-corner sweep on sparse, promotional layouts), and the **layer-cake** pattern (eyes jumping between headings and subheadings, skipping the body in between). The actionable inverse: put high-value content, navigation, and primary calls-to-action where the scan lands, and write scannable headings and subheadings so the layer-cake scan finds real structure. **Caveat (medium confidence):** the F-pattern emerges mainly on _text-heavy, poorly-formatted_ pages with weak hierarchy — NNG frames it as much a symptom to design _against_ (with grouping, clear hierarchy, headings, and chunking) as a path to exploit. Do not engineer an F into a well-structured screen; treat these patterns as a diagnosis of where attention defaults when structure is missing.

## Responsive strategy

Treat responsive layout as one coherent narrative, not a pile of breakpoint overrides:

- **Mobile-first** — design the narrow layout first and let it expand; starting wide and cramming down loses the content priority the narrow view forces you to decide.
- **Content-driven breakpoints** — add a breakpoint where the _content_ breaks (lines grow too long, a row gets too cramped), not at fixed device widths. The device landscape is too varied to target by name.
- **Intrinsic and container-driven layouts** — prefer components that respond to their own available space (wrapping, container queries) over a single set of global viewport breakpoints, so a component stays resilient wherever it is placed (_Every Layout_, web.dev — Learn Responsive Design).
- **Constrained measure** — cap line length to a comfortable measure of roughly 50–80 characters; longer lines fatigue the eye as it tracks back to the start of the next line.

The accessibility floors that bound the responsive range — **WCAG 1.4.10 Reflow** (no loss of content and no horizontal scrolling at a 320px width) and the touch-target minimums — are not duplicated here; they live in `accessibility.md`, and the responsive judgment cross-links them rather than restating them.

## Constrained content width and centering

Cap the width of text and primary content, and center the constrained column rather than letting it stretch (_Refactoring UI_). Line length has a comfortable ceiling — text that runs edge-to-edge across a wide monitor is hard to read, and a constrained, centered column reads as intentional. Two failure modes are equally defects: a column that loses its centering and jams against one edge on wide viewports, and content stretched full-bleed across a huge monitor with no width cap. The portable rule is to give primary content a maximum width and keep it centered as the viewport grows; the framework mechanic that renders it (a container utility, a centered max-width wrapper) belongs to the stack skill. This file is the authoritative home for the constrained-width judgment — `visual-design.md` keeps a one-line pointer here, and the responsive half (reflow at narrow widths) lives in `accessibility.md`.

## Layout archetypes

Reach for established macro-structures that match users' existing mental models rather than inventing bespoke ones (web.dev — Layout patterns; _Every Layout_):

- **Holy-grail** — header, footer, and a main column flanked by one or two sidebars; the conventional application shell.
- **Sidebar** — a fixed or collapsible navigation/utility rail beside a fluid main region.
- **Split view** — a list/master pane beside a detail pane (inbox, settings, file browser).
- **Dashboard / card grid** — a responsive grid of cards or tiles for at-a-glance, heterogeneous content.

Pick the archetype that fits the content and the task, then compose it on the grid. A mismatch is itself a layout defect — a dashboard forced into a single scrolling column wastes wide viewports, and a long-form reading view split into panes fragments the text.

## Where the mechanics live

The judgments above are portable. The framework primitives that render them — grid and flex utilities, container queries, breakpoint variants, and spacing tokens — live in the stack skill (`tailwind-shadcn`), which cross-references this file for the rationale. Name the principle and its authority here; let the stack skill emit the mechanics.
