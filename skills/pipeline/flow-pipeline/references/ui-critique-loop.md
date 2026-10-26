# UI critique loop (verify, once per pipeline)

The post-pass procedure `/flow-verify` runs after its own checks end clean, for a UI pull request whose Test Steps carry a look-and-feel (`SUBJECTIVE:`) sign-off. It photographs the page section by section, has one read-only critic judge the gallery, makes ONE fix round when the critic finds defects, keeps the round only when the page measurably improved, and writes a `## UI review` section into the PR body. Every mechanical decision is a `flow-ui-critique` subcommand; the critic is a `flow-claude-headless` Bash call per [headless-claude.md](headless-claude.md), not a Task-tool exemption. Section capture is described in [ui-smoke-pass.md](ui-smoke-pass.md) (`## Section capture (critique loop)`), and the smaller smell-only variant is its `## Smell-repair round`.

Every `flow-ui-critique` call is its own standalone Bash call with an absolute `--worktree "$WORKTREE"`. A call that prints `{"ran":false,"skipReason":…}` is a named skip, never an error: handle it as written below.

## Steps

**0. Re-entry.** Run `flow-ui-critique gate` (step 1). When it reports an `openRound`, a previous run died mid-round. Run `git revert --no-edit <preSha>..HEAD` when `HEAD` is not `<preSha>`, then `flow-ui-critique round-end --decision revert --reason resumed-mid-round --worktree "$WORKTREE"`, and go straight to step 6. A resumed loop never re-runs its round.

**1. Pre-drive gate.** Save the PR body (`gh pr view "$PR" --json body --jq .body > .flow-tmp/body.md`), or use `.flow-tmp/pr-description-draft.md` when no PR exists yet. Run `flow-ui-critique gate --body-file <that file> --worktree "$WORKTREE"`. With `run:true`, every UI-smoke `flow-ui-driver` spawn in this `/flow-verify` invocation carries `SECTIONS: on` (only the drive whose ASSEMBLE is clean actually captures). With `run:false`, do nothing more here; verify's smell-repair round may still run.

**2. Post-drive gate.** After the final clean drive, run the gate again with `--driver-result .flow-tmp/ui-driver-result.json`. On `run:false`:

- with a `SUBJECTIVE:` item present (the reason is anything but `no-subjective-item` or `already-ran`): `flow-ui-critique record --outcome skipped --reason "<detail>" --complete --worktree "$WORKTREE"`, render the stub at step 6, and hand back to verify's smell-repair round;
- with no `SUBJECTIVE:` item, or `already-ran`: hand back to the smell-repair round silently.

**3. Critique.** Copy the driver artifact to `.flow-tmp/ui-critique/round-0-driver.json` (the re-drive in step 5 saves its images under `ui-evidence/critique-after/`, so these round-0 images are never overwritten). Produce the ASSEMBLE output deterministically, with no browser (`flow-ui-validate --manifest .flow/ui-validation.json --captures .flow-tmp/ui-captures.json > .flow-tmp/ui-critique/round-0-findings.json`; the driver does not persist it). Run `flow-ui-critique critique --phase round-0 --driver-result .flow-tmp/ui-critique/round-0-driver.json --plan .flow-tmp/plan.md --smells .flow-tmp/ui-critique/round-0-findings.json --out .flow-tmp/ui-critique/critique-0.json --worktree "$WORKTREE"`.

The first matching bullet wins:

- `ran:false`: `record --outcome skipped --reason "<skipReason>" --complete`, render the stub at step 6, and hand back to verify's smell-repair round (the renderer turns the helper code into a plain reason). The call is spent either way — `critique` refuses a second call for the same phase, so the loop cannot be re-entered to buy another.
- Gate `mode: list-only` (the loop is demoted after repeated reverted rounds): `record --outcome list-only --reason "<demotion reason>" --complete --residual-file .flow-tmp/ui-critique/critique-0.json`, then step 6. This comes before the clean case so a clean demoted run still counts toward the five-PR probation.
- No `defect` or `major` finding: `record --outcome clean --reason "no defect or major finding" --complete --residual-file .flow-tmp/ui-critique/critique-0.json`, then step 6.

