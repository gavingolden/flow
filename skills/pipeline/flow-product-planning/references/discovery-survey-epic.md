# Discovery survey and epic procedure (read only for `SURVEY:` runs or epic-member features)

## Step 1.8: blind-survey weighing

**When the gate fires:**

1. Read the file at the marker's absolute path with the `Read` tool. NEVER `import
bin/lib/*` — discovery runs in the consumer worktree, where flow's own source tree
   does not exist (the same constraint step 1.5's research note relies on).
2. For each judge that ran, weigh its `### 2. Recommended method` against the user's own
   proposed method, grounded in cited codebase evidence (the same evidentiary bar the
   rest of this document holds discovery to elsewhere) — not a vibe comparison.
3. Decide the verdict using these definitions: `converge-against` = both judges
   ran AND both top recommendations are materially different from the user's method (they
   need not agree with each other); `converge-with` = both materially the user's method;
   `split` = anything else, including a single-judge run. A single-judge run can therefore
   never yield `converge-against` — there is no second independent judgment to converge
   against the user's method with.
4. Author `## Method selection` per the step-5 section list in discovery-instructions.md. Each judge line opens
   with that judge's top recommendation quoted VERBATIM — its first sentence, in double
   quotes — before any paraphrase, so the user can audit the verdict both at the
   `pause-for-method` checkpoint (any intent, `converge-against`) and later at plan
   review (every other verdict). A skipped judge writes `skipped: <reason>` instead and
   contributes nothing to the verdict.

## Step 5: Method selection section shape

- **Method selection** (omit-when-no-`SURVEY:`-marker) — only when step 1.8's blind
  method survey ran: five bullet lines plus a table — `- **User's method:**`, `- **Judge A (<model>):** "<its
top recommendation's first sentence, verbatim>" — <paraphrase>` (a skipped judge writes
  `- **Judge A (<model>):** skipped: <reason>`), `- **Judge B (<model>):** …` (same shape),
  `- **Survey verdict:** <converge-against | split | converge-with>` (bare, exact, one
  line — the same machine-parsed contract `- **Recommended path:**` uses), `- **Chosen
method:** <one line> — <why>` — followed by a `| Before (user's method as asked) | After
(chosen method) |` table. See step 1.8 for how the verdict is decided. Omit the heading
  entirely when the marker was absent from the invocation.

## Step 5: Epic context sub-section

### Epic context

Populated only when step 1.7 detects epic membership (omit-when-empty — same
never-an-empty-heading discipline as the sections in the discovery-instructions.md step-5 section list). Names: the epic slug, this
feature's id and its rationale within the epic, its `dependsOn` edges (naming the
produced/consumed artifact for each), and its downstream dependents whose consumed
interfaces must stay stable.

A required `**Manifest write-back:**` line follows — `none` when this run changes no
edge, otherwise every edge to add or remove, each naming its produced/consumed or
shared artifact. A non-`none` value MUST appear as a task in `# Task breakdown` that
edits `.flow/epics/<slug>/manifest.json` — the write-back lands in THIS PR (same-PR
obligation), never a later amend. A standalone producer adds itself to
`sharedArtifacts` and an edge against the previous producer only; a discovered-invalid
edge is removed the same way. `flow-epic-dag --touched-files` in the fix-applier's
epic step fails a PR that touches a declared shared artifact unless the PR's own
feature is among its declared producers (a non-epic PR passes only when the
manifest is in the same diff).

**Source-traceability rule:** every claim here MUST be
traceable to `design.md` and `manifest.json` — read both on detection (step 1.7); never
infer epic context from the slug or the pointer sentence alone.
