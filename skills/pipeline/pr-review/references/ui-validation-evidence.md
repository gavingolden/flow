# UI-validation evidence (Step 8c browser-item bucket)

The detail behind `/pr-review` Step 8c's browser-validation path. Read this
when a PR's Test Steps enumerate concrete visual-appearance items and the
worktree ships a `.flow/ui-validation.json` manifest. Step 8c keeps a short
pointer; the full runnable-bucket procedure, the captures contract, the
evidence rule, and the screenshot save-path cascade live here.

The `chrome-devtools` MCP must be **connected at session start** — Claude
Code resolves MCP servers once when the session boots, so a manifest that
appears mid-session without the MCP already connected stays not-runnable.

## Browser-item runnable bucket (visual-appearance via the browser-validation capability)

When the `chrome-devtools` MCP and a `.flow/ui-validation.json` manifest are
present, **enumerated visual-appearance items become a runnable bucket** rather
than not-runnable. Probe the MCP with a guarded
`ToolSearch query="select:mcp__chrome-devtools__navigate_page"` once at the top
of Step 8c; on missing schema, leave every browser item unticked with a
`subjective UX` reason as before (MCP-absent runs are no regression — browser
items stay not-runnable and unticked exactly as today). With the MCP present,
per visual item:

1. Drive the browser via the manifest: `navigate_page` to the route →
   `wait_for` an explicit selector → `take_snapshot` (the a11y snapshot — the
   **primary** evidence) → `take_screenshot` (the **secondary** artifact,
   referenced by path, never embedded — `gh` takes no inline binary). Honor
   `disableAnimations` via `prefers-reduced-motion` emulation.
2. Judge the snapshot + screenshot against the `ui-ux` skill's authorities
   (Nielsen, WCAG/POUR, Refactoring UI) via `/ui-ux`'s "evaluate from a
   snapshot/screenshot" entry point.
3. On a pass, inject the a11y snapshot as the primary `<details>` block and tick
   the box via the **unchanged** `flow-inject-evidence` interface (Step 8c.i),
   the screenshot referenced by its saved path inside the block (`--output-file`
   points at the captured snapshot text, `--exit-code 0`).
4. An **irreducibly-aesthetic** item ("does this feel premium?") stays unticked
   with a `subjective UX` reason — only concrete, second-observer-reproducible
   visual-appearance assertions are runnable here.

This adds **no new Task-tool exemption**: Step 8c runs inside the already-exempt
Fix-Applier subagent surface, and the MCP calls are harness-level tool calls in
that context. See `references/manual-test-rubric.md` "Caveat: browser-validation
flakiness".

## Captures contract

`failedRequests` are request URLs (URL-filterable via the manifest's
`ignoreRequestPatterns`); `consoleErrors` are genuine JS errors, NOT the
"Failed to load resource" network echoes (those live in `failedRequests`). The
optional manifest `ignoreConsolePatterns` / `ignoreRequestPatterns` substring
lists suppress benign noise before `ok` — canonically the favicon 404, via
`ignoreRequestPatterns: ["/favicon.ico"]`. When the pass flags a benign console
error or failed request unrelated to the diff (favicon 404, third-party
beacon/analytics, extension noise), do **not** fix-loop on it: add the
substring to `ignoreRequestPatterns` / `ignoreConsolePatterns` in
`.flow/ui-validation.json`, commit that manifest change (it lands in the
reviewable PR diff), and re-run. Reserve fix-loop failures for post-filter
errors.

## Snapshot-primary, screenshot-by-reference

The a11y `take_snapshot` is the gate — it is the primary evidence injected via
`flow-inject-evidence`. The screenshot is supplementary: referenced by its
saved path inside the evidence block, never embedded (`gh` takes no inline
binary).

## Screenshot save-path cascade

`flow new` now pre-authorizes the per-pipeline worktree as an MCP workspace
root at launch (`claude --add-dir <repo-parent>/<repo>-<slug>`), and
`/flow-pipeline` step 2 best-effort runtime-`/add-dir`s the actual worktree
path to cover the auto-suffix-collision case where the launch-time path
diverges (issue #317). So the PREFERRED branch below is now expected to
succeed for pipeline-launched sessions. The cascade stays as defense-in-depth
— a session launched without the flag (or an MCP server that does not honor
`--add-dir`'s workspace root for its screenshot sandbox) still degrades
cleanly:

1. PREFERRED — `.flow-tmp/ui-evidence/<n>.png` under the worktree (the
   worktree is registered as a workspace root via `flow new`'s injected
   `claude --add-dir`).
2. On denial, FALL BACK to session-cwd `.flow-tmp/ui-evidence/`.
3. Else SKIP with a loud note — the a11y snapshot is the gate, the screenshot
   supplementary, never blocking.
