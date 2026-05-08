# Deployment Pruning Playbook

Cloudflare Pages exposes no native retention CLI/API; deployments
accumulate indefinitely. Pruning is a scripted workflow with two paths.

## Wrangler path (simple cases)

- `wrangler pages deployment list --project-name <project>` (paginated).
- `wrangler pages deployment delete <id> --project-name <project>` (one
  at a time).
- Wrangler refuses to delete: (1) the current production deployment (the
  alias target), (2) deployments with active aliases (e.g. branch-head
  deployments mapped to a custom domain). For those, use the REST API
  path.

## CF REST API path (aliased / active deployments, scripted bulk)

- Endpoint:
  `DELETE /accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}?force=true`
- Auth: `Authorization: Bearer ${CLOUDFLARE_API_TOKEN}` (token must have
  `Account.Cloudflare Pages:Edit` permission scope).
- The `force=true` query parameter overrides the alias-protection check.

## Footgun: production deployments

Deleting the current production deployment WILL break the production URL
until a new deployment lands. The script template defaults to
`--keep-production-latest=true` precisely to prevent this. Override only
with conscious intent.

## Recommended workflow

1. Decide retention policy: e.g. 'delete preview deployments older than 30
   days, never touch main/production-aliased'.
2. Copy `templates/prune-cf-deployments.ts` from this skill into your
   project's `scripts/` dir.
3. Run with `--dry-run` (default) first to inspect the would-delete list.
4. Re-run with `--apply` when the list looks right.
5. Schedule (cron, GitHub Actions) for ongoing maintenance.

Example invocations:

```bash
# Preview deployments older than 30 days, dry-run first
bun scripts/prune-cf-deployments.ts \
  --project <your-project> \
  --older-than 30d \
  --branch '!main' \
  --branch '!production'
# Then add --apply when ready

# Aggressive cleanup of feature/* branches older than 7 days
bun scripts/prune-cf-deployments.ts \
  --project <your-project> \
  --older-than 7d \
  --branch 'feat/*' \
  --apply
```

## Note on the 'auto-delete after 7 days' dashboard recommendation

Some older Cloudflare Pages deployment guides (including
`econ-data/DEPLOYING.md:448`) recommend setting 'auto-delete after 7 days'
under the project's dashboard Settings. As of the time of this writing,
that toggle has been historically unreliable (on-and-off in the dashboard
UI, no documented CLI/API surface). Treat the dashboard recommendation as
suspect — even when the toggle appears, it does not cover production
deployments. The scripted approach in this skill is the durable answer;
the user may want to update any internal docs that recommend the dashboard
toggle.

## Required environment

- `CLOUDFLARE_API_TOKEN` — API token with `Account.Cloudflare Pages:Edit`
  permission. Generate at dash.cloudflare.com → My Profile → API Tokens.
- `CLOUDFLARE_ACCOUNT_ID` — your account ID (not project ID). Find at
  dash.cloudflare.com → right sidebar.
