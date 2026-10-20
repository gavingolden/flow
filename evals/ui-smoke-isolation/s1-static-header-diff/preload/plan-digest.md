# PRD (excerpt)

**Goal:** Restructure the marketing site's header into a persistent
top-nav bar (`#nav`) with links to the three main sections, replacing the
current plain `<h1>`-only header.

## Scope

- `public/index.html` — wrap the existing `<h1>` in a `<header>`, add a
  `<nav id="nav">` sibling with three `<a>` links.
- No other files change. No new dependencies. The app still serves from
  `bun serve.ts` with no build step.

## Acceptance

- `GET /` returns a page containing an element matching `#nav`.
- No console errors, no failed requests.
