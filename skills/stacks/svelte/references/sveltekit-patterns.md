# SvelteKit Patterns Reference

Route structure, data loading, and navigation patterns used in this project.
Loaded on-demand from the `svelte` skill.

## Route File Conventions

| File                               | Runs on     | Purpose                                                                            |
| ---------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `+page.svelte`                     | Client      | Page component                                                                     |
| `+page.ts`                         | Both        | Universal load function (runs on server during SSR, then on client for navigation) |
| `+page.server.ts`                  | Server only | Server load function and form actions — use for database queries, secrets          |
| `+layout.svelte`                   | Client      | Shared layout wrapper (applies to all child routes)                                |
| `+layout.ts` / `+layout.server.ts` | Varies      | Layout-level data loading                                                          |
| `+server.ts`                       | Server only | API endpoints (GET, POST, PUT, DELETE handlers)                                    |
| `+error.svelte`                    | Client      | Error page for the route segment                                                   |

## Route Organization

```
src/routes/
├── +layout.svelte              # Root layout (theme, global providers)
├── +page.svelte                # Landing page
├── dashboard/
│   ├── +layout.svelte          # Authenticated layout shell
│   ├── +page.svelte            # Dashboard list page
│   └── [id]/
│       ├── +page.svelte        # Single dashboard view
│       └── chart/[chartId]/
│           └── +page.svelte    # Fullscreen chart view
├── login/+page.svelte
├── signup/+page.svelte
└── s/[token]/+page.svelte      # Shared dashboard (public link)
```

Dynamic segments use `[param]` syntax. Access params via `$page.params`.

## $page Store

The `$page` store from `$app/stores` provides route metadata:

```svelte
<script lang="ts">
  import { page } from "$app/stores";

  // Route params (reactive via $derived)
  const dashboardId = $derived($page.params.id);

  // URL search params
  const tab = $derived($page.url.searchParams.get("tab") ?? "overview");

  // Shallow routing state (see below)
  const modalOpen = $derived(!!$page.state.modalId);
</script>
```

Always wrap `$page` reads in `$derived` so the component re-renders when
the route changes.

## Shallow Routing

Use `pushState` / `replaceState` from `$app/navigation` to store ephemeral UI
state (modals, fullscreen views) in the browser history without a full
navigation. The user can press Back to dismiss.

```svelte
<script lang="ts">
  import { pushState } from "$app/navigation";
  import { page } from "$app/stores";

  function openFullscreen(chartId: string) {
    pushState("", { fullscreenChartId: chartId });
  }

  // Read the state reactively
  const fullscreenGraph = $derived.by(() => {
    const chartId = $page.state.fullscreenChartId;
    if (!chartId || !dashboard) return null;
    return dashboard.graphs.find((g) => g.id === chartId) ?? null;
  });
</script>

{#if fullscreenGraph}
  <FullscreenChartModal open={true} graph={fullscreenGraph} onclose={() => history.back()} />
{/if}
```

**Key points:**

