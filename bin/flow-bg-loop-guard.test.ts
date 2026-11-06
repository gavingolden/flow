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
    expect(d?.permissionDecisionReason).toContain("run_in_background");
    expect(d?.permissionDecisionReason).toContain("flow-spawn --detach");
  });
});

describe("decide — allowed", () => {
  it.each([
    ["bare jobs -p", "jobs -p"],
    ["kill %1", "sleep 1 & kill %1"],
    ["p=$! cleanup", "sleep 1 & p=$!; kill $p"],
    ["a foreground endless loop", "while true; do sleep 1; done"],
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
