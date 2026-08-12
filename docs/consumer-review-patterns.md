# Consumer Review Patterns

This doc is a **portable seed**, not a loaded checklist. It holds review-pattern entries that
are specific to a consumer repo's stack (Svelte/bits-ui, Supabase/Postgres, service-worker/web,
Go, a particular test-environment setup) rather than to flow itself. **No flow skill reads this
file.** It exists so a consumer repo can bootstrap its own `.flow/review-checklist.md` (see
`references/consumer-repo-contract.md`) instead of starting from a blank page.

**Adoption path:** in the consumer repo, `cp docs/consumer-review-patterns.md
.flow/review-checklist.md` (or copy the sections that apply), then prune/extend it — every
review-lens agent reads `.flow/review-checklist.md` when present, at the same standing as its
own lens checklist.

---

## Svelte / UI

### Accessibility

Interactive UI elements must expose their semantics and state to assistive technologies.
Missing labels and incorrect ARIA roles cause controls to be invisible or misleading to
screen readers.

**What to look for:** `<button>`, `<input>`, `<textarea>`, `<select>` without `aria-label`,
`aria-labelledby`, or an associated `<label>`; custom widgets (star ratings, toggles, tab
bars) without appropriate ARIA roles (`radiogroup`, `radio`, `tab`, `tablist`); interactive
elements that change visual state without corresponding `aria-checked`/`aria-selected`/
`aria-expanded`; `placeholder` used as the only accessible name.

**How to check:**

1. For every interactive element in the diff, verify it has a programmatic accessible name.
2. For custom widgets mimicking native controls, verify appropriate ARIA roles and state
   attributes.
3. Confirm visual state changes have matching ARIA state attributes.

**General rule:** if a visual state change communicates meaning to sighted users, there must
be a corresponding ARIA attribute communicating the same meaning to assistive tech.

### Component Composition

When composing multiple headless UI primitives (e.g., Tooltip + Popover from bits-ui), each
primitive's trigger must forward its props to the actual rendered element via the `child`
snippet pattern. Missing prop forwarding causes the primitive to silently lose
keyboard/screen-reader behavior.

**What to look for:** multiple trigger/wrapper primitives nested around a single interactive
element; `child` snippet used on one primitive but not its siblings; headless UI components
used without the `{#snippet child({ props })}` pattern.

**How to check:**

1. For each headless trigger in the diff, verify it uses `{#snippet child({ props })}` and
   spreads `{...props}` on the rendered element.
2. When multiple triggers wrap the same element, verify **all** of them forward props.
3. Confirm prop spreading order puts more-specific props last.

**General rule:** every headless trigger wrapping an element must use the `child` snippet to
forward its props. If you see nested triggers, count the `child` snippets — the count must
match.

### New Top-Level Landmark Must Match Sibling Landmark Container Styling

A PR that introduces a new top-level landmark (`<main>`, `<header>`, a page-owning wrapper)
on a route that previously delegated to a shared layout must carry over the shared layout's
container guards (`overflow-x-hidden`, safe-area padding, scroll containment) — not just its
visual vocabulary. A decorative child that deliberately overflows (full-bleed SVG, marquee
band) makes the missing guard user-visible as horizontal scroll on narrow viewports, because
the guard also protects against FUTURE children.

**How to check:** `grep -rn '<main' <src>` and diff the class lists of every `main` landmark;
if the new landmark omits a guard the others share, flag as `suggestion (non-blocking)`.

### Dangling Separator on Empty Optional Subfield

When a UI renders `label — detail` (or similar separator-joined pairs) from
defensively-parsed data where a subfield may be empty, check that the separator renders only
when the subfield is non-empty. Lenient parsers that keep partially-empty entries make the
dangling-separator state reachable. Look for: template literals or markup joining two
optional strings with a fixed separator.

---

## Supabase / Postgres

### SECURITY DEFINER `search_path` Pinning Judged Against the Repo, Not the Copied File

