import { describe, expect, it } from "vitest";
import {
  clusterCommand,
  clusterTurn,
  isSupervisorSession,
  render,
  segmentSession,
  selfTest,
  type PhaseTurn,
  type ReviewCluster,
} from "./supervisor-turns";

const usage = {
  input_tokens: 1,
  cache_read_input_tokens: 100,
  output_tokens: 5,
};
const T = "2026-10-01T00:00:00Z";
const row = (id: string, block: object, ts = T, u: object = usage) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { id, model: "claude-opus-5", usage: u, content: [block] },
  });
const bash = (command: string) => ({
  type: "tool_use",
  name: "Bash",
  input: { command },
});
const skill = (s: string) => ({
  type: "tool_use",
  name: "Skill",
  input: { skill: s },
});
const phases = (cmds: object[], since = 0) =>
  segmentSession(
    cmds.map((b, i) => row(`m${i}`, b)),
    since,
  ).map((t) => t.phase);

describe("supervisor-turns self-test", () => {
  it("should pass every in-memory fixture", () => {
    expect(selfTest()).toEqual([]);
  });
});

describe("segmentSession phase boundaries", () => {
  it("should start in pre and move to implement on the flow-coder skill", () => {
    expect(
      phases([bash("ls"), skill("flow-module-core:flow-coder"), bash("ls")]),
    ).toEqual(["pre", "implement", "implement"]);
  });

  it("should start review at the flow-pr-review skill load", () => {
    expect(
      phases([
        skill("flow-coder"),
        skill("flow-module-core:flow-pr-review"),
        bash("ls"),
      ]),
    ).toEqual(["implement", "review", "review"]);
  });

  it("should start review at flow-state-update --phase reviewing", () => {
    expect(
      phases([bash("flow-state-update --phase reviewing"), bash("ls")]),
    ).toEqual(["review", "review"]);
  });

  it("should move through ci-wait, gate and merge and reset to implement on --phase implementing", () => {
    expect(
      phases([
        bash("flow-state-update --phase reviewing"),
        bash("flow-state-update --phase ci-wait"),
        bash("RESULT=$(flow-gate-decide 7)"),
        bash("cd /w && flow-merge-guard 7"),
        bash("flow-state-update --phase implementing"),
      ]),
    ).toEqual(["review", "ci-wait", "gate", "merge", "implement"]);
  });

  it("should not treat a helper name mentioned inside a heredoc as a boundary", () => {
    expect(
      phases([bash("cat <<'EOF'\nsee `flow-gate-decide` docs\nEOF")]),
    ).toEqual(["pre"]);
  });

  it("should keep boundaries stable when --since drops earlier turns", () => {
    const lines = [
      row(
        "a",
        bash("flow-state-update --phase reviewing"),
        "2026-09-01T00:00:00Z",
      ),
      row("b", bash("ls"), T),
    ];
    expect(
      segmentSession(lines, Date.parse("2026-10-01T00:00:00Z")).map(
        (t) => t.phase,
      ),
    ).toEqual(["review"]);
  });
});

describe("segmentSession message-id de-duplication", () => {
  it("should count a multi-line message once and price its last usage", () => {
    const lines = [
      row("x", { type: "text", text: "hi" }, T, { ...usage, output_tokens: 1 }),
      row("x", bash("ls"), T, { ...usage, output_tokens: 9 }),
      row("x", bash("pwd"), T, { ...usage, output_tokens: 9 }),
    ];
    const turns = segmentSession(lines, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].bashCommands).toEqual(["ls", "pwd"]);
    expect(turns[0].tools).toEqual(["Bash", "Bash"]);
    const last = segmentSession([lines[2]], 0)[0];
    expect(turns[0].usd).toBe(last.usd);
    expect(turns[0].contextTokens).toBe(101);
  });

  it("should apply a boundary carried by a later line of the same message", () => {
    const lines = [
      row("x", { type: "text", text: "hi" }),
      row("x", bash("flow-gate-decide 1")),
    ];
    expect(segmentSession(lines, 0)[0].phase).toBe("gate");
  });
});

describe("clusterCommand", () => {
  const cases: [string, ReviewCluster][] = [
    [
      "until test -s $T/agent-output-security.json; do sleep 5; done",
      "lens-collect",
    ],
    [
      "for i in $(seq 1 115); do [ -s $A ] && break; sleep 5; done",
      "lens-collect",
    ],
    [
      "flow-agent-finding-schema --validate $T/agent-output-x.json",
      "lens-collect",
    ],
    ["jq -c . $T/agent-output-bug-detection.json", "lens-collect"],
    [
      "until jq -e . $T/consolidator-result.json; do sleep 5; done",
      "consolidator-collect",
    ],
    [
      "jq -r .scope_verdict .flow-tmp/consolidator-result.json",
      "consolidator-collect",
    ],
    [
      "flow-fix-applier-schema --validate $A/fix-applier-result.json",
      "fix-applier-collect",
    ],
    ["jq -r .status .flow-tmp/fix-applier-result.json", "fix-applier-collect"],
    [
      "flow-inject-evidence --body-file b.md --item x --output-file e.txt",
      "test-steps-run",
    ],
    [
      "bash -c 'true' > $T/evidence-1.txt 2>&1; echo $? > $T/exit-1",
      "test-steps-run",
    ],
    ["gh pr edit 5 --body-file .flow-tmp/body.md", "test-steps-run"],
    ["flow-post-findings --pr 5 --findings f.json", "findings-post"],
    ["cd /w; flow-review-prep --pr 5", "prep-finalize"],
    ["flow-review-finalize --pr 5 --status clean", "prep-finalize"],
    ["git status --short", "rest"],
    ["gh pr view 5 --json title", "rest"],
  ];
  it.each(cases)("should cluster %s as %s", (cmd, want) => {
    expect(clusterCommand(cmd)).toBe(want);
  });

  it("should cover every cluster name", () => {
    expect(new Set(cases.map((c) => c[1]))).toEqual(
      new Set<ReviewCluster>([
        "lens-collect",
        "consolidator-collect",
        "fix-applier-collect",
        "test-steps-run",
        "findings-post",
        "prep-finalize",
        "rest",
      ]),
    );
  });

  it("should pick the highest-priority cluster for a mixed turn and rest when no command", () => {
    const turn = (cmds: string[]): PhaseTurn => ({
      phase: "review",
      usd: 1,
      contextTokens: 1,
      tools: ["Bash"],
      bashCommands: cmds,
    });
    expect(clusterTurn(turn(["sleep 5", "flow-post-findings --pr 1"]))).toBe(
      "findings-post",
    );
    expect(clusterTurn(turn([]))).toBe("rest");
  });
});

describe("isSupervisorSession and render", () => {
  it("should require a flow-pipeline Skill load", () => {
    expect(
      isSupervisorSession([row("a", skill("flow-module-core:flow-pipeline"))]),
    ).toBe(true);
    expect(isSupervisorSession([row("a", bash("echo flow-pipeline"))])).toBe(
      false,
    );
  });

  it("should render every phase and cluster row from segmented sessions", () => {
    const s = segmentSession(
      [
        row("a", bash("flow-state-update --phase reviewing")),
        row("b", bash("flow-post-findings --pr 1")),
        row("c", bash("flow-gate-decide 1")),
        row("d", bash("flow-merge-guard 1")),
      ],
      0,
    );
    const out = render([s]);
    for (const p of ["pre", "implement", "ci-wait", "review", "gate", "merge"])
      expect(out).toContain(`| ${p} `);
    expect(out).toContain("findings-post");
    expect(out).toContain("flow-merge-guard");
  });
});
