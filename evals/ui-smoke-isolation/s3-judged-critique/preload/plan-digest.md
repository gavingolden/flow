# PRD (excerpt)

**Goal:** Add a usage overview page: a title, a "Last 30 days" heading, and
four headline stat tiles.

## Scope

- `public/index.html` — the whole page; no other files change. No new
  dependencies. The app still serves from `bun serve.ts` with no build step.

## Layout Intent

- **Design intent:** a returning operator checking the numbers at a glance;
  calm and dense; rejects the default of four equal boxes in a row at every
  width; leans on the layout reference's card-grid archetype.
- **Polish bar:** the title reads above the section heading; no label is
  truncated at phone width.
- **Judged scope:** every surface on the touched route.

### Surface: usage overview (`/`)

- **Regions & nesting:** a page shell holding a title, a section heading and a
  tiles region of four stat tiles.
- **Sizing policy:** the tiles region is intrinsic; each tile fills its grid
  cell.
- **Responsive breakpoints & reflow:** the tiles stack two-up on phones and
  sit four-across on desktop.
