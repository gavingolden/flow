# Example PRD: Dashboard Sharing

This is a completed PRD for a real feature in this project. Use it as a reference for tone,
specificity, and structure — not as a template to copy verbatim.

---

# Dashboard Sharing

## Problem Statement

Users have no way to show their dashboards to people who don't have Stax Data accounts. A user
who builds a dashboard tracking economic indicators for a meeting or report has to screenshot it
or present their screen — the viewer can't interact with the data, and the dashboard goes stale
immediately. Shareable links would let users distribute live, read-only dashboards to anyone with
the URL.

## Scope Boundary

**In scope:** Share via secret link (anyone with the URL can view). One link per dashboard.
Toggle link on/off. Anonymous read-only viewing of shared dashboards.

**Out of scope:** Granular permissions (view/edit), sharing with specific users by email,
collaborative editing, share analytics (who viewed when), expiring links.

## User Stories / Acceptance Criteria

### Story 1: Share a dashboard

- [ ] Given I own a dashboard, when I click "Share", then a unique shareable URL is generated
- [ ] Given a share link exists, when I view the share dialog, then the URL is displayed and
      copyable
- [ ] Given a share link exists, when I toggle it off, then the link stops working for viewers
- [ ] Given a share link is toggled off, when I toggle it back on, then the same URL works again

### Story 2: View a shared dashboard

- [ ] Given a valid share token in the URL, when an anonymous user visits `/s/{token}`, then
      they see the dashboard with all graphs and expressions rendered
- [ ] Given an invalid or deactivated token, when anyone visits the URL, then they see a "not
      found" page (no information leakage about whether the dashboard exists)
- [ ] Given a shared dashboard, the viewer cannot edit, delete, or navigate to other dashboards

## Architecture Decisions

- **Layers touched:** Database (new table + RPC), Domain model (new `share` module), UI
  (share dialog + shared view page)
- **Domain modules:** New `share` module. References `dashboard`, `graph`, and `expression`
  for the read-only view
- **Data flow:** CRUD entity pattern (Supabase direct). Anonymous access uses a SECURITY DEFINER
  RPC function to bypass RLS — the function validates the token itself
- **Pattern:** Follows standard domain module pattern. No Go proxy needed (no external API).
  The RPC function is a one-off pattern justified by the anonymous access requirement

## Technical Constraints

- RLS must enforce that only dashboard owners can create/manage share links
- Anonymous viewing must NOT use a service role key in the frontend — the SECURITY DEFINER
  RPC on the database side handles this
- The shared view must render the dashboard exactly as the owner sees it (same expressions,
  same graphs, same time range) but with all editing UI removed
- Share tokens are UUIDs — no sequential or guessable identifiers

## Task Breakdown

### Task 1: Create dashboard_shares migration

- **Skill:** `database`
- **Description:** Create the `dashboard_shares` table with columns (id, dashboard_id, token,
  is_active, timestamps), unique constraints, RLS policies for owner-only access, and the
  `get_shared_dashboard` SECURITY DEFINER RPC function
- **Inputs:** Existing `dashboards` table schema
- **Outputs:** Migration file, generated TypeScript DB types
- **Acceptance criteria:** Migration applies cleanly; RLS prevents non-owners from querying
  the table; RPC returns full dashboard+graphs+expressions payload for valid tokens

### Task 2: Build share domain model

- **Skill:** `svelte`
- **Description:** Create `src/lib/domain/share/` with Share entity, ShareRepository (CRUD +
  RPC call), SharedDashboardPayload type, DB types, and barrel exports
- **Inputs:** Generated DB types from Task 1
- **Outputs:** Domain module with repository, entity, and payload type
- **Acceptance criteria:** Repository methods return `Result<T, ShareError>`; Share entity
  exposes a `shareUrl` computed property; SharedDashboardPayload correctly types the nested
  dashboard+graphs+expressions structure

### Task 3: Build share dialog UI

- **Skill:** `ui`
- **Description:** Create a share dialog accessible from the dashboard page. Shows share URL
  with copy button, toggle to activate/deactivate the link
- **Inputs:** Share domain model from Task 2
- **Outputs:** ShareDialog component, integration into dashboard page header
- **Acceptance criteria:** Dialog creates share on first open; copy button works; toggle
  updates is_active; disabled state shows "Link is inactive"

### Task 4: Build shared dashboard viewer page

- **Skill:** `svelte`
- **Description:** Create `/s/[token]` route that calls the RPC function, deserializes the
  payload into domain models, and renders the dashboard read-only
- **Inputs:** SharedDashboardPayload type from Task 2, existing dashboard/graph/expression
  rendering components
- **Outputs:** Shared view page with read-only rendering, 404 handling for invalid tokens
- **Acceptance criteria:** Valid token renders full dashboard; invalid token shows 404; no
  editing UI is visible; all expressions evaluate and charts render

### Task 5: Write tests

- **Skill:** `testing`
- **Description:** Unit tests for ShareRepository (mock Supabase client), Share entity, and
  SharedDashboardPayload deserialization
- **Inputs:** Share domain module from Task 2
- **Outputs:** Test files with full coverage of repository methods and entity behavior
- **Acceptance criteria:** Tests pass; cover create, get, toggle, and RPC call paths; cover
  error cases (DB errors, not found)

## Open Questions

- [ ] Should share links have an expiration date? (Decided: no for v1, but the schema should
      accommodate adding an `expires_at` column later)
- [ ] Should the shared view show a "Built with Stax Data" watermark? (Needs product decision)
