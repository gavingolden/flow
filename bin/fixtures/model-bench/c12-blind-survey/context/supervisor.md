# The supervisor

The supervisor is one long-running agent session that walks a feature through
fixed phases: triage, plan, implement, verify, review, merge. Between phases it
can run shell commands and read their output, and it hands the heavy reading
and drafting of each phase to a short-lived sub-agent that starts with no
memory of the session.

It keeps a small state file per feature (current phase, pull request number,
user answers). Every phase it enters is recorded there, so a crash or a
restarted session resumes from the last recorded phase.
