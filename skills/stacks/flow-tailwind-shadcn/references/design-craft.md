# Design Craft Principles

Portable design judgment — the anti-default philosophy, hierarchy, spacing rhythm, surface/depth,
and typography _reasoning_ — lives in `universal/ui-ux` (`references/visual-design.md`). This file
is the Tailwind/shadcn mechanics layer: how that judgment maps to this repo's tokens. Each section
below pairs a one-line up-pointer with the retained token specifics.

## Anti-Default Philosophy

Portable principle: see `universal/ui-ux` — its Anti-Patterns and `references/visual-design.md`
carry the anti-default stance ("if another AI would produce the same output, you failed"). In this
repo's tokens, that means rejecting the defaults below:

- Same `rounded-lg bg-card p-4` on every container
- Uniform `gap-4` everywhere regardless of content relationship
- Every card at the same elevation
- Text in only one or two sizes
- Gray borders at identical opacity on all surfaces

## Product Domain Context

This is a **financial/economic data platform**. The design language should communicate:

- **Precision** — data-dense layouts, monospaced numbers, tight alignment
- **Trust** — muted professional tones, restrained animation, no decorative excess
- **Clarity** — high data-ink ratio, minimal chrome, clear visual hierarchy

Color world: the oklch system in `src/app.css` already reflects this — cool neutrals, deliberate
accent colors. Lean into it. Avoid saturated decorative colors that compete with chart data.

## Surface Layering System

Portable principle: see `universal/ui-ux` `references/visual-design.md` — depth communicates
hierarchy; elevated surfaces read lighter in dark mode; no two adjacent containers share treatment.
Tailwind token mechanics below.

Surfaces communicate hierarchy through depth. Use the existing token progression:

| Layer   | Token           | Use                               |
| ------- | --------------- | --------------------------------- |
| Ground  | `bg-background` | Page background, lowest level     |
| Card    | `bg-card`       | Primary content containers        |
| Popover | `bg-popover`    | Elevated overlays, dropdowns      |
| Muted   | `bg-muted`      | Recessed areas, secondary regions |

Border progression: `border-border` for standard separation, `border-input` for form elements,
`border-ring` for focus states.

**Dark mode token specifics:**

- Use border opacity for subtle separation: `border-border/50` for gentle dividers.
- In dark mode, shadows are nearly invisible — rely on the surface-color differences in the table above.

## Typography Hierarchy

Portable principle: see `universal/ui-ux` `references/visual-design.md` — 3+ typographic levels via
size/weight/contrast; decisive jumps. Tailwind token mechanics below.

Every screen should use **3+ levels** of typographic emphasis:

| Level     | Tokens                                                  | Use                            |
| --------- | ------------------------------------------------------- | ------------------------------ |
| Primary   | `text-foreground`, `text-lg`/`text-xl`, `font-semibold` | Page titles, key metrics       |
| Secondary | `text-foreground`, `text-base`, `font-medium`           | Section headers, labels        |
| Body      | `text-muted-foreground`, `text-sm`                      | Descriptions, supporting text  |
| Tertiary  | `text-muted-foreground`, `text-xs`                      | Timestamps, metadata, captions |

Financial data rules:

- Numbers use `font-mono` for column alignment
- Positive/negative values use `text-chart-2`/`text-destructive` (or similar semantic tokens)
- Large numbers get formatted with commas or abbreviations (1.2M, not 1200000)

## Spacing System

Portable principle: see `universal/ui-ux` `references/layout.md` — spatial proximity mirrors
semantic proximity (Gestalt grouping) and the base-unit spacing scale; items semantically closer are
spatially closer. Tailwind scale below.

Tailwind's 4px base grid. Spacing communicates content relationships:

| Context               | Spacing             | Rationale                           |
| --------------------- | ------------------- | ----------------------------------- |
| Card internal padding | `p-4` to `p-6`      | Breathing room for content          |
| Section gaps          | `gap-4` to `gap-6`  | Separation between content groups   |
| Tight data displays   | `p-2` to `p-3`      | Data density without claustrophobia |
| Related items         | `gap-1` to `gap-2`  | Items that belong together          |
| Unrelated sections    | `gap-8` to `gap-12` | Clear content breaks                |

## Component Composition Patterns

Portable principles: see `universal/ui-ux` — card anatomy and animation restraint in
`references/visual-design.md`; empty/error states in `references/interaction-ux.md`; the
interactive state model (default/hover/focus/active/loading/disabled) and loading-indicator
selection in `references/component-interaction.md`. Tailwind mechanics below.

**Card structure** — Cards are not just boxes. A well-composed card has:

- Header region (title + optional actions) with bottom border or spacing break
- Content region with appropriate density
- Optional footer with secondary actions or metadata

**Data display** — Tables and lists should:

- Right-align numeric columns
- Use consistent row height
- Alternate subtle backgrounds (`even:bg-muted/50`) only when rows are dense
- Header cells use `text-muted-foreground text-xs font-medium uppercase tracking-wider`

**Empty states** — Never leave a container blank. Provide:

- A muted icon (from `lucide-svelte`, sized `w-8 h-8` or larger)
- A short explanation in `text-muted-foreground`
- An action if applicable

**Loading states** — Use skeleton placeholders that match the expected content shape. Animate with
`animate-pulse` on `bg-muted` blocks.

**Interaction states** — Every interactive element needs: hover, focus-visible, active, and
disabled states. Use `transition-colors` for smooth feedback.

**Animation restraint** — Limit animation to feedback (hover, transitions) and state changes.
Duration: `duration-150` to `duration-200`. No decorative animation.

## Icon Guidelines

Portable principle: see `universal/ui-ux` `references/visual-design.md` — size icons to adjacent
text; icon-only controls need an accessible label. Tailwind/package mechanics below.

- Use `lucide-svelte` exclusively for consistency
- Size icons to match adjacent text: `w-4 h-4` with `text-sm`, `w-5 h-5` with `text-base`
- Icons are secondary to text — use `text-muted-foreground` for decorative icons
- Never use an icon without a text label unless the meaning is universally clear (close, search, menu)
- Import individually: `import { ChevronDown } from "lucide-svelte"`
