# Post-Build Critique Protocol

## Critique Checklist

After building a UI component or page, walk through each dimension:

| Dimension       | Check                | Question                                                                 |
| --------------- | -------------------- | ------------------------------------------------------------------------ |
| **Composition** | Visual hierarchy     | Can you identify primary, secondary, and tertiary content at a glance?   |
|                 | Content grouping     | Are related items closer together than unrelated ones?                   |
|                 | Whitespace           | Does spacing vary intentionally, or is everything `gap-4`?               |
|                 | Flow                 | Does the eye move naturally from most to least important?                |
| **Craft**       | Surface variation    | Do adjacent containers differ in surface treatment (bg, border, shadow)? |
|                 | Border intention     | Does every border serve a purpose, or are some just "default"?           |
|                 | Color restraint      | Are accent colors used sparingly and meaningfully?                       |
| **Content**     | Typography levels    | Are 3+ text levels present (size, weight, color)?                        |
|                 | Number formatting    | Are financial numbers monospaced, aligned, and formatted?                |
|                 | Empty/loading states | What happens with no data? During loading?                               |
| **Structure**   | Semantic HTML        | Are headings, lists, and landmarks used correctly?                       |
|                 | Dark mode            | Do surfaces, borders, and text all work in both themes?                  |
|                 | Responsiveness       | Does the layout adapt at mobile, tablet, and desktop?                    |

## Common Anti-Patterns

### The Identical Container Problem

```
BAD:  Every card uses bg-card rounded-lg border p-4
GOOD: Primary card: bg-card rounded-lg border p-6 shadow-sm
      Secondary card: bg-muted/50 rounded-md border-0 p-4
      Inline group: bg-transparent border-b p-3
```

Vary surface, padding, border, and rounding based on content importance.

### The Missing Hierarchy Problem

```
BAD:  All text is text-sm text-foreground
GOOD: Title: text-lg font-semibold text-foreground
      Subtitle: text-sm text-muted-foreground
      Value: text-2xl font-mono font-bold text-foreground
      Label: text-xs text-muted-foreground uppercase tracking-wider
```

If you squint and everything looks the same weight, hierarchy is missing.

### The Default Spacing Problem

```
BAD:  <div class="space-y-4"> for everything
GOOD: Related items: gap-2
      Content sections: gap-6
      Page sections: gap-8 or gap-12
```

Uniform spacing flattens the information architecture.

### The Flat Dark Mode Problem

```
BAD:  Same bg-card for all surfaces in dark mode
GOOD: Ground: bg-background (darkest)
      Card: bg-card (slightly lighter)
      Elevated: bg-popover (lighter still)
      Borders: border-border/60 (subtle, not harsh)
```

In dark mode, elevation = lightness. Without variation, everything merges into a single plane.

### The Decorative Border Problem

```
BAD:  border on every element because "it looks more defined"
GOOD: Use borders only to separate content groups
      Use bg differences to distinguish nested surfaces
      Use shadow-sm for elevation instead of borders where appropriate
```

Too many borders create visual noise. Every border should answer: "What am I separating, and why?"

## Critique Workflow

1. **Build** the component following the skill instructions (intent through accessibility)
2. **Pause** — do not submit yet
3. **Walk the checklist** above, scoring each dimension mentally
4. **Identify** the 1-3 most impactful fixes (not everything needs fixing)
5. **Apply** the fixes, prioritizing:
   - Missing visual hierarchy (highest impact)
   - Identical surface treatments
   - Typography flatness
   - Spacing uniformity
6. **Verify both themes** — toggle light/dark and confirm the hierarchy holds
7. **Name one non-default choice** you made — if you can't, revisit step 1

The critique should take 30-60 seconds of review, not a full redesign. It's a quality gate, not a
second pass.
