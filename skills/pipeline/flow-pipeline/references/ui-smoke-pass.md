# Browser-driven UI-smoke pass (gate-time)

The shared procedure behind the gate-time UI-smoke pass that both `/flow-pipeline` Step 6 (the supervisor-side "Automated UI-smoke pass") and `/verify`'s "Optional UI-smoke pass" run. Both consumers keep a short pointer and their own framing (the supervisor's 3-attempt fix loop; `/verify`'s "alongside `flow-pre-commit`" + Step 3 routing); the full probe → fallback → launch → drive-MCP → assemble → fix-loop → noise-filter → persist-back body lives here so the two cannot drift. This is the gate-time smoke pass; the review-time visual-appearance evidence path is a separate procedure documented in `../../pr-review/references/ui-validation-evidence.md`.

## When it runs

When the worktree declares a `.flow/ui-validation.json` manifest AND the `chrome-devtools` MCP is available in the session, run the browser-driven UI-smoke pass as part of the verify gate. The `chrome-devtools` MCP is resolved once at session start, so a manifest that appears mid-session without the MCP already connected stays not-runnable. Headless / MCP-absent runs stay green — the pass is an additive live check, never a blocker on environments that can't drive a browser.

## Probe and skip

Probe for the MCP first with a guarded `ToolSearch query="select:mcp__chrome-devtools__navigate_page"`. On missing schema, fall back to `flow-ui-validate --mcp-absent --manifest .flow/ui-validation.json` — a quiet `ran:false` / `skipped_reason: mcp-not-available` skip that never blocks the run, exactly mirroring `flow-pre-commit`'s optional-tool `skipReason` (the `actionlint` / `go` off-PATH skips). Otherwise run `flow-ui-validate --manifest .flow/ui-validation.json --changed-files <git diff --name-only HEAD>`. On a `ran:false` skip, relay the loud `nudge` when `loud:true` (the discovery prompt to copy `templates/ui-validation.json.example`, or a broken-precondition hint) and proceed — the rest of the diff still verifies.

## Launch and drive

On a `ran:true` ready envelope, read `meta.env` from the envelope and inject it into the launch subprocess's environment, then bring up the launch — a single command that may start frontend+backend on dedicated ports — open a per-pipeline isolated page first (`new_page` with an `isolatedContext` named from the pipeline slug — read `@flow-slug` / `~/.flow/state/<slug>.json` / the worktree basename — so two pipelines sharing one chrome-devtools MCP server do not bleed cookies/storage). Then drive the MCP per route, and **inside each route, loop over `meta.viewports`** (the envelope carries the declared set or the built-in default `xs 320 / mobile 390 / tablet 768 / desktop 1280 / wide 1440`): for each viewport `resize_page` to its `width` (use a tall fixed height — e.g. 2000px — so above-the-fold cropping never hides overflow) → the existing per-route `navigate_page` → `wait_for` → `take_snapshot` → `list_console_messages` → `list_network_requests` drive (honoring `manifest.disableAnimations` via `prefers-reduced-motion` emulation) → `evaluate_script` reading `document.scrollingElement.scrollWidth` / `clientWidth` and the page-root constrained container's `getBoundingClientRect()` left/right gaps (`rootGap: {left, right}`) → `take_screenshot` (filename includes the viewport name, e.g. `0-wide.png`). Write the enriched per-viewport captures JSON — each route gains a `viewports[]` array of `{ name, width, snapshotText, consoleErrors, failedRequests, screenshotPath, rootGap, scrollWidth, clientWidth }` — and call `flow-ui-validate --manifest .flow/ui-validation.json --captures <path>`; tear the launched server(s) down on completion. The helper applies the three mechanical geometry assertions (off-center, horizontal overflow, missing-element-at-breakpoint) to those raw NUMBERS — it never drives the MCP and never reads the DOM (the no-nested-LLM split below). Screenshot capture follows the save-path cascade documented in `/pr-review` Step 8c (worktree `.flow-tmp/ui-evidence/` preferred → session-cwd fallback → skip-with-loud-note; the a11y snapshot is the gate).

