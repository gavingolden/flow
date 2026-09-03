# Headless Claude via `flow-claude-headless`

Full contract for the one sanctioned raw `claude -p` spawn site. Any skill
the `/flow-pipeline` supervisor loads in-process — including consumer-repo
skills invoked during implement — may run a fixed-model, fixed-effort
headless Claude call ONLY through `flow-claude-headless`. It is a **Bash
fan-out, not a tenth Task-tool exemption** (same shape as the Gemini lens,
the cross-model plan review, and the blind method survey — see `AGENTS.md`
`## Don'ts`, the shared phrase "Bash fan-out, not a tenth exemption").

## When a skill may call it

- Any skill the supervisor loads in-process, consumer-repo skills invoked
  during implement included.
- Never a raw `claude -p` invocation directly — always through the
  `flow-claude-headless` helper.
- Never from inside a `flow-claude-headless` child itself: the helper sets
  `FLOW_HEADLESS_DEPTH=1` on every child it spawns, and `run()` checks
  that variable on entry — a nested call exits 2 with
  `{ran:false,skipReason:"headless-depth-exceeded"}` before spawning
  anything.
- The copilot-classify inline judgment (`SKILL.md` step 7) remains a
  no-subprocess site — it makes no `claude -p` call and no Task spawn.
  `flow-claude-headless` does not change that.

## Invocation

```
flow-claude-headless (--prompt <text, up to 200 chars> | --prompt-file <path>) \
  --model <alias|id> --effort <low|medium|high|xhigh|max> \
  [--max-budget-usd 5] [--max-turns 25] [--allowed-tools Read,Grep,Glob] \
  [--env KEY]... [--bare] [--timeout-sec 600] [--out <path>] [--task <name>]
```

- `--effort` is required and explicit: verified live on `claude` 2.1.259
  (also available as a `/effort <level>` prompt-form on 2.1.205+), and the
  child env never carries `CLAUDE_EFFORT` or `CLAUDE_CODE_EFFORT_LEVEL` —
  those two names are always stripped (see the allowlist below), so
  nothing else pins the child's effort.
- `--max-turns` is accepted but hidden from `claude --help` on 2.1.259
  (probed via the missing-argument error, not the help text) — re-verify
  on any CLI upgrade before relying on it.
- The child env is an **allowlist**, not a denylist: only `PATH`, `HOME`,
  `TMPDIR`, `SHELL`, `TERM`, `LANG`, `USER`, `CLAUDE_CONFIG_DIR`, the
  auth/network passthrough (`CLAUDE_CODE_OAUTH_TOKEN`, `HTTP_PROXY`,
  `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, `no_proxy`,
  `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`), any `ANTHROPIC_*`/`LC_*`-prefixed
  key, and explicit `--env` names cross into the child. `ENV_NEVER` — all
  7 entries, `FLOW_SLUG`, `TMUX_PANE`, `FLOW_NOTIFY`, `CLAUDECODE`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_EFFORT`, `CLAUDE_CODE_EFFORT_LEVEL`
  — never reach the child, even if named via `--env`. Stripping `FLOW_SLUG`/
  `TMUX_PANE` prevents THIS helper from reproducing issue #618, where a
  leaked `FLOW_SLUG` let a nested session trip `flow-stop-guard` against
  the PARENT pipeline and overwrite its `state.json` — it does not close
  #618 itself: a raw/manual child process outside this helper can still
  inherit the slug, and `flow-stop-guard`'s own ownership check remains
  open (see "What it does not cover" below). `FLOW_PIPELINE=1` and
  `FLOW_HEADLESS_DEPTH=1` are always set on the child.
- `--allowedTools` is a floor, not a ceiling: a `dontAsk` child still
  inherits every `Bash(...)` allow rule from the caller's own
  `~/.claude/settings.json`. Two guards close that gap: `--setting-sources
project` drops the user-level settings file from the child's resolved
  config, and `--disallowedTools` gets a bare `Bash` entry appended
  whenever the caller's `--allowed-tools` set contains no `Bash(...)`
  entry — deny beats allow.
- `--bare` needs `ANTHROPIC_API_KEY` — OAuth and keychain credentials are
  never read in `--bare` mode, so a subscription-only user gets
  "Not logged in" if `--bare` is passed without an API key configured.

## Envelope

Every invocation writes exactly one JSON line to stdout and exits 0 or 2:

- Bad args or the depth guard → exit 2, `{ran:false, task, skipReason:
"bad-args"|"headless-depth-exceeded", ...}`.
- Every runtime skip → exit 0, `{ran:false, task, skipReason:
"claude-not-found"|"claude-not-logged-in"|"claude-timeout"|
"claude-error"|"incomplete-result", stderrTail?}`.
- Success → exit 0, `{ran:true, task, artifact, session_id, model,
effort, total_cost_usd, num_turns, duration_ms, is_error,
terminal_reason, permission_denials}`, all lifted verbatim from the
  child's `--output-format json` result file.

## Non-bare default

By default the child loads the worktree's `CLAUDE.md`, hooks, and
`.mcp.json` — no hook-disable flag exists on `claude` 2.1.259 (only
`CLAUDE_CODE_DISABLE_HOOK_FORWARDING`/
`CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS`, neither a general
kill-switch). Guards on the non-bare default: the fixed headless preamble
line prepended to every prompt (telling the child no human is present and
to ignore interactive-session assumptions), stdin closed, the fixed
`FIXED_DENY_LIST` deny-list, and `--permission-mode dontAsk`. Escapes:
`--bare` (skips hooks entirely but loses OAuth, see above), and
`claude --safe-mode` — verified to keep auth/model/tools/permissions
working while dropping `CLAUDE.md`, skills, plugins, hooks, MCP servers,
custom commands, and agents — noted here as a possible future `--isolate`
opt-in, not yet exposed by `flow-claude-headless`.

## Headless vs Agent definition

- Prefer `flow-claude-headless` for a fixed-model, fixed-effort leaf
  reviewer: per-call `--model`/`--effort`, an exact `total_cost_usd`, zero
  parent-context cost (the parent sees one JSON line), identical behaviour
  whether launched from a chat session, a pipeline, or a plain script, and
  immune to the session-start agent-frontmatter snapshot problem (an
  agent-definition's frontmatter is frozen at the spawning session's
  start; a CLI flag is not). The child's tools run under its own
  `--permission-mode dontAsk` + `--allowedTools` + `FIXED_DENY_LIST`, not
  the parent's auto-mode classifier — observed, not guaranteed: the
  launching Bash call itself is still classifier-reviewed, which is why
  keeping the invocation short (`--prompt-file` over a long inline
  `--prompt`) matters.
- Prefer an `Agent`/`Task`-tool agent definition when the reviewer needs
  the parent's MCP/tool surface, or must be visible in the parent
  transcript.

## What it does not cover

- `/flow-research` Tier-2 stays unchanged — it has its own
  `FLOW_PIPELINE` guard and its own migration is a filed follow-up, not
  part of this contract.
- The copilot-classify inline judgment (`SKILL.md` step 7) — still a
  no-subprocess site, makes no `claude -p` call at all.
- Issue #618's `flow-stop-guard` ownership check itself — `#618` stays
  open. `bin/lib/session-identity.ts` only validates and reads
  `FLOW_SLUG`; `flow-stop-guard` still trusts whatever value it's handed,
  and this PR does not touch that check. This helper's env allowlist is
  an independent guard that prevents this ONE spawn site from
  reproducing the leak — it is not the fix for #618, and a raw/manual
  child process elsewhere in the codebase can still trip it.
