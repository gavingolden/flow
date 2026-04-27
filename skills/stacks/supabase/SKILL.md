---
name: supabase
description: >-
  Modify the PostgreSQL database schema, write Supabase migrations, add indexes,
  configure RLS policies, or regenerate TypeScript types. Use when user says
  "create migration", "add column", "schema change", "generate types", "add RLS",
  "database index", or "update seed data".
---

# Goal

Maintain a secure, performant, and type-safe database layer using Supabase local development and PostgreSQL best
practices.

# When to Use

- Creating or altering tables, columns, indexes, or constraints
- Writing new Supabase migration files
- Regenerating TypeScript types after a schema change
- Adding or modifying Row Level Security (RLS) policies
- Updating seed data after a schema change

# When NOT to Use

- Frontend UI changes (defer to `tailwind-shadcn` or `svelte`)
- Application-level data fetching or transformation logic (no skill needed)
- Backend Go handler changes unrelated to a schema change (no skill needed)
- Writing tests for database-adjacent domain code (defer to `testing`)

# Context

- Migrations directory: `supabase/migrations/`
- Generated types: project's configured types output path (commonly `src/lib/database/types.ts` for SvelteKit projects). Check the `db:types` script in `package.json` for the exact location.
- Seed file: `supabase/seed.sql`
- Migration template: `.claude/skills/supabase/templates/migration.sql.template`
- Shared database functions: an early migration (e.g., `*_shared_functions.sql`) typically defines reusable triggers like `handle_updated_at()`.
- Domain files that consume DB types: project-specific (commonly `src/lib/domain/`).

**Available npm scripts:**

| Command                           | Purpose                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `npm run db:start`                | Start local Supabase (loads `.env`)                                |
| `npm run db:stop`                 | Stop local Supabase                                                |
| `npm run db:restart`              | Stop + start local Supabase                                        |
| `npm run db:types`                | Regenerate TypeScript types from local DB                          |
| `npm run db:migration:new <desc>` | Create timestamped migration file                                  |
| `npm run db:migration:up:local`   | Apply pending migrations locally                                   |
| `npm run db:reset:local`          | **Destructive** — reset local DB and reapply all migrations + seed |
| `npm run db:status`               | List migration status                                              |
| `npm run db:diff`                 | Auto-generate migration SQL from schema changes made in Studio     |
| `npm run db:studio`               | Open Supabase Studio in browser                                    |

# Instructions

## 1. Create Migration

- Run `npm run db:migration:new <description>` to generate a timestamped file.
- Use `.claude/skills/supabase/templates/migration.sql.template` as the starting skeleton.
- Write pure PostgreSQL in the migration file.
- Include a comment header explaining the purpose of the migration.

**Alternative — diff-based migration:** If changes were made interactively in Supabase Studio,
run `npm run db:diff` to auto-generate the migration SQL, then review and clean up the output.

## 2. Security (RLS)

Enforce Row Level Security on all new tables (per `AGENTS.md` Security section).

- Enable RLS: `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;`
- Define explicit SELECT, INSERT, UPDATE, and DELETE policies (or use `FOR ALL` when predicates are identical).
- Use `auth.uid()` for user-scoped access.
- **Child tables without `user_id`:** Use the nested `EXISTS` subquery pattern. See `references/nested-rls-pattern.md`.

## 3. Performance and Integrity

- Add B-Tree indexes on foreign keys and frequently queried columns.
- Consider GIN indexes for JSONB or full-text search columns.
- Add check constraints for data integrity (e.g., enum validation, positive values).
- **JSONB expression indexes:** Use `CREATE UNIQUE INDEX ... ON table ((config->>'key'))` when enforcing
  uniqueness on JSONB fields.

## 4. `updated_at` Triggers

All tables with an `updated_at` column must have an auto-update trigger using the shared
`handle_updated_at()` function:

```sql
CREATE TRIGGER update_<table_name>_updated_at
    BEFORE UPDATE ON <table_name>
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();
```

## 5. Apply and Generate Types

- Apply the migration: `npm run db:migration:up:local` for incremental, or `npm run db:reset:local`
  for a clean reset (**requires user approval — destroys local data**).
- Check migration status: `npm run db:status`.
- Regenerate TypeScript types: `npm run db:types`.
- Review the generated types file to confirm the new types appear.

## 6. Frontend Sync

- Review domain files (commonly under `src/lib/domain/`) that consume the changed tables.
- Update TypeScript imports and types to use the newly generated definitions.

## 7. Update Seed Data (if applicable)

If the migration adds new required columns or tables that affect development workflows:

- Export current data: `supabase db dump --data-only --schema public --schema auth -f supabase/seed.sql`
- Include `--schema auth` to preserve user references that `public` tables depend on.
- Commit the updated `supabase/seed.sql`.

# Troubleshooting

**Migration fails on `db:migration:up:local`:**

- Check the error message for conflicting constraints or missing dependencies.
- If the local DB is in a bad state, use `npm run db:reset:local` (requires user approval).
- Use `npm run db:status` to check which migrations have been applied.

**Type generation fails (`db:types`):**

- Ensure Supabase is running: `npm run db:start`.
- Confirm the migration was applied successfully before generating types.

**Seed data breaks after Supabase CLI upgrade:**

- The `auth.sessions` schema may change between CLI versions (e.g., `scopes` column).
- Remove `INSERT INTO auth.sessions` statements from `supabase/seed.sql`, or run
  `supabase db reset --local --no-seed` if session data isn't needed.

# Verification

- Migration applies cleanly via `npm run db:migration:up:local` or `npm run db:reset:local`.
- `npm run db:types` generates updated types without errors.
- `npm run check` and `npm run lint` pass with no type errors in domain files.
- RLS policies are present for all new tables.
- `updated_at` triggers are present for all tables with an `updated_at` column.

# Constraints

- NEVER execute raw SQL directly against the database — use the migration system.
- NEVER modify the generated types file manually — it is regenerated by `db:types`.
- NEVER run `npm run db:reset:local` without explicit user approval — it destroys all local data.
- NEVER omit `updated_at` triggers on tables with an `updated_at` column.
- Use `npm run db:types` instead of the raw `supabase gen types` command to ensure consistency.
