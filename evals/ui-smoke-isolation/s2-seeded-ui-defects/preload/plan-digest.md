# PRD (excerpt)

**Goal:** Add a quarterly report page: a sticky header with a "Jump to
details" link, a summary, a three-region table, and a details section.

## Scope

- `public/index.html` — the whole page; no other files change. No new
  dependencies. The app still serves from `bun serve.ts` with no build step.

## Acceptance

- `GET /` returns a page containing an element matching `#summary`.
- The page reads cleanly at phone and desktop widths: no leaked markers in
  visible text, the jump link lands visibly below the header, nothing runs
  past the viewport, and no control is duplicated without a reason.
- No console errors, no failed requests.
