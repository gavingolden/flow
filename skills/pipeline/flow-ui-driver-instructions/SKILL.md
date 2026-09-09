---
name: flow-ui-driver-instructions
description: Preloaded instructions for the flow-ui-driver subagent; not for direct invocation.
---

<!-- flow-instructions-sentinel: flow-ui-driver-instructions -->

# UI-driver instructions

These instructions are read by the UI-driver subagent that `/flow-verify`'s
SKILL.md (or `/flow-pr-review` Step 8c.iii) spawns via the Task tool. The
subagent runs in an isolated context — its MCP tool calls, launch subprocess
output, and captures assembly stay inside its own session and are never
returned to the caller. The only outputs it produces are the side effects on
the worktree (the committed manifest self-improvements, the captures JSON)
and the structured artifact it writes to disk
(`.flow-tmp/ui-driver-result.json`), plus a brief one-paragraph summary it
returns on completion.

The drive procedure itself — probe, launch, per-route/per-viewport MCP
sequence, noise filter, self-improving manifest persist-back, teardown — is
the shared body already documented in
[`../flow-pipeline/references/ui-smoke-pass.md`](../flow-pipeline/references/ui-smoke-pass.md).
This file does not reproduce that procedure; it cites it by relative path so
the two cannot drift, and adds only what is specific to running that
procedure INSIDE a spawned, isolated sub-agent rather than inline in the
calling skill's own context: the spawn-prompt inputs, the artifact contract,
and the two responsibilities the caller does not do for you (the
`evidence_paths[] → ui_screenshots[]` mapping, and the `fix_context[]`
assembly).

## Inputs

The wrapper passes you these inputs in its spawn prompt:

- `ENVELOPE_PATH` — the absolute path to the `flow-ui-validate` verdict
  envelope the caller already resolved (a `ran:true` ready or bootstrap
  envelope; the caller does the probe → bootstrap-inference step before ever
  spawning you, so you only ever receive a drivable envelope).
- `MANIFEST_PATH` — the absolute path to `.flow/ui-validation.json`.
- `WORKTREE` — the absolute worktree path (your working directory).
- `SLUG` — the pipeline slug, resolved by the caller from `FLOW_SLUG` /
  `~/.flow/state/<slug>.json` / the worktree basename (env-only chain — see
  "Never read tmux pane state" below).
- `ARTIFACT_PATH` — the absolute path to write the result artifact
  (`.flow-tmp/ui-driver-result.json` under the worktree).
- `CAPTURES_PATH` — the absolute path to write the per-route/per-viewport
  captures JSON (`.flow-tmp/ui-captures.json` under the worktree).
- `MODE` — optional. Absent for the `/flow-verify` default drive (drive the
  full manifest route set). Set to the literal `visual-appearance` by the
  `/flow-pr-review` 8c.iii caller, always paired with an enumerated checklist
  item list in the same spawn prompt: drive only the routes needed to cover
  those items, apply `ui-smoke-pass.md`'s per-viewport `## UI traits to
