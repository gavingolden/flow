# Architecture Patterns

Reference for planning decisions. Load this when you need to determine which layers a feature
touches and how tasks should be ordered.

## Domain Module Anatomy

Every domain area in `src/lib/domain/` follows this file structure. Not every file is always
needed — use what the feature requires.

| File                     | Purpose                                   | When Needed                          |
| ------------------------ | ----------------------------------------- | ------------------------------------ |
| `entity.svelte.ts`       | Reactive domain model (uses `$state`)     | Always — this IS the domain entity   |
| `entity-dto.ts`          | Maps between DB rows and domain models    | When entity is persisted to Supabase |
| `entity.repository.ts`   | Supabase CRUD operations                  | When entity is persisted to Supabase |
| `entity.store.svelte.ts` | Global reactive store for UI state        | When UI needs shared state           |
| `entity-db-types.ts`     | TypeScript types generated from DB schema | When entity has a DB table           |
| `index.ts`               | Barrel exports                            | Always                               |

**Full example — dashboard domain** (`src/lib/domain/dashboard/`):

```
dashboard.svelte.ts          # Dashboard class with $state fields (id, name, timeRange, graphs)
dashboard-dto.ts             # DashboardDto serializes TimeRange to/from DB columns
dashboard.repository.ts      # DashboardRepository: CRUD via Supabase client (injected)
dashboard.store.svelte.ts    # DashboardState + DashboardListState for UI
dashboard-db-types.ts        # DashboardRow, DashboardInsert, DashboardUpdate, DashboardError
dashboard-search-params.ts   # URL search param helpers (feature-specific, not standard)
index.ts                     # Barrel exports
```

**Minimal example — share domain** (`src/lib/domain/share/`):

```
share.svelte.ts              # Share class (immutable, no $state — read-only entity)
share.repository.ts          # ShareRepository + RPC call for anonymous access
share-db-types.ts            # ShareRow, ShareError
shared-dashboard-payload.ts  # Composite type for the full shared view (dashboard + graphs + expressions)
index.ts                     # Barrel exports
```

Note: Share has no DTO (simple enough to map inline), no store (state lives in the dashboard
context), and no `$state` (shares are immutable once created).

## Data Flow Patterns

The project has three distinct data flows. Knowing which one applies determines the task ordering.

### 1. CRUD Entities (Supabase Direct)

**Used by:** dashboards, graphs, expressions, shares, profiles

```
UI component → domain store → repository → Supabase → PostgreSQL
                                                ↕
                                              RLS policies enforce ownership
```

Tasks follow: DB migration → DB types → DTO → Repository → Domain model → Store → UI

### 2. External Data (Backend Proxy)

```
UI component → source function → Backend proxy → External API
                    ↓
              Domain objects → transformation → rendering
```

A backend proxy exists when API keys must never reach the frontend. Every external data source
that requires a secret goes through it.

Tasks follow: Backend proxy handler → Manifest/config → Source function → UI integration

### 3. Computed Data (Client-Side)

```
Query results → client-side evaluation → derived results
```

Purely client-side. No backend involvement.

## Decision Trees

### Does this feature need a new database table?

- Is there new user-owned data that must survive page refresh? → **Yes**
- Is the data derived from existing tables? → Probably not — compute it
- Is it configuration/preferences? → Consider adding columns to an existing table first

If yes: plan a migration task as the first dependency. Include RLS policies (every table needs them)
and an `updated_at` trigger.

### Does this feature need the Go proxy?

- Does it call an external API that requires an API key? → **Yes, always**
- Does it call a public API with no authentication? → Still yes, for rate limiting and caching
- Is all data already in Supabase? → No proxy needed

If yes: the Go handler is a separate task from the frontend integration. Check if the
`data-provider` skill applies.

### New domain module or extend an existing one?

- Does this represent a new entity type with its own lifecycle? → **New module**
- Does it add behavior to an existing entity? → **Extend** (add files to existing module)
- Is it cross-cutting (touches multiple entities)? → New module with references to existing ones

Existing domain modules: `dashboard`, `data-source`, `expression`, `feedback`, `graph`,
`keybinds`, `profile`, `share`, `shared` (shared types/utilities).

### `.svelte.ts` or plain `.ts`?

- Does the file use `$state`, `$derived`, or `$effect`? → `.svelte.ts`
- Is it pure logic, types, or utilities? → `.ts`

## Layer Dependency Ordering

When breaking features into tasks, follow this ordering. Each layer depends on the ones above it.

```
1. Database migration         (schema, RLS, triggers, RPCs)
2. Generated DB types         (run type generation after migration)
3. Go proxy handler           (if external API involved)
4. Domain model               (entity class, DTO, repository)
5. Domain store               (reactive state management)
6. UI components              (pages, components, layouts)
7. Integration wiring         (connecting layers, route setup)
8. Tests                      (unit + integration per layer)
```

A task at layer N should only depend on tasks at layers 1 through N-1. If you find a circular
dependency, the tasks are too coarse — split them.
