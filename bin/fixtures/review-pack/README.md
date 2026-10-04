# review-pack fixtures

Inputs for `bin/lib/review-pack.test.ts`.

- `skill/references/agent-prompts.md` — trimmed template: shared block with every `{{...}}` variable, the seven lens sections, and the `## Gemini Cross-Model Lens` terminator.
- `skill/references/conventional-comments.md`, `skill/references/checklists/<lens>.md` — one-line stand-ins appended to each brief.
- `inputs/` — copied by the test to `<tmp>/.flow-tmp/`: `pr-review-fetch.md`, `pr-commits.md`, `intent-comments.md`, `diff.txt`, `static-analysis.json`, `review-scope.json` (supply-chain gated off, product brief found).
