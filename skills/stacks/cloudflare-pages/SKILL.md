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

For bulk-pruning (e.g. all preview deployments older than 30 days,
excluding production), copy the Bun script template:

```bash
cp ~/.claude/skills/cloudflare-pages/templates/prune-cf-deployments.ts <your-project>/scripts/
bun <your-project>/scripts/prune-cf-deployments.ts \
  --project <your-project> \
  --older-than 30d \
  --branch '!main' \
  --dry-run    # default; --apply to actually delete
```

For full pruning workflow including the CF REST API fallback for
aliased/active deployments, see `references/deployment-pruning.md`.

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
