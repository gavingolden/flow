# Browser-driven UI-smoke pass (gate-time)

The shared procedure behind the gate-time UI-smoke pass that both `/flow-pipeline` Step 6 (the supervisor-side "Automated UI-smoke pass") and `/verify`'s "Optional UI-smoke pass" run. Both consumers keep a short pointer and their own framing (the supervisor's 3-attempt fix loop; `/verify`'s "alongside `flow-pre-commit`" + Step 3 routing); the full probe → fallback → launch → drive-MCP → assemble → fix-loop → noise-filter → persist-back body lives here so the two cannot drift. This is the gate-time smoke pass; the review-time visual-appearance evidence path is a separate procedure documented in `../../pr-review/references/ui-validation-evidence.md`.

## When it runs

When the worktree declares a `.flow/ui-validation.json` manifest AND the `chrome-devtools` MCP is available in the session, run the browser-driven UI-smoke pass as part of the verify gate. The `chrome-devtools` MCP is resolved once at session start, so a manifest that appears mid-session without the MCP already connected stays not-runnable. Headless / MCP-absent runs stay green — the pass is an additive live check, never a blocker on environments that can't drive a browser.

## Probe and skip

Probe for the MCP first with a guarded `ToolSearch query="select:mcp__chrome-devtools__navigate_page"`. On missing schema, fall back to `flow-ui-validate --mcp-absent --manifest .flow/ui-validation.json` — a quiet `ran:false` / `skipped_reason: mcp-not-available` skip that never blocks the run, exactly mirroring `flow-pre-commit`'s optional-tool `skipReason` (the `actionlint` / `go` off-PATH skips). Otherwise run `flow-ui-validate --manifest .flow/ui-validation.json --changed-files <git diff --name-only HEAD>`. On a `ran:false` skip, relay the loud `nudge` when `loud:true` (the discovery prompt to copy `templates/ui-validation.json.example`, or a broken-precondition hint) and proceed — the rest of the diff still verifies.

## Launch and drive

On a `ran:true` ready envelope, read `meta.env` from the envelope and inject it into the launch subprocess's environment, then bring up the launch — a single command that may start frontend+backend on dedicated ports — and drive the MCP per route (`navigate_page` → `wait_for` → `take_snapshot` → `list_console_messages` → `list_network_requests`, honoring `manifest.disableAnimations` via `prefers-reduced-motion` emulation), write a captures JSON, and call `flow-ui-validate --manifest .flow/ui-validation.json --captures <path>`; tear the launched server(s) down on completion. Screenshot capture follows the save-path cascade documented in `/pr-review` Step 8c (worktree `.flow-tmp/ui-evidence/` preferred → session-cwd fallback → skip-with-loud-note; the a11y snapshot is the gate).

## Fix-loop routing

A `ran:true` result with `ok:false` (a console error, a failed request, or a missing `expectSelectors` element) is a verify failure routed through the same fix loop as any failed `flow-pre-commit` check. Prefer a durable Playwright/vitest spec for any deterministic guard worth keeping forever; reserve the MCP pass for the live + visual-evidence checks.

## Noise filter

Benign request/console noise (canonically the favicon 404, which emits both a `/favicon.ico` failed request and a generic "Failed to load resource" console error) is suppressed via the manifest's optional `ignoreRequestPatterns` / `ignoreConsolePatterns` substring lists — manifest-config-only, no built-in default. **Adaptive noise filter:** when an `ok:false` flags a console error or failed request that is benign noise unrelated to the diff (a favicon 404, a third-party beacon/analytics request, browser-extension noise), do **not** consume a fix-loop attempt on it — add the offending substring to the manifest's `ignoreRequestPatterns` / `ignoreConsolePatterns` in `.flow/ui-validation.json` and **commit that manifest change** (it lands in the reviewable PR diff), then re-run; reserve the fix loop for post-filter errors the diff actually introduced.

## Self-improving manifest

**Self-improving manifest (CRITICAL):** reusing that same commit-the-manifest-change precedent, when the agent adapts the launch on the fly to make a custom-port run work (tweaks the command, adds/changes an `env` var, fixes `baseUrl`), it persists the launch adaptation back into `.flow/ui-validation.json` (env/launch/baseUrl) and commits it into the reviewable PR diff, so the next run starts deterministic.

## No nested LLM

The MCP tool calls live in the calling skill's LLM context (the supervisor's Step 6, or `/verify`) — the helper is LLM-free and runs no nested LLM (no `claude -p`, no Task; `flow-pre-commit` is a pure subprocess and cannot drive MCP).
