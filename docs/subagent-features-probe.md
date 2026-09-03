# Subagent features probe — live results

Recorded from a real `bun bin/flow-plugin-probe.ts --live --json` run
against this host: `claude` 2.1.259, already logged in, with `FLOW_SLUG`
and `TMUX_PANE` unset in the child env. Four new probe ids
(`agent-memory-scope`, `skills-preload-name`, `max-turns-partial`,
`cache-ttl-1h`) settle the unverified assumptions Tasks 2–5 of the
adopt-three-claude-code-subagent-features plan act on.

## agent-memory-scope

**Verdict: confirmed.**

- A `memory: local` fixture agent (`--agents` JSON) run with `cwd` set to a
  linked git worktree writes its note to
  `<cwd>/.claude/agent-memory-local/<agent-name>/MEMORY.md` — resolution is
  **cwd-relative**, not repo-root-relative.
- Repeated with a pre-planted symlink at
  `<worktree>/.claude/agent-memory-local` pointing at a separate cache
  directory outside the worktree: the agent wrote through the symlink
  (`MEMORY.md` landed inside the cache directory, and the path stayed a
  symlink afterward, not replaced by a real directory).

**Decision this drives:** the memory handoff is the **cwd-relative +
symlink-followed** branch — Task 4's `linkAgentMemory` (symlinking
`<worktree>/.claude/agent-memory-local` → a per-repo cache dir under
`~/.flow/cache/`) is safe to implement, and `agents/core/flow-discovery.md`
/ `agents/core/flow-scout.md` keep `memory: local` in frontmatter.

## skills-preload-name

**Verdict: confirmed.**

- A fixture agent with `skills: ["flow-probe-preload-skill"]` (bare
  directory name, no plugin prefix) echoed the sentinel embedded in the
  skill's `SKILL.md` without ever calling `Read`.

**Decision this drives:** every new `skills:` entry added in Task 2/3 uses
the **bare skill directory name** form (e.g. `skills: [flow-scout-instructions]`),
matching the sub-agents page's only documented example shape.

## max-turns-partial

**Verdict: confirmed.**

- A `maxTurns: 1` fixture agent spawned via an actual Task-tool call (not
  `--agent` on the top-level session, which does not exercise a subagent's
  turn budget) returned this raw text when it hit the budget mid-task:

  ```
  NOTE: this agent stopped at its 1-turn limit before finishing. It was
  still calling tools and had produced no report. Send the agent a message
  (SendMessage) to let it continue from where it stopped.
  agentId: a44c4074d2ec9ec50 (use SendMessage with to: 'a44c4074d2ec9ec50',
  summary: '<5-10 word recap>' to continue this agent)
  ```

  accompanied by a usage block (`subagent_tokens`, `tool_uses`,
  `duration_ms`).

**Decision this drives:** `references/partial-result-continuation.md`'s
detection predicate is "the Task result contains a `NOTE: this agent
stopped at its <N>-turn limit` line and an `agentId: <id>` line", and its
continuation step is exactly one `SendMessage` to that `agentId`. This is
the literal shape `agents/core/flow-verify.md` / `flow-fix-applier.md` /
`flow-edit-applier.md` / `flow-merge-resolver.md`'s new turn-budget
paragraphs describe.

## cache-ttl-1h

**Verdict: confirmed.**

- `experimental.cacheTtl` is read only from a subagent **file** (confirmed
  separately: `--agents` JSON has no `experimental` field in `claude
--help`'s documented shape) — a file-based fixture agent
  (`experimental:\n  cacheTtl: 1h` in its frontmatter) spawned via the Task
  tool produced a transcript under
  `~/.claude/projects/<project>/**/subagents/agent-*.jsonl` containing a
  non-zero `"ephemeral_1h_input_tokens":26782` entry.

**Decision this drives:** the 1h cache TTL is honored on this
subscription-plan host for a file-based agent definition; `agents/core/flow-discovery.md`,
`flow-verify.md`, `flow-fix-applier.md`, and `flow-consolidator.md` keep
`experimental:\n  cacheTtl: 1h` in frontmatter. Billing behaviour across
plan tiers (subscription-on-usage-credits vs. API key) is NOT observable
from this probe — `docs/configuration.md`'s new section states that as a
documented, unverified-by-this-probe caveat per the vendor's own docs.

## Non-live baseline (unchanged probes)

`bun bin/flow-plugin-probe.ts --json` (no `--live`) on this host:
`add-dir-discovery`, `symlink-materialization`, `bin-path-injection`,
`enabled-plugins`, `skill-invocation-name` all `confirmed`;
`agent-invocation-name` `inconclusive` (pre-existing, unrelated to this
change — see the file's own probe for detail); the four new ids report
`skipped` with evidence `"requires --live"`.
