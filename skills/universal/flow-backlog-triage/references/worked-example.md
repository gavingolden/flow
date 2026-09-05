# Worked example

A small, fabricated-but-realistic example: six items — a mix of GitHub
issue numbers and notes refs — walked through all four phases.

**Source items (Phase 0 inventory):**

- `#412` (GitHub issue) — "Session drops randomly after ~10 min idle."
- `#420` (GitHub issue) — "Add dark-mode toggle to settings page."
- `#431` (GitHub issue) — "Nightly Terraform drift check is red."
- `H3` (note) — "Prod smoketest against `/api/health` failing every run."
- `H7` (note) — "Status chips on the dashboard are confusing — remove
  them."
- `M2` (note) — "Status chips should get their own dedicated column, not
  be inline."

`Inventory: 3 issues, 3 notes` — 6 items total, so the final disposition
table must carry exactly 6 rows.

## Phase 1 — Verify

- `#412`: verified against `bin/lib/session.ts` — the session-refresh
  timer clears on tab-blur but the auth-race code path it was meant to
  fix (PR #519) only handles the desktop-focus case. **CONFIRMED** —
  reproducible, cite `bin/lib/session.ts:88` (stale-session auth race).
  The earlier draft had called this "likely fixed by #519 — verify and
  close"; verification proved that guess wrong.
- `#420`: found already shipped in `git log` — **ALREADY DONE**, closed
  by PR #533 (`Add dark-mode toggle`, merged), evidence comment cites
  `settings/theme.ts` and PR #533.
- `#431` and `H3`: **ROOT CAUSE LINK** — `gh run list` shows both the
  nightly Terraform-drift check and the prod smoketest failing starting
  the same day; `git log` shows a secrets-rotation commit landed that
  morning with an incomplete rollout. Both trace to one missing set of
  rotated secrets in the deploy environment — one fix (restore the
  secrets) closes both. Priority reordered up accordingly.
- `H7` / `M2`: **CONFLICT** — one note asks to remove the status chips,
  the other asks to give them a dedicated column. Surfaced as a single
  decision point (see Phase 2 below), not silently picked.
- A hypothetical `#433` ("deploy runbook still names the pre-rotation
  secret names") is not part of the six-item inventory above — like
  `#399` in Phase 4, it is introduced later, at Phase 3, purely to
  illustrate chunking. **CONFIRMED** against the deploy runbook file.
  It is treated as inventoried for root-cause-leverage purposes only —
  the tie-break a rider's ref can decide per Chunking above — without
  adding a seventh row to the six-item inventory table.

## Phase 2 — Adjudicate

- `#412` — class: bug. Verdict: **DO** — a real, currently-reproducible
  session-drop is clear user value (a real user notices and is logged
  out); the fix is proportionate (session-refresh timer scope).
- `#420` — verdict: **ALREADY DONE**, closes automatically with evidence
  (see Phase 4).
- `#431` + `H3` — class: hardening (root-cause link). Verdict: **DO** —
  a red CI/smoketest signal is system value (reliability); one bundle
  fixes both signals.
- `H7` / `M2` — **CONFLICT, escalation question:** "Remove the status
  chips (H7) or give them a dedicated column (M2)?" Recommendation: give
  them a dedicated column (M2) — the chips carry real state a user
  scans for, removing them (H7) loses that signal entirely; a dedicated
  column keeps the information without the current inline crowding H7
  is actually complaining about.
- Rider `#433` — verdict: **DO** — small, correctness-adjacent docs fix
  (the runbook still names pre-rotation secrets) riding on Bundle B's
  surface; too small to earn its own bundle-sized review.
- A seventh, illustrative note not in the six above — "revisit the retry
  backoff constants" — is **DO-LATER**, with a concrete promotion
  trigger: "revisit when the next incident review touches the retry
  path." Without that trigger it would default to REJECT per the
  grooming-mode fundamentals rule.

## Phase 3 — Bundle

- **Bundle A** (Small, opus/low): `#412` alone — one file, one function,
  low risk.
- **Bundle B** (Medium, opus/high): `#431` + `H3` together — same root
  cause (the rotated secrets), same fix, one reviewable PR restoring the
  secrets and re-verifying both signals go green.
- `#420` needs no bundle — it closes on evidence, not a PR.
- **Rider** `#433` — same surface as Bundle B (the deploy environment);
  its own Small docs PR, sequenced after B.
- The `H7`/`M2` conflict is NOT bundled into anything until the user
  answers the escalation question — bundling ahead of a NEEDS-DECISION
  would smuggle a judgment call into a DO bundle.

**Chunking + ranking (`top: 1`)**: chunk #1 = Bundle B + rider #433
(Value rank 4, closes 3 refs); Bundle A is next-chunk candidate #2
(Value rank 4, closes 1 ref) — decided on root-cause leverage.

## Phase 4 — Act

- `#420` — **evidence-based closure, automated**:

  ```
  gh issue close 420 --comment "Already shipped — dark-mode toggle landed in PR #533 (settings/theme.ts). Verified live."
  ```

- A hypothetical `#399` ("dashboard export button") verified as
  low-value and solved differently already — **REJECT, staged, not
  auto-closed**:

  ```
  gh issue close 399 --comment 'closing as won'\''t-do — the CSV export in #533 already covers this use case, and a second dedicated export button adds a maintenance surface for no incremental user value.'
  ```

  This comment is a ready-to-run command the kill list shows verbatim;
  the skill never runs it — the user running it themselves is the
  confirmation. `Verdict: below bar — the CSV export in #533 already
covers this use case; a second export button adds maintenance surface
for no incremental user value.`

- Bundle B (`#431` + `H3`) is a DO bundle with no fire-time parameter —
  queued directly:

  ```
  flow feature create --tmux --model opus --effort high --slug restore-deploy-secrets 'implement bundle issue #440 — restore rotated deploy secrets (fixes #431, H3)'
  ```

- A hypothetical Bundle C — "add a configurable retention window for
  audit logs" — is a DO bundle whose retention value is a fire-time
  decision parameter the user must supply, shown with the
  `<value required>` placeholder:

  ```
  flow feature create --tmux --model opus --effort low --slug audit-log-retention 'implement bundle issue #441 — configurable audit-log retention window (default retention: <value required>)'
  ```

  Bundle C is introduced here solely to illustrate the fire-time
  `<value required>` placeholder — like `#399` above, it sits outside
  the six-item inventory and the ranked chunk set below, so it does not
  appear in `Shown` or the Next-chunk candidates ledger.

## Verbatim note attachment

`H3` came from the adhoc notes file, so Phase 0 also captured it
byte-for-byte into `.flow-tmp/triage/source-notes-verbatim.md`:

```
<!-- flow-verbatim-refs: H3, H7, M2 -->
<!-- flow-verbatim-source: notes/backlog-dump.md -->

**H3** — adhoc notes, high priority

> Prod smoketest against /api/health failing every run, not sure if
> its the health endpoint itself or something upstream
```

Once Bundle B's work is filed as issue `#440` (see Phase 4 above), Phase
4's attach step maps `H3` onto it in
`.flow-tmp/triage/verbatim-map.json`:

```json
{
  "version": 1,
  "sourceOfTruth": "notes/backlog-dump.md",
  "preamble": { "triageDates": "the 2026-08-07 triage" },
  "attachments": [
    {
      "issue": 440,
      "refs": [{ "ref": "H3", "label": "adhoc notes, high priority" }]
    }
  ],
  "unattached": []
}
```

The parent session then runs the helper by its bare PATH name:

```
flow-verbatim-notes attach --verbatim-file .flow-tmp/triage/source-notes-verbatim.md --map-file .flow-tmp/triage/verbatim-map.json
```

The run's JSON envelope drives the document's report section:

### Verbatim note attachment

| Issue | Refs attached | Result  |
| ----- | ------------- | ------- |
| 440   | H3            | created |

**Refs on no issue:** none.

And the end-of-run chat summary gains one line:

```
Verbatim notes: 1 issue (1 created, 0 updated), 0 skipped, 0 refs on no issue.
```

`H7` and `M2` stay out of this run's map entirely — the conflict between
them is still an open Decision Brief question, and neither has a
GitHub issue to attach to yet.

## Decision Brief excerpt

The same run's Decision Brief renders the top-ranked chunk as an
outcome-first card, cut to `top: 1`, rather than restating the Phase 3
bundle mechanics above:

**Shown:** top 1 of 2 DO chunks (1 next-chunk candidate in the Audit
Appendix)
**Ranking bias:** grooming mode — observed failures rank ahead of
absent features; name a milestone for feature-led chunks

### #1

- **Outcome:** The nightly deploy-health checks go green again and
  stay green.
- **What changes / who notices:** No one directly — this is a
  reliability fix. The team stops getting paged for a false-positive
  drift alert and a failing smoketest that were actually the same
  root cause.
- **Why it's worth it:**
  - **UX:** none
  - **Problem:** the deploy environment's secrets rotation landed with
    an incomplete rollout, breaking both the nightly Terraform-drift
    check and the prod smoketest [anchor: gh run list → both nightly
    checks red since the rotation commit]
  - **Stability/efficiency:** two red CI/deploy-health signals every
    night, collapsing to one root cause [anchor: gh run list → both
    nightly checks red since the rotation commit]
  - **Value rank:** 4 [anchor: gh run list → both nightly checks red
    since the rotation commit]
  - **Complexity:** Medium — one bundle restoring the rotated secrets,
    re-verifying both signals go green
  - **Risk:** Low — a contained, reviewable fix with an obvious
    rollback (re-apply the prior secret values)
  - **If never done:** both signals stay red indefinitely and the team
    keeps getting paged for what looks like two unrelated incidents
  - **Verdict:** clears bar — two red signals every night erodes trust
    in CI faster than one; restoring the rotated secrets closes both
    at once
- **Refs:** #431, H3
- **Riders:** #433 — deploy runbook still names the pre-rotation
  secret names
- **Why it beat the next one down:** root-cause leverage — closes
  #431, H3, #433 vs one ref for the session-drop fix [anchor: the ref
  list itself — #431, H3, #433 vs #412]
- **In-chunk PR order:** restore secrets → runbook update
- **File-overlap warnings:** none
- **Tier:** Fix now (active problems)
- **Size:** M

Launch queue (Fix now tier):

```
flow feature create --tmux --model opus --effort high --slug restore-deploy-secrets 'implement bundle issue #440 — restore rotated deploy secrets (fixes #431, H3)'
flow feature create --tmux --model opus --effort low --slug deploy-runbook-secret-names 'implement bundle issue #433 — update deploy runbook to drop pre-rotation secret names (rider on #440)'
```

## Next-chunk candidates excerpt

| Rank | Ref(s) | Bundle issue | Verdict | Why it missed the cut                                                 |
| ---- | ------ | ------------ | ------- | --------------------------------------------------------------------- |
| 2    | #412   | —            | DO      | Value rank 4 ties chunk #1; loses on root-cause leverage (1 ref vs 3) |

Re-run after acting on chunk #1 to surface it.

## What this example demonstrates

- **ALREADY DONE closure** — `#420`, verified against PR #533 and
  `settings/theme.ts`, evidence comment drafted and auto-closed.
- **REJECT with drafted won't-do comment, staged not closed** —
  hypothetical `#399`, its `gh issue close --comment "closing as
won't-do — ..."` command shown verbatim, never run by the skill.
- **CONFLICT escalation** — `H7` vs `M2`, surfaced as one numbered
  decision point with a recommendation (dedicated column) rather than
  silently picked.
- **ROOT CAUSE link** — `#431` + `H3`, two separately-filed red signals
  collapsed into one bundle and one fix, reordering priority.
- **Fire-time decision parameter** — hypothetical Bundle C, queued as DO
  with an explicit `<value required>` placeholder rather than silently
  assuming a default retention window.
- **Outcome-first bundle cards** — the Decision Brief excerpt above
  renders the one shown chunk by user-facing outcome rather than
  mechanism, and keeps the jargon ban in the card prose itself: no
  issue mechanics outside the value-prop block's `[anchor: …]` tails,
  the card's `**Refs:**` line, and the rider's ref prefix — the
  sanctioned checkable exceptions.
- **Chunk with a rider** — chunk #1 is Bundle B (`#431` + `H3`) plus
  rider `#433`, which shares Bundle B's surface (the deploy
  environment) but never inflates the chunk's Value rank.
- **Top-n cut with the beat-the-next line** — `top: 1` shows only chunk
  #1; the card states which key beat the next chunk down (root-cause
  leverage: 3 refs closed vs 1), so the ranking stays falsifiable from
  the card alone.
- **Next-chunk candidates ledger** — Bundle A (`#412`), which ties chunk
  #1 on Value rank and loses on root-cause leverage, lands in the
  `## Next-chunk candidates excerpt` above rather than getting its own
  card.
- **Verbatim note attachment** — `H3`'s adhoc note, captured
  byte-for-byte at Phase 0, is posted onto its bundle issue (`#440`) at
  Phase 4 via `flow-verbatim-notes attach`, and the run reports it
  `created` in the `### Verbatim note attachment` section and the chat
  tally.
