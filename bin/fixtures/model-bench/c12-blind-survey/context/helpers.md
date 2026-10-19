# Helper scripts

The repository ships small command-line helpers that the supervisor runs
directly through its shell tool. Each helper does one job, reads its inputs
from flags, writes a result file, and prints one line of JSON. Examples:

- a research runner: takes the question and an output path, runs the web search
  and writes the findings plus a small status file;
- a plan linter: reads the plan file and exits non-zero when a required section
  is missing;
- a note writer: reads the status file and adds a visible note to the plan when
  the research step was skipped.

Helpers are plain scripts with their own tests.
