# Resource cleanup (before any terminal state)

Before the supervisor reaches **any** terminal state — `MERGED`,
`GATED`, `NEEDS HUMAN`, or `cancelled` — every resource a pipeline step
or sub-skill spawned must already be torn down. A flow agent never
leaves a spawned resource running on the user's machine. Three named
layers, in order:

**Layer 1 — point-of-use teardown first.** Close what you opened on
every exit path, at the site that opened it:

- **Dev servers / launch subprocesses** — already torn down by the
  UI-smoke and UI-validation passes ("tear the launched server(s) down on completion").
- **chrome-devtools MCP pages/contexts** — the per-pipeline isolated page each browser pass opens is closed with `close_page` on completion and on every error/early-exit path, scoped to the page/context this pipeline opened. Contract in [references/ui-smoke-pass.md](../ui-smoke-pass.md) "Teardown" and `/flow-pr-review`'s `references/ui-validation-evidence.md` "Teardown".
- **Playwright / headless browsers** — any repo headless browser an agent stood up (the Step 8c.iii fallback) exits when its Bash invocation returns.
- **Background processes** — anything launched `run_in_background` (the bounded `flow-ci-wait` waiter is the canonical case) reaches a terminal exit or is reaped before the pipeline ends, via `flow-spawn`'s registry (the wrapper process itself is unregistered and lives only for the wait's duration).
- **Agent-written env/config files** — any env/config file a browser/UI pass created is deleted on completion and on every error/early-exit path (see "Teardown" in [references/ui-smoke-pass.md](../ui-smoke-pass.md)).

**Layer 2 — the guaranteed registry-first backstop.** `close_page`
never closes the Chrome process — chrome-devtools-mcp exposes no
browser-close tool. The pipeline runs
`flow-browser-teardown --reap --record` as a **standalone call**
(never `&&`/`;`-joined to the `flow-gate-summary` call after it — a
non-zero exit here is EXPECTED and must not block the render) before
EVERY terminal state, never `|| true`-swallowed (the helper always
exits 0). Registry-driven, falling back to the ancestry walk (SIGTERM
only, so THIS session's own server's `shutdown()` reaps its Chrome)
for what the registry missed. `--record` writes the verdict to
`~/.flow/state/<slug>.json` as `state.reap`, rendered by the following
`flow-gate-summary --cleanup` as the CLEANUP row. A post-teardown MCP
call in the same session degrades exactly as
`flow-ui-validate --mcp-absent`.

**Layer 3 — `flow reap`, the crash-path net, never the
primary.** `flow reap [--slug <s>] [--yes]` covers both registered
rows left by a session that crashed before reaching Layer 2 and
shape-heuristic strays (`--include-strays`) — report-only by
default, `--yes` required to act. Ad-hoc housekeeping only
(`docs/configuration.md`), never wired into a runbook step.

**Why Layer 2 is ancestry-scoped, not page-enumeration.** A **page-enumeration** sweep (`list_pages`-and-close) was evaluated and **deliberately not built**: parallel pipelines may share one un-isolated MCP server, so it cannot reliably tell this pipeline's page from a sibling's or the user's own Chrome, and would risk the exact harm it set out to prevent. **Process ancestry** does not share that failure mode — a sibling's server is a different session PID, and the user's own Chrome is never a descendant of this session's `claude` process. The operator-side `--isolated` MCP registration is complementary, not sufficient: its temp profile is cleaned up only *after* the browser closes, so it is gated on the very close `close_page` never performs. The same standing rule binds every agent in this repo — `.claude/rules/flow-supervisor-contracts.md` `## Don'ts` "Don't leave spawned resources running".
