# Roadmap

This file tracks queued work. Shipped and cancelled items live in
git history (`git log --oneline -- docs/roadmap.md` recovers the prior
status entries if needed). The roadmap is not a permanent record of
what was built — when an item ships, its row and detail block come
out.

## Status table

Legend: ⬜ queued · ⏸ optional

| Item | Adds | Status |
|---|---|---|
| **Doc-to-helper contract sync test** | Cross-check the supervisor SKILL.md decision strings (e.g. `proceed-to-review`, `ci-passed`) against the helper's exported union types so doc drift can't silently route the supervisor to the wrong action. | ⏸ optional |

---

## Doc-to-helper contract sync test (optional)

Deferred from PR 77 pr-review.
`skills/pipeline/flow-pipeline/SKILL.md`'s step-7 / step-9 /
Resume-mode tables enumerate the `.decision` and `.resumeAt` strings
the supervisor branches on. If a helper renames a decision (e.g.
`proceed-to-review` → `ci-passed`) the doc would silently drift and
the supervisor would fall through to the wrong action.

Optional because the fix needs new test infra (parse the SKILL.md
table cells, cross-check against the helper's exported union types)
and architectural decisions about how strict to be (regex on the first
column? import the TypeScript union via a generated JSON?). Pick up
opportunistically when the next helper-rename PR lands, or before any
new decision-emitting helper is added — not cold.

---

## Future stretch / out of scope

- **Multi-machine pipelines.** Single-machine by design. If
  multi-machine ever returns as a requirement, Design A
  (GitHub-native) in
  [`alternate-architecture.md`](./alternate-architecture.md) is the
  path back.
- **Web UI / dashboard / status server.** tmux is the UI.
- **Slack / email / Jira integration.** macOS notifications are the
  only notification surface.
- **Cross-repo coordination.** flow operates on one repo at a time.
- **Beads (database) state-store backend.** The state store is
  per-pipeline `~/.flow/state/<slug>.json`; if the queue ever gets
  unwieldy, swap in Beads via an adapter.
