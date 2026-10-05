## TLDR

Adds a fixture change so the review tail has a body to run.

## Why

The review's verification items need a body with runnable, failing and subjective Test Steps.

## Test Steps

- [ ] Run `bash scripts/ok.sh` — prints ok.
- [ ] Run `test -f README.md && grep -aq fixture README.md` — the readme is the fixture's.
- [ ] Run `bash scripts/fail.sh` — exits 0.
- [ ] SUBJECTIVE: you approve the wording of this PR.
