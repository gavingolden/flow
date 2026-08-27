# fixture repo (s1-step7-ci-wait)

Placeholder repo content — `flow-ci-check`'s decision matrix is a
metadata-only `gh pr view` / `gh pr checks` read; it never reads repo
files. No `.github/workflows/` directory is committed, so
`readWorkflowsDir()` resolves `ciConfigured: false` and the scenario never
needs `gh pr checks` at all — the phase advance fires unconditionally
before any CI observation, which is exactly the write under test.
