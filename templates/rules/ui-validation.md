---
paths:
  [
    "**/*.svelte",
    "**/*.tsx",
    "**/*.jsx",
    "**/*.vue",
    "**/*.svelte.ts",
    "**/*.svelte.js",
    "**/*.css",
    "**/*.scss",
    "**/routes/**",
    "**/components/**",
    ".flow/ui-validation.json",
    ".flow/design/**",
  ]
---

### Browser-driven UI validation (optional, opt-in)

flow can self-validate the rendered UI — render smoke (no console errors,
no failed requests, key elements present) at verify time and a subjective
visual-appearance pass at review time — via the `chrome-devtools` MCP plus
a `.flow/ui-validation.json` manifest. The manifest is no longer paperwork
you must author first: when the diff touches a **meaningful UI surface**
(`.svelte`/`.tsx`/`.jsx`/`.vue`, or a `routes/`/`components/` path — a bare
`.css` token change with no derivable route does not qualify, and neither
does a bare `.svelte.ts`/`.svelte.js` runes module on its own: it is
counted as a UI file so the rule still loads, but carries no route of its
own) and the MCP
is present but no manifest exists, `flow-ui-validate` returns a mechanical
**bootstrap** verdict: it deterministically infers `launch` (from
`package.json` scripts), a per-run free port + `baseUrl`, `routes` (from the
diff, stack-agnostically), and auth (`loginUrl` + credential env-var NAMES
from `.env.example`), then the skill empirically verifies it (launch
started, routes rendered, login succeeded) and **auto-completes + commits**
a manifest — storing names and non-secret config only — never a secret
value. An absent MCP always skips quietly (exit 0), so headless/CI runs
stay green; and whenever a UI diff goes unverified (no MCP, or creds/launch
couldn't be resolved) the PR body and gate summary say so explicitly rather
than skipping silently.

The three-ingredient new-repo onboarding:

1. **MCP, once per machine.** Register `chrome-devtools-mcp` in
   `~/.claude.json` (local scope). This is outside flow's control and
   outside any repo — flow only documents the pointer; it never installs
   or ships the MCP config. Register it with `--isolated` so every browser
   it launches gets its own auto-cleaned throwaway user-data-dir. This lets
   concurrent flow pipelines — each its own session, hence its own
   chrome-devtools MCP server process — run the UI-validation pass without
   colliding on the single shared default profile. Without `--isolated`, the
   second concurrent pipeline to reach UI validation fails with `The browser
   is already running for ~/.cache/chrome-devtools-mcp/chrome-profile`; flow
   degrades that to a clean skip (you lose browser coverage but the run stays
   green). A per-repo `--user-data-dir` is an alternative if you want a
   persistent logged-in profile per repo. `--isolated` only swaps the
   on-disk profile for a throwaway one — that throwaway profile is
   documented as cleaned up *after the browser is closed*, so `--isolated`
   alone does not stop a leaked browser process; see
   `references/verification.md` ("Clean up spawned resources") for how
   the browser process itself is reaped. Add
   `--headless=new` (not the legacy `--headless`) if you never want a Dock
   icon for the automation browser.
2. **Manifest, auto-completed (hand-authoring optional).** flow now
   bootstraps `.flow/ui-validation.json` for you: on a meaningful UI diff it
   infers `launch`/`baseUrl`/`routes`/`loginUrl` and credential env-var
   **NAMES** (mined from `.env.example`), empirically verifies them by
   driving the browser, and commits a manifest it EMPIRICALLY VERIFIED
   (launch started, routes rendered, login succeeded) — storing names and
   non-secret config only — never a secret value. You may still copy the
   committed `templates/ui-validation.json.example` stub to
   `.flow/ui-validation.json` and hand-author it to pin routes/selectors the
   heuristic can't derive; a committed manifest is a deterministic cache the
   agent then maintains rather than re-infers. Fields:
   - `launch` (required) — the dev-server command, e.g. `npm run dev`.
   - `baseUrl` (required) — e.g. `http://localhost:5173`.
   - `loginUrl` (optional) — the login route.
   - `credentialEnvVars` (optional) — `{ user, pass }` env-var **NAMES**
     (not values), e.g. `{ "user": "TEST_USER_EMAIL", "pass": "TEST_USER_PASSWORD" }`.
   - `routes` (required) — an array of `{ path, expectSelectors? }`; each
     `expectSelectors` entry must appear in the route's a11y snapshot.
   - `disableAnimations` (optional boolean) — honored via
     `prefers-reduced-motion` emulation for stable snapshots.
   - `ignoreConsolePatterns` / `ignoreRequestPatterns` (optional string
     arrays) — substring (not regex) noise filters applied per route before
     `ok` is computed. The canonical case is the favicon 404 the browser
     auto-requests: clear it with `ignoreRequestPatterns: ["/favicon.ico"]`.
     Absent => no filtering.
   - `env` (optional) — a flat string→string map injected into the launch
     process for **non-secret launch config only** (ports, public URLs, CORS
     origins). Secrets stay as NAMES in `credentialEnvVars`, resolved from the
     shell env; never inline a credential value here.

   **Dedicated agent-test ports.** Agents launch the app on a freshly-allocated
   free port **per process**, never a fixed offset: one `{{PORT}}` sentinel for
   a single-process app, or one `{{PORT_<NAME>}}` named sentinel (UPPER_SNAKE,
   e.g. `{{PORT_BACKEND}}`) per additional process, each resolved to its own
   distinct free port every run — so an agent run never collides with the
   developer's own running dev server, nor with another concurrent agent run.
   A custom-port launch must handle three gotchas (rewritten against
   sentinels, same three failure modes as a fixed offset): (1) the backend CORS
   allow-list must admit the frontend's per-run origin — set
   `CORS_ALLOWED_ORIGINS` in `env` to the per-run `baseUrl`; (2) per-endpoint
   frontend URL vars (e.g. `VITE_*_URL`, like `VITE_API_URL`) must point at the
   backend's per-run `{{PORT_<NAME>}}`; (3) prefer seeded `TEST_USER_*`
   password login over OAuth — OAuth/Supabase redirect URIs are origin-specific
   and break on a per-run origin (the fallback is manually registering the
   origin's redirect URL with the OAuth provider). If the app needs a separate
   backend, the single `launch` command can start both processes (e.g. via
   `concurrently`). The flat `env` map is injected **once** into the parent
   launch process, so it carries only overrides that are the same across
   processes (e.g. `CORS_ALLOWED_ORIGINS`, and the public backend URL the
   frontend reads via `VITE_*_URL`). Per-process-differing vars — most commonly
   each process's own port — go **inline** in the `launch` command per
   sub-command (e.g. `PORT={{PORT}} … dev:frontend` and `PORT={{PORT_BACKEND}}
   … dev:backend`), not in `env`, since a single flat `env` value can't express
   two different ports. flow does **not** orchestrate a separate backend
   lifecycle.

   **Don't write test-time port or URL overrides to a file.** Pass them
   inline to the launch subprocess (env vars / CLI flags); never write
   `.env.local`, `.env`, or any other config file. A gitignored override
   outlives the run and silently re-points a later manual `npm run dev`.
   Extend `.flow/ui-validation.json` (env, a new `{{PORT_<NAME>}}` sentinel)
   instead.

   **Self-completing + self-maintaining manifest (CRITICAL).** The agent
   completes and maintains EVERYTHING the smoketest needs, not just the
   launch: when it adapts on the fly to make a run work (tweaks the launch
   command, adds/changes an env var, fixes `baseUrl`, corrects a 404'd route,
   records the login route + credential NAMES), it
   persists the launch adaptation back into `.flow/ui-validation.json` — and
   the same for every other field it verified — and commits it into the
   reviewable PR diff, so the human never has to ask and the next run starts
   deterministic. Runtime
   credential VALUES are resolved from the local `.env`/shell env and NEVER
   persisted: the committed manifest stores names and non-secret config only —
   never a secret value. Treat the manifest as a deterministic cache of
   non-secret facts the agent maintains, not a frozen contract.
3. **Seed + creds, once per repo.** Provide a loginable test user + fixture
   data and document it under a "Local Testing Credentials" section in this
   file, so the review/verify passes can log in deterministically.

**Committed artifacts reference credential NAMES only.** The manifest, plan,
commit messages, and PR bodies reference credential env-var NAMES only —
never a plaintext VALUE. A browser-driving sub-agent MAY resolve and use the
manifest-named VALUES at runtime to drive the login form (`navigate` the
`loginUrl` → locate and fill the email/password fields via the generic
selector heuristic → submit), but the resolved VALUE must never be echoed
into chat, logs, PR bodies, screenshots, or any captured evidence — a
filled-form screenshot leaks it exactly as a committed file would, so
capture evidence only on post-auth routes, never the login form. This is
scoped to zero-risk seed/test accounts named in the manifest; it is not a
license to hand-type arbitrary or production passwords.

**Operational notes.** The `chrome-devtools` MCP must be connected at
session start: a mid-session registration is invisible to the running
session and any sub-agent it spawns (a fresh sub-agent shares the parent's
MCP connection set), so a reload/restart is required to pick it up. For
screenshot evidence to land in the worktree, the worktree should be a
configured MCP workspace root; otherwise the capture falls back to the
session cwd or is skipped — the a11y snapshot is the gate either way.
Captured screenshots' clickable absolute paths now surface in the pipeline
session at verify and review time, and a UI diff with no screenshot is
surfaced as an explicit in-session validation gap rather than a silent
omission.

**Security.** The `chrome-devtools` MCP drives a real browser and can run
arbitrary JS in the page context, so harden the setup: (1) point it at
**trusted/local targets only** — never let it navigate to an untrusted
site; (2) use an **isolated/throwaway Chrome profile** — never set
`--user-data-dir` to your real profile, or the automated session inherits
its cookies, saved sessions, and passwords — registering with `--isolated`
satisfies this automatically (temp profile, auto-cleaned) and additionally
prevents the parallel-pipeline profile-lock collision described above;
(3) ensure Chrome's
remote-debugging port (default `9222`) is an **unauthenticated** control
channel bound to `127.0.0.1` (loopback) only, never `0.0.0.0` — otherwise
any host on the LAN can drive the browser. flow sets no port, profile, or
socket (the MCP config lives in `~/.claude.json`, outside flow's control),
so these are the operator's responsibility.

`.flow/ui-validation.json` lives under the `.flow/` prefix, so a consumer
may add a `jq empty .flow/ui-validation.json` check to its
`.flow/pre-commit.json` flow-config scope to lint the manifest's JSON on
commit.

### Design foundation (`.flow/design/foundation.md`, optional)

When a flow pipeline builds UI against a referenced design artifact (a mock
URL, an artifact HTML page, a PDF/image mock), it may create — and from then
on maintain — a committed `.flow/design/foundation.md` in this repo. The file
is a **small, human-legible design-foundation contract**: prose plus a
semantic token map that names how type, surface, elevation, and chrome roles
map onto this repo's existing CSS tokens. It is not a wireframe and not a
value dump — it records the recurring rules ("card surfaces use
`--surface-raised`; page chrome text is `--text-muted`") that every later
UI-touching pipeline reads as required context, so styling decisions stay
consistent across features instead of being re-derived per PR.

Conventions the agent follows (and a human editor should too):

- **Agent-maintained, committed.** The pipeline creates and extends the file
  through reviewable PR diffs — the same discipline as the self-completing
  `.flow/ui-validation.json` manifest above.
- **Extend only on a recurring rule.** A new entry is added only when a
  feature surfaces a NEW rule that will recur across surfaces; one-off values
  stay in the component that uses them. Existing rules are never rewritten in
  passing.
- **No secrets, ever.** The file is a design contract; nothing in it may be a
  credential, token, or private URL.
- **Re-freeze is explicit-only.** The per-pipeline design spec and reference
  snapshot are re-extracted from the artifact only when a user redirect
  supplies a changed artifact or explicitly asks — never silently.
- **Deleting it degrades gracefully.** Removing the file returns design
  handling to fully-ephemeral, per-pipeline behavior; nothing breaks.
- **Ephemeral siblings are never committed.** The machine-readable
  `spec.json` and the frozen artifact snapshot live under
  `.flow-tmp/design/` for the duration of one pipeline and never land in the
  repo — the committed foundation is the only durable artifact.
