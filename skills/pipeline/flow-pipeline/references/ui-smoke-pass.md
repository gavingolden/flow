# Browser-driven UI-smoke pass (gate-time)

The shared procedure behind the gate-time UI-smoke pass that both `/flow-pipeline` Step 6 (the supervisor-side "Automated UI-smoke pass") and `/flow-verify`'s "Optional UI-smoke pass" run. Both consumers keep a short pointer and their own framing (the supervisor's 3-attempt fix loop; `/flow-verify`'s "alongside `flow-pre-commit`" + Step 3 routing); the full probe → fallback → launch → drive-MCP → assemble → fix-loop → noise-filter → persist-back body lives here so the two cannot drift. This is the gate-time smoke pass; the review-time visual-appearance evidence path is a separate procedure documented in `../../flow-pr-review/references/ui-validation-evidence.md`.

## When it runs

When the diff touches a meaningful UI surface AND the `chrome-devtools` MCP is available in the session, run the browser-driven UI-smoke pass as part of the verify gate — a hand-authored `.flow/ui-validation.json` manifest is no longer a precondition. The `chrome-devtools` MCP is resolved once at session start, so a UI diff that appears mid-session without the MCP already connected stays not-runnable. Headless / MCP-absent runs stay green — the pass is an additive live check, never a blocker on environments that can't drive a browser. On a run that does drive the browser, the per-route/per-viewport screenshot is a first-class required capture alongside the a11y snapshot: every screenshot path that lands on disk is recorded into the verify-loop artifact's `ui_screenshots[]` so the supervisor can surface each one as a clickable absolute path in the session (see "Launch and drive" below). The a11y snapshot stays the mechanical gate — a missing or unwritable screenshot is never a new merge-block.

## Probe and skip (and bootstrap)

Probe for the MCP first with a guarded `ToolSearch query="select:mcp__chrome-devtools__navigate_page"`. On missing schema, fall back to `flow-ui-validate --mcp-absent --manifest .flow/ui-validation.json` — a quiet `ran:false` / `skipped_reason: mcp-not-available` skip that never blocks the run, exactly mirroring `flow-pre-commit`'s optional-tool `skipReason` (the `actionlint` / `go` off-PATH skips). Otherwise run `flow-ui-validate --manifest .flow/ui-validation.json --changed-files <git diff --name-only HEAD>` and **branch on the helper verdict, never on your own prose** — the mechanical fire-decision is the whole point.

- **`action: "bootstrap"`** (no valid manifest yet, meaningful UI diff, MCP present): the helper has deterministically inferred `launch`/`baseUrl` (with the `{{PORT}}` placeholder), `routes`, `loginUrl`, and credential env-var NAMES, plus a `needs[]` of what it couldn't infer. Allocate a free port, resolve the `{{PORT}}` placeholder, and **empirically verify** the inference: bring the launch up, drive the derived routes, and (when a `loginUrl` is present) resolve the credential VALUES from the local `.env`/shell env at run time and log in. On success, write the verified NAMES/config back into `.flow/ui-validation.json` — storing names and non-secret config only — never a secret value — and commit it into the reviewable PR diff, then proceed with the assemble step as if a manifest had always existed. When `needs` includes `credentials` (a login wall exists but no credential NAMES could be mined and none resolve from the local env), write everything else you verified into the manifest, commit it, and escalate `NEEDS HUMAN: smoketest-needs-creds` (autonomous path) rather than guessing a login flow.
- **`ran: true` (ready)**: a valid manifest already exists — drive it directly (below).
- **`ran: false` skip**: relay the loud `nudge` when `loud:true` (a broken-precondition hint, or the quiet not-meaningful skip for a bare stylesheet with no derivable route) and proceed — the rest of the diff still verifies. Whenever a UI diff went unverified this way, record the reason so the supervisor surfaces the user-visible "UI changed; browser validation did not run — <reason>" line (see the `ui_smoke` reason carrier). The same reason carrier also covers the case where the browser DID render but every screenshot save path was denied — reason `screenshots-unwritable` — which likewise never blocks the run; it is a surfaced gap, not a failure.

## Launch and drive

On a `ran:true` ready envelope, read `meta.env` from the envelope and inject it into the launch subprocess's environment, then bring up the launch — a single command that may start frontend+backend on dedicated ports — open a per-pipeline isolated page first (`new_page` with an `isolatedContext` named from the pipeline slug — read `@flow-slug` / `~/.flow/state/<slug>.json` / the worktree basename — so two pipelines sharing one chrome-devtools MCP server do not bleed cookies/storage). Then drive the MCP per route, and **inside each route, loop over `meta.viewports`** (the envelope carries the declared set or the built-in default `xs 320 / mobile 390 / tablet 768 / desktop 1280 / wide 1440`): for each viewport `resize_page` to its `width` × its `height` when declared, else a tall default (2000px) — so above-the-fold cropping never hides overflow → the existing per-route `navigate_page` → `wait_for` → `take_snapshot` → `list_console_messages` → `list_network_requests` drive (honoring `manifest.disableAnimations` via `prefers-reduced-motion` emulation) → `evaluate_script` reading `document.scrollingElement.scrollWidth` / `clientWidth` and the page-root constrained container's `getBoundingClientRect()` left/right gaps (`rootGap: {left, right}`) → `take_screenshot` (filename includes the viewport name, e.g. `0-wide.png`). Write the enriched per-viewport captures JSON — each route gains a `viewports[]` array of `{ name, width, snapshotText, consoleErrors, failedRequests, screenshotPath, rootGap, scrollWidth, clientWidth }` — and call `flow-ui-validate --manifest .flow/ui-validation.json --captures <path>`; tear the launched server(s) down on completion. The helper applies the three mechanical geometry assertions (off-center, horizontal overflow, missing-element-at-breakpoint) to those raw NUMBERS — it never drives the MCP and never reads the DOM (the no-nested-LLM split below). Screenshot capture follows the save-path cascade documented in `/flow-pr-review` Step 8c (worktree `.flow-tmp/ui-evidence/` preferred → session-cwd fallback → skip-with-loud-note). Every path the cascade successfully writes is required evidence recorded into `ui_screenshots[]`; the a11y snapshot remains the sole mechanical gate, so a cascade that lands on skip-with-loud-note (`screenshots-unwritable`) surfaces the gap in-session but never fails the pass or blocks the merge.