**Container-selection heuristic (page-root constrained container).** The element whose `rootGap` you pass is the outermost element under `<main>` (or `<body>` when there is no `<main>`) whose computed width is _less than_ the viewport width — i.e. a deliberately constrained column. Measure its `getBoundingClientRect()` and pass `rootGap.left` / `rootGap.right` as the distances from the viewport edges. A full-bleed element (width equal to the viewport) has no meaningful gap, so it is not the constrained container; skip it. The per-viewport "UI traits to verify" rubric — authored canonically in [../../pr-review/references/ui-validation-evidence.md](../../pr-review/references/ui-validation-evidence.md) under `## UI traits to verify` — is applied **per captured viewport** alongside these mechanical assertions.

**Shared-profile lock (parallel pipelines).** chrome-devtools-mcp backs every browser with a single default on-disk Chrome profile (`~/.cache/chrome-devtools-mcp/chrome-profile`), so two pipelines that both reach this pass under one un-isolated MCP registration contend for it — the second to launch errors with `The browser is already running for ~/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances`. On detecting the lock, drive `flow-ui-validate --browser-busy` — a loud-but-clean `ran:false` / `skipped_reason: browser-profile-busy` skip that degrades exactly like an absent MCP, never a hard failure. The cross-process fix is operator-side: register the chrome-devtools MCP with `--isolated` in `~/.claude.json` so each server process gets its own auto-cleaned throwaway profile. The per-call `isolatedContext` above is same-server defense-in-depth only — it isolates pages within one MCP server but does NOT resolve the cross-process on-disk-profile lock.

## Teardown (servers and browser, symmetric)

Tearing the launched server(s) down on completion is only half the cleanup —
the pass also opened a per-pipeline isolated page (`new_page` with an
`isolatedContext`), and that page/context must be torn down too, or the
chrome-devtools MCP Chrome is left running on the user's machine, holding its
profile lock and orphaning a browser window. Mirror the server teardown: on
completion **and on every error / early-exit path** (a launch failure, a
captures-assembly error, a fix-loop bail-out), close the per-pipeline isolated
page you opened — `close_page` on that page, disposing the `isolatedContext` —
in the same breath as bringing the launched server(s) down. Close **only** the
page/context THIS pipeline opened (keyed on the pipeline slug); never close a
sibling pipeline's page or any pre-existing page the user opened. `close_page`
takes the numeric `pageId` your `new_page` call returned — capture that id at
open time and pass exactly it; do NOT re-derive the page via `list_pages` at
teardown, since the `isolatedContext` name is not a closeable handle and a
`list_pages` scan under a shared MCP server can land on a sibling pipeline's
page or the user's own tab. The MCP-absent and headless paths opened nothing,
so teardown is a no-op there, never a failure.

## Fix-loop routing

A `ran:true` result with `ok:false` (a console error, a failed request, or a missing `expectSelectors` element) is a verify failure routed through the same fix loop as any failed `flow-pre-commit` check. Prefer a durable Playwright/vitest spec for any deterministic guard worth keeping forever; reserve the MCP pass for the live + visual-evidence checks.

## Noise filter

Benign request/console noise (canonically the favicon 404, which emits both a `/favicon.ico` failed request and a generic "Failed to load resource" console error) is suppressed via the manifest's optional `ignoreRequestPatterns` / `ignoreConsolePatterns` substring lists — manifest-config-only, no built-in default. **Adaptive noise filter:** when an `ok:false` flags a console error or failed request that is benign noise unrelated to the diff (a favicon 404, a third-party beacon/analytics request, browser-extension noise), do **not** consume a fix-loop attempt on it — add the offending substring to the manifest's `ignoreRequestPatterns` / `ignoreConsolePatterns` in `.flow/ui-validation.json` and **commit that manifest change** (it lands in the reviewable PR diff), then re-run; reserve the fix loop for post-filter errors the diff actually introduced.

## Self-improving manifest

**Self-improving manifest (CRITICAL):** reusing that same commit-the-manifest-change precedent, when the agent adapts the launch on the fly to make a custom-port run work (tweaks the command, adds/changes an `env` var, fixes `baseUrl`), it persists the launch adaptation back into `.flow/ui-validation.json` (env/launch/baseUrl) and commits it into the reviewable PR diff, so the next run starts deterministic.

## No nested LLM

The MCP tool calls live in the calling skill's LLM context (the supervisor's Step 6, or `/verify`) — the helper is LLM-free and runs no nested LLM (no `claude -p`, no Task; `flow-pre-commit` is a pure subprocess and cannot drive MCP).
