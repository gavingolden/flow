---
name: tailwind-shadcn
description: >-
  Build or modify Tailwind CSS v4 / shadcn-svelte UI in this repo.
  TRIGGER when: `.svelte` styling, `tailwind.config`, `@theme`
  directives, `$lib/components/ui/*` primitives (`bits-ui`,
  `@lucide/svelte`). SKIP when: non-Tailwind UI (MUI, Chakra,
  Bootstrap, styled-components, CSS-in-JS).
---

# Goal

Implement accessible, keyboard-navigable, and responsive UI components using the project's Tailwind CSS v4 design
system and shadcn-svelte primitives. Every design choice should be intentional and explainable — not the default
output another AI would produce.

# When to Use

- Building new UI layouts or pages
- Styling existing components
- Integrating shadcn-svelte (bits-ui) primitives
- Working with the ECharts theme
- Implementing dark/light mode theming

# When NOT to Use

- Writing Svelte component logic without styling concerns (defer to `svelte`)
- Writing tests for components (defer to `testing`)
- Database or backend changes (defer to `supabase-project`)
- Projects whose UI layer is a non-Tailwind design system: Material UI
  (`@mui/material`), Chakra (`@chakra-ui/react`), Bootstrap, Bulma,
  `styled-components`, `@emotion/*`, `@vanilla-extract/*`, or pure CSS
  Modules / CSS-in-JS with no Tailwind context.

# Context

- Base UI components (shadcn-svelte): `src/lib/components/ui/`
- Layout shell: `src/lib/components/layout/` (e.g., `AuthenticatedLayout.svelte`)
- Design tokens and CSS variables: `src/app.css` (`:root` and `.dark` blocks)
- Icons: `@lucide/svelte` (the maintained scoped package; import individually: `import { ChevronDown } from "@lucide/svelte"`). Older projects may still use `lucide-svelte` — both work but `@lucide/svelte` is the current package.
- Toasts: `svelte-sonner` (import `toast` from `"svelte-sonner"` — `<Toaster>` is already mounted in the root layout)
- Class utility: `cn()` from `$lib/utils` (wraps `clsx` + `tailwind-merge`)
- Tailwind v4 configuration: CSS-first via `@theme inline` in `src/app.css` (minimal `tailwind.config.js` for content globs and font family)
- Tailwind v4 details: `references/tailwind-v4.md`
- Design token reference: `references/design-tokens.md`
- Design craft principles: `references/design-craft.md`
- Component patterns (layout, forms, bits-ui child snippets): `references/component-patterns.md`
- Post-build critique protocol: `references/critique-protocol.md`

# Instructions

## 1. Clarify Design Intent

Before writing any code, answer these questions (mentally for minor changes, explicitly for new
components or pages):

- **Who** is the user and what must they accomplish here?
- **Feel** — what should this feel like? (e.g., data-dense dashboard, clean onboarding, focused
  detail view)
- **Reject** — what default are you consciously avoiding? Name at least one.
- **Reference** — does an existing page or component in the app set a precedent to follow?

For minor styling tweaks (color change, spacing fix), a quick mental check suffices. For new
components or significant redesigns, state the intent before proceeding.

See `references/design-craft.md` for the anti-default philosophy and domain context.

## 2. Check Existing Components

**CRITICAL:** Always check `src/lib/components/ui/` for shadcn-svelte primitives before building
custom ones.

### Import styles

shadcn-svelte components use two import patterns depending on whether they have subparts:

**Compound (namespace) import** — for multi-part components:

```svelte
import * as Card from "$lib/components/ui/card";
<!-- then use <Card.Root>, <Card.Header>, <Card.Title>, <Card.Content>, <Card.Footer> -->
```

**Named import** — for single-element components:

```svelte
import {Button} from "$lib/components/ui/button";
```

### Component quick reference

| Import Style              | Components                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Compound** (`import *`) | `AlertDialog`, `Calendar`, `Card`, `Collapsible`, `Combobox`, `Dialog`, `DropdownMenu`, `Popover`, `Select`, `ToggleGroup`, `Tooltip` |
| **Named** (`import { }`)  | `Button`, `Input`, `Label`, `Separator`, `Skeleton`, `Toggle`, `InlineLabel`                                                          |
| **Special**               | `Toaster` from `$lib/components/ui/sonner` (already mounted in root layout)                                                           |

