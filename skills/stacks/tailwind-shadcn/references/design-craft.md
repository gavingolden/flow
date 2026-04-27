# Design Craft Principles

## Anti-Default Philosophy

The core test: **if another AI would produce the same output given the same prompt, you failed.**

Every design choice — surface color, border radius, spacing, shadow — must be intentional and
explainable. Defaults are invisible decisions that accumulate into generic, forgettable interfaces.

Common defaults to reject:

- Same `rounded-lg bg-card p-4` on every container
- Uniform `gap-4` everywhere regardless of content relationship
- Every card at the same elevation
- Text in only one or two sizes
- Gray borders at identical opacity on all surfaces

Ask: "Why this value and not another?" If the answer is "it's the default," change it.

## Product Domain Context

This is a **financial/economic data platform**. The design language should communicate:

- **Precision** — data-dense layouts, monospaced numbers, tight alignment
- **Trust** — muted professional tones, restrained animation, no decorative excess
- **Clarity** — high data-ink ratio, minimal chrome, clear visual hierarchy

Color world: the oklch system in `src/app.css` already reflects this — cool neutrals, deliberate
accent colors. Lean into it. Avoid saturated decorative colors that compete with chart data.

## Surface Layering System

Surfaces communicate hierarchy through depth. Use the existing token progression:

| Layer   | Token           | Use                               |
| ------- | --------------- | --------------------------------- |
| Ground  | `bg-background` | Page background, lowest level     |
| Card    | `bg-card`       | Primary content containers        |
| Popover | `bg-popover`    | Elevated overlays, dropdowns      |
| Muted   | `bg-muted`      | Recessed areas, secondary regions |

Border progression: `border-border` for standard separation, `border-input` for form elements,
`border-ring` for focus states.

**Dark mode specifics:**

- Surfaces go lighter as they elevate (opposite of light mode intuition)
- Use border opacity to create subtle separation: `border-border/50` for gentle dividers
- Commit to one shadow strategy — in dark mode, shadows are nearly invisible; rely on surface
  color differences instead

**Rule:** No two adjacent containers should share the same surface + border treatment unless they
are peers in a list.

## Typography Hierarchy

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

Tailwind's 4px base grid. Spacing communicates content relationships:

| Context               | Spacing             | Rationale                           |
| --------------------- | ------------------- | ----------------------------------- |
| Card internal padding | `p-4` to `p-6`      | Breathing room for content          |
| Section gaps          | `gap-4` to `gap-6`  | Separation between content groups   |
| Tight data displays   | `p-2` to `p-3`      | Data density without claustrophobia |
| Related items         | `gap-1` to `gap-2`  | Items that belong together          |
| Unrelated sections    | `gap-8` to `gap-12` | Clear content breaks                |

**Rule:** Items that are semantically closer should be spatially closer. If two sections have the
same gap, ask whether they are actually equally related.

## Component Composition Patterns

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

- Use `lucide-svelte` exclusively for consistency
- Size icons to match adjacent text: `w-4 h-4` with `text-sm`, `w-5 h-5` with `text-base`
- Icons are secondary to text — use `text-muted-foreground` for decorative icons
- Never use an icon without a text label unless the meaning is universally clear (close, search, menu)
- Import individually: `import { ChevronDown } from "lucide-svelte"`
