# UI Engineer Reference: Design Tokens

This file documents the design token system defined in `src/app.css`. All colors use the `oklch()`
color space for perceptual uniformity across light and dark modes.

## Color Token Semantics

| Token           | Light Mode  | Dark Mode         | Hue Family    | Usage                  |
| --------------- | ----------- | ----------------- | ------------- | ---------------------- |
| `--background`  | Near-white  | Near-black        | Cool blue 250 | Page background        |
| `--foreground`  | Near-black  | Near-white        | Cool blue 230 | Primary text           |
| `--card`        | White       | Dark slate        | Neutral       | Card/panel surfaces    |
| `--popover`     | White       | Dark slate        | Neutral       | Popover surfaces       |
| `--primary`     | Dark teal   | Light teal        | Teal 195      | Primary actions, links |
| `--secondary`   | Pale teal   | Dark gray         | Teal 200      | Secondary actions      |
| `--muted`       | Pale teal   | Dark gray         | Teal 200      | Disabled/subtle text   |
| `--accent`      | Pale teal   | Dark gray         | Teal 190      | Hover/focus states     |
| `--destructive` | Red         | Lighter red       | Red 27        | Delete/error actions   |
| `--border`      | Light gray  | White 10% opacity | Blue 210      | Borders, dividers      |
| `--input`       | Light gray  | White 15% opacity | Blue 210      | Input field borders    |
| `--ring`        | Medium teal | Dark teal         | Teal 195      | Focus ring color       |

Each color token has a paired `*-foreground` variant for text rendered on that color surface
(e.g., `--primary-foreground` is near-white in light mode for contrast against `--primary`).

## Financial Data Tokens

| Token        | Light Mode  | Dark Mode   | Usage                            |
| ------------ | ----------- | ----------- | -------------------------------- |
| `--positive` | Green (155) | Light green | Positive values, up indicators   |
| `--negative` | Red (27)    | Lighter red | Negative values, down indicators |

Use `text-positive` / `text-negative` for data that represents gains/losses. These are registered
in `@theme inline` as `--color-positive` and `--color-negative`.

## Chart Colors

`--chart-1` through `--chart-20` provide a 20-color palette for data visualization. Each has
distinct light and dark mode values optimized for readability. The hues are spread across the
color wheel to maximize distinguishability between series.

If the project has a charting theme module, sync it with these CSS variables — do not
hardcode chart colors separately.

## Sidebar Tokens

`--sidebar-*` tokens mirror the main semantic tokens but are scoped to the sidebar component:
`--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-accent`, `--sidebar-border`,
`--sidebar-ring`, plus their `-foreground` pairs.

## Typography

| Token         | Value                                              | Tailwind Class |
| ------------- | -------------------------------------------------- | -------------- |
| `--font-sans` | Geist Sans, system-ui, -apple-system, sans-serif   | `font-sans`    |
| `--font-mono` | Geist Mono, Source Code Pro, Menlo, Consolas, mono | `font-mono`    |

`font-sans` is applied to `<body>` by default. Use `font-mono` for numeric data, code snippets,
and tabular values — it keeps digits aligned in columns.

## Border Radius

| Token         | Computed Value                | Tailwind Class |
| ------------- | ----------------------------- | -------------- |
| `--radius`    | `0.375rem` (6px) — base value | —              |
| `--radius-sm` | `calc(--radius - 4px)` → 2px  | `rounded-sm`   |
| `--radius-md` | `calc(--radius - 2px)` → 4px  | `rounded-md`   |
| `--radius-lg` | `var(--radius)` → 6px         | `rounded-lg`   |
| `--radius-xl` | `calc(--radius + 4px)` → 10px | `rounded-xl`   |

## Base Layer Defaults

The `@layer base` block in `src/app.css` applies these globally:

- All elements: `border-border outline-ring/50` — default border and outline colors
- `<body>`: `bg-background text-foreground font-sans` — base surface and text
- `<code>`, `<pre>`, `<kbd>`, `<samp>`: `font-mono`

## Tailwind v4 Integration

All tokens are registered in the `@theme inline` block as `--color-*` values, which makes them
available as Tailwind utilities (e.g., `bg-background`, `text-primary`, `border-border`).

To add a new token, see `references/tailwind-v4.md` for the three-step process: define in `:root`,
define in `.dark`, register in `@theme inline`.
