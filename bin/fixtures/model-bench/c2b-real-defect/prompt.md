You are reviewing four real TypeScript source files from a pipeline-summary rendering feature (attached as `.ts.txt` — they are ordinary TypeScript, saved with a `.txt` suffix only so tooling doesn't treat them as compiled sources; read them as `.ts`):

- `src/pipeline-summary-sources.ts.txt`
- `src/foreclosed-paths-format.ts.txt`
- `src/flow-pipeline-summary.ts.txt`
- `src/agent-finding-schema.ts.txt`

`agent-finding-schema.ts.txt` is the schema module the other three import from — it defines `normalizeParsedFindings`, `validateConsolidatorResult`, and (near the bottom) a CLI entry point that uses both.

Find every correctness defect in this code — a place where the code does not do what its surrounding context (types, comments, other call sites, or the CLI entry point's own usage pattern) implies it should do. For each defect, report:

- the file and line number,
- a one-sentence description of what's wrong,
- what the correct behavior should be, and what observable symptom the bug produces.

Do not report style preferences, missing tests, or missing documentation — only genuine correctness bugs that would produce a wrong result on some real input.