`critique` writes its own spend and omitted-section count into `log.json`; no step passes them by hand.

**4. Fix.** Save the baseline: `.flow-tmp/ui-findings.json` is `round-0-findings.json`. Run `flow-ui-critique round-begin --kind critique --worktree "$WORKTREE"` — the pre-round commit lands in `log.json` before any edit, and that is what makes a revert and a resumed loop safe. Then ONE `/flow-coder` edit-set (the existing Edit-Applier exemption), one entry per touched route, carrying the `defect` and `major` findings, the plan's `## Layout Intent`, the flow-ui-ux `rendered-critique.md`, `layout.md`, `visual-design.md` and `accessibility.md` paths (from `flow-module-status --skill-path flow-ui-ux --ref references/<name>.md`), and the instruction "fix the source; preserve the content — never delete text or hide a section to satisfy a finding".

**5. Judge the round.** One `MODE: sections` re-drive of `flow-ui-driver` (caller stays `verify`). Copy its artifact to `.flow-tmp/ui-critique/after-driver.json`, re-run the ASSEMBLE command into `.flow-tmp/ui-critique/after-findings.json`, then `flow-ui-validate --compare .flow-tmp/ui-critique/round-0-findings.json .flow-tmp/ui-critique/after-findings.json > .flow-tmp/ui-critique/compare.json`. When `regressed` is `false`, run `flow-ui-critique critique --phase post-round … --out .flow-tmp/ui-critique/critique-1.json` — a new headless child that sees only the after-gallery and nothing about what changed. Then `flow-ui-critique accept --compare .flow-tmp/ui-critique/compare.json --targeted .flow-tmp/ui-critique/critique-0.json --after .flow-tmp/ui-critique/critique-1.json --after-driver .flow-tmp/ui-critique/after-driver.json`. A `regressed` compare skips the post-round critique and runs `accept` without `--after` (its revert reason names the regression); otherwise a missing `--after`, because the post-round critique was skipped or failed, is a `revert`, and so is a targeted section absent from the after-gallery (`--after-driver`).

- `revert`: `git revert --no-edit <preSha>..HEAD` (history-preserving, safe after a push), then `flow-ui-critique round-end --decision revert --reason "<reason>" --residual-file .flow-tmp/ui-critique/critique-0.json`.
- `keep`: `flow-ui-critique round-end --decision keep --reason "<reason>" --residual-file .flow-tmp/ui-critique/critique-1.json`.

**6. Render.** Run `flow-ui-critique render --body-file .flow-tmp/body.md --push-copy .flow-tmp/body.push.md --worktree "$WORKTREE"`. With a PR: `flow-md-validate --fix-pr-body .flow-tmp/body.push.md`, then `gh pr edit "$PR" --body-file .flow-tmp/body.push.md` — the image-free copy; the review step uploads the gallery. Print one in-session line, `UI critique: <kept | reverted | clean | list-only | not run>, <n> residual defect(s) — see ## UI review`. Every path to this step has already marked the log completed (`record … --complete`, or `round-end`, which completes it), so a re-entry skips the loop.

## Bounds

- One round, ever; never a `NEEDS HUMAN`. It sits outside verify's 3-attempt defect cap and runs once per pipeline: a completed `log.json` makes every later gate say `already-ran`.
- Neither this loop nor the smell-repair round runs when `/flow-verify` was invoked with `UI_SMOKE_DRIVER: inline` (the Fix-Applier's review-time re-run): that caller is a sub-agent and cannot spawn the re-drive or `/flow-coder`.
- Any mid-loop `ran:false` reverts an open round, renders what exists with the skip named, and completes. The helper itself enforces the call bound: `critique` returns `already-ran` once the log is completed and `phase-already-critiqued` for a repeated phase, so two critic calls per pipeline is a property of the code, not only of this procedure. The loop never ticks, edits or answers a `SUBJECTIVE:` item, and never runs at `gated`.
- "After the loop ends clean" means "when this `/flow-verify` invocation ends clean": `/flow-verify` cannot tell it is on the supervisor's last outer attempt, so the `completed` flag is what keeps the loop to one run.
