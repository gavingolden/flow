# Env Vars and Build Settings on Cloudflare Pages

## Build-time vs runtime variables

- Build-time variables (`VITE_*`, `PUBLIC_*`, framework-specific prefixes)
  are read by the bundler during `npm run build` and **baked into the
  static bundle** — the values become string literals in the compiled
  JavaScript.
- Runtime variables (only relevant if using Pages Functions) are read by
  the request handler at execution time.
- **Implication: changing a build-time variable in the Pages dashboard
  does NOT take effect until you redeploy.** This is the most common
  source of 'I changed the env var and nothing happened' confusion.

## SPA fallback for SvelteKit (and other SPAs)

With `@sveltejs/adapter-static({ fallback: '200.html' })`, the build emits
`build/200.html` as the SPA catch-all. The static adapter expects this
file to be served for any request path the static files don't match (so
client-side routing works). Cloudflare Pages, however, serves
`index.html` for the root path `/` — not `200.html`.

If `build/index.html` does not exist, requests to `/` return 404. The fix
is a one-line post-build copy:

```bash
cp build/200.html build/index.html
```

Wire it into your build command (Pages dashboard → Settings → Build &
Deploy → Build command):

```
npm run build && cp build/200.html build/index.html
```

Or in `package.json`:

```json
{ "scripts": { "build": "vite build && cp build/200.html build/index.html" } }
```

## NODE_VERSION env var

The Pages default Node version is older than current Node LTS and may not
support modern syntax (e.g. top-level await, optional chaining in some
configs, native ESM nuances). Set `NODE_VERSION=20` (or your project's
required version) explicitly in the Pages env vars for both Preview and
Production environments.

## Build cache

Pages dashboard → Settings → Build cache: enable. Caches `node_modules/`
between builds, saves ~30-60s per deploy. Worth turning on unless you
have a reason not to (e.g. flaky cache invalidation).

## CORS for preview URLs

Preview deployments get dynamic URLs at
`https://<hash>.<project>.pages.dev`. If your frontend calls a backend on
a different origin, the backend must allowlist both your production Pages
URL AND a wildcard for preview URLs:

```
CORS_ALLOWED_ORIGINS=https://<your-project>.pages.dev,https://*.<your-project>.pages.dev
```

Watch for shell-escape pitfalls when setting this in CI/CLI. The exact
escape syntax depends on the backend platform.

## Setting Site URL / redirect URLs

If your project uses an auth provider (Supabase, Clerk, Firebase), set
the Site URL to your production Pages URL and add
`https://<your-project>.pages.dev/**` as a redirect URL allowlist entry.
Preview URLs typically don't need separate redirect URL entries unless
you test auth flows on previews.
