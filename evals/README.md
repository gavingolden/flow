# Eval harness

`flow eval` runs a small fixed set of fixture features through Claude Code
twice — once with the live skill frontmatter (`pr7` config) and once
with `model:` / `effort:` keys stripped (`defaults` config) — to check
whether the per-skill model + effort tuning shipped in PR 7 actually
beats Claude Code's defaults.

```sh
flow eval                                     # full suite, both configs
flow eval --fixture 01-add-version-flag       # single fixture
flow eval --config pr7                        # one-sided
flow eval --keep-tmpdir                       # leave scratch repos for inspection
```

The command exits non-zero when `pr7` regresses (passes ≥ 2 fewer
fixtures than `defaults`). Per-run artefacts land under
`evals/.runs/<timestamp>/<config>/<fixture>/` and are gitignored.

## Adding a fixture

Drop a directory under `evals/fixtures/<NN>-<short-slug>/` with these
four files:

```
evals/fixtures/06-my-new-fixture/
  prompt.md          # the seed input (passed to claude -p)
  rubric.yml         # hard checks + soft criteria
  seed/              # files copied to the scratch repo as starting state
    package.json
    src/...
  reference.diff     # human-readable example output (not used for grading)
```

`flow eval` picks up new fixture directories automatically — no code
changes required.

### `prompt.md`

The full instruction passed to Claude Code in the scratch repo. Keep it
realistic — the more it looks like a real `flow new` description, the
more meaningful the eval. The implementor invokes `/new-feature` against
this prompt, so phrase it in user terms:

```
/new-feature add a `--version` flag to bin/cli.ts that prints the version
from package.json and exits 0
```

### `rubric.yml`

Two top-level sections; either may be empty (but at least one check must
exist).

```yaml
hard:
  must_pass:
    - "npm test"
    - "tsc --noEmit"
  must_create:
    - "bin/cli.ts"
  must_not_modify:
    - "package.json"
soft:
  - "Tests cover the new flag's parsing logic, not just its presence."
  - "Help text mentions --version with a one-line description."
  - "No new dependencies were added."
```

- **`hard.must_pass`** — shell commands run from the scratch repo root
  after the implementor commits. Each must exit 0.
- **`hard.must_create`** — file globs that must exist post-run. Empty by
  default.
- **`hard.must_not_modify`** — globs the implementation must not touch
  (compared against the diff). Empty by default.
- **`soft`** — list of YES/NO judgment questions. The judge (Claude Opus
  4.7 at xhigh effort) reads the prompt + final diff and scores each
  criterion. Pass = every soft criterion judged YES.

Pass = every hard check passes AND every soft criterion is YES.

### `seed/`

The starting state copied into a fresh `mktemp`-rooted scratch repo
before `claude -p` runs. Keep it small — a few files, no `node_modules`.
The runner runs `git init` and makes a baseline commit before invoking
the implementor.

If a fixture's hard checks need `npm install`, add an explicit
`hard.must_pass: ["npm install --silent && npm test"]` step rather than
auto-installing. That keeps the runner generic.

### `reference.diff`

A human-readable example of an acceptable output diff. **Not** used for
grading — the rubric does that. It exists as documentation: a future
contributor sees what "an acceptable solution" looks like without
re-running the eval.

Generate it once with a known-good run:

```sh
flow eval --fixture 06-my-new-fixture --config pr7 --keep-tmpdir
diff -u evals/fixtures/06-my-new-fixture/seed evals/.runs/<ts>/pr7/06-my-new-fixture/repo > \
  evals/fixtures/06-my-new-fixture/reference.diff
```

## How a run works

For each (fixture × config) pair, `flow eval`:

1. Copies `seed/` to `evals/.runs/<timestamp>/<config>/<fixture>/repo/`.
2. `git init`s and makes a baseline commit so subsequent diffs are clean.
3. Materialises a `.claude/skills/` symlink set:
   - `pr7` → live `skills/pipeline/{flow-pipeline,product-planning,
     new-feature,verify,pr-review}/`.
   - `defaults` → a per-run tmpdir mirror with `model:` and `effort:`
     stripped from each `SKILL.md` frontmatter.
4. Runs `claude -p "<prompt>" --output-format stream-json
   --include-partial-messages` from the repo root. Stdout is captured to
   `implementor.jsonl`.
5. Diffs the post-run repo against the baseline commit, writes
   `final.diff`.
6. Runs `hard.must_pass` shell commands; checks `must_create` /
   `must_not_modify` globs against the diff; writes `hard.json`.
7. Invokes the judge (`claude --model claude-opus-4-7 --effort xhigh`)
   with the prompt + final diff + `soft` list; writes
   `judge.jsonl` plus a parsed `soft.json`.
8. Aggregates pass/fail + cost into the per-run summary.

## Why the artefacts stick around

Run output isn't deleted by default — keeping it makes regressions
debuggable. The `.runs/` directory is gitignored. Use `--keep-tmpdir`
when you also want to keep the scratch repo for manual inspection;
otherwise the scratch repo is left in place but `flow eval` will not
re-use it.
