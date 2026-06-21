# UI-validation evidence (Step 8c browser-item bucket)

The detail behind `/pr-review` Step 8c's browser-validation path. Read this
when a PR's Test Steps enumerate concrete visual-appearance items and the
worktree ships a `.flow/ui-validation.json` manifest. Step 8c keeps a short
pointer; the full runnable-bucket procedure, the captures contract, the
evidence rule, and the screenshot save-path cascade live here.

The `chrome-devtools` MCP must be **connected at session start** — Claude
Code resolves MCP servers once when the session boots, so a manifest that
appears mid-session without the MCP already connected stays not-runnable.

## Shared-profile lock (parallel pipelines)

chrome-devtools-mcp launches every browser against a single default on-disk
Chrome profile (`~/.cache/chrome-devtools-mcp/chrome-profile`). Each flow
pipeline runs its own Claude Code session and therefore its own
chrome-devtools MCP server process, so two pipelines that both reach Step 8c
under an un-isolated MCP registration contend for that one profile dir — the
second to launch fails with:

> `The browser is already running for ~/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances`

**Recovery / prevention.** Register the chrome-devtools MCP server with
`--isolated` in `~/.claude.json` so each server process gets its own
auto-cleaned throwaway profile and concurrent pipelines never contend (a
per-repo `--user-data-dir` is the alternative when you want a persistent
logged-in profile). Failing that, wait for or close the other pipeline
browser.

**Degradation.** The per-call `isolatedContext` in the step-1 recipe isolates
pages within one MCP server but does NOT resolve this cross-process lock —
`--isolated` is the real cross-pipeline fix and `isolatedContext` is
complementary defense-in-depth. When Step 8c detects the lock error it treats
it as a clean, loud-but-non-failing skip via `flow-ui-validate --browser-busy`,
emitting a `ran:false` / `skipped_reason: browser-profile-busy` envelope with a
recovery nudge — identical degradation to the MCP-absent path.
A busy browser is never a hard failure; the a11y-snapshot gate is simply
skipped for this run and review proceeds on the rest of the diff.

## Browser-item runnable bucket (visual-appearance via the browser-validation capability)

When the `chrome-devtools` MCP and a `.flow/ui-validation.json` manifest are
present, **enumerated visual-appearance items become a runnable bucket** rather
than not-runnable. Probe the MCP with a guarded
`ToolSearch query="select:mcp__chrome-devtools__navigate_page"` once at the top
of Step 8c; on missing schema, leave every browser item unticked with a
`subjective UX` reason as before (MCP-absent runs are no regression — browser
items stay not-runnable and unticked exactly as today). With the MCP present,
per visual item:

0. Before driving any route, read `meta.env` from the `flow-ui-validate` ready
   envelope and inject it into the launch subprocess's environment, then bring
   up the launch. A consumer whose app needs a separate backend can have its
   single `launch` command start both the frontend and the backend (e.g. via
   `concurrently`). `meta.env` is injected **once** into the parent launch
   environment, so it carries only overrides that are the same across processes
   (`VITE_*_URL`, CORS origins); per-process-differing vars — most commonly each
   process's own `PORT` — go **inline** in the `launch` command per sub-command
   (e.g. `PORT=5273 … dev:frontend` and `PORT=8090 … dev:backend`), since one
   flat `env` value can't express two different ports. flow does not orchestrate
   a separate backend lifecycle. Tear the launched server(s) down on
   completion.
1. Drive the browser via the manifest: open a per-pipeline isolated page first
   — `new_page` with `isolatedContext` set to the pipeline slug (read from
   `@flow-slug` / `~/.flow/state/<slug>.json` / the worktree basename) so
   concurrent pipelines sharing one chrome-devtools MCP server do not share
   cookies/storage — then `navigate_page` to the route →
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

## Teardown (servers and browser, symmetric)

Step 0's "Tear the launched server(s) down on completion" is only half the
cleanup — step 1 also opened a per-pipeline isolated page (`new_page` with an
`isolatedContext`), and that page/context must be torn down too, or the
chrome-devtools MCP Chrome is left running on the user's machine, holding its
profile lock and orphaning a browser window. Mirror the server teardown: once
the browser items are judged and evidence injected — **and on every error /
early-exit path** (a launch failure, an MCP-call error, a bail-out mid-bucket)
— close the per-pipeline isolated page you opened with `close_page`, disposing
the `isolatedContext`, in the same breath as bringing the launched server(s)
down. Close **only** the page/context THIS pipeline opened (keyed on the
pipeline slug); never close a sibling pipeline's page or a pre-existing page the
user opened. `close_page` takes the numeric `pageId` your `new_page` call
returned — capture that id at open time and pass exactly it; do NOT re-derive
the page via `list_pages` at teardown, since the `isolatedContext` name is not a
closeable handle and a `list_pages` scan under a shared MCP server can land on a
sibling pipeline's page or the user's own tab. The MCP-absent and browser-busy
paths opened nothing, so teardown is a no-op there, never a failure.

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

**Self-improving manifest (CRITICAL).** Reusing that same commit-the-manifest
pattern: when the agent adapts the launch on the fly to make a custom-port run
work (tweaks the command, adds/changes an `env` var, fixes `baseUrl`), it
persists the launch adaptation back into `.flow/ui-validation.json`
(env/launch/baseUrl) and commits it into the reviewable PR diff, so the next
run starts deterministic. Treat the manifest as a deterministic cache of
non-secret facts the agent maintains, not a frozen contract.

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
