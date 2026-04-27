# Svelte 5 Patterns Reference

Extended examples for Svelte 5 patterns. Loaded on-demand from the `svelte` skill.

## Table of Contents

- [Reactive Class Pattern](#reactive-class-pattern)
- [$state.snapshot Usage](#statesnap-usage)
- [$state.raw for Performance](#stateraw-for-performance)
- [$effect Cleanup Pattern](#effect-cleanup-pattern)
- [Async Data: $effect vs $derived](#async-data-effect-vs-derived)
- [untrack() Usage](#untrack-usage)
- [Cross-Component State Sharing](#cross-component-state-sharing)
- [HMR Disposal](#hmr-disposal)
- [state_unsafe_mutation Error](#state_unsafe_mutation-error)
- [$effect.root Memory Leak](#effectroot-memory-leak)
- [Svelte 4 to 5 Migration Cheat Sheet](#svelte-4--5-migration-cheat-sheet)
- [Snippet Patterns](#snippet-patterns)

---

## Reactive Class Pattern

Classes with `$state` fields are the primary state management pattern. Svelte's
compiler transforms field initializers into reactive signals, so class instances
are deeply reactive without wrapping in stores.

```typescript
// dashboard.svelte.ts
import { ephemeralId, isEphemeralId } from "$lib/util/id-generator";

export class Dashboard {
  private constructor() {} // Force use of factory methods

  public id: string = $state(ephemeralId());
  public name: string = $state("Untitled Dashboard");
  public graphs: Array<Graph> = $state([]);
  public graphCount: number = $state(0);

  // $derived.by for multi-step sync computations
  #isConfigComplete: boolean = $derived.by(() => {
    if (!this.endpointId || !this.fieldPath) return false;
    const endpoint = findEndpoint(this.endpointId);
    return !!endpoint;
  });

  // Plain getter for non-reactive computed values (no $derived needed)
  get isEphemeral(): boolean {
    return isEphemeralId(this.id);
  }

  // Factory method for deserialization
  static fromDb(data: DashboardData): Dashboard {
    const d = new Dashboard();
    d.id = data.id;
    d.name = data.name;
    return d;
  }

  // Methods that mutate $state fields trigger reactivity automatically
  addGraph(): Graph {
    const graph = Graph.create();
    graph.position = this.graphs.length;
    this.graphs.push(graph); // Proxy array — push triggers updates
    this.graphCount = this.graphs.length;
    return graph;
  }
}
```

**Key points:**

- `$state()` in field initializers creates reactive proxies (arrays and plain
  objects are deeply proxied; class instances are not)
- Private `$derived.by` fields work for internal computed state
- Getters (`get isEphemeral`) are fine for non-reactive computations that don't
  need to be tracked as dependencies of other derivations
- `$state([])` arrays support `.push()`, `.splice()`, etc. — mutations are
  tracked automatically through the proxy

---

## $state.snapshot Usage

`$state.snapshot()` strips the reactive proxy and returns a plain value. Use it
when passing reactive state to APIs that don't expect proxies:

```typescript
// Cloning a reactive object — pass snapshot values to avoid proxy leaking
clone(newGraph: Graph): Expression {
  return new QueryExpression(
    newGraph,
    $state.snapshot(this.id),
    $state.snapshot(this.symbol),
    $state.snapshot(this.isVisible),
    $state.snapshot(this.interpolationMode),
  );
}

// Serializing for external APIs
const plain = $state.snapshot(this.config);
localStorage.setItem("config", JSON.stringify(plain));

// Passing to structuredClone or libraries that reject proxies
const copy = structuredClone($state.snapshot(myState));
```

---

## $state.raw for Performance

`$state.raw()` creates a signal without deep proxying. The value is reactive at
the top level (reassignment triggers updates) but internal mutations to nested
properties are not tracked.

```typescript
// Large dataset — no need for deep reactivity on individual items
public items: Item[] = $state.raw([]);

// Reassignment triggers updates:
this.items = newItems;            // reactive

// Mutation does NOT trigger updates:
this.items.push(newItem);         // silent — UI won't update
```

Use `$state.raw` when:

- The data is large and read-only (e.g., fetched API responses)
- You always replace the entire value, never mutate nested properties
- Deep proxy overhead is measurable (profiled, not assumed)

---

## $effect Cleanup Pattern

Return a function from `$effect` to run cleanup before the next execution or
when the component unmounts:

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

    // Cleanup: remove listener on re-run or unmount
    return () => mql.removeEventListener("change", handler);
  });

  return {
    get matches() {
      return matches;
    },
  };
}
```

**Common cleanup scenarios:**

- Event listeners (`addEventListener` / `removeEventListener`)
- Timers (`setInterval` / `clearInterval`)
- WebSocket connections
- AbortController for fetch requests

---

## Async Data: $effect vs $derived

**Prefer `$effect` for async work.** Svelte's dependency tracking only works for
synchronous reads. Values read after `await` are not tracked, which leads to
subtle bugs where derived values don't re-compute when dependencies change.

```typescript
// AVOID: async $derived — dependencies after await are invisible
public rawData: Promise<Item[]> = $derived.by(async () => {
  const id = this.endpointId;  // tracked
  const data = await fetchData(id);
  const extra = this.fieldPath; // NOT tracked — after await
  return data;
});

// PREFER: $effect with $state for async results
public data: Item[] = $state([]);
public loading: boolean = $state(false);
public error: Error | null = $state(null);

// In a component's <script> block:
$effect(() => {
  const id = expression.endpointId;  // tracked
  const field = expression.fieldPath; // tracked
  if (!id || !field) return;

  expression.loading = true;
  fetchData(id, field)
    .then((result) => { expression.data = result; })
    .catch((err) => { expression.error = err; })
    .finally(() => { expression.loading = false; });
});
```

**If you encounter existing async `$derived.by`** (e.g., `QueryExpression.rawData`),
understand it works because the author carefully placed all dependency reads before
the first `await`. Don't extend this pattern to new code.

---

## untrack() Usage

`untrack()` reads a reactive value without creating a dependency. Use it to break
unwanted reactive chains:

```typescript
import { untrack } from "svelte";

$effect(() => {
  // We want this effect to run when `query` changes...
  const currentQuery = query;

  // ...but NOT when `config` changes (just reading its current value)
  const currentConfig = untrack(() => config);

  performSearch(currentQuery, currentConfig);
});
```

**Common uses:**

- Reading configuration that shouldn't trigger re-execution
- Logging reactive values without creating dependencies
- Breaking circular dependency chains between effects

---

## Cross-Component State Sharing

For state shared across multiple components, export a module-level singleton:

```typescript
// auth.svelte.ts
export class AuthStore {
  user = $state<User | null>(null);
  session = $state<Session | null>(null);
  loading = $state(true);

  get isAuthenticated(): boolean {
    return !!this.user && !!this.session;
  }

  async signIn(email: string, password: string) {
    /* ... */
  }
}

// Singleton — any component importing authStore shares the same instance
export const authStore = new AuthStore();
```

Any component that imports `authStore` reads and writes the same reactive state.
This is simpler than Svelte 4 writable stores for most cases.

---

## HMR Disposal

When a module-level singleton sets up subscriptions (auth listeners, WebSocket
connections), the old instance leaks during hot module replacement. Clean up with
`import.meta.hot`:

```typescript
export const authStore = new AuthStore();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    authStore.destroy(); // Unsubscribe listeners, close connections
  });
}
```

This prevents duplicate subscriptions and stale callbacks during development.

---

## `state_unsafe_mutation` Error

Svelte 5 throws `state_unsafe_mutation` if you set a `$state` field inside
`$derived` or `$derived.by`. The reactive graph must be acyclic.

### Problem

```typescript
// WRONG: Mutating state inside $derived
#isValid = $derived.by(() => {
  if (this.displayScale === 1 && this.series.unitMultiplier !== 1) {
    this.displayScale = this.series.unitMultiplier; // FORBIDDEN
  }
  return true;
});
```

### Solution

Set defaults at construction or deserialization time:

```typescript
// CORRECT: Set defaults at construction time
const displayScale = savedConfig.displayScale ?? resolveDefault(seriesId);
return new MyExpression(/* ... */, displayScale);
```

If you need to "auto-populate" a field when data changes, use a separate
`$effect` that handles the transition explicitly.

---

## `$effect.root` Memory Leak

`$effect.root` creates an effect outside Svelte's component lifecycle. Its
returned destroy function **must** be called manually.

### Problem

```typescript
// DANGEROUS: destroy function may never be called
class ConfigModal {
  #cleanup = $effect.root(() => {
    $effect(() => {
      /* reactive logic */
    });
  });
  // If #cleanup is never called → leaked effect
}
```

### Solution

Prefer component-scoped `$effect`:

```svelte
<script lang="ts">
  // Automatically cleaned up when component unmounts
  $effect(() => {
    /* reactive logic */
  });
</script>
```

If `$effect.root` is truly necessary (rare), ensure cleanup runs in `onDestroy`
or an equivalent lifecycle hook.

---

## Svelte 4 -> 5 Migration Cheat Sheet

| Svelte 4                             | Svelte 5 Equivalent                                  |
| ------------------------------------ | ---------------------------------------------------- |
| `export let prop`                    | `let { prop } = $props()`                            |
| `$: doubled = count * 2`             | `let doubled = $derived(count * 2)`                  |
| `$: { /* side effect */ }`           | `$effect(() => { /* side effect */ })`               |
| `on:click={handler}`                 | `onclick={handler}`                                  |
| `createEventDispatcher()`            | Callback props: `let { onclick } = $props()`         |
| `<slot />`                           | `{@render children()}`                               |
| `<slot name="header" />`             | `{#snippet header()}...{/snippet}{@render header()}` |
| `$$restProps`                        | `let { ...rest } = $props()`                         |
| `beforeUpdate` / `afterUpdate`       | `$effect.pre()` / `$effect()`                        |
| `writable()` / `readable()` (stores) | `$state()` / `$derived()`                            |

---

## Snippet Patterns

### Default + Override Snippets

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

### Snippets with Parameters

```svelte
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    items: string[];
    renderItem: Snippet<[string, number]>;
  }

  let { items, renderItem }: Props = $props();
</script>

{#each items as item, index}
  {@render renderItem(item, index)}
{/each}
```