- First argument to `pushState` is the URL (empty string = keep current URL)
- State is typed via `App.PageState` in `src/app.d.ts`
- State is lost on full page reload (it's in-memory only)

## Load Functions

Load functions run before the page renders and provide data via `export let data`
(Svelte 4) or the `data` prop (Svelte 5).

```typescript
// +page.server.ts — server-only, can access DB, secrets
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  const dashboard = await db.getDashboard(params.id);
  return { dashboard };
};
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<h1>{data.dashboard.name}</h1>
```

**This project's approach:** Most data fetching happens client-side through
reactive stores (DashboardStore, GraphStore) rather than SvelteKit load
functions. This is because the app is an SPA with Supabase auth — the stores
manage loading/error state and cache data across navigations.

## Navigation

```typescript
import { goto } from "$app/navigation";

// Navigate programmatically
goto(`/dashboard/${id}`);

// Navigate with state replacement (no back button entry)
goto("/dashboard", { replaceState: true });
```

### URL Canonicalisation — Avoid Same-URL `goto` Loops

When an `$effect` reads `$page.url.searchParams` and calls `goto()` to
canonicalise the URL (e.g. project default params back into the URL so
shareable links always reflect rendered state), it **must** guard
against the case where the rebuilt target equals the current URL.
Otherwise the page freezes:

1. `$effect` reads `$page.url.searchParams` (subscription).
2. Effect computes the canonical target, finds it equals the current URL.
3. Effect calls `goto(target, { replaceState: true })` anyway.
4. SvelteKit's internal `_goto` has **no same-URL short-circuit on the
   programmatic path** — it runs `load_route`, calls `update_url`, and
   fires `stores.page.set(...)` + `stores.page.notify()`.
5. The page-store notify re-triggers the effect (it's subscribed via
   step 1) with the same inputs.
6. Loop. The tab hangs because the navigation queue never drains.

The previous form of the bug only doesn't trip when the canonical target
*always* differs from the no-params landing — e.g. when the serializer
always emits `?grader=PSA&variant=all`, the first goto writes those
params, the next tick's `search.has('grader') && search.has('variant')`
is true, and the effect early-exits. The moment the serializer is
"smartened" to omit defaults (so canonical URLs are shorter and cleaner),
the bare-URL case becomes a same-URL goto and the loop opens up.

#### ❌ Anti-pattern

```svelte
$effect(() => {
  const search = $page.url.searchParams;
  // Early-exit only when something is already in the URL.
  const hasAnyKnownParam =
    search.has("a") || search.has("b") || search.has("c");
  if (hasAnyKnownParam) return;

  const query = serializeParams(currentState).toString();
  const suffix = query.length > 0 ? `?${query}` : "";
  // BUG: when `serializeParams` returns "" for all-default state, this
  // gotos the same URL we're already on. Page-store notify → re-fire
  // → goto → notify → … freeze.
  void goto(`/page/${id}${suffix}`, { replaceState: true });
});
```

#### ✅ Correct

```svelte
$effect(() => {
  const search = $page.url.searchParams;
  const hasAnyKnownParam =
    search.has("a") || search.has("b") || search.has("c");
  if (hasAnyKnownParam) return;

  const query = serializeParams(currentState).toString();
  const suffix = query.length > 0 ? `?${query}` : "";
  const target = `/page/${id}${suffix}`;

  // CRITICAL: skip when the rebuilt URL is already canonical. The early
  // `hasAnyKnownParam` exit is not sufficient — a serializer that omits
  // defaults produces an empty query, and goto to the same URL still
  // fires a page-store notify that re-triggers this effect.
  if (target === $page.url.pathname + $page.url.search) return;

  void goto(target, { replaceState: true });
});
```

#### Why unit tests don't catch this

The bug requires three things together: `$effect` reactive context, an
active `$page` store, and `goto()` actually firing a navigation. Page-
component unit tests typically mock `$app/navigation` (so `goto` is a
`vi.fn()`) and don't run a full SvelteKit page lifecycle, so the
notify-re-fire chain never materialises. The reliable detection is a
manual smoke load on the bare URL (`/page/<id>` with no params) — a
frozen tab is the only signal.

When extracting a canonicalisation block into a pure helper (e.g.
`deriveCanonicalUrl(currentState, pathname): string | null` returning
`null` when no goto is needed), unit testing the helper directly is
cheap and a good complement to the manual smoke. Return `null` from
the helper when the canonical equals the current — the caller calls
`goto` only on non-null returns.

#### Related anti-patterns

This is one instance of the broader "**`$effect` subscribes to X, writes
something that re-triggers X**" loop family. The Svelte 5 anti-patterns
section of `SKILL.md` documents the in-component variants
(`state_unsafe_mutation`, read-then-write store loops); the SvelteKit
twist is that `$page.url` is *also* a write-target via `goto`, so the
same loop shape applies across the store boundary. The fix shape is
also consistent: either `untrack()` the read, or guard the write with
an equality check.

## Environment Variables

Access environment variables through SvelteKit's module system:

```typescript
// Client-side (must be prefixed with PUBLIC_)
import { PUBLIC_SUPABASE_URL } from "$env/static/public";

// Server-side only (+page.server.ts, +server.ts, hooks)
import { DATABASE_URL } from "$env/static/private";

// Vite env vars (legacy, still used for some config)
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
```

## Exemplar Files

Look in your project's `src/routes/` for routes that use params + shallow routing + store
integration as references. The root `+layout.svelte` is the right place to wire theme and
providers. Routes with a different auth context (e.g., public shared views) should live under
their own segment.
