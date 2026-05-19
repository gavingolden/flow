---
name: cloudflare-pages
description: >-
  Cloudflare Pages stack helper covering deployment pruning, preview vs
  production env handling, SPA fallback (`cp build/200.html build/index.html`),
  and CORS wildcard configuration. Use when user says `/cloudflare-pages`,
  'use the cloudflare-pages skill', or 'prune cf deployments'.
disable-model-invocation: true
---

# Goal

Provide deployment-pruning, preview/prod env handling, SPA fallback, and
CORS guidance for projects deployed to Cloudflare Pages — without bringing
in the full 8-skill cloudflare plugin. Manually invoked only; the skill
matcher does not auto-load this skill on file/path signals.

# When to Use

- Bulk-pruning preview / production deployments that have accumulated.
- Configuring preview vs production env vars on a Cloudflare Pages project.
- Setting up SPA fallback for SvelteKit `@sveltejs/adapter-static` (or any
  SPA) on Pages.
- Configuring CORS allowlist to handle preview deployment URLs.
- User invokes via `/cloudflare-pages`, 'use the cloudflare-pages skill',
  or 'prune cf deployments' — manual invocation only (the matcher does not
  auto-load this skill).

# When NOT to Use

- Cloudflare Workers (non-Pages) — defer to the official `cloudflare:wrangler`
  skill from the cloudflare plugin (`cloudflare@claude-plugins-official`).
- KV / R2 / D1 / Durable Objects / Workers AI / Vectorize / Hyperdrive /
  Queues / Workflows / Pipelines / Containers / Secrets Store — defer to
  `cloudflare:wrangler`.
- Pages Functions (`_worker.js` Pages Functions, advanced routing) — beyond
  a brief callout, defer to `cloudflare:wrangler`.
- Account-level setup (creating accounts, billing, Zero Trust) — out of
  scope.

# Context

- Cloudflare Pages exposes no native deployment-retention CLI/API today
  (the dashboard 'Deployment retention' toggle has been historically
  unreliable). Pruning must be scripted.
- Wrangler's `pages deployment list` and `pages deployment delete` commands
  handle simple cases but refuse aliased / active deployments — the CF
  REST API
  (`DELETE /accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}?force=true`)
  is required for those.
- Build env vars prefixed `VITE_*` or `PUBLIC_*` are baked into the bundle
  at build time — changing them requires a redeploy.
- Preview deployments get dynamic URLs (`https://<hash>.<project>.pages.dev`)
  that need wildcard handling in CORS allowlists.

## 1. Deployment Pruning

This is the originating concern this skill exists to address.

For a few stale deployments, use Wrangler:

```bash
wrangler pages deployment list --project-name <your-project>
wrangler pages deployment delete <deployment-id> --project-name <your-project>
```

For bulk-pruning on a schedule (e.g. nightly cleanup of preview deployments
older than 30 days), call the reusable workflow from a wrapper workflow in
your repo:

```yaml
# .github/workflows/prune-cf-pages.yml
name: prune-cf-pages

on:
  schedule:
    - cron: '0 7 * * *'   # 07:00 UTC daily
  workflow_dispatch:

jobs:
  prune:
    permissions:
      contents: read
    uses: gavingolden/flow/.github/workflows/cloudflare-pages-prune.yml@<sha>
    with:
      project: my-project
      older_than_days: 30
      branch: '!main'      # optional; omit to match all branches
      dry_run: false       # default; deletes deployments. set true for a dry-run validation pass
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      WORKFLOW_REPO_TOKEN: ${{ secrets.WORKFLOW_REPO_TOKEN }}  # optional; see below
```

The SHA in `uses:` pins both the workflow contract AND the prune script —
the workflow's own `actions/checkout` step fetches `gavingolden/flow` at
the same SHA the caller resolved, so the script the workflow runs always
matches the workflow's own version. The workflow resolves its own SHA
from `job.workflow_ref` (which carries the `@<sha>` suffix the caller
pinned), so callers never have to pass flow's SHA explicitly — just keep
the `@<sha>` pin on `uses:` up to date. To upgrade, bump the SHA;
consumers never re-vendor.

