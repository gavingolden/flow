# fixture repo (s5-open-pr-implementing)

`pr.json` seeds one OPEN PR #7 on branch `eval` so `flow-open-pr`'s
`probePr` resolves it via the selector-less `gh pr view --json number,url`
call and takes the idempotent read-back path, never the fresh-create path.
`materializeFixture` configures no `origin` remote for this fixture, and
`bin/lib/eval-runner.ts`'s child-argv `--disallowedTools` list denies
`Bash(gh pr create:*)` for every scenario child, so the fresh-create branch
(`git ls-remote` + `git push -u origin HEAD` + `gh pr create`) is
unreachable inside an eval by design — see the plan's excluded-alternative
`gh-pr-create-fresh-path-scenario`.
