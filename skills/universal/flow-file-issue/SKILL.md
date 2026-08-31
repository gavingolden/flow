---
name: flow-file-issue
description: >-
  File a GitHub issue by hand against the flow-value-rubric contract: walk
  the value-prop rubric with the user, draft a conforming body, preflight it
  with `flow-create-issue --dry-run`, then file. Use when the user says
  "file an issue", "open an issue", "create a github issue", or asks to
  track a finding on the tracker. Skip when the finding is already a
  candidate follow-up ticked in a plan.md — that path is filed by
  /flow-pipeline's Step 10 post-merge sweep, not by this skill.
---

# Goal

File a GitHub issue that carries a ranked, anchored justification instead
of an empty or unsubstantiated body. `flow-create-issue` rejects a
non-conforming body (exit 3) before it ever reaches `gh`, so this skill's
job is to get the body right on the first or second try, not to work
around the gate.

# When to Use

- The user asks to file, open, or create a GitHub issue for a defect,
  gap, or idea they want tracked.
- The user hands over a finding (a bug they hit, a dead link, a missing
  feature) and wants it on the tracker rather than just discussed.

# When NOT to Use

- A candidate follow-up already ticked in a plan.md's
  `# Candidate follow-up issues` section — `/flow-pipeline`'s Step 10
  post-merge sweep files that automatically; filing it again here would
  duplicate the issue.
- A finding discovered mid-review by `/flow-pr-review` — that path files
  through the fix-applier's deferral flow, not this skill.

# Process

1. **Draft the value-prop block with the user.** Ask what changed, who
   notices, and what the concrete failure or friction is. Do not invent an
   anchor — every non-`none` UX/Problem/Stability line and the Value rank
   need a real `[anchor: …]` (a `file:line`, a reproduced command, a PR/
   issue reference, a measured number, or the user's own quoted words). If
   the finding is genuinely a typo or a dead link, use the **Short form**
   below instead of the full block.

2. **Write the body to `.flow-tmp/`.** Never write into the installed
   skills tree — this skill only ever writes a scratch body file under the
   invoking worktree's `.flow-tmp/` directory and calls `flow-create-issue`
   by its bare PATH name (this skill runs in consumer worktrees where
   flow's own `bin/` does not exist, so it must never shell out to
   `bun bin/...` or import from `bin/lib`).

3. **Preflight with `--dry-run`.**

   ```bash
   flow-create-issue --title "<short subject>" \
     --body-file .flow-tmp/flow-file-issue-body.md --dry-run
   ```

   Exit `0` means the body conforms — the printed JSON's `.action` is
   `would-create` or `existing`. Exit `3` means the body was rejected;
   the JSON on stdout carries `.misses`, `.expected`, and
   `.shortFormExample` — repair the draft from those fields and retry
   rather than guessing.

4. **File it.** Once the dry run passes, re-run the same command without
   `--dry-run` (add `--label` as appropriate for the target repo's
   conventions). Report the resulting issue URL to the user.

# The value-prop rubric

<!-- flow-value-rubric:begin -->

**Value-prop block** — required before an item is ticked, filed, deferred, or verdicted DO / NEEDS-DECISION.

- **UX:** <who notices, what changes for them, how often / how much> `[anchor: …]` — or `none`
- **Problem:** <the concrete failure or friction this removes> `[anchor: …]` — or `none`
- **Stability/efficiency:** <crash / flake / cost / latency effect, with the reproduced or measured number> `[anchor: …]` — or `none`
- **Value rank:** `1`-`5` `[anchor: …]` — the highest rank whose condition is met: `5` data loss, security exposure, or a broken path with no workaround; `4` a user-visible failure with a workaround recurring on a named cadence; `3` a measured inefficiency with a number; `2` a single-instance annoyance or an unfired latent risk; `1` cosmetic
- **Complexity:** `Trivial` | `Small` | `Medium` | `Large` — <files touched, blast radius>
- **Risk:** `Low` | `Medium` | `High` — <review load, regression risk>
- **If never done:** <what breaks, stays broken, or keeps costing — or `nothing`>
- **Verdict:** `clears bar` | `below bar` — <the decisive line, and why it outweighs (or fails to outweigh) Complexity and Risk>

**Short form.** For a genuinely trivial item (a typo, a dead link), skip the full block and write one line instead: `**Short form:** [V:n|C:x|R:y] <one-line text> [anchor: …]`. The compact tuple keeps the item sortable — the short form drops the prose, never the rank.

**Anchor rule.** Every non-`none` UX / Problem / Stability line, and the Value rank, ends with `[anchor: …]` drawn from this closed list: a `file:line`; a reproduced behaviour (`command → observed output`); a command that fails today; a merged PR or commit; an issue number with its age; a measured number; the user's own words, quoted. A value line with no anchor is `unsubstantiated` and counts as `none`; a rank with no anchor is invalid — it cannot be falsified by opening it. Write file anchors bare (`[anchor: path/to/file.ts:42]`), never wrapped in backticks, so the lint can check the path exists.

**Bar.** `clears bar` requires at least one substantiated value line, a `Value rank` of `2` or higher, a one-line rationale that it outweighs Complexity and Risk, and a non-`nothing` If-never-done line. `Value rank: 2` is the normal clear-bar baseline, not a special case — most items that clear the bar clear it at `2`. Anything else — including unclear — is `below bar`.

**Banned phrasing.** `nicer`, `cleaner`, `could improve`, `might`, `best practice`, `would be good to`, `likely`. An anchor the reader cannot open or run in seconds is worse than `none` — never invent one.

<!-- flow-value-rubric:end -->

# Constraints

- Never write into `SKILL_DIR` or any other file under the installed
  skills tree — this skill's only writes are a scratch body file under
  the invoking worktree's `.flow-tmp/` and the `flow-create-issue` call
  itself.
- Never invoke flow's own `bin/` directly (`bun bin/...`) or import from
  `bin/lib` — this skill runs in consumer worktrees that do not have
  flow's `bin/` on disk. Call `flow-create-issue` by its bare PATH name
  only.
- Never add a bypass flag or otherwise skip the `--dry-run` preflight —
  the gate exists so a rejected body is caught before it reaches the
  tracker, not after.