`WORKFLOW_REPO_TOKEN` is only required in the **private→private cross-repo
case**: when your calling repo is private *and* `gavingolden/flow` is
private to your account/org, the default `GITHUB_TOKEN` is scoped to the
caller's repo and cannot fetch a sibling private repo's source, so the
`actions/checkout` step that pulls `gavingolden/flow` will 404. Pass a
fine-grained PAT (or GitHub App installation token) with `Contents:Read`
on `gavingolden/flow` to resolve. Omit (or leave unset) when the caller
is a public repo, when `gavingolden/flow` is public, or when the caller
*is* `gavingolden/flow` itself — in those cases the default token already
has read access. (Note that the *revision* being checked out is still
resolved from `job.workflow_ref` regardless of which token does the
fetch — the token decides whether the fetch is allowed, not which SHA is
fetched.)

Inputs:

- `project` (string, required) — Cloudflare Pages project name.
- `older_than_days` (number, required) — cutoff in days; passed to the
  script as `--older-than <N>d`.
- `branch` (string, optional, default `''`) — single glob passed to the
  script's `--branch` flag. Supports positive (`feat/*`) or negative
  (`!main`) globs. Empty string omits `--branch` so the script matches
  all branches.
- `dry_run` (boolean, optional, default `false`) — **permanently deletes**
  Cloudflare Pages deployments matched by the filter via `DELETE ?force=true`
  REST calls; set true for a safe dry-run validation pass that invokes the
  script with `--dry-run` and only prints the would-delete list.

Secrets:

- `CLOUDFLARE_API_TOKEN` — token with `Account.Cloudflare Pages:Edit`
  scope.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID (not project ID).
- `WORKFLOW_REPO_TOKEN` (optional) — token with `Contents:Read` on
  `gavingolden/flow`. Required only in the private→private cross-repo
  case (see the paragraph after the YAML example above); omit otherwise.

### When to vendor instead

The reusable workflow exposes only the four inputs above. Vendor the
script directly when you need to:

- Extend the script (custom filtering logic, additional CF API calls).
- Run pruning outside GitHub Actions (cron on a server, ad-hoc local
  cleanup).
- Use flags the workflow does not expose: `--keep-aliased` /
  `--no-keep-aliased`, `--keep-production-latest` /
  `--no-keep-production-latest`, `--max <N>`, or the script's full
  `--older-than` syntax (ISO date / ISO datetime in addition to `<N>d`).

Note the intentional asymmetry: the workflow input `dry_run` defaults to
`false` (scheduled/unattended use, where opt-in dry-run would defeat the
cron), while the script CLI below defaults to `--dry-run` (interactive
vendor use, where the safe default protects ad-hoc operators).

```bash
cp ~/.claude/skills/cloudflare-pages/templates/prune-cf-deployments.ts <your-project>/scripts/
bun <your-project>/scripts/prune-cf-deployments.ts \
  --project <your-project> \
  --older-than 30d \
  --branch '!main' \
  --dry-run    # default; --apply to actually delete
```

The trade-off: vendoring gives access to the script's full flag set, at
the cost of re-vendoring on every script update (no SHA-pin upgrade path).

For full pruning workflow including the CF REST API fallback for
aliased/active deployments, see `references/deployment-pruning.md`.

### Failure mode: caller-side context resolution

Inside a reusable workflow, `github.workflow_ref` and `github.workflow_sha`
both resolve to the *caller's* run — not to the called (reusable) workflow.
PR #158 (merge SHA `b464d2c`) shipped a fix that read `github.workflow_ref`
on the premise it would resolve called-side; empirical post-merge dispatch
proved otherwise, and the self-checkout step rejected the caller's
`refs/heads/main` value against its 40-char-hex SHA guard. The correct
alternative is `job.workflow_ref` / `job.workflow_sha`, which the `job`
context table documents as referring to "the reusable workflow file" for
jobs defined inside one. Note: both `job.*` fields are documented as not
available on GitHub Enterprise Server (flow targets github.com only); the
documented GHES fallback is a caller-passed `flow_sha` `workflow_call`
input (approach b in the original plan), at the cost of consumer-side YAML
churn. The current PR's commit pair is the historical anchor for this
failure mode — `git log` for `job.workflow_ref` and "PR #158" surfaces
both.

## 2. Deployment Workflow

Two modes:

- **Git-driven auto-deploys** (most common): push to a branch → Cloudflare
  auto-deploys; production branch → production URL, other branches →
  preview URL at `<hash>.<project>.pages.dev`.
