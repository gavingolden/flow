# Component Patterns

Project-specific patterns for layout composition, bits-ui integration, and forms.

## Table of Contents

- [Layout Composition](#layout-composition)
- [bits-ui child Snippet Pattern](#bits-ui-child-snippet-pattern)
- [Form Patterns](#form-patterns)

---

## Layout Composition

### AuthenticatedLayout

The main page shell. Provides the header, skip-to-content link, and `<main id="main-content">` landmark.

**File:** `src/lib/components/layout/AuthenticatedLayout.svelte`

**Props:**

| Prop             | Type      | Description                                      |
| ---------------- | --------- | ------------------------------------------------ |
| `children`       | `Snippet` | Page body content (implicit)                     |
| `navBarActions?` | `Snippet` | Actions rendered in the right side of the header |
| `classes?`       | `object`  | Override classes: `{ navBarRoot?, bodyRoot? }`   |

**Standard page structure:**

```svelte
<script lang="ts">
  import AuthenticatedLayout from "$lib/components/layout/AuthenticatedLayout.svelte";
  import { Button } from "$lib/components/ui/button";
</script>

{#snippet navBarActions()}
  <Button>Save</Button>
{/snippet}

<AuthenticatedLayout {navBarActions}>
  <!-- page content -->
</AuthenticatedLayout>
```

**Layout overrides** — use the `classes` prop to customize the body grid:

```svelte
<AuthenticatedLayout classes={{ bodyRoot: "grid lg:grid-cols-2 gap-4" }}>
  <!-- two-column layout at lg -->
</AuthenticatedLayout>
```

**Default body styling:** `mx-auto my-2 overflow-x-hidden px-4 focus:outline-none md:px-6` —
responsive horizontal padding that tightens on mobile.

### Other Layout Components

- **`AppHeader`** — renders the logo, nav links, theme toggle, and user menu. Accepts `navBarActions`
  snippet. Rarely used directly — `AuthenticatedLayout` wraps it.
- **`Breadcrumbs`** — auto-generates from the route path. Override labels via
  `breadcrumb-overrides.svelte.ts`.
- **`SharedLayout`** — for public/unauthenticated pages.

---

## bits-ui child Snippet Pattern

shadcn-svelte wraps bits-ui, which uses a `child` snippet to give consumers full control over the
rendered trigger element. This pattern appears in Trigger components (`Dialog.Trigger`,
`DropdownMenu.Trigger`, `Tooltip.Trigger`, `Popover.Trigger`, etc.).

### Why it exists

bits-ui Trigger components render a default `<button>` internally. When you need a different element
(e.g., a styled `Button` component), use the `child` snippet. The `props` object it provides
contains accessibility attributes, event handlers, and state from bits-ui — spreading it onto your
element is mandatory.

### Basic pattern

```svelte
<Dialog.Trigger>
  {#snippet child({ props })}
    <Button {...props} variant="outline">Open</Button>
  {/snippet}
</Dialog.Trigger>
```

### Nested composition

When wrapping a trigger inside another trigger (e.g., Tooltip around a DropdownMenu trigger), rename
the inner `props` to avoid shadowing:

```svelte
<TooltipTrigger>
  {#snippet child({ props: tooltipProps })}
    <DropdownMenu.Trigger {...tooltipProps}>
      {#snippet child({ props })}
        <Button {...props} variant="outline" size="icon" aria-label="Theme">
          <Sun class="h-[1.2rem] w-[1.2rem]" />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
  {/snippet}
</TooltipTrigger>
```

Source: `src/lib/components/ui/ThemeSelector.svelte` demonstrates this exact pattern.

### When to use vs. not use

- **Use `child`** when you need a custom element (styled Button, anchor, etc.) as the trigger.
- **Skip `child`** when the default `<button>` is fine — just put content directly inside the trigger.

---

## Form Patterns

### Dialog-embedded form

Wrap the dialog content in a `<form>` so the submit button works with Enter key and native
validation:

```svelte
<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <form onsubmit={handleSubmit}>
      <Dialog.Header>
        <Dialog.Title>New Item</Dialog.Title>
        <Dialog.Description>Description text.</Dialog.Description>
      </Dialog.Header>

      <div class="py-4">
        <Label for="item-name" class="sr-only">Name</Label>
        <Input id="item-name" bind:value={name} placeholder="Name" required autofocus />
      </div>

      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={handleCancel}>Cancel</Button>
        <Button type="submit" disabled={!name.trim()}>Create</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
```

Source: `src/lib/components/dashboard/CreateDashboardDialog.svelte`

### Key conventions

- **Event handling:** Use Svelte 5 attribute syntax `onsubmit={handler}`, not the legacy
  `on:submit` directive. Call `e.preventDefault()` in the handler.
- **Label linking:** Always pair `<Label for="id">` with `<Input id="id">`. Use `class="sr-only"` on
  labels when the placeholder provides sufficient visual context.
- **Input refs:** Use `bind:ref={element}` (not `bind:this`) for programmatic focus or selection.
- **Validation:** The `Input` component automatically applies `aria-invalid:border-destructive`
  styling. Set the `required` attribute for native validation; use `disabled` on the submit button
  for custom validation logic.
- **Open state:** Use `bind:open` on `Dialog.Root` with an `onOpenChange` callback to reset form
  state when the dialog closes.
