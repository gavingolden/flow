# Consumer-repo contract

Offload target for `AGENTS.md` `## Consumer-repo notes`. Full detail on
the surface area a consumer repo wiring `flow-pre-commit` in as its sole
gate needs to know about.

## Scope detection

`flow-pre-commit` is the verify gate `/flow-pipeline`, `/flow-verify`, and
`/flow-coder` rely on. Scope detection is prefix-/extension-based against
the diff: `src/` trips `src`; `scripts/`, `templates/scripts/`, and
`bin/` all trip `scripts`; any `.md` or `.template` file trips `docs`,
which runs `flow-md-validate .` (link + frontmatter, `.md`-only),
`npm run test` (structural-anchor lints), and `npm run lint`; the
`backend/` prefix trips `backend` (prefix-only): `go vet -C backend ./...`
and `go test -C backend ./...`. Workflow YAML under `.github/workflows/`
ALSO trips `actions` (`actionlint .github/workflows/` + `npm run lint`) on
top of `scripts`. `actionlint` and `go` are OPTIONAL: off `PATH`, the
affected check emits a `skipReason` and counts as passed.

The `root-fallback` pseudo-scope (`npm run typecheck` + `npm run test` +
`npm run lint` at root) fires **additively** — appended alongside matched
scopes for any unclaimed file (never when the diff is fully claimed).
(`filterDefinedChecks` drops undefined-script checks; a zero-check
non-empty diff signals `reason: "no-checks-defined"`.)

## Host-wide test-concurrency cap

`flow-pre-commit` caps concurrent local test runs host-wide at
`K = max(1, ceil(os.availableParallelism()/9))` via a counting semaphore
in `~/.flow/test-sem/`, so parallel pipelines stop oversubscribing cores.
Only the test check is throttled (others run unthrottled). Override `K`
via `FLOW_TEST_CONCURRENCY`; on acquire timeout the test runs anyway.

## Host-wide research cache

`flow-research-cache` caches synthesis at `~/.flow/research-cache/`, keyed
on the normalized question; F2 discovery and direct `/flow-research` use
disjoint keyspaces. 48h TTL; miss/stale/corrupt → exit 3, never errors.
Opt-in `prune` sweep. Contract in `discovery-instructions.md`.

## Zero-config monorepo auto-detect + three-layer command resolution

Before root-fallback claims orphans, a SEPARATE pass maps each unclaimed
`apps/<pkg>/` or `packages/<pkg>/` dir that **owns a `package.json`** to
an auto-detected path-named scope (`apps/web`, via `--scope apps/web`); a
no-owner file falls to root-fallback.

Every scope resolves through one shared table in `bin/lib/stack-table.ts`:

1. The package's own declared verify scripts, probed
   `typecheck`/`check` → `lint` → `test` → `format:check`, scoped
   `npm run <script> -w <pkg-path>`, with a **name-based** denylist
   (NAMES not bodies) that never runs mutating/interactive scripts
   (`format`/`dev`/`build`/…).
2. A stack-default table keyed on a marker file (v1: node + go), into
   which flow's built-ins are lifted unchanged.
3. A flow-drafted `.flow/pre-commit.json` entry in the PR diff (see
   `/flow-pipeline` Step 6) when 1–2 resolve nothing — that file is the
   **escape-hatch**: a top-level array of `{ name, prefixes, checks }`
   scopes (merged config > auto-detect > built-in); `checks` run as argv
   (no shell).

## Optional UI-validation manifest

A consumer may declare `.flow/ui-validation.json` (a single OBJECT, not
an array) to opt into browser-driven UI validation; `flow-ui-validate`
parses it tolerantly and skips gracefully (exit 0, loud only on a broken
precondition). Fields + onboarding in `templates/AGENTS.md.template`.

## Design foundation

`.flow/design/foundation.md` is a small human-legible contract —
type/surface/elevation/chrome roles mapped onto the repo's CSS tokens —
agent-maintained, committed (full convention in
`templates/AGENTS.md.template`). Extend only on a new recurring rule;
never secrets; re-freeze is explicit-only. Deleting it degrades to
fully-ephemeral. `spec.json` + reference snapshot stay pipeline-ephemeral
under `.flow-tmp/design/`, never committed.