### bits-ui child snippet

When compound Trigger components need a custom element instead of the default `<button>`, use
the `child` snippet pattern. This is common when composing triggers with styled Buttons or nesting
multiple trigger components. See `references/component-patterns.md` for the full pattern and
nested composition examples.

### Usage example

```svelte
<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
</script>

<Dialog.Root>
  <Dialog.Trigger>
    <Button variant="outline">Open</Button>
  </Dialog.Trigger>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Confirm Action</Dialog.Title>
      <Dialog.Description>Are you sure?</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="ghost">Cancel</Button>
      <Button>Confirm</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
```

## 3. Class Composition with `cn()`

Always use `cn()` from `$lib/utils` to compose Tailwind classes. It wraps `clsx` + `tailwind-merge`,
so conflicting utilities resolve correctly and conditional classes work cleanly.

```svelte
<script lang="ts">
  import { cn } from "$lib/utils.js";

  interface Props {
    class?: string;
    active?: boolean;
  }
  let { class: className, active = false }: Props = $props();
</script>

<div class={cn("bg-card rounded-lg border p-4", active && "ring-primary ring-2", className)}>
  <!-- content -->
</div>
```

The `className` prop at the end lets consumers override base styles (e.g., `<MyCard class="mt-4" />`).
Never concatenate class strings manually — `cn()` handles deduplication and conflict resolution
(e.g., `cn("p-4", "p-6")` correctly outputs `p-6`).

## 4. Component Checkpoint

Before building each significant component, briefly state:

- **Intent** — what this component communicates (not what it renders)
- **Surface** — which surface layer and why (background, card, muted, popover)
- **Typography** — which hierarchy levels are present and why
- **Spacing** — what rhythm and why (tight data vs. spacious content)

This takes one sentence per bullet. The purpose is to force intentional decisions before
writing markup. Skip for trivial changes (swapping an icon, fixing a typo).

See `references/design-craft.md` for surface layering, typography, and spacing systems.

## 5. Styling

- Use semantic color tokens: `bg-background`, `text-foreground`, `border-border`, etc.
- Use `text-positive` / `text-negative` for financial gain/loss indicators.
- Reference `references/design-tokens.md` for the full token list.
- Use `dark:` variant for dark-mode-specific overrides when needed.
- Prefer responsive utilities (`sm:`, `md:`, `lg:`) for layout changes.

## 6. Theming

- Light/dark tokens are defined in `:root` and `.dark` blocks in `src/app.css`.
- Components automatically inherit theming via CSS variables — avoid hardcoding colors.
- If adding new design tokens, add them to both `:root` and `.dark`, and register in `@theme inline`.
  See `references/tailwind-v4.md` for the full process.
- **Theme switching** uses `mode-watcher`: import `setMode`, `mode`, `userPrefersMode` from
  `"mode-watcher"`. The existing `ThemeSelector.svelte` (at `$lib/components/ui/ThemeSelector.svelte`)
  and `mode-toggle.svelte` already implement theme switching — reuse or extend them rather than
  building a new toggle.

## 7. Toast Notifications

Use `svelte-sonner` for user feedback. The `<Toaster>` component is already mounted in the root
layout — do not add another instance.

```svelte
import { toast } from "svelte-sonner";

toast.success("Dashboard created");
toast.error("Failed to save", { description: error.message });
```

## 8. Charting Integration

- Chart colors should use the `--chart-1` through `--chart-20` CSS variables defined in
  `src/app.css`. Don't hardcode chart colors elsewhere.
- When the project includes a charting theme module, sync it with these CSS variables.

## 9. Accessibility & Keyboard Navigation

- shadcn-svelte primitives handle keyboard navigation by default — don't override it.
- Provide `aria-label` for icon-only buttons.
- **ARIA interactive widgets:** When using interactive ARIA roles (`role="separator"`,
  `role="slider"`), include `tabindex="0"` and keyboard event handlers. Add `svelte-ignore`
  comments in Svelte to suppress false-positive a11y lint warnings on these elements.

## 10. Responsive Design

