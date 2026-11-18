import { describe, expect, it } from "vitest";
import { unboundedPollLoop, unboundedWatch } from "./poll-loop";

const INCIDENT = `until [ "$(jq -r .phase ~/.flow/state/vitest5-vite-upgrade.json)" = merged ] && tmux capture-pane -p | grep done ; do sleep 20; done`;

describe("unboundedPollLoop — refused", () => {
  it.each([
    ["the incident command", INCIDENT],
    ["a bare while true", "while true; do sleep 1; done"],
    [
      "a dev-server readiness loop",
      "until curl -sf localhost:3000; do sleep 2; done",
    ],
    [
      "a condition-only numeric compare on a substitution",
      'while [ "$(pgrep -c node)" -gt 0 ]; do sleep 5; done',
    ],
    ["a C-style for with an empty condition", "for ((;;)); do sleep 20; done"],
    ["a bash -c wrapped poll", "bash -c 'until test -f x; do sleep 20; done'"],
    [
      "a perl select sleep",
      "until test -f x; do perl -e 'select(undef,undef,undef,5)'; done",
    ],
    ["a /bin/sleep poll", "while ! test -f x; do /bin/sleep 3; done"],
    [
      "a loop in a heredoc fed to bash",
      "bash <<'EOF'\nuntil [ -f x ]; do sleep 20; done\nEOF",
    ],
    [
      "a jq-substituted phase poll with no deadline",
      'until [ "$(jq -r .phase f)" = merged ]; do sleep 20; done',
    ],
    [
      "an over-cap SECONDS deadline",
      "end=$((SECONDS+864000)); until test -f x; do [ $SECONDS -lt $end ] || exit 3; sleep 5; done",
    ],
    [
      "an over-cap seq loop",
      "for i in $(seq 1 5000); do test -f x && break; sleep 10; done",
    ],
    [
      "an over-cap timeout wrapper",
      "timeout 999999 bash -c 'until test -f x; do sleep 5; done'",
    ],
    [
      "a counter compared only in the body with no exit",
      "until test -f x; do n=$((n+1)); sleep 5; done",
    ],
    ["a poll after an && chain", "cd x && until test -f y; do sleep 1; done"],
  ])("should refuse %s", (_n, cmd) => {
    expect(unboundedPollLoop(cmd)).toBe(true);
  });
});

describe("unboundedPollLoop — allowed", () => {
  it.each([
    [
      "the SECONDS deadline one-liner",
      "end=$((SECONDS+600)); until test -f x; do [ $SECONDS -lt $end ] || exit 3; sleep 5; done",
    ],
    [
      "a date +%s deadline",
      "end=$(( $(date +%s) + 300 )); while [ $(date +%s) -lt $end ]; do test -f x && break; sleep 2; done",
    ],
    [
      "a condition counter with no break",
      "n=0; until [ $n -ge 5 ]; do n=$((n+1)); sleep 2; done",
    ],
    [
      "a body counter paired with break",
      "n=0; until test -f x; do n=$((n+1)); [ $n -ge 30 ] && break; sleep 2; done",
    ],
    [
      "a (( )) counter paired with exit",
      "i=0; while true; do (( i++ )); (( i > 20 )) && exit 1; sleep 1; done",
    ],
    [
      "a seq loop within the cap",
      "for i in $(seq 1 30); do test -f x && break; sleep 2; done",
    ],
    ["a brace loop", "for i in {1..10}; do sleep 1; done"],
    ["a C-style bounded for", "for ((i=0;i<10;i++)); do sleep 1; done"],
    [
      "flow-ci-wait in the loop",
      "until flow-ci-wait 412 --max-sec 60; do sleep 1; done",
    ],
    ["flow-wait", "flow-wait --max-sec 600 --state foo --phase merged"],
    [
      "timeout wrapping bash -c",
      "timeout 600 bash -c 'until test -f x; do sleep 5; done'",
    ],
    [
      "a piped while read",
      "git branch | while read -r b; do echo $b; sleep 1; done",
    ],
    [
      "a redirected while read",
      "while read -r l; do echo $l; sleep 1; done < list.txt",
    ],
    ["a loop with no sleep", "while read l; do echo $l; done < f"],
    ["quoted loop text", `echo "until x; do sleep 1; done"`],
    [
      "a date +%s deadline inside double-quoted substitutions",
      'end=$(( $(date +%s) + 300 )); while [ "$(date +%s)" -lt "$target" ] && [ "$(date +%s)" -lt "$end" ]; do sleep 10; done',
    ],
    [
      "a kill -0 loop with a date +%s deadline",
      'P=$(cat t2.pid); end=$(( $(date +%s) + 420 )); while kill -0 "$P" 2>/dev/null && [ "$(date +%s)" -lt "$end" ]; do sleep 15; done',
    ],
    [
      "an until loop with an in-body date +%s deadline exit",
      'end=$(( $(date +%s) + 1500 )); until [ -s "$W/.flow-tmp/scout.md" ]; do [ "$(date +%s)" -ge "$end" ] && { echo deadline; exit 1; }; sleep 10; done',
    ],
    [
      "a loop written to a file by a cat heredoc",
      "cat > x.sh <<'EOF'\nwhile true; do sleep 20; done\nEOF",
    ],
    ["a finite for-in list with sleep", "for f in a b c; do sleep 1; done"],
  ])("should allow %s", (_n, cmd) => {
    expect(unboundedPollLoop(cmd)).toBe(false);
  });
});

describe("unboundedWatch", () => {
  it.each([
    "gh pr checks 412 --watch",
    "gh pr checks 412 --interval 10 --watch",
    "gh pr checks --watch",
    "gh run watch",
    "gh run watch 12345",
    "tail -f log.txt",
    "tail -F log.txt",
    "tail -n 20 -f log.txt",
    "timeout 999999 gh pr checks --watch",
  ])("should refuse %s", (cmd) => {
    expect(unboundedWatch(cmd)).toBe(true);
  });

  it.each([
    "timeout 600 gh pr checks --watch",
    "gtimeout 600 tail -f log.txt",
    "flow-wait --max-sec 60 -- tail -f x",
    "gh pr checks 412",
    "gh pr view 412 --json state",
    "tail -n 20 log.txt",
    `echo "gh pr checks --watch"`,
  ])("should allow %s", (cmd) => {
    expect(unboundedWatch(cmd)).toBe(false);
  });
});
