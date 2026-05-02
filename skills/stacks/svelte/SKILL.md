---
name: svelte
description: >-
  Use whenever creating, modifying, or reviewing Svelte components, reactive
  state, or store/repository patterns. TRIGGER when: files with `.svelte` or
  `.svelte.ts` extension; SvelteKit route files (`+page.svelte`,
  `+layout.svelte`, `+page.server.ts`, `+server.ts`); imports from `svelte`,
  `svelte/store`, `svelte/transition`, or `@sveltejs/kit`; runes (`$state`,
  `$derived`, `$effect`, `$props`); user mentions "Svelte", "SvelteKit",
  "runes", "reactive class", "store pattern", "migrate to Svelte 5". SKIP
  when: file imports `react`, `react-dom`, `vue`, `solid-js`,
  `@angular/core`, or other competing component frameworks; `.tsx`, `.jsx`,
  or `.vue` files; the project's view layer is React, Vue, Solid, or
  Angular.
---

# Goal

Write modern, type-safe Svelte 5 code using runes and reactive classes, following
this project's established architecture patterns.

# When to Use

- Creating or modifying `.svelte` components
- Creating or modifying `.svelte.ts` reactive state files
- Reviewing Svelte code for anti-patterns or legacy syntax
- Migrating Svelte 4 code to Svelte 5
- Building or modifying store/repository patterns
- Working with SvelteKit route files

# When NOT to Use

- Pure TypeScript domain logic with no Svelte reactivity (no skill needed)
- Styling-only changes with no component logic (defer to `tailwind-shadcn`)
- Writing tests for components (defer to `testing`)

# Context