verify` rubric, and set each `fix_context[]` entry's optional `item` field
  to the checklist item it maps evidence back to (see step 4 below).
- `SKILL_DIR` — the absolute skill base directory. Resolve
  `../flow-pipeline/references/ui-smoke-pass.md` relative to this path, not
  the worktree you `cd`'d into.

## 1. Load context

- Read the envelope at `ENVELOPE_PATH` for `meta.launch`, `meta.env`,
  `meta.baseUrl`, `meta.port`/`meta.ports`, `routes[]`, `loginUrl`,
  `credentialEnvVars`, and `meta.viewports`.
- Read `../flow-pipeline/references/ui-smoke-pass.md` end to end before
  driving anything — "Launch and drive", "Design-fidelity sub-pass",
  "Teardown", "Fix-loop routing", "Noise filter", and "Self-improving
  manifest" are all load-bearing, not optional background.

## 2. Drive

Follow `ui-smoke-pass.md`'s "Probe and skip (and bootstrap)" and "Launch and
drive" sections verbatim — that shared file carries the canonical
per-route/per-viewport drive-MCP call sequence (issue #318 de-duplicated it
into one shared reference; do not re-copy it here). In short: bring the
launch up via `flow-spawn --class default -- sh -c '<meta.launch>'` with
`meta.env` injected inline (never a `.env.local`/`.env`/config file), open a
per-pipeline isolated page keyed on `SLUG`, run the Login step when the
manifest declares a login wall and the credential VALUES resolve from the
local env, then drive each route × each declared viewport per
`ui-smoke-pass.md`'s "Launch and drive" section.

**Never capture the login form, and never persist a credential VALUE.** The
email/username field renders in plaintext in both a screenshot and an a11y
snapshot — masking is not the protection here — so the unconditional rule is:
the login form is simply never captured as evidence, and only credential
NAMES (never a VALUE) are ever written to the manifest, a commit message, or
this agent's own artifact. Your `Write` grant makes omitting this rule more
dangerous than it was when the pass ran inline, not less — honor it exactly
as written in `ui-smoke-pass.md`.

**Slug resolution is env-only.** Resolve `SLUG` from the value the wrapper
passed you (itself derived from `FLOW_SLUG` / `~/.flow/state/<slug>.json` /
the worktree basename). Never read tmux pane state — in code or in this
file's own prose — to key the isolated page or resolve the slug; that is a
frozen anti-pattern (`bin/pane-read-lint.test.ts` fails CI on a pane read
anywhere, prose included).

Write the enriched per-viewport captures to `CAPTURES_PATH` and run
`flow-ui-validate --manifest "$MANIFEST_PATH" --captures "$CAPTURES_PATH"`.
Apply the "Noise filter" and "Self-improving manifest" sections exactly:
when a flagged error is benign noise unrelated to the diff, add the
substring to `ignoreRequestPatterns` / `ignoreConsolePatterns` and commit the
manifest change rather than treating it as a drive failure; when you adapted
the launch/env/baseUrl/routes/login fields to make the run work, persist
those adaptations back into `.flow/ui-validation.json` and commit them too.

## 3. Tear down on every exit path

Follow `ui-smoke-pass.md`'s "Teardown (servers and browser, symmetric)"
section exactly, on completion **and on every error / early-exit path** —
close the isolated page/context you opened (by the numeric `pageId` your own
`new_page` call returned, never a re-derived `list_pages` scan) and bring the
launched server(s) down (by the `flow-spawn` pid or the registry `pgid`,
never a bare shell-job kill). Do this before writing the artifact in step 5,
so a crash after teardown still leaves the worktree clean.

## 4. Map captures to the artifact shape

Two mappings this agent owns that the caller does not do for you:

- **`evidence_paths[] → ui_screenshots[]`.** `flow-ui-validate --captures`'s
  verdict carries `evidence_paths[]`; carry forward the existing `test -f`
  survival guard — a screenshot path that failed to actually land on disk
  (the save-path cascade's `screenshots-unwritable` case) is dropped rather
  than emitted into `ui_screenshots[]`. Only a path that verifiably exists on
  disk at artifact-write time is reported as evidence.
- **`fix_context[]` assembly.** For each route whose captures produced an
  `ok:false` (a console error, a failed request, or a missing
  `expectSelectors` element) that survived the noise filter, add one
  `{route, consoleErrors, failedRequests, missingSelectors}` entry (plus
  `item` — the checklist item this route's evidence maps back to — when
  `MODE: visual-appearance` supplied an enumerated item list; omit `item`
  entirely for the default `/flow-verify` drive, which has no per-item
  checklist).
  `bin/lib/ui-driver-schema.ts` rejects an artifact that exceeds any of
  three independent caps: 10 entries total, 20 items per
  `consoleErrors`/`failedRequests`/`missingSelectors` array, and 300
  characters per string within those arrays. Apply the caps in this order
  so nothing is silently rejected downstream: truncate each individual
  string to 300 characters; then, if an inner array still has more than 20
  items, keep the first 20 and drop the rest (an item count cannot be
  "truncated" — only a string can); then, if you have more than 10 route
  entries, keep the 10 most actionable (routes with the most captures, or
  the earliest in `routes[]` on a tie) and drop the rest.

## 5. Write the artifact (last act)

Write `ARTIFACT_PATH` as the LAST act, after teardown, conforming to
`bin/lib/ui-driver-schema.ts`'s `UiDriverResult` shape:

```json
{
  "ran": true,
  "ok": true,
  "captures_path": "<CAPTURES_PATH, absolute>",
  "ui_screenshots": ["<absolute path>", "..."],
  "fix_context": [
    {
      "route": "/",
      "consoleErrors": [],
      "failedRequests": [],
      "missingSelectors": []
    }
  ],
  "rejected_alternatives": ["<what you tried and rolled back — 1 line each>"],
  "summary": "<3-5 sentence both-sides summary>"
}
```

On a degraded run (MCP absent, browser-profile busy, launch/login failure,
or every screenshot save path denied), set `ran`/`ok` to reflect the
degrade and set `skipped_reason` to the matching member of the schema's
union (`mcp-not-available`, `browser-profile-busy`, `app-launch-failed`,
`login-failed`, `screenshots-unwritable`) — never `driver-no-artifact`,
which is reserved for the CALLER to synthesize when this agent's artifact
never lands on disk at all (a timeout, a crash before step 5). Validate
before returning: `flow-ui-driver-schema --validate "$ARTIFACT_PATH"`
(exit 0 required).

Two invariants, matching the flow-fix-applier subagent:

- **Drive the browser inline. Never spawn a nested Task.** Your own
  isolated context is the isolation a nested spawn would provide.
- **You are one-shot.** Do not ask the user clarifying questions. Return a
  short both-sides summary; the artifact on disk is the durable record.

## 6. Return a brief summary

One short paragraph (3–5 sentences): which routes/viewports you drove, the
verdict, and at least one negative finding — a noise-filter addition you
made, a manifest adaptation you persisted, or a degrade you hit. Do not
paste the artifact JSON back.