**Container-selection heuristic (page-root constrained container).** The element whose `rootGap` you pass is the outermost element under `<main>` (or `<body>` when there is no `<main>`) whose computed width is _less than_ the viewport width — i.e. a deliberately constrained column. Measure its `getBoundingClientRect()` and pass `rootGap.left` / `rootGap.right` as the distances from the viewport edges. A full-bleed element (width equal to the viewport) has no meaningful gap, so it is not the constrained container; skip it. The per-viewport "UI traits to verify" rubric — authored canonically in [../../flow-pr-review/references/ui-validation-evidence.md](../../flow-pr-review/references/ui-validation-evidence.md) under `## UI traits to verify` — is applied **per captured viewport** alongside these mechanical assertions.

**Shared-profile lock (parallel pipelines).** chrome-devtools-mcp backs every browser with a single default on-disk Chrome profile (`~/.cache/chrome-devtools-mcp/chrome-profile`), so two pipelines that both reach this pass under one un-isolated MCP registration contend for it — the second to launch errors with `The browser is already running for ~/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances`. On detecting the lock, drive `flow-ui-validate --browser-busy` — a loud-but-clean `ran:false` / `skipped_reason: browser-profile-busy` skip that degrades exactly like an absent MCP, never a hard failure. The cross-process fix is operator-side: register the chrome-devtools MCP with `--isolated` in `~/.claude.json` so each server process gets its own auto-cleaned throwaway profile. The per-call `isolatedContext` above is same-server defense-in-depth only — it isolates pages within one MCP server but does NOT resolve the cross-process on-disk-profile lock.

## Design-fidelity sub-pass (spec-gated)

**Gate: this sub-pass exists only when the worktree-local `.flow-tmp/design/spec.json` exists.** No `spec.json` → the sub-pass does not exist — zero cost, zero prose, zero tool calls; the smoke pass above is byte-for-byte unchanged. (The spec is pipeline-ephemeral, frozen by discovery's design-artifact fidelity pre-pass and never committed.)

When the spec exists, after the existing per-route capture loop:

1. For each surface declared in the spec, on that surface's route run `flow-design-spec probe-script --spec .flow-tmp/design/spec.json --surface <name>` and evaluate the emitted JS via `evaluate_script` in the same isolated page.
2. The evaluated script returns a bare array of `{selector, found, properties}` — wrap it as `{"surface": "<name>", "captured": <returned array>}` before persisting. Persist that envelope to `.flow-tmp/design/capture-<surface>.json` **with the harness file-write tool (Write), NEVER via bash `echo`/heredoc string interpolation** — shell-interpolating arbitrary JSON is an escaping hazard (quotes, backticks, `$` in captured values).
3. Run `flow-design-spec diff --spec .flow-tmp/design/spec.json --captured .flow-tmp/design/capture-<surface>.json --json` per surface. Judged-tier assertions report `skipped-judged` here (they are review-time judgment, not gate-time mechanics).
4. Route any `ok:false` envelope through the **existing fix loop as a verify failure** — same loop as a failed `flow-pre-commit` check. **Fix-loop context re-injection:** a fidelity-failure entry carries the absolute paths of the committed `.flow/design/foundation.md` and the ephemeral `.flow-tmp/design/spec.json` alongside the failing assertion ids, so the fix pass re-reads the contract rather than patching blind.

Degradation is exactly the existing pass's: on MCP-absent or browser-busy, take the loud skip via the same `ui_smoke` reason carrier ("design-fidelity spec present; browser validation did not run — <reason>") — never a hard failure.

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

**Self-completing + self-maintaining manifest (CRITICAL):** reusing that same commit-the-manifest-change precedent, the agent completes and maintains EVERYTHING the smoketest needs, not just the launch. When it adapts on the fly to make a run work — tweaks the launch command, adds/changes an `env` var, fixes `baseUrl`, corrects a route that 404'd or a launch field that failed, records the `loginUrl` + credential env-var NAMES it verified during a bootstrap — it persists the launch adaptation back into `.flow/ui-validation.json` (env/launch/baseUrl/routes/loginUrl/credentialEnvVars), and does the same for every other field it verified, and commits it into the reviewable PR diff, so the next run starts deterministic. Runtime credential VALUES are resolved from the local `.env`/shell env and NEVER persisted: the committed manifest stores names and non-secret config only — never a secret value.

## No nested LLM

The MCP tool calls live in the calling skill's LLM context (the supervisor's Step 6, or `/flow-verify`) — the helper is LLM-free and runs no nested LLM (no `claude -p`, no Task; `flow-pre-commit` is a pure subprocess and cannot drive MCP).
