## Why

Anything built on top of `flow-claude-headless` (the one sanctioned raw
`claude -p` spawn site) had no way to launch a completely toolless child —
useful for a judge-style check that must not be able to read or write
anything beyond the one file it was handed. Callers were stuck accepting
whatever tool surface the caller's own defaults granted.

## User-facing changes

`flow-claude-headless` now accepts an optional `--tools <list>` flag. Passing
an empty string (`--tools ""`) disables every tool in the spawned child, for
a caller that wants a pure text-completion session with no tool access at
all. Every existing caller that never passes `--tools` sees no change in
behaviour — the flag is purely additive.
