# Store Architecture Reference

This project's domain state management follows a layered architecture:
**Store -> Repository -> Database**. Loaded on-demand from the `svelte` skill.

## Overview

```
┌─────────────────────────┐
│  Component (.svelte)    │  Reads store state, calls store methods
├─────────────────────────┤
│  Store (.store.svelte.ts)│  Reactive state ($state), business logic
├─────────────────────────┤
│  Repository (.ts)       │  Data access, returns Result<T, E>
├─────────────────────────┤
│  Database (Supabase)    │  Persistence layer
└─────────────────────────┘
```

**Why this layering matters:**

- Stores own reactive state and can be used directly in components
- Repositories are pure data access — no reactivity, no UI concerns
- Factory injection makes stores testable without a real database
- The Result type forces callers to handle errors explicitly

## Store Pattern

Stores are reactive classes that manage domain state with `$state` fields and
expose async methods for CRUD operations.

```typescript
// dashboard.store.svelte.ts

export type DashboardState = {
  dashboard: Dashboard | null;
  loading: boolean;
  error: DashboardError | null;
};

export type RepositoryFactory = () => Result<DashboardRepository, DashboardError>;

export class DashboardStore {
  private state: DashboardState = $state({
    dashboard: null,
    loading: false,
    error: null,
  });

  constructor(private readonly repositoryFactory: RepositoryFactory) {}

  getState(): DashboardState {
    return this.state;
  }

  async loadById(dashboardId: string): Promise<void> {
    this.state.loading = true;
    this.state.error = null;

    try {
      const repoResult = this.repositoryFactory();
      if (!repoResult.ok) {
        this.state.error = repoResult.error;
        return;
      }

      const result = await repoResult.data.getById(dashboardId);
      if (result.ok) {
        this.state.dashboard = result.data;
      } else {
        this.state.error = result.error;
      }
    } finally {
      this.state.loading = false;
    }
  }

  clear(): void {
    this.state.dashboard = null;
    this.state.error = null;
    this.state.loading = false;
  }
}

// Module-level singleton wired to the real factory
export const dashboardStore = new DashboardStore(createDashboardRepository);
```

### Key patterns

- **`$state` for the state object** — the entire state shape is reactive, so
  components that read `state.loading` automatically re-render when it changes
- **`RepositoryFactory` type** — a function that returns `Result<Repo, Error>`,
  not the repo directly, because repo creation can fail (e.g., Supabase not
  configured)
- **Module-level singleton** — `export const dashboardStore = new DashboardStore(...)`
  provides a shared instance across all components
- **Expose state via getter** — `getState()` returns the reactive state object
  so components can destructure: `const { dashboard, loading } = dashboardStore.getState()`

## Repository Pattern

Repositories handle data access and return typed `Result` values:

```typescript
// dashboard.repository.ts

export class DashboardRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getById(id: string): Promise<Result<Dashboard, DashboardError>> {
    const { data, error } = await this.client.from("dashboards").select("*").eq("id", id).single();

    if (error) {
      return { ok: false, error: { code: "DB_ERROR", message: error.message } };
    }

    return { ok: true, data: Dashboard.fromDb(data) };
  }
}

// Factory function — returns Result because client initialization can fail
export function createDashboardRepository(): Result<DashboardRepository, DashboardError> {
  if (!supabase) {
    return { ok: false, error: { code: "NOT_CONFIGURED", message: "Supabase not available" } };
  }
  return { ok: true, data: new DashboardRepository(supabase) };
}
```

## Result Type

All repository operations return `Result<T, E>` instead of throwing:

```typescript
// result.ts
export type Result<T, E> = { ok: true; data: T } | { ok: false; error: E };
```

This forces callers to check the `ok` flag before accessing data, preventing
unhandled errors.

## Dependency Injection for Testing

The factory pattern enables testing without a real database:

```typescript
// In tests
const mockFactory: RepositoryFactory = () => ({
  ok: true,
  data: {
    getById: async () => ({ ok: true, data: Dashboard.fromDb(mockData) }),
    // ... other methods
  } as DashboardRepository,
});

const testStore = new DashboardStore(mockFactory);
await testStore.loadById("test-id");
expect(testStore.getState().dashboard).toBeDefined();
```

## Using Stores in Components

```svelte
<script lang="ts">
  import { dashboardStore } from "$lib/domain/dashboard";

  // Get the reactive state object
  const dashboardState = dashboardStore.getState();

  // Load data (usually triggered by route change)
  $effect(() => {
    dashboardStore.loadById(dashboardId);
  });
</script>

{#if dashboardState.loading}
  <LoadingSkeleton />
{:else if dashboardState.error}
  <p class="text-destructive">{dashboardState.error.message}</p>
{:else if dashboardState.dashboard}
  <h1>{dashboardState.dashboard.name}</h1>
{/if}
```

## When to Create a New Store

Create a store when a domain entity needs:

- **Persistence** — CRUD operations against the database
- **Shared reactive state** — multiple components read/write the same data
- **Loading/error lifecycle** — async operations with UI feedback

For simple reactive state without persistence, a plain reactive class or
composable function is sufficient.

## Exemplar Files

| File                                                 | What it demonstrates                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/lib/domain/dashboard/dashboard.store.svelte.ts` | Full store with list + detail state, DI                                      |
| `src/lib/domain/graph/graph.store.svelte.ts`         | Simpler store — save/delete only, error callbacks                            |
| `src/lib/auth.svelte.ts`                             | Module singleton with HMR disposal, no repository (direct Supabase auth API) |
| `src/lib/domain/dashboard/dashboard.svelte.ts`       | Reactive domain model (not a store)                                          |
