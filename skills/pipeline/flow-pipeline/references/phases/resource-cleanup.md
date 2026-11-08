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
- **CPU-contention loops** — run them through `flow-stress --cpu <n> --max-sec <s> -- <cmd>`, never hand-rolled `&`-backgrounded busy loops: the Bash tool's zsh gives `$(jobs -p)` an empty job table, so `kill $(jobs -p)` kills nothing and the loops outlive the command. A PreToolUse guard (`flow-bg-loop-guard`) refuses that shape (a backgrounded job cleaned up with `$(jobs -p)` in the same command).
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
`flow-gate-summary --cleanup` as the CLEANUP row. It also stops every
leftover process whose working directory is inside this pipeline's
worktree, whose parent is gone and whose launching Bash-tool shell has
exited (the worktree arm runs on every path, including when a registered
MCP server covered the ancestry step), and records the count in the
CLEANUP row (`N leftover processes stopped`, plus any stopped earlier in
the run); a leftover that survives SIGKILL reads `unclean`. A post-teardown MCP
call in the same session degrades exactly as
`flow-ui-validate --mcp-absent`.

Between terminal states, a throttled after-Bash-call check
(`flow-orphan-sweep-hook`, at most once a minute per pipeline) and the
turn-end hook (`flow-stop-guard`) stop only CPU-busy leftover groups
(at least 2 minutes old, at least 25% of a core summed across the
group) within about two minutes and say so; idle leftovers (an owner's
dev server) wait for the terminal sweep, and a server the agent needs until
the run ends is launched with `flow-spawn --detach` (registered, so the
mid-run sweeps skip it; the terminal reap still stops it).

**Layer 3 — `flow reap`, the crash-path net, never the
primary.** `flow reap [--slug <s>] [--yes]` covers both registered
rows left by a session that crashed before reaching Layer 2 and
shape-heuristic strays (`--include-strays`, which now includes orphaned
agy runs left by a delegate call whose guard was killed) — report-only
by default, `--yes` required to act. Its "Leftover processes in pipeline
worktrees" section lists unrecorded leftovers per worktree and stops
them only with `--yes --include-strays` for a pipeline whose session has
ended; a live pipeline's leftovers are listed as "left to the live
pipeline", and busy orphans outside every worktree are listed, never
signalled. `flow reap --worktrees` is the worktree-folder mode (finished
worktrees and leftover folders; preview by default, `--yes` removes), and
the same sweep runs automatically, detached, from `flow feature create`
at most hourly (`cleanup.worktrees: false` turns it off). Ad-hoc
housekeeping only (`docs/configuration.md`), never wired into a runbook
step.

**Why Layer 2 is ancestry-scoped, not page-enumeration.** A **page-enumeration** sweep (`list_pages`-and-close) was evaluated and **deliberately not built**: parallel pipelines may share one un-isolated MCP server, so it cannot reliably tell this pipeline's page from a sibling's or the user's own Chrome, and would risk the exact harm it set out to prevent. **Process ancestry** does not share that failure mode — a sibling's server is a different session PID, and the user's own Chrome is never a descendant of this session's `claude` process. The operator-side `--isolated` MCP registration is complementary, not sufficient: its temp profile is cleaned up only *after* the browser closes, so it is gated on the very close `close_page` never performs. The same standing rule binds every agent in this repo — `.claude/rules/flow-supervisor-contracts.md` `## Don'ts` "Don't leave spawned resources running".
