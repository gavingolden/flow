# fixture repo (s6-no-new-commits-skip)

Placeholder repo content — the Gatekeeper Subagent's Step 1.5 procedure is a
metadata-only `gh pr view` call and never reads repo files (other than the
`.flow-tmp/pr-review-result.json` + `.flow-tmp/pr-review-last-sha` marker
this scenario's "no new commits" rule specifically checks).