- Design mobile-first. Tailwind breakpoints: `sm:` (640px), `md:` (768px), `lg:` (1024px), `xl:` (1280px).
- **Responsive show/hide:** Use opacity transitions instead of `hidden`/`block` for progressive
  disclosure on hover. This avoids layout shifts and supports smooth transitions:

  ```
  opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100
  ```

  This keeps elements always visible on mobile (touch devices have no hover) and reveals them on
  hover at `md:` and above. Requires a `group` class on the parent container.

- **Responsive inline styles:** Never apply fixed `style:width` or `style:height` unconditionally
  when the layout changes across breakpoints. Use `window.matchMedia()` (in a `$effect`) to
  conditionally apply inline styles at the intended breakpoint.

## 11. Narrow-screen stacking

Follow the project-wide responsive stacking rule in the consumer repo's `AGENTS.md` →
`## Responsive Layout` when one exists. Default pattern for any horizontal flex/grid
container: `flex-col md:flex-row` (or `grid-cols-1 md:grid-cols-N`). The `md` (768px)
boundary is the canonical narrow-screen threshold (matches a typical `useIsMobile()`
helper at `(max-width: 767px)`).

May stay horizontal below `md`: short icon-button rows, segmented controls of ≤ 3 short
items, breadcrumb trails, and **chip/toggle/facet rows using `flex flex-wrap`** (the
wrap is itself a form of stacking — chips break to new rows on narrow rather than
truncating or scrolling, preferable to `flex-col` for ≥ 4 short items).

For form controls inside a stacked container, add `w-full md:w-auto` to inputs, selects,
and buttons so they fill the column on narrow.

## 12. Forms

For dialog-embedded forms and form patterns, see `references/component-patterns.md`. Key points:
use native `<form onsubmit>`, pair `<Label for>` with `<Input id>`, and use `bind:open` on
`Dialog.Root` with `onOpenChange` for state reset.

## 13. Critique

After building, pause and run through the critique checklist from `references/critique-protocol.md`:

- **Composition** — Can you identify primary, secondary, and tertiary content at a glance? Does
  spacing vary intentionally?
- **Craft** — Do adjacent containers differ in surface treatment? Does every border serve a purpose?
- **Content** — Are 3+ typography levels present? Are numbers formatted and monospaced?
- **Defaults rejected** — Name one specific, non-generic choice you made.

Identify the 1-3 highest-impact fixes and apply them. Verify the result holds in both light and
dark modes. For minor changes, a quick mental scan suffices.

# Troubleshooting

**Custom Tailwind class not generating:**

- Tailwind v4 only generates utilities for tokens registered in `@theme inline`. Ensure the
  CSS variable is registered there. See `references/tailwind-v4.md`.

**Dark mode not toggling:**

- Verify the `.dark` class is being toggled on the root element. Check that the CSS variable
  exists in both `:root` and `.dark` blocks in `src/app.css`.

**shadcn-svelte component not rendering correctly:**

- Ensure the component is imported from `$lib/components/ui/<component>`, not directly from
  `bits-ui`. The shadcn wrappers apply project-specific styling.

**New color not appearing:**

- Three steps required: (1) define in `:root`, (2) define in `.dark`, (3) register in
  `@theme inline`. Missing any step will cause the color to be absent.

**Chart colors inconsistent with theme:**

- Use `--chart-1` through `--chart-20` CSS variables. Do not hardcode hex/rgb values.

# Verification

- `npm run check` and `npm run lint` pass.
- Component renders correctly in both light and dark modes.
- All interactive elements are keyboard-navigable (tab, enter, escape).
- Layout adapts correctly at mobile, tablet, and desktop widths.
- No custom CSS in `<style>` blocks (use Tailwind utilities).
- Semantic HTML and ARIA attributes are present for interactive elements.
- Design choices are intentional — can explain WHY for surface, spacing, and typography decisions.

# Constraints

- Do NOT write custom CSS in `<style>` blocks unless absolutely necessary — use Tailwind utility classes.
- Do NOT hardcode color values — use CSS variables / semantic tokens.
- Do NOT write tests — recommend the `testing` skill to the user when the UI work is complete.
- Do NOT create new color variables without adding them to both `:root` and `.dark` themes.
- Do NOT use identical surface treatment for all containers — vary depth intentionally.
