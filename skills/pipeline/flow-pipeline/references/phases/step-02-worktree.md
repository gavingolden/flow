## Step 2 — Worktree

**Phase:** `worktree-create`

First, advertise the phase before doing the work — `flow-new-worktree`
can take a couple of seconds, and the user shouldn't see a stale
`triaging` row in `flow ls` while git is working:

```bash
flow-state-update --phase worktree-create
```

Then create the worktree:

```bash
flow-new-worktree <slug>
```

The positional `<slug>` is belt-and-suspenders: `flow-new-worktree` reads
`$FLOW_SLUG` ambiently, so a bare call resolves the same value; a
positional that doesn't match `$FLOW_SLUG` is a hard error
(`slug-mismatch:`, exit 2), not a silent footgun (step 1's "never
re-derives the slug" contract).

Capture the absolute worktree path it prints. Set `$WORKTREE` to
this for the rest of the pipeline. **`cd` into the worktree** —
every subsequent step runs from there.

Now record the worktree path in state.json (the only step where
`--worktree` is set):

```bash
flow-state-update --phase worktree-create --worktree "$WORKTREE"
```

`flow feature create` reserved this folder and passed it to Claude as a
working directory, so `cd "$WORKTREE"` persists; `flow-new-worktree` creates
the worktree inside it.

**End condition:** the worktree directory exists, is on a fresh
branch, and `pwd` matches `$WORKTREE`.

On non-zero exit: escalate `NEEDS HUMAN: worktree-create-failed
<stderr>` and end.
