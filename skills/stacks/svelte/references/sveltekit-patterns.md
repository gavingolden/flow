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
