## Step 0 — Echo the originating request

Run `flow prompt` (bare — no slug argument; both launchers export `FLOW_SLUG`
into the session env, and `flow prompt` resolves it ambiently, exactly like
`flow-new-worktree` / `flow-resume-decide`). The resume seed is a fixed
literal (`Use the /flow-pipeline skill in --resume mode for: <slug>`) with
no slug-bearing prefix to parse, so the bare ambient call is the only form
that works on both a fresh launch and a resume re-entry. Document
`flow prompt <slug>` only as the form a user types in another terminal.

Extract the region from the FIRST `<!-- flow-request-echo:start -->` marker
to the LAST `<!-- flow-request-echo:end -->` marker in its stdout (not the
first end marker — a request body that itself quotes the end-marker string
would otherwise truncate the echo) and echo it VERBATIM as the session's
FIRST assistant output — prose, not a tool-call result, since Claude Code
truncates Bash tool output. Never paraphrase, reorder, truncate, or re-wrap
it.

Step 0 writes no state and is inert on control flow. On any non-zero exit
from `flow prompt`, emit one plain line noting the request could not be
read and continue straight to Step 1 — Step 0 never escalates. Step 1's
existing `NEEDS HUMAN: request-file-missing` escalation (below) stays the
sole authority for an actually-missing request.
