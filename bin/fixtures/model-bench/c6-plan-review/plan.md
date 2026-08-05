# PRD

# Webhook Notifier for Pipeline Terminal States

**Goal:** Let a pipeline supervisor POST a JSON payload to a configured webhook URL when it reaches a terminal state, so remote integrations (Slack, PagerDuty, a status dashboard) learn a pipeline finished without polling `~/.flow/state/<slug>.json`.

## Problem Statement

`flow-notify` only reaches the local machine — it fires a macOS notification via `terminal-notifier`/`osascript`, which is useless for a headless CI runner or a teammate who isn't at that machine. Teams that want a Slack ping or a PagerDuty alert when a pipeline reaches MERGED, gated, or NEEDS HUMAN currently have to poll the state file themselves.

## Scope Boundary

**In scope:** one new helper `bin/flow-webhook-notify.ts`, a `webhookUrl` field in `~/.flow/config.json`, and call sites in `/flow-pipeline` step 10 (post-merge) and the gate-decision step.

**Out of scope:** retry-on-failure, a delivery-status dashboard, payload templating.

## Behavioral contrast

### System flow (before → after)

- **Before:** nothing — a remote integration must poll `~/.flow/state/<slug>.json` itself.
- **After:** `bin/flow-webhook-notify.ts` POSTs a JSON payload to the configured webhook URL at each terminal state.

**Lost:** none — additive.

## User Stories / Acceptance Criteria

### Story 1

- [ ] Given `webhookUrl` is configured and a pipeline reaches MERGED, when `/flow-pipeline` step 10 completes, then a POST fires with a `{status, slug, prUrl}` body — verified via `flow-webhook-notify --dry-run --status merged --slug demo --pr-url https://example.test/pr/1 | jq -e '.status == "merged"'`.

### Story 2

- [ ] Given no webhook is configured, the helper is a silent no-op — verified via `env -u FLOW_WEBHOOK_URL flow-webhook-notify --status merged --slug demo; echo $?` printing `0`.

### Story 3

- [ ] Given a slow or unreachable webhook endpoint, the report reads clearly enough that an on-call engineer understands what happened.

## Architecture Decisions

- **Layers touched:** `bin/lib/webhook-notify.ts` (payload contract), `bin/flow-webhook-notify.ts` (CLI), `bin/lib/config-schema.ts` (config field), `/flow-pipeline` step 10 + gate step (call sites).
- **Config resolution:** the `FLOW_WEBHOOK_URL` environment variable takes precedence over `webhookUrl` in `~/.flow/config.json` — the same env-override-first convention `flow-notify`'s `FLOW_NOTIFY` opt-in already uses, so an ad-hoc override never has to touch the shared config file.

## Technical Constraints

- **Never block the supervisor's terminal path on network I/O.** The webhook POST must be dispatched via a detached, fire-and-forget spawn — exactly the pattern `flow-notify.ts`'s header documents for its own backend calls (spawn errors are swallowed; the helper returns 0 even if the notification never lands). A synchronous `await` on the POST inside the supervisor's step-10 flow is out of bounds: a stalled or unreachable webhook endpoint must never delay the terminal recap the user is waiting on.
- Payload size stays under 4KB — no full diff or PR body embedded, only identifiers and a URL.

## Open Questions

- [ ] Should the helper retry on a failed delivery?
  - **Recommended:** no retry in v1 — matches the fire-and-forget precedent `flow-notify` already sets; a retry queue is a bigger scope than a terminal-state ping needs.

## Recommendation

**Proceed** — clear value for headless supervisors and remote teammates.

**Redundancy:** none found — `flow-notify` is local-only (darwin notification center); this is the network-reachable complement, not a duplicate.

## Plan risks

A malformed or unreachable `webhookUrl` fails silently (per the fire-and-forget constraint above), so a broken integration could go unnoticed for a while before someone checks the state file directly.

## Cut list

nothing — plan is already minimal.

# Task breakdown

Dependency table (task → the task(s) it depends on):

| Task | Depends on |
| --- | --- |
| Task 1: Define the webhook payload contract | — |
| Task 2: Implement the `flow-webhook-notify` CLI helper | Task 1 |
| Task 3: Add `webhookUrl` to the config schema | — |
| Task 4: Wire call sites in `/flow-pipeline` step 10 + gate step | Task 2 |

### Task 1: Define the webhook payload contract

- **Skill:** `bun-helper`
- **Description:** Define the `WebhookPayload` type and a pure `buildWebhookPayload()` builder that both the CLI helper and its tests import.
- **Inputs:** a terminal `status`, a `slug`, an optional `prUrl`.
- **Outputs:** a `WebhookPayload` object ready to `JSON.stringify` into the POST body.
- **Contract:**
  - **Files:** create `bin/lib/webhook-notify.ts`
  - **Interfaces:** export `buildWebhookPayload(status: string, slug: string, prUrl?: string): WebhookPayload`. Also calls `resolveWebhookUrl()` — exported by `bin/flow-webhook-notify.ts` (Task 2) — to decide whether to set the payload's `dryRun` flag, since a dry run with no resolvable URL should still report a payload for the caller to inspect.
  - **Call-site edits:** none
- **Acceptance criteria:** `npm run test -- bin/lib/webhook-notify.test.ts`

### Task 2: Implement the `flow-webhook-notify` CLI helper

- **Skill:** `bun-helper`
- **Description:** A CLI wrapper around `buildWebhookPayload()` that resolves the target URL (env override then config), and either prints the payload (`--dry-run`) or dispatches it via a detached spawn.
- **Inputs:** `--status`, `--slug`, `--pr-url` (optional), `--dry-run` (optional).
- **Outputs:** exit 0 always (fire-and-forget; see Technical Constraints).
- **Contract:**
  - **Files:** create `bin/flow-webhook-notify.ts`
  - **Interfaces:** export `resolveWebhookUrl(env, config): string | null`; import `buildWebhookPayload` from `bin/lib/webhook-notify.ts`.
  - **Call-site edits:** none
- **Acceptance criteria:** `npm run test -- bin/flow-webhook-notify.test.ts`

### Task 3: Add `webhookUrl` to the config schema

- **Skill:** `bun-helper`
- **Description:** Add an optional `webhookUrl` string field to the config schema so `flow config` validates it like every other field. This task is independent of Task 2 — the CLI helper reads `webhookUrl` directly from the parsed config JSON at runtime rather than importing a shared type from this file, so the two can land in either order.
- **Inputs:** none
- **Outputs:** a validated optional field
- **Contract:**
  - **Files:** modify `bin/lib/config-schema.ts`
  - **Interfaces:** add `webhookUrl?: string` to the `FlowConfig` type
  - **Call-site edits:** none
- **Acceptance criteria:** `npm run test -- bin/lib/config-schema.test.ts`

### Task 4: Wire call sites in `/flow-pipeline` step 10 + gate step

- **Skill:** `pipeline-md`
- **Description:** Fire the webhook at each terminal state alongside the existing `flow-notify` call.
- **Inputs:** the resolved `status`/`slug`/`prUrl` step 10 and the gate step already compute.
- **Outputs:** a webhook fired at MERGED, gated, and NEEDS HUMAN.
- **Contract:**
  - **Files:** modify `skills/pipeline/flow-pipeline/SKILL.md`
  - **Interfaces:** none new
  - **Call-site edits:** in `/flow-pipeline` step 10, `await flowWebhookNotify(status, slug, prUrl)` synchronously right before printing the terminal recap, so the recap line can report whether delivery succeeded before the session ends.
- **Acceptance criteria:** `npm run verify`
