# Tailwind CSS v4 Reference

This project uses Tailwind v4, which differs significantly from v3. Loaded on-demand from the
`ui` skill.

## Key Differences from v3

| Feature          | Tailwind v3                                                  | Tailwind v4                                                                                           |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Configuration    | `tailwind.config.js`                                         | CSS-first via `@theme inline`; minimal `tailwind.config.js` remains for content globs and font family |
| Import syntax    | `@tailwind base; @tailwind components; @tailwind utilities;` | `@import "tailwindcss"`                                                                               |
| Custom colors    | `theme.extend.colors` in config                              | `--color-*` tokens in `@theme inline` block                                                           |
| Dark mode        | `darkMode: 'class'` in config                                | `@custom-variant dark (&:is(.dark *))`                                                                |
| Custom utilities | `@layer utilities { ... }` in CSS                            | `@utility name { ... }`                                                                               |

## `@theme inline` Directive

The `@theme inline` block in `src/app.css` registers design tokens as Tailwind utilities. The
`inline` keyword prevents Tailwind from generating CSS variables for these tokens — they reference
existing CSS custom properties instead:

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  /* ... */
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
```

## Adding New Design Tokens

When adding a new token:

1. Define the CSS variable in both `:root` and `.dark` blocks in `src/app.css`
2. Register it in the `@theme inline` block
3. Use the semantic class in components (e.g., `bg-my-token`, `text-my-token`)

```css
/* Step 1: Define in :root and .dark */
:root {
  --my-token: oklch(0.95 0 0);
}
.dark {
  --my-token: oklch(0.15 0 0);
}

/* Step 2: Register in @theme inline */
@theme inline {
  --color-my-token: var(--my-token);
}
```

## `@custom-variant`

Custom variants are defined in CSS instead of the config file:

```css
@custom-variant dark (&:is(.dark *));
```

This enables the `dark:` prefix in utility classes (e.g., `dark:bg-background`).

## Common Pitfalls

**v3 config patterns may not work as expected:**

- Most configuration is CSS-first in `src/app.css`. A minimal `tailwind.config.js` still exists
  for content globs and `theme.extend.fontFamily` — update it when changing content scanning or
  font extensions.

**Custom class not working:**

- Ensure the token is registered in `@theme inline`. Tailwind v4 only generates utilities for
  registered tokens.

**`@apply` with custom tokens:**

- `@apply` works with registered tokens, but prefer direct utility classes in markup over
  `@apply` in CSS.
