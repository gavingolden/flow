## Step 5.5 — Sync skills into the pipeline's copy

**Phase:** `installing-skills`

Sub-skills loaded by the supervisor in steps 6–8 (`/flow-verify`,
`/flow-pr-review`) are read from `~/.flow/claude-home/.claude/skills/`
(loaded into the supervisor session via the seed session's
`--add-dir ~/.flow/claude-home`), and agents from the same tree, nested
inside each artifact's owning module's plugin root
(`~/.flow/claude-home/.claude/skills/flow-module-<id>/agents/`)
— both populated by `flow install` (and `flow install --upgrade`) via symlink.
A worktree that adds new files under `skills/` or `agents/` in step 5
does not get those files symlinked automatically; the same supervisor
session cannot use them downstream until `flow install --upgrade` runs.
This step closes that gap. A flow-self (or `--skills-from`) pipeline also runs
on a private real-file copy of the skills; the sync below re-syncs a flow-self
copy only (a `--skills-from` copy stays pinned). A skill added mid-session does
NOT hot-reload. When the sync's `.written` is non-empty, upsert the
not-exercised `> [!NOTE]` per [references/skill-overlay.md](../skill-overlay.md).

```bash
flow-state-update --phase installing-skills

# Private-copy sync — EVERY change (edit/add/delete), not only additions.
if flow-skill-overlay status --slug "$FLOW_SLUG" | jq -e .exists >/dev/null; then
  flow-skill-overlay sync --slug "$FLOW_SLUG" --from "$WORKTREE" > "$WORKTREE/.flow-tmp/skill-overlay-sync.json" \
    && jq -r 'if .ran then "synced: \(.written + .removed | join(" "))" else "sync skipped: \(.skipReason)" end' "$WORKTREE/.flow-tmp/skill-overlay-sync.json" \
    || echo "skill-overlay sync FAILED (see stderr above); the private copy was NOT updated" >&2
fi

# Resolve the default branch dynamically — never hardcode origin/main (a `master` repo would silently skip the re-symlink).
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
                  | sed 's|^refs/remotes/origin/||')
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

ADDED=$(git diff --name-only --diff-filter=A "origin/$DEFAULT_BRANCH...HEAD" | \
          grep -E '^(skills|agents)/' || true)

if [ -n "$ADDED" ]; then
  echo "Detected new skill/agent files; re-symlinking:"
  echo "$ADDED" | sed 's/^/  /'
  flow install --upgrade --source "$WORKTREE"
  # Post-merge follow-up: re-link the home install against canonical main (--auto + allowlist ⇒ step 11 runs it on MERGED).
  flow-followups add \
    --command "flow install --upgrade" \
    --reason "new skills/agents added on this branch — re-symlink home install post-merge" \
    --auto \
    --registered-by "flow-pipeline:step-5.5"
else
  echo "No skill/agent additions; skipping re-symlink."
fi
```

The detection grep uses `--name-only --diff-filter=A` and the triple-dot
range so only genuine file *additions* under `skills/`/`agents/` trigger a
re-symlink (modifications/deletions do not); the default-branch resolution
mirrors `bin/flow-new-worktree.ts` / `bin/flow-pre-commit.ts` — do not
hardcode `origin/main`.

`--source "$WORKTREE"` forces `flow install` to read its content tree from
the in-flight worktree (so a flow-self PR adding a skill sees the new files
this session); for non-flow repos the worktree has no `skills/`/`agents/`
tree, so the detection guard above keeps this branch from running. The
override swaps only the **content source** — the **recorded owner** in
`~/.flow/installed.json` stays on the canonical install root via
`resolveFlowSource()`, so a worktree's post-merge removal can't strand
manifest entries, and dangling symlinks from past `--source` runs get
reaped on the next `flow install --upgrade`.

**Concurrency.** `flow install` wraps its symlink work in
`~/.flow/setup.lock` (`bin/lib/lock.ts`), so parallel pipelines that
both add skills/agents serialise here rather than racing on
`~/.flow/claude-home/.claude/skills/` (skills and agents both, each
nested under its owning module's plugin root). Do not add an ad-hoc
lock at this call site.

**End condition:** the helper exits 0. On non-zero exit (the verb
maps `summary.blocked > 0` to exit 1; parser errors map to 2):
retry once. If the retry also fails, escalate
`NEEDS HUMAN: flow-setup-upgrade-failed <stderr>` — the supervisor
cannot safely continue to step 6 without the new skill/agent files
visible.
