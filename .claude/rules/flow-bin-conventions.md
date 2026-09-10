---
paths: ["bin/**", ".github/**", "package.json"]
---

# bin/ conventions

## Scripts: Bun runtime, distributed via symlinks

Source for shipped helper binaries lives in **`bin/`**. User-callable
helpers (`flow-new-worktree`, `flow-pre-commit`, `flow-state-update`,
`flow-notify`, `flow-ui-validate`, `flow-review-telemetry`,
`flow-test-audit`, etc.) live there with `.ts`
extensions, Bun shebangs, and tests next door
(`<name>.test.ts`, skipped when `flow install` symlinks into
`~/.local/bin/<name>`). The five schema validators
(`flow-pr-review-result-schema`, `flow-agent-finding-schema`,
`flow-fix-applier-schema`, `flow-epic-manifest-schema`,
`flow-intent-resolution-schema`) are also symlinked, sourced from
`bin/lib/*-schema.ts` via an allowlisted `discoverValidators`
(vs `discoverHelpers`'s auto-pickup of every `bin/*.ts`).
`bin/flow` itself is Bun and dispatches every verb natively.

`flow install` also materializes a skills-dir plugin root per selected
module (`docs/configuration.md`). `flow-plugin-probe`/`flow-plugin-contract-lint`
join `flow-release`/`flow-model-bench`/`flow-eval` in `MAINTAINER_ONLY` — never on PATH.

Conventions for any script under `bin/`: `#!/usr/bin/env bun` + `chmod
+x`; gate `main()` with `import.meta.main` (not an
`import.meta.url`/`process.argv[1]` comparison, which breaks through a
symlink); tests live next door, run via `npm run test`. Default new
scripts to Bun; deviating needs user confirmation and an inline comment.

Telemetry is helper-emitted only, via `bin/lib/telemetry.ts`'s `recordEvent`
at existing chokepoints — never agent prose; a signal no helper sees is
DERIVED from one a helper already writes. Contract: `docs/configuration.md`.

## Don'ts

- **Don't make tmux pane/window state a load-bearing input.** Backend-agnostic
  signals only, in order: the launch env (`FLOW_SLUG`, set by both launcher
  backends), `~/.flow/state/<slug>.json`, then on-disk artifacts — the plain
  shell is the DEFAULT launcher, so a bare install has none. flow's options
  (`@flow-slug`, `@flow-phase`, `@flow-repo`, `@flow-phase-short`,
  `@flow-kind`, `@flow-epic`, `@flow-pr`) are additive, publish-only mirrors
  (`@flow-epic` always: epic slug, feature or design/run, else empty;
  `@flow-pr` bare digits, empty pre-PR, no reader). Two sanctioned reads: `@flow-kind`, load-bearing ONLY because epic orchestration
  is already tmux-only by an independent hard constraint — its precondition
  must be named in a comment at BOTH producing and consuming site, and absence
  must degrade to a CORRECT, safe-by-construction default; and `@flow-slug`,
  read back only as a `flow ls`/`attach`/`done` window-join key
  (`LIST_WINDOWS_FORMAT`), never identity. See `resolveSlugAmbient` (env-only)
  and `resolveKindAmbient` in `bin/lib/session-identity.ts`;
  `bin/pane-read-lint.test.ts` fails CI on any pane read outside the frozen
  allowlist, in code or prose. `flow ls`'s KIND column reads
  `PipelineState.kind`, never `@flow-kind`.
- **Don't write test-time port or URL overrides to a file.** Pass them
  inline to the launch subprocess (env vars / CLI flags); never write
  `.env.local`, `.env`, or any other config file. A gitignored override
  outlives the run and silently re-points a later manual `npm run dev`.
  Extend `.flow/ui-validation.json` (env, a `{{PORT_<NAME>}}` sentinel)
  instead. See
  `skills/pipeline/flow-pipeline/references/ui-smoke-pass.md`.
- **Don't gate a post-commit verification on a worktree-vs-index diff.**
  Post-commit, worktree == index == HEAD, so `git diff --check` /
  `git status --porcelain` report clean regardless of content — read the
  committed tree instead (`git grep ... HEAD`). See
  `skills/pipeline/flow-merge-resolver-instructions/SKILL.md`
  Step 5 and `flow-conflict-marker-check`.

## CI

`.github/workflows/ci.yml` runs `npm run verify` (`typecheck:scripts` +
vitest + lint) on every PR and push to `main` — the server-side backstop
for the local-only `flow-pre-commit` gate. The runner installs Node and
Bun (vitest spawns `bun`). **Make the `verify` job a required status
check** via a branch ruleset on `main` — select job name `verify` (shown
`CI / verify` in the checks tab). A repo-admin setting, not
workflow-enforceable.
