# Step 8c manual per-item run recipe

The fallback for Step 8c when `command -v flow-run-test-steps` fails (an
un-upgraded install), for runnable items outside `## Test Steps` (legacy
headings such as `Manual validation` / `How to test`, which the runner's parser
does not read), and for prose items promoted in 8c.ii.

## For each runnable item

1. Execute it exactly as written, capturing both stdout and stderr to a file.
   Run the item with no pipe and capture `$?` directly, so the recorded
   exit status is shell-agnostic — a piped `tee` capture would leave the
   exit code in a bash-only pipeline array that is empty under a zsh
   outer shell, silently ticking the box on a failing item:

   ```bash
   bash -c 'cmd' > .flow-tmp/evidence-<n>.txt 2>&1
   echo "$?" > .flow-tmp/exit-<n>
   ```

   Same discipline as Step 8 — a non-zero exit means investigate and fix the
   underlying issue, not explain it away.

2. If a fix is needed, make a **new commit** (do not amend the pushed commit per
   `AGENTS.md`) and `git push` before re-running.
3. On pass, the box gets ticked AND the captured output gets injected as a
   `<details>` evidence block immediately under the item — see the inject
   call below.

## Inject evidence under the item

Save the PR body to scratch first (the runner's `--pr` does this itself, so the
fetch is only needed on this manual path), then apply every item to the same
working copy:

```bash
mkdir -p .flow-tmp
gh pr view <number> --json body --jq '.body' > .flow-tmp/body.md

# For each runnable item, after running it:
flow-inject-evidence \
  --body-file .flow-tmp/body.md \
  --item '<regex matching the item line>' \
  --output-file .flow-tmp/evidence-<n>.txt \
  --exit-code "$(cat .flow-tmp/exit-<n>)"
```

Return to Step 8c.i in SKILL.md for the single write-back of the body once
every item has been processed.
