# Migrating an existing AGENTS.md onto the three-file split

`templates/AGENTS.md.template` shipped as one monolithic file through
p6-context-budget (2026-09-09); the p2-context-diet-template-skills diet
split it into a core plus two offload tiers. A repo that already copied
the old monolithic template does not need to re-copy the whole thing —
it needs to make the same three moves the template itself made.

## The three moves

1. **UI validation + design foundation → a path-scoped rule.** The
   `### Browser-driven UI validation (optional, opt-in)` and
   `### Design foundation` sections move into a new rule file carrying
   `paths: ["**/*.svelte", "**/*.tsx", "**/*.jsx", "**/*.vue",
"**/routes/**", "**/components/**"]` frontmatter — the two sections a
   file read genuinely precedes, and nothing else.

   **LOAD-BEARING:** in an adopting repo, this rule file must land at
   `.claude/rules/ui-validation.md` — Claude Code's `paths:` frontmatter
   only takes effect for files under `.claude/rules/`. A copy of this
   file placed anywhere else (e.g. left at the repo root, or under a
   `rules/` directory outside `.claude/`) silently never fires; nothing
   errors, the rule just never loads. The core's own `## Where to look`
   row points at the file with the flow-tree-relative form the lint in
   this repo asserts (`rules/ui-validation.md`, relative to
   `templates/`); an adopting repo's actual destination is
   `.claude/rules/ui-validation.md`, not that same relative path.

2. **The eight trigger-less sections → three reference files.** Manual
   Verification and Clean up spawned resources move to
   `references/verification.md`; Google-AI delegation and the Product
   brief move to `references/delegation.md`; Agent Behavior,
   Anti-Overengineering (with the Fix-now bar), Scope, Skill
   Consultation, Tooling, Code Quality, Comments, and Testing move to
   `references/agent-conduct.md`. None of these sections are gated by a
   file-path trigger the way UI validation is — they are read on demand
   by name, not preceded by any particular file touch — so they become
   plain reference files rather than `paths:`-scoped rules.

3. **The core keeps safety, security, hardening, and compact
   instructions, and gains a routing table.** `## Safety (Sandbox
Disabled)` (all of its subsections, including Command Execution and
   Committing), `## Context budget`, `## Compact Instructions`,
   `## Critical Judgment`, `## Hardening`, and `## Security` stay in the
   core file, untouched. The core opens with a `## Where to look` table
   naming the rule file and the three reference files, plus a pointer
   back to this migration doc — the migration steps themselves do not
   live in the core, since they are noise for a fresh-repo reader and
   invisible to a reader who already has a copy.

## Measuring the result

After making the three moves, measure the new split with:

```sh
flow-context-budget --repo .
```

`--json` adds a `templatePayload` key with `core` / `lazyRules` /
`references` sub-estimates (chars, lines, estimated tokens) so you can
confirm the core stayed small and the two offload tiers picked up the
moved content, without hand-counting.
