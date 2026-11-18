import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  backgroundsEndlessLoop,
  decide,
  usesJobsPSubstitution,
} from "./flow-bg-loop-guard";

const bash = (command: string) => ({
  tool_name: "Bash",
  tool_input: { command },
});

describe("decide — denied", () => {
  it.each([
    [
      "the incident command verbatim",
      "(for i in 1 2; do (while :; do :; done) & done; sleep 1; kill $(jobs -p))",
    ],
    [
      "a bounded for loop backgrounded in ( … ) cleaned up with kill $(jobs -p)",
      "(for i in {1..999999}; do :; done & sleep 1; kill $(jobs -p))",
    ],
    ["top-level sleep & then kill $(jobs -p)", "sleep 1 & kill $(jobs -p)"],
    ["backtick jobs -p", "sleep 1 & kill `jobs -p`"],
    ["jobs -p inside double quotes", 'sleep 1 & kill "$(jobs -p)"'],
    ["while true backgrounded", "while true; do :; done &"],
    [
      "while [ 1 ] backgrounded with redirects",
      "while [ 1 ]; do :; done >/dev/null 2>&1 &",
    ],
    ["while (( 1 )) in a group", "( while (( 1 )); do :; done ) &"],
    ["until false backgrounded", "until false; do sleep 1; done &"],
    [
      "a nested loop with an endless outer",
      "while :; do for i in 1 2; do :; done; done &",
    ],
    ["yes backgrounded", "yes > /dev/null &"],
    ["nohup yes backgrounded", "nohup yes >/dev/null 2>&1 &"],
  ])("should deny %s", (_n, command) => {
    const d = decide(bash(command));
    expect(d?.permissionDecision).toBe("deny");
    expect(d?.permissionDecisionReason).toContain("flow-stress");
    expect(d?.permissionDecisionReason).not.toContain("run_in_background");
    expect(d?.permissionDecisionReason).toContain("flow-spawn --detach");
  });

  it("should keep the endless-loop reason first when a backgrounded loop also polls", () => {
    const d = decide(bash("until false; do sleep 1; done &"));
    expect(d?.permissionDecisionReason).toContain("flow-stress");
    expect(d?.permissionDecisionReason).not.toContain("flow-wait");
  });
});

describe("decide — deadline-less polls and watches", () => {
  it.each([
    [
      "the incident poll",
      `until [ "$(jq -r .phase ~/.flow/state/s.json)" = merged ]; do sleep 20; done`,
    ],
    [
      "a condition-only numeric compare",
      'while [ "$(pgrep -c node)" -gt 0 ]; do sleep 5; done',
    ],
    ["gh pr checks --watch", "gh pr checks 412 --watch"],
    ["a wrapped poll", "bash -c 'until test -f x; do sleep 20; done'"],
    ["an over-cap timeout", "timeout 999999 gh pr checks 412 --watch"],
    ["a backgrounded poll", "until test -f x; do sleep 20; done &"],
  ])("should deny %s with the poll reason", (_n, command) => {
    const d = decide(bash(command));
    expect(d?.permissionDecision).toBe("deny");
    expect(d?.permissionDecisionReason).toContain(
      "flow-wait --max-sec <s> --state <slug> --phase <p>",
    );
    expect(d?.permissionDecisionReason).toContain("end=$((SECONDS+600))");
    expect(d?.permissionDecisionReason).toContain("timeout");
    expect(d?.permissionDecisionReason).not.toContain("run_in_background");
  });
});

describe("decide — allowed", () => {
  it.each([
    ["bare jobs -p", "jobs -p"],
    ["kill %1", "sleep 1 & kill %1"],
    ["p=$! cleanup", "sleep 1 & p=$!; kill $p"],
    [
      "a foreground while read with sleep",
      "git branch | while read -r b; do echo $b; sleep 1; done",
    ],
    [
      "timeout wrapping gh pr checks --watch",
      "timeout 600 gh pr checks 412 --watch",
    ],
    [
      "a condition-counter loop",
      "n=0; until [ $n -ge 5 ]; do n=$((n+1)); sleep 2; done",
    ],
    [
      "the SECONDS deadline loop",
      "end=$((SECONDS+600)); until test -f x; do [ $SECONDS -lt $end ] || exit 3; sleep 5; done",
    ],
    ["flow-wait", "flow-wait --max-sec 600 --state foo --phase merged"],
    ["a bounded while read loop", "while read l; do echo $l; done < f"],
    ["a backgrounded while read loop", "while read l; do :; done < f &"],
    ["an && chain", "make && make test"],
    ["stderr redirect", "go test ./... 2>&1 | tail"],
    ["&> redirect", "go test ./... &> out.log"],
    ["quoted loop text", 'echo "while true; do :; done &"'],
    ["single-quoted jobs -p", "sleep 1 & echo '$(jobs -p)'"],
    [
      "a flow-stress call",
      "flow-stress --cpu 4 --max-sec 60 -- go test -race ./...",
    ],
    ["yes piped into head", "yes | head -3 &"],
    ["foreground yes piped", "yes | head -1"],
    ["a foreground job with $(jobs -p) only", "echo $(jobs -p)"],
  ])("should allow %s", (_n, command) => {
    expect(decide(bash(command))).toBeNull();
  });
});

describe("decide — fail open", () => {
  it("should return null for malformed or non-Bash input", () => {
    expect(decide(null)).toBeNull();
    expect(decide("x")).toBeNull();
    expect(
      decide({
        tool_name: "Read",
        tool_input: { command: "while :; do :; done &" },
      }),
    ).toBeNull();
    expect(decide({ tool_name: "Bash", tool_input: {} })).toBeNull();
    expect(
      decide({ tool_name: "Bash", tool_input: { command: "" } }),
    ).toBeNull();
  });
});

describe("scanners", () => {
  it("should not call an unbackgrounded endless loop backgrounding", () => {
    expect(backgroundsEndlessLoop("while :; do :; done")).toBe(false);
  });

  it("should detect $(jobs -p) only outside single quotes", () => {
    expect(usesJobsPSubstitution("kill $(jobs -p)")).toBe(true);
    expect(usesJobsPSubstitution("echo '$(jobs -p)'")).toBe(false);
  });
});

describe("flow-bg-loop-guard executable", () => {
  const SCRIPT = fileURLToPath(
    new URL("./flow-bg-loop-guard.ts", import.meta.url),
  );
  const run = (stdin: string) =>
    spawnSync(SCRIPT, [], { input: stdin, encoding: "utf8" });

  it("is executable", () => {
    expect(() => fs.accessSync(SCRIPT, fs.constants.X_OK)).not.toThrow();
  });

  it("prints a PreToolUse deny decision and exits 0 for the incident shape", () => {
    const r = run(JSON.stringify(bash("sleep 1 & kill $(jobs -p)")));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBeTruthy();
  });

  it("prints nothing and exits 0 for an ordinary command and for malformed stdin", () => {
    for (const input of [JSON.stringify(bash("ls")), "not json{", ""]) {
      const r = run(input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });
});
