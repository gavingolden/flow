# Roadmap

This file tracks queued work. Shipped and cancelled items live in
git history (`git log --oneline -- docs/roadmap.md` recovers the prior
status entries if needed). The roadmap is not a permanent record of
what was built — when an item ships, its row and detail block come
out.

## Status table

Legend: ⬜ queued

| Item | Adds | Status |
|---|---|---|
| **Item 26 — `flow setup --upgrade` orphan-pruning + worktree-rooted source paths** | Two symbiotic symlink-hygiene bugs witnessed on the econ-data PR #192 pipeline. **Symptom A:** when an upstream helper or skill is deleted, `flow setup --upgrade` does not prune the corresponding `~/.local/bin/` or `~/.claude/skills/` symlink. **Symptom B:** `flow setup --upgrade --source "$WORKTREE"` records worktree-lifetime paths in the install manifest. Shared root cause — worktree paths used as symlink targets. | ⬜ queued |

---

## Item 26 — `flow setup --upgrade` orphan-pruning + worktree-rooted source paths

Two symbiotic symlink-hygiene bugs witnessed on the econ-data PR #192
pipeline.

**Symptom A:** when an upstream helper or skill is deleted (e.g.
`bin/flow-roadmap-mark-shipped.ts` deleted in #71), `flow setup
--upgrade` does not prune the corresponding `~/.local/bin/` or
`~/.claude/skills/` symlink — `removeIfManagedSymlink`'s prefix check
rejects targets that resolve outside the current `flowSource`, and the
orphan record drops out of the manifest on the next install, making
the dangling link permanently invisible to future reaps.

**Symptom B:** `flow setup --upgrade --source "$WORKTREE"` (the
supervisor's step-5.5 invocation) writes manifest targets pointing at
the worktree's `bin/` and `skills/` paths; once `flow-remove-worktree`
runs post-merge, all those symlinks dangle.

Shared root cause — worktree paths used as symlink targets — so fixing
B prevents future A and A's relaxed reaping cleans up B's existing
damage.

Done when:

- [ ] Separate "content source" from "recorded owner" in
  `bin/lib/setup.ts` so `--source <worktree>` records install-root
  paths in `~/.flow/installed.json`.
- [ ] Relax `bin/lib/symlink.ts:removeIfManagedSymlink` to also remove
  dangling symlinks whose manifest entry matches by name, even when
  the resolved path no longer prefixes `flowSource`.
- [ ] Delete or update the supervisor's step-5.5 install-source caveat
  docstring (`skills/pipeline/flow-pipeline/SKILL.md` lines 527-537)
  once the recording behaviour lands.

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