- **CLI deploys** via `wrangler pages deploy ./build` for ad-hoc deploys
  outside git.

## 3. Preview vs Production Environments

- Build env vars are split between Preview and Production environments in
  the dashboard.
- `VITE_*` and `PUBLIC_*` (and any framework-specific build-time prefix)
  are baked into the bundle at build time. **Changing them in the
  dashboard requires a redeploy.**
- Runtime env vars (only relevant if using Pages Functions) are read at
  request time.
- Set `NODE_VERSION` explicitly in build env vars — the Pages default Node
  version is stale and may not support modern syntax.

## 4. CORS Allowlist for Preview URLs

Preview deployments get dynamic `<hash>.<project>.pages.dev` subdomains.
Backends called from previews must allowlist both production and preview
wildcards:

```
CORS_ALLOWED_ORIGINS=https://<your-project>.pages.dev,https://*.<your-project>.pages.dev
```

Watch for comma-escape pitfalls when setting CORS env vars in shell scripts
(some CLIs need explicit escapes).

## 5. SPA Fallback (SvelteKit / Vite SPAs)

With `@sveltejs/adapter-static` and `fallback: '200.html'`, the build emits
`200.html` but Cloudflare Pages serves `index.html` for the root path.
Without copying `200.html` to `index.html`, root `/` returns 404 because
the static adapter expects `200.html` to act as the catch-all but Pages
does not honour it for root requests:

```bash
npm run build && cp build/200.html build/index.html
```

Set this as the build command in the Pages dashboard (or in `package.json`
scripts). For full rationale see `references/env-vars-and-build.md`.

# Troubleshooting

- Root path `/` returns 404 → missing `cp build/200.html build/index.html`
  post-build step.
- Env var change didn't take effect → `VITE_*` / `PUBLIC_*` are build-time;
  trigger a redeploy.
- CORS error from preview URL → backend allowlist missing
  `https://*.<project>.pages.dev` wildcard.
- Build fails on modern syntax → `NODE_VERSION` env var not set; default
  is stale.
- `wrangler pages deployment delete` refuses with 'aliased' error → the
  deployment is the current production target or has an active alias; use
  the CF REST API path (see `references/deployment-pruning.md`).

# Verification

- Skill installed at `~/.claude/skills/cloudflare-pages/` after
  `flow setup --upgrade`.

**Reusable-workflow path:**

- Wrapper workflow in the consumer repo declares
  `uses: gavingolden/flow/.github/workflows/cloudflare-pages-prune.yml@<sha>`
  pinned to a real commit SHA (not a floating tag).
- Calling job declares `permissions: contents: read` so the workflow's
  `actions/checkout` step has read access via the default token (parity
  with the YAML example in section 1).
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set as secrets in
  the calling repo and passed through the wrapper workflow's `secrets:`
  block.
- For the private→private cross-repo case, `WORKFLOW_REPO_TOKEN` is also
  set as a secret in the calling repo and passed through.
- First trigger runs with `dry_run: false` (the default) and the job log
  contains `mode=APPLY`.

**Vendor path:**

- Pruning template copied to consumer's `scripts/` dir; runs in `--dry-run`
  mode by default.
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set in shell env
  before invoking the script.

# Constraints

- Manually invoked only — `disable-model-invocation: true` opts this skill
  out of auto-loading. Sibling stacks (`svelte`, `supabase-project`,
  `tailwind-shadcn`) auto-load on file/path signals; this one does not.
- The pruning script template uses the Cloudflare REST API directly (no
  `wrangler` shell-out) — Wrangler refuses aliased/active deletes, and
  shelling out compounds test ceremony.
- No 'keep N per branch' flag — over-engineered for the operation's
  frequency. Use tighter `--older-than` or pre-filter with `--branch`
  patterns instead.

## Cross-references

- `references/deployment-pruning.md` — full pruning playbook (Wrangler
  default + CF REST API fallback).
- `references/env-vars-and-build.md` — build-time vs runtime variables,
  SPA fallback rationale, NODE_VERSION.
- `templates/prune-cf-deployments.ts` — opt-in Bun pruning script (copy
  into your project's `scripts/`).
- `.github/workflows/cloudflare-pages-prune.yml` — reusable GitHub Actions
  workflow for scheduled bulk pruning (recommended consumer path).