A new `SECURITY DEFINER` function copied from one precedent migration can silently omit a
hardening convention (`SET search_path = public`) that other migrations in the same repo do
apply. "The file I copied didn't pin it" is not evidence the repo lacks the convention.

**How to check:**

1. `grep -rn "SECURITY DEFINER" supabase/migrations/` and compare: do OTHER migrations
   append `SET search_path = public`? If any do, flag the new function even when the
   nearest-copied precedent omits it.
2. Inside the new function/backfill, check every table reference is schema-qualified
   consistently with the rest of the same file.

**General rule:** for security-hardening conventions, the standard is the strictest
precedent in the repo, not the file the author happened to copy.

### SECURITY DEFINER RPC Revoked from PUBLIC Without an Explicit service_role EXECUTE Grant

When a migration creates a function (especially `SECURITY DEFINER`) and hardens it with
`REVOKE EXECUTE ... FROM PUBLIC, authenticated, anon`, check that every backend caller's DB
role still holds EXECUTE — Postgres roles do not bypass EXECUTE grants, and Supabase's
`service_role` reaches RPCs only via a default-privileges grant that a prior hardening
migration may have narrowed. A local stack can green-light the call while prod denies it if
the two diverge on default privileges. Look for: `REVOKE ... ON FUNCTION` with no paired
`GRANT EXECUTE ... TO service_role` in the same migration.

---

## Service-Worker / Web

### HTTP Freshness Intent vs SW Precache Membership

A file given a `Cache-Control: no-cache` / revalidate-always rule (via `_headers`, server
config, or meta headers) that is simultaneously swept into a service worker's precache and
served cache-first has its freshness intent silently defeated: once the SW controls the
page, the HTTP rule never fires.

**What to look for:** a PR that both (a) adds/edits an HTTP caching rule for a specific
asset and (b) builds a SW precache list from a wholesale `files`/static directory sweep;
exclusion lists that name some always-revalidate assets but not all of them.

**How to check:**

1. List every path named in the PR's HTTP caching rules.
2. For each, check whether the SW precache-list builder includes it.
3. Any path with a revalidate-always HTTP rule that is also precached+served-cache-first is
   a finding — exclude it from the precache or intentionally document the override.

**General rule:** every asset the PR marks revalidate-always over HTTP must be absent from
any cache-first SW layer the same PR ships.

---

## Go

### Timestamp Parse with `time.RFC3339` Against PostgREST/Supabase Values

When Go code parses timestamps returned by PostgREST/Supabase with `time.Parse(time.RFC3339,
...)`, check for fractional seconds — Supabase timestamptz values serialize with microseconds
(RFC3339Nano shape), so a strict RFC3339 parse fails. Especially dangerous when the parse
error is swallowed into a boolean/default (`return false on error`), silently defeating the
gate the timestamp feeds. Look for: `time.Parse(time.RFC3339, row["created_at"])` (or any
DB-sourced timestamp) whose error path collapses to a permissive default; require
`time.RFC3339Nano` (parses both) or explicit error propagation.

---

## Test Environment

Tests that use browser APIs need the correct Vitest environment and SvelteKit module mocks.
Missing these causes cryptic failures or false passes. The jsdom/mock pattern below is
Svelte-specific, but the underlying principle (tests exercising browser/framework globals
need the matching test environment) generalizes to any framework with an equivalent
test-environment flag.

**What to look for:** test files that import code using `window`, `navigator`, `document`,
`fetch`, `matchMedia`, `localStorage`, `sessionStorage`, or `$app/environment`,
`$app/navigation`, `$app/stores`.

**How to check:**

1. Does the test file have `@vitest-environment jsdom` in a doc comment at the top?
2. Does it mock `$app/environment` with `vi.mock("$app/environment", () => ({ browser: true }))`?
3. Are other SvelteKit modules mocked if imported?
4. Are global property stubs (e.g., `navigator.onLine`) scoped to `beforeAll`/`afterAll` or
   save/restore in `beforeEach`/`afterEach`?

**General rule:** if the production code has a `browser` guard or touches a browser global,
the test needs jsdom + the corresponding mock.
