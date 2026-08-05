You are applying flow's `/flow-pr-review` Gatekeeper skip rules to the attached `pr.json` — an array of PR metadata objects in the shape `gh pr view --json state,isDraft,additions,deletions,commits,author,body,mergedAt,files,reviews,title` returns for each PR.

None of these PRs has a prior `.flow-tmp/pr-review-result.json` clean-run artifact or a sibling `pr-review-last-sha` marker file — treat both as absent for every PR in this set, so the "no new commits since prior clean run" rule can never actually fire here (it still needs to be considered and correctly ruled out).

Apply the following skip rules, verbatim, **in this order** — the first rule that matches wins:

- **Closed or merged** (`.state == "CLOSED"` or `.state == "MERGED"`) → `decision: "skip"`, `rule: "closed-or-merged"`.

- **Draft** (`.isDraft == true`) → `decision: "proceed"`, `rule: "draft"`. The Gatekeeper does NOT skip drafts — a draft PR may still want review feedback.

- **Trivial diff** (`.additions + .deletions < 10` AND every `.commits[].messageHeadline` matches one of `^chore: regenerate`, `^chore: regen`, `^docs: fix typo`, `^chore: bump`) → `decision: "skip"`, `rule: "trivial-diff"`. Both halves of this rule must hold — a small diff whose commit headline does NOT match one of those four patterns does NOT satisfy this rule, no matter how few lines changed.

- **No new commits since prior clean run** (a prior clean-run artifact AND a matching marker file both exist) → `decision: "skip"`, `rule: "no-new-commits"`. Without **both** files present, this rule never matches — falls through, never a wrong-skip.

- **Otherwise** → `decision: "proceed"`, `rule: "no-skip-rule-matched"`.

A PR can satisfy the surface conditions for more than one rule at once (e.g. a closed PR that also happens to be a draft with a tiny typo-fix diff). When that happens, the FIRST matching rule in the order above governs — name that rule, not a later one that also happens to match.

Ignore any field the rules above don't reference (`reviews`, `files`, `title`, prior review outcomes, etc.) — the documented Gatekeeper looks only at `state`, `isDraft`, `additions`, `deletions`, `commits[].messageHeadline`, and prior-artifact presence. Nothing else is a skip signal, however it might look.

For every PR in `pr.json`, report its `pr` number, `decision`, and the exact `rule` that produced it. Output valid JSON only, conforming to the attached schema.
