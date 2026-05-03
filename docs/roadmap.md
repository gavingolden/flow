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
| **Item 27 — markdown internal-link + SKILL.md frontmatter validator** | New `flow-md-validate <path>` Bun helper checks internal markdown links (relative paths + heading anchors) and SKILL.md YAML frontmatter presence. New `docs` scope in `flow-pre-commit` matches `*.md` by extension and runs the validator on docs-touching diffs. | 🚧 in review |

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

## Item 27 — markdown internal-link + SKILL.md frontmatter validator

Markdown is flow's documentation surface — 60 files spanning `docs/`,
`skills/`, the roadmap, and root-level READMEs cross-reference each other
by hand. There is no automated check today, so renames silently break
links, reworded headings silently break anchors, and a new `SKILL.md` can
ship without YAML frontmatter and stay broken until someone notices.

The validator is a single Bun script that:

- Walks `*.md` files (skipping `node_modules/`, `.git/`, `.flow-tmp/`).
- Strips fenced code blocks and inline-code spans before scanning so
  doc files with code samples don't trip the link regex.
- Slugs headings using GitHub's canonical algorithm (lowercase, strip
  non-word/space/hyphen, char-by-char `' '` → `-`, no collapse).
- Reports broken relative-path links, broken in-page and cross-file
  heading anchors, and missing/`name:`-less SKILL.md frontmatter.
- Skips external (`https?://`, `mailto:`, `tel:`, `ftp:`) and image
  links — out of scope.

Done when:

- [x] `bin/flow-md-validate.ts` (Bun, `import.meta.main` gate) +
  `bin/flow-md-validate.test.ts` next door.
- [x] `bin/flow-pre-commit.ts` adds a `docs` scope; matcher shape
  generalised from `Record<Scope, string[]>` to
  `Record<Scope, { prefixes?; extensions? }>` so `*.md` can match by
  extension.
- [x] `flow setup` symlink walk auto-distributes the new helper
  (existing `bin/lib/sources.ts` enumerates every `bin/*.ts`).
- [x] All existing violations across this repo's 60 `.md` files fixed.

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