- Framework: Svelte 5 with SvelteKit 2
- Components: `src/lib/components/` (adjust to this project's layout)
- Domain state: `src/lib/domain/` or equivalent (`.svelte.ts` files for reactive state)
- Base UI primitives: `src/lib/components/ui/` (shadcn-svelte / bits-ui, if used)
- Extended rune patterns: `references/svelte5-patterns.md`
- SvelteKit patterns: `references/sveltekit-patterns.md`
- Store architecture: `references/store-architecture.md`

# Instructions

## 1. Component Structure

Always use `<script lang="ts">` — no exceptions. Import types with
`import type { ... }` when only used in type positions.

Use `$props()` for component inputs. Always type them explicitly with an
`interface` or `type`:

```svelte
<script lang="ts">
  interface Props {
    title: string;
    count?: number;
    onchange?: (value: string) => void;
  }

  let { title, count = 0, onchange }: Props = $props();
</script>
```

## 2. Reactive State — Runes

### Core runes

| Rune            | Purpose                                | Use for                                                               |
| --------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `$state()`      | Mutable reactive state                 | Local variables, class fields                                         |
| `$state.raw()`  | Shallow-reactive state (no deep proxy) | Large arrays, perf-sensitive data that doesn't need nested reactivity |
| `$derived()`    | Computed value (expression)            | Simple transforms: `let doubled = $derived(count * 2)`                |
| `$derived.by()` | Computed value (function body)         | Multi-step sync computations with intermediate variables              |
| `$effect()`     | Side effect                            | DOM interactions, subscriptions, async data fetching                  |
| `$effect.pre()` | Pre-render effect                      | Reading DOM measurements before paint                                 |
| `$bindable()`   | Two-way binding prop                   | Form inputs: `let { value = $bindable() } = $props()`                 |
| `$inspect()`    | Debug logging                          | Remove before committing                                              |
| `untrack()`     | Read without creating dependency       | Breaking circular dependencies, reading config in effects             |

### `$state.snapshot()`

When passing `$state` proxy objects to external APIs (structuredClone, JSON
serialization, library functions), use `$state.snapshot()` to get a plain copy:

```typescript
clone(newParent: Parent): Item {
  const cloned = new Item(
    newParent,
    $state.snapshot(this.id),
    $state.snapshot(this.name),
  );
  return cloned;
}
```

### `$effect` rules

- **One effect, one job.** Don't bundle unrelated side effects.
- **Return a cleanup function** for subscriptions and event listeners:
  ```typescript
  $effect(() => {
    const mql = window.matchMedia(query);
    matches = mql.matches;
    const handler = (e: MediaQueryListEvent) => {
      matches = e.matches;
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  });
  ```
- **Async work goes in `$effect`, not `$derived`.** Values read after `await`
  are not tracked as dependencies. Use `$effect` for fetches and set a `$state`
  variable with the result. Only use `$derived` / `$derived.by` for synchronous
  computations.
- **Never mark an `$effect` callback as `async`** — the cleanup function won't
  run. Instead, call an async function inside a sync effect:
  ```typescript
  $effect(() => {
    const currentId = this.id; // tracked dependency
    loadData(currentId); // fire-and-forget async
  });
  ```

### Anti-patterns

**CRITICAL — Never mutate `$state` inside `$derived`:** Svelte 5 throws
`state_unsafe_mutation`. The reactive graph must be acyclic. Set defaults at
construction/deserialization time, not reactively.

**CRITICAL — Avoid `$effect.root` in classes (memory leak risk):** Its destroy
function must be called manually. Prefer component-scoped `$effect` instead.

See `references/svelte5-patterns.md` for full examples of both anti-patterns.

## 3. Reactive Classes

Reactive classes are the primary pattern for domain models and stores in this
project. Use `$state` in class fields to make instances deeply reactive without
stores or wrappers.

```typescript
export class Dashboard {
  public id: string = $state(ephemeralId());
  public name: string = $state("Untitled Dashboard");
  public graphs: Array<Graph> = $state([]);

  // Derived fields for computed properties
  #isConfigComplete: boolean = $derived.by(() => {
    return !!this.endpointId && !!this.fieldPath;
  });

  // Non-reactive computed values use getters
  get isEphemeral(): boolean {
    return isEphemeralId(this.id);
  }

  // Factory methods for construction from external data
  static fromDb(data: DashboardData): Dashboard {
    const d = new Dashboard();
    d.id = data.id;
    d.name = data.name;
    return d;
  }
}
```

**Key patterns:**

- Public `$state` fields for mutable data the UI reads and writes
- Private `$derived.by` fields (`#field = $derived.by(...)`) for internal computed state
- Plain getters for non-reactive computed values
- `static fromDb()` factory methods for deserialization
- Private constructors when construction requires specific initialization

**When to use reactive classes vs. composable functions:**

- **Classes** — domain models (Dashboard, Graph, Expression), stores with
  multiple methods and lifecycle, complex state machines
- **Functions** — utility hooks (media queries, network status), simple shared
  reactive state with no methods

See `references/svelte5-patterns.md` for a complete reactive class example.

## 4. Composable Functions

For lightweight reactive utilities, use functions that return objects with getters.
The getter ensures the caller reads the current reactive value:

```typescript
export function useMediaQuery(query: string): { readonly matches: boolean } {
  let matches: boolean = $state(false);

  $effect(() => {
    const mql = window.matchMedia(query);
    matches = mql.matches;
    const handler = (e: MediaQueryListEvent) => {
      matches = e.matches;
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  });

  return {
    get matches() {
      return matches;
    },
  };
}
```

The object-with-getters pattern keeps the reference reactive — a plain `return { matches }`
would snapshot the value and lose reactivity.

## 5. Event Handling

Use Svelte 5 event attributes: `onclick={handler}`, `oninput={handler}`.
Do NOT use legacy directives: `on:click`, `on:input`.

For component events, use callback props (not `createEventDispatcher`):

```svelte
<!-- Child -->
<script lang="ts">
  let { onselect }: { onselect?: (value: string) => void } = $props();
</script>

<button onclick={() => onselect?.("clicked")}>Click</button>

<!-- Parent -->
<Child onselect={(value) => (selected = value)} />
```

## 6. Content Composition — Snippets

Use Svelte 5 snippets instead of `<slot>`:

```svelte
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    header?: Snippet;
    children: Snippet;
  }

  let { header, children }: Props = $props();
</script>

{#if header}
  {@render header()}
{:else}
  <h2>Default Header</h2>
{/if}

{@render children()}
```

For parameterized snippets, use `Snippet<[ParamType]>`:

```svelte
<script lang="ts">
  import type { Snippet } from "svelte";
  let { renderItem }: { renderItem: Snippet<[string, number]> } = $props();
</script>

{#each items as item, index}
  {@render renderItem(item, index)}
{/each}
```

## 7. SvelteKit Integration

Route files live in `src/routes/`. Key conventions:

- `+page.svelte` — page component
- `+layout.svelte` — shared layout wrapper
- `+page.server.ts` — server-side load functions and form actions
- `+server.ts` — API endpoints (GET, POST, etc.)

Use the `$page` store from `$app/stores` for route params and shallow routing state:

```svelte
<script lang="ts">
  import { page } from "$app/stores";

  const dashboardId = $derived($page.params.id);

  // Shallow routing state (set via pushState/replaceState)
  const fullscreenGraph = $derived.by(() => {
    const chartId = $page.state.fullscreenChartId;
    if (!chartId || !dashboard) return null;
    return dashboard.graphs.find((g) => g.id === chartId) ?? null;
  });
</script>
```

See `references/sveltekit-patterns.md` for load functions, route organization, and
data flow patterns.

## 8. Store Architecture

Domain state follows a **Store -> Repository -> Database** layering:

- **Store** (`.store.svelte.ts`) — reactive state + business logic, uses `$state` fields
- **Repository** — data access layer, returns `Result<T, E>` types
- **Factory injection** — stores accept a `RepositoryFactory` for testability

```typescript
export class DashboardStore {
  private state: DashboardState = $state({ dashboard: null, loading: false, error: null });

  constructor(private readonly repositoryFactory: RepositoryFactory) {}

  async loadById(id: string): Promise<void> {
    this.state.loading = true;
    const repoResult = this.repositoryFactory();
    // ...
  }
}

// Module-level singleton with the real factory
export const dashboardStore = new DashboardStore(createDashboardRepository);
```

See `references/store-architecture.md` for the full pattern and exemplar files.

## 9. File Naming

- Components: `PascalCase.svelte` (e.g., `TimeRangePicker.svelte`)
- Reactive state: `kebab-case.svelte.ts` (e.g., `query-expression.svelte.ts`)
- Non-reactive logic: `kebab-case.ts` (e.g., `data-point.ts`)
- Use `.svelte.ts` ONLY when the file uses runes. Pure TypeScript uses `.ts`.

## 10. Error Boundaries

Every `<svelte:boundary>` **must** report the error to whatever observability layer the
project uses (Sentry, PostHog, custom logger, etc.) in its `onerror` handler. Error
boundaries intercept errors before SvelteKit's `handleError` hook, so without this call the
error is silently swallowed and never reaches your monitoring pipeline.

```svelte
<script lang="ts">
  // Adjust import to match your project's analytics / logging layer.
  import { captureException } from "$lib/analytics";
  import { createLogger } from "$lib/util/logger";

  const logger = createLogger("MyComponent");
</script>

<svelte:boundary
  onerror={(error) => {
    captureException(error);
    logger.error("Render error:", error);
  }}
>
  {@render children()}
</svelte:boundary>
```

The `handleError` hook in `src/hooks.client.ts` remains the fallback for non-render
client-side errors. It does **not** fire for errors caught by `<svelte:boundary>`.

# Troubleshooting

**`state_unsafe_mutation` at runtime:**
You're mutating `$state` inside `$derived` or `$derived.by`. Move the mutation to
construction time or use a separate `$effect`. See `references/svelte5-patterns.md`.

**Memory leaks from `$effect.root`:**
The destroy function returned by `$effect.root` is not being called. Switch to
component-scoped `$effect` or ensure cleanup runs in `onDestroy`.

**Legacy syntax errors after migration:**
`export let` -> `$props()`, `$:` -> `$derived()` / `$effect()`, `on:click` -> `onclick`.
See migration cheat sheet in `references/svelte5-patterns.md`.

**`<slot>` not rendering:**
Svelte 5 replaces `<slot>` with snippets. Use `{@render children()}` and accept a
`children: Snippet` prop.

**Effect cleanup not running:**
If you marked the `$effect` callback as `async`, the cleanup function is lost. Wrap
the async call in a sync effect instead. See section 2.

**Stale values after `await` in `$effect`:**
Values read after `await` are not tracked. Read all reactive dependencies
synchronously before the first `await`, then use those captured values.

# Verification

- `npm run check` and `npm run lint` pass (TypeScript + Svelte type checking).
- No Svelte 4 legacy syntax (`export let`, `$:`, `on:click`, `<slot>`, `createEventDispatcher`).
- All `$props()` are explicitly typed.
- `$derived` is used only for synchronous computations.
- Reactive classes use `$state` field initializers, not stores.

# Constraints

- NEVER use Svelte 4 legacy syntax.
- NEVER use `any` type — always provide explicit types.
- NEVER use `$derived` or `$derived.by` for async work — use `$effect` instead.
- **Avoid persistence thrashing:** When a reactive store persists to `localStorage` on every write,
  use a transient local variable during high-frequency interactions (e.g., drag) and commit to the
  store only on interaction end (e.g., `pointerup`).
- **Design for testability**: Keep logic in importable functions (not inline in markup), accept
  dependencies as props, and ensure child components can be stubbed in unit tests. See the
  `testing` skill for component isolation patterns.
- For responsive layout and accessibility patterns (inline styles across breakpoints, ARIA
  interactive widgets, `svelte-ignore` for a11y lints), defer to the `tailwind-shadcn` skill.
